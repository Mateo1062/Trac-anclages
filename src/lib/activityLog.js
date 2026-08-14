// Journal d'activité — qui a créé/modifié/supprimé quoi, et quand.
// Branché directement sur la couche fetch du client Supabase (offlineFetch.js)
// et sur la synchronisation hors-ligne (offlineSync.js) : chaque écriture
// réussie (en ligne ou rejouée après une coupure) est journalisée sans
// qu'aucune page n'ait besoin d'appeler quoi que ce soit explicitement.
const SUPABASE_URL = 'https://gzyteuuttgiuyefholhj.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6eXRldXV0dGdpdXllZmhvbGhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NTQxMzEsImV4cCI6MjA5NzIzMDEzMX0.qXVQCTuvGSYpkriuJ8mlM8wjytNSjp3mpNGNQJub8tU'

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE']

function decodeJwt(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(decodeURIComponent(escape(atob(b64))))
  } catch { return null }
}

export function logActivity({ url, method, headers, bodyText }) {
  try {
    if (!WRITE_METHODS.includes(method)) return
    const tableMatch = url.match(/\/rest\/v1\/([^/?]+)/)
    const table = tableMatch ? tableMatch[1] : null
    // Évite la boucle (ne journalise pas les écritures dans le journal lui-même)
    // et ignore ce qui n'est pas une table REST (auth, storage, realtime…).
    if (!table || table === 'activity_log') return

    const authHeader = headers?.['Authorization'] || headers?.['authorization'] || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const claims = token ? decodeJwt(token) : null
    const userId = claims?.sub || null
    const email = claims?.email || null

    let recordId = null
    let summary = null
    let payload = null
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText)
        const rows = Array.isArray(payload) ? payload : [payload]
        recordId = rows[0]?.id != null ? String(rows[0].id) : null
        if (rows.length > 1) summary = `${rows.length} ligne(s)`
      } catch { /* corps non JSON — rare (ex: DELETE sans body) */ }
    }
    if (!recordId) {
      const idMatch = url.match(/[?&]id=eq\.([^&]+)/)
      if (idMatch) recordId = decodeURIComponent(idMatch[1])
    }

    const logRow = { user_id: userId, user_email: email, method, table_name: table, record_id: recordId, summary, payload }

    // Fire-and-forget : la journalisation ne doit jamais bloquer ni faire
    // échouer l'écriture réelle qui vient de réussir.
    fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader || `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(logRow),
    }).catch(() => {})
  } catch { /* la journalisation ne doit jamais casser l'appelant */ }
}
