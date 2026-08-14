import { queueMutation, cacheResponse, getCachedResponse } from './offlineDb'
import { refreshPendingCount, reportStaleDataServed, clearStaleDataFlag } from './offlineSync'
import { logActivity } from './activityLog'

const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE']
// Les écritures restent courtes (échec rapide = mise en file plus tôt). Les
// lectures, elles, doivent tolérer une connexion juste lente (rural, 4G
// faible) sans basculer sur le cache pour autant — un délai trop court y
// bascule trop souvent, ce qui peut réafficher des données périmées après une
// suppression toute fraîche (l'utilisateur ne voit alors AUCUN indice que ce
// qu'il regarde n'est pas la version actuelle).
const WRITE_TIMEOUT_MS = 8000
const READ_TIMEOUT_MS = 25000

function normalizeHeaders(headers) {
  const out = {}
  if (!headers) return out
  if (headers instanceof Headers) { headers.forEach((v, k) => { out[k] = v }); return out }
  if (Array.isArray(headers)) { headers.forEach(([k, v]) => { out[k] = v }); return out }
  return { ...headers }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TypeError('offline-timeout')), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * Fetch de remplacement pour le client Supabase : transparent pour toutes
 * les pages (aucun appel `supabase.from(...)` à modifier). Intercepte
 * uniquement les requêtes REST (`/rest/v1/`) :
 *  - GET  : réseau d'abord, sinon dernière réponse connue en cache (IndexedDB)
 *  - écritures (POST/PATCH/PUT/DELETE) : réseau d'abord ; si hors-ligne,
 *    la requête est mise en file d'attente et une réponse optimiste est
 *    renvoyée immédiatement pour que l'UI continue de fonctionner normalement.
 */
export function createOfflineFetch() {
  return async function offlineFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url
    const method = (init.method || 'GET').toUpperCase()
    const isRest = url.includes('/rest/v1/')

    if (!isRest) return fetch(input, init)

    const isWrite = WRITE_METHODS.includes(method)
    const attemptNetwork = navigator.onLine

    if (attemptNetwork) {
      try {
        const res = await withTimeout(fetch(input, init), isWrite ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS)
        if (method === 'GET' && res.ok) {
          const clone = res.clone()
          clone.text().then(body => cacheResponse(url, body, res.status, normalizeHeaders(res.headers))).catch(() => {})
          clearStaleDataFlag()
        }
        if (isWrite && res.ok) {
          logActivity({ url, method, headers: normalizeHeaders(init.headers), bodyText: typeof init.body === 'string' ? init.body : null })
        }
        return res
      } catch (networkErr) {
        // tombe dans les branches hors-ligne ci-dessous
      }
    }

    if (method === 'GET') {
      const cached = await getCachedResponse(url)
      if (cached) {
        // Signalé même si navigator.onLine dit "en ligne" — c'est justement le cas
        // qui passait inaperçu (connexion trop lente plutôt que vraiment coupée).
        reportStaleDataServed()
        return new Response(cached.body, { status: 200, statusText: 'OK (cache hors-ligne)', headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({ message: 'Hors-ligne et aucune donnée en cache pour cette requête.' }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      })
    }

    if (isWrite) {
      const headers = normalizeHeaders(init.headers)
      let bodyText = init.body
      let bodyObj = null
      if (typeof bodyText === 'string') {
        try { bodyObj = JSON.parse(bodyText) } catch { /* pas du JSON */ }
      }
      if (method === 'POST' && bodyObj && !Array.isArray(bodyObj) && !bodyObj.id) {
        bodyObj.id = crypto.randomUUID()
        bodyText = JSON.stringify(bodyObj)
      }

      await queueMutation({ url, method, headers, body: bodyText })
      await refreshPendingCount()

      const preferReturn = (headers['Prefer'] || headers['prefer'] || '').includes('return=representation')
      // `.single()`/`.maybeSingle()` demandent au vrai PostgREST un objet JSON nu
      // (pas un tableau) via cet Accept header — il faut reproduire exactement
      // ce format, sinon postgrest-js reçoit un tableau là où il attend `{...}`.
      const wantsSingleObject = (headers['Accept'] || headers['accept'] || '').includes('vnd.pgrst.object')
      const echoRows = bodyObj ? (Array.isArray(bodyObj) ? bodyObj : [bodyObj]) : []
      const responseBody = wantsSingleObject ? (echoRows[0] ?? null) : echoRows
      return new Response(preferReturn ? JSON.stringify(responseBody) : null, {
        status: method === 'POST' ? 201 : 200,
        statusText: 'Queued (hors-ligne)',
        headers: { 'Content-Type': 'application/json' },
      })
    }

    throw new TypeError('Failed to fetch (hors-ligne)')
  }
}
