// Fonction serverless Vercel — proxy vers l'API Gemini (Google AI) pour l'assistant IA.
// La clé GEMINI_API_KEY reste côté serveur (jamais exposée au navigateur).
// Vérifie que l'appelant a une session Supabase valide avant d'utiliser le quota gratuit,
// et donne à l'IA des "tools" pour lire/créer des données réelles (parcelles, interventions).

const SUPABASE_URL = 'https://ofmikroavbdhquckfkkx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbWlrcm9hdmJkaHF1Y2tma2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2ODQwOTEsImV4cCI6MjEwMjI2MDA5MX0.8-WaHAberQZasXOOBxjpi67H-SFQYxaS35a_Lzhppu4'

const TYPES_INTERVENTION = ['Traitement et protection des cultures', 'Ferti minérale et foliaire', 'Plantation', 'Semis', 'Fertilisation et amendement organique', 'Désherbage mécanique', 'Travail du sol', 'Récolte', 'Irrigation']

// Même règle que src/lib/campagne.js (1er août -> 31 juillet), dupliquée ici
// pour ne pas dépendre d'un import cross-dossier dans la fonction serverless.
function campagneForDate(dateStr) {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`
}

const SYSTEM_PROMPT = `Tu es l'assistant IA intégré à Traç'Anclages, une application de gestion agricole
(parcelles, cultures, interventions, planning, frigos, coûts). Tu peux :
- répondre à des questions générales sur l'agriculture, la réglementation, les bonnes pratiques,
- consulter les vraies parcelles et interventions de l'exploitation via les outils fournis (list_parcelles, list_interventions) pour répondre avec des chiffres réels plutôt que d'inventer,
- créer une nouvelle intervention (create_intervention) quand l'utilisateur te le demande clairement,
- expliquer comment utiliser une fonctionnalité de l'application.
Avant de créer une intervention, si une information nécessaire manque (parcelle, date, type), demande-la
plutôt que de deviner. Après création, confirme précisément ce qui a été enregistré.
Réponds toujours en français, de façon concise et concrète.`

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'list_parcelles',
      description: "Liste les parcelles de l'exploitation (nom, surface en ha, entité, culture actuelle).",
      parameters: { type: 'OBJECT', properties: {} },
    },
    {
      name: 'list_interventions',
      description: "Liste les interventions récentes (traitements, semis, récolte, etc.), éventuellement filtrées par parcelle.",
      parameters: {
        type: 'OBJECT',
        properties: {
          parcelle_nom: { type: 'STRING', description: 'Nom (exact ou partiel) de la parcelle pour filtrer — optionnel' },
          limite: { type: 'NUMBER', description: 'Nombre maximum de résultats, défaut 10' },
        },
      },
    },
    {
      name: 'create_intervention',
      description: "Crée une nouvelle intervention agricole sur une parcelle existante.",
      parameters: {
        type: 'OBJECT',
        properties: {
          parcelle_nom: { type: 'STRING', description: 'Nom exact de la parcelle concernée' },
          date: { type: 'STRING', description: 'Date au format AAAA-MM-JJ' },
          type: { type: 'STRING', description: "Type d'intervention", enum: TYPES_INTERVENTION },
          produit_nom: { type: 'STRING', description: 'Nom du produit utilisé — optionnel' },
          quantite: { type: 'NUMBER', description: 'Quantité de produit — optionnel' },
          unite: { type: 'STRING', description: 'Unité (L, kg, g, mL, T) — optionnel' },
          remarque: { type: 'STRING', description: 'Remarque libre — optionnel' },
        },
        required: ['parcelle_nom', 'date', 'type'],
      },
    },
  ],
}]

async function sbFetch(path, token, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message || 'Erreur base de données')
  return data
}

async function resolveParcelleId(nom, token) {
  const rows = await sbFetch(`parcelles?select=id,nom&nom=ilike.*${encodeURIComponent(nom)}*&limit=5`, token)
  if (rows.length === 0) return { error: `Aucune parcelle ne correspond à "${nom}".` }
  const exact = rows.find(r => r.nom.toLowerCase() === nom.toLowerCase())
  if (exact) return { id: exact.id, nom: exact.nom }
  if (rows.length === 1) return { id: rows[0].id, nom: rows[0].nom }
  return { error: `Plusieurs parcelles correspondent à "${nom}" : ${rows.map(r => r.nom).join(', ')}. Précise le nom exact.` }
}

async function runTool(name, args, ctx) {
  const { token, userId } = ctx
  if (name === 'list_parcelles') {
    const rows = await sbFetch('parcelles?select=nom,surface,entite,culture_actuelle&order=nom&limit=200', token)
    return { parcelles: rows }
  }
  if (name === 'list_interventions') {
    let query = `interventions_phyto?select=date,observation,produit_nom,quantite,unite,parcelle,remarque&order=date.desc&limit=${Math.min(Number(args.limite) || 10, 50)}`
    if (args.parcelle_nom) query += `&parcelle=ilike.*${encodeURIComponent(args.parcelle_nom)}*`
    const rows = await sbFetch(query, token)
    return { interventions: rows }
  }
  if (name === 'create_intervention') {
    if (!TYPES_INTERVENTION.includes(args.type)) {
      return { error: `Type invalide. Types valides : ${TYPES_INTERVENTION.join(', ')}` }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date || '')) {
      return { error: 'Date invalide, utilise le format AAAA-MM-JJ.' }
    }
    const parcelle = await resolveParcelleId(args.parcelle_nom, token)
    if (parcelle.error) return { error: parcelle.error }
    const row = {
      date: args.date,
      parcelle_id: parcelle.id,
      parcelle: parcelle.nom,
      observation: args.type,
      produit_nom: args.produit_nom || args.type,
      quantite: args.quantite ?? null,
      unite: args.unite || null,
      remarque: args.remarque || null,
      campagne: campagneForDate(args.date),
      user_id: userId,
    }
    await sbFetch('interventions_phyto', token, { method: 'POST', body: JSON.stringify(row) })
    return { ok: true, cree: { parcelle: parcelle.nom, date: args.date, type: args.type } }
  }
  return { error: `Outil inconnu : ${name}` }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const authHeader = req.headers.authorization || ''
  const token = authHeader.replace(/^Bearer\s+/i, '')
  if (!token) {
    res.status(401).json({ error: 'Non authentifié' })
    return
  }

  const userCheck = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  })
  if (!userCheck.ok) {
    res.status(401).json({ error: 'Session invalide' })
    return
  }
  const authUser = await userCheck.json()

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    res.status(500).json({ error: "Clé GEMINI_API_KEY manquante côté serveur." })
    return
  }

  const { messages } = req.body || {}
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages manquant' })
    return
  }

  let contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  try {
    let reply = ''
    for (let round = 0; round < 4; round++) {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            tools: TOOLS,
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          }),
        }
      )
      const data = await geminiRes.json()
      if (!geminiRes.ok) {
        res.status(geminiRes.status).json({ error: data.error?.message || 'Erreur Gemini' })
        return
      }

      const parts = data.candidates?.[0]?.content?.parts || []
      const functionCalls = parts.filter(p => p.functionCall)

      if (functionCalls.length === 0) {
        reply = parts.map(p => p.text || '').join('')
        break
      }

      contents.push({ role: 'model', parts })
      const responseParts = []
      for (const p of functionCalls) {
        let result
        try {
          result = await runTool(p.functionCall.name, p.functionCall.args || {}, { token, userId: authUser.id })
        } catch (err) {
          result = { error: err.message }
        }
        responseParts.push({ functionResponse: { name: p.functionCall.name, response: result } })
      }
      contents.push({ role: 'function', parts: responseParts })
    }

    res.status(200).json({ reply: reply || "Je n'ai pas pu obtenir de réponse complète, réessaie." })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
