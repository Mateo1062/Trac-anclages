import { getQueue, removeFromQueue, clearQueue as clearQueueDb } from './offlineDb'
import { logActivity } from './activityLog'
// Import différé (pas au niveau module) pour éviter un cycle d'import bloquant
// avec supabase.js -> offlineFetch.js -> offlineSync.js -> supabase.js : la
// fonction n'est appelée qu'au moment du rejeu, jamais au chargement du module.
let _supabasePromise = null
function getSupabase() {
  if (!_supabasePromise) _supabasePromise = import('./supabase').then(m => m.supabase)
  return _supabasePromise
}

/**
 * Petit pub-sub pour informer l'UI (bandeau hors-ligne, etc.) de l'état de
 * la connexion et de la file d'attente, sans dépendre d'un contexte React
 * (le fetch offline lui-même est en dehors de tout composant).
 */
const listeners = new Set()

export function subscribeOfflineStatus(fn) {
  listeners.add(fn)
  fn(getStatus())
  return () => listeners.delete(fn)
}

let pendingCount = 0
let syncing = false
// Dernière erreur rencontrée en rejouant la file — jusqu'ici totalement invisible
// (juste avalée), impossible à diagnostiquer sans les outils dev. Affichée dans
// le bandeau pour comprendre ce qui bloque sans avoir à ouvrir la console.
let lastError = null
// Une lecture (GET) qui échoue/expire alors que navigator.onLine dit "en ligne"
// (connexion juste lente, portail captif...) retombe silencieusement sur la
// dernière réponse connue en cache — jusqu'ici invisible : ça pouvait donner
// l'impression que des données supprimées "revenaient" alors qu'il s'agissait
// juste d'un rechargement qui avait servi une copie périmée. Horodatage de la
// dernière fois que ça s'est produit, effacé au prochain chargement réussi.
let staleDataAt = null

function getStatus() {
  return { online: navigator.onLine, pendingCount, syncing, lastError, staleDataAt }
}

export function reportStaleDataServed() {
  staleDataAt = Date.now()
  notify()
}
export function clearStaleDataFlag() {
  staleDataAt = null
  notify()
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Délai dépassé (réseau trop lent ou bloqué)')), ms)
    promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/** Vide la file d'attente sans rien envoyer — échappatoire manuelle depuis le
 *  bandeau quand une mutation reste bloquée indéfiniment. Les modifications
 *  concernées ne seront jamais appliquées côté serveur. */
export async function clearQueue() {
  await clearQueueDb()
  lastError = null
  await refreshPendingCount()
}

function notify() {
  const status = getStatus()
  listeners.forEach(fn => fn(status))
}

export async function refreshPendingCount() {
  const queue = await getQueue()
  pendingCount = queue.length
  notify()
  return pendingCount
}

let replaying = false

/** Rejoue la file d'attente dans l'ordre. S'arrête à la première erreur réseau
 *  (on retentera au prochain 'online' / tick) mais continue si le serveur
 *  répond avec une erreur métier (ex: contrainte violée) pour ne pas bloquer
 *  indéfiniment les mutations suivantes — l'erreur est juste journalisée. */
export async function replayQueue() {
  if (replaying) return
  replaying = true
  syncing = true
  notify()
  try {
    const queue = await getQueue()
    for (const item of queue) {
      try {
        // Une mutation mise en file peut attendre des heures avant d'être rejouée
        // (mauvaise couverture réseau sur le terrain) — le jeton d'authentification
        // capturé au moment de la mise en file a alors expiré (~1h). On le
        // remplace ici par le jeton courant (rafraîchi automatiquement par
        // supabase-js tant que l'appli reste ouverte) avant de rejouer, sinon la
        // requête échoue en 401 et était jusqu'ici abandonnée en silence — la
        // suppression/modification n'avait alors JAMAIS lieu côté serveur.
        const headers = { ...item.headers }
        if (headers.Authorization || headers.authorization) {
          const supabase = await getSupabase()
          const { data: { session } } = await supabase.auth.getSession()
          if (session?.access_token) {
            delete headers.authorization
            headers.Authorization = `Bearer ${session.access_token}`
          }
        }
        const res = await withTimeout(fetch(item.url, { method: item.method, headers, body: item.body }), 15000)
        // 401 = jeton pas (encore) valide : on réessaiera plus tard, une fois
        // reconnecté avec une session valide, ça repassera. 403 en revanche est un
        // vrai refus de droit (policy RLS) qui ne se résoudra jamais tout seul —
        // le traiter comme le 401 bloquerait la file indéfiniment pour rien.
        if (!res.ok && (res.status >= 500 || res.status === 401)) {
          lastError = `${item.method} ${item.url.split('/rest/v1/')[1] || item.url} — HTTP ${res.status} : ${await res.text().catch(() => '')}`.slice(0, 300)
          console.error('[offline] rejeu suspendu (nouvelle tentative plus tard) :', lastError)
          break
        }
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          console.warn('[offline] mutation rejetée par le serveur, abandonnée :', item.method, item.url, msg)
          lastError = `Abandonnée — ${item.method} ${item.url.split('/rest/v1/')[1] || item.url} — HTTP ${res.status} : ${msg}`.slice(0, 300)
        } else {
          logActivity({ url: item.url, method: item.method, headers, bodyText: typeof item.body === 'string' ? item.body : null })
        }
        await removeFromQueue(item.id)
      } catch (e) {
        // toujours hors-ligne / erreur réseau (ou délai dépassé) : on s'arrête, on réessaiera
        lastError = `${item.method} ${item.url.split('/rest/v1/')[1] || item.url} — ${e.message}`.slice(0, 300)
        console.error('[offline] rejeu interrompu, nouvelle tentative plus tard :', lastError, e)
        break
      }
    }
  } finally {
    await refreshPendingCount()
    syncing = false
    notify()
    replaying = false
  }
}

window.addEventListener('online', () => { notify(); replayQueue() })
window.addEventListener('offline', notify)

// Filet de sécurité : si l'événement 'online' ne se déclenche pas de façon
// fiable (portails captifs, etc.), on retente périodiquement tant qu'il y a
// des mutations en attente et que le navigateur se croit en ligne.
setInterval(() => {
  if (navigator.onLine && pendingCount > 0) replayQueue()
}, 20000)

refreshPendingCount()
