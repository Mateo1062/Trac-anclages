// Fonction serverless Vercel — proxy vers l'API Gemini (Google AI) pour l'assistant IA.
// La clé GEMINI_API_KEY reste côté serveur (jamais exposée au navigateur).
// Vérifie que l'appelant a une session Supabase valide avant d'utiliser le quota gratuit.

const SUPABASE_URL = 'https://ofmikroavbdhquckfkkx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbWlrcm9hdmJkaHF1Y2tma2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2ODQwOTEsImV4cCI6MjEwMjI2MDA5MX0.8-WaHAberQZasXOOBxjpi67H-SFQYxaS35a_Lzhppu4'

const SYSTEM_PROMPT = `Tu es l'assistant IA intégré à Traç'Anclages, une application de gestion agricole
(parcelles, cultures, interventions, planning, frigos, coûts). Tu aides les utilisateurs à :
- répondre à des questions générales sur l'agriculture, la réglementation, les bonnes pratiques,
- rédiger ou reformuler des notes d'intervention à partir de quelques mots-clés,
- expliquer comment utiliser une fonctionnalité de l'application.
Tu n'as pas d'accès direct aux données de l'exploitation (parcelles, historiques, chiffres) —
si une question en dépend, dis-le clairement et demande à l'utilisateur de te fournir les chiffres
utiles plutôt que de les inventer. Réponds toujours en français, de façon concise et concrète.`

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

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        }),
      }
    )

    const data = await geminiRes.json()
    if (!geminiRes.ok) {
      res.status(geminiRes.status).json({ error: data.error?.message || 'Erreur Gemini' })
      return
    }

    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || ''
    res.status(200).json({ reply })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
