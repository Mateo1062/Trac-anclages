/**
 * IndexedDB store used by le mode hors-ligne :
 * - `mutation_queue` : requêtes d'écriture (insert/update/upsert/delete) en attente de synchro
 * - `response_cache` : dernière réponse connue de chaque requête GET, pour consultation hors-ligne
 */
const DB_NAME = 'tracagri-offline'
const DB_VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('mutation_queue')) {
        db.createObjectStore('mutation_queue', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('response_cache')) {
        db.createObjectStore('response_cache', { keyPath: 'url' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(storeName, mode) {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName))
}

export async function queueMutation(entry) {
  const store = await tx('mutation_queue', 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.add({ ...entry, createdAt: Date.now() })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function getQueue() {
  const store = await tx('mutation_queue', 'readonly')
  return new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.id - b.id))
    req.onerror = () => reject(req.error)
  })
}

export async function removeFromQueue(id) {
  const store = await tx('mutation_queue', 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// Vide toute la file d'attente — échappatoire manuelle depuis le bandeau
// hors-ligne quand une mutation reste bloquée indéfiniment (voir OfflineBanner).
// Les mutations effacées ainsi ne seront JAMAIS envoyées au serveur : à utiliser
// seulement si l'action correspondante va être refaite manuellement ensuite.
export async function clearQueue() {
  const store = await tx('mutation_queue', 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function cacheResponse(url, body, status, headers) {
  const store = await tx('response_cache', 'readwrite')
  return new Promise((resolve, reject) => {
    const req = store.put({ url, body, status, headers, cachedAt: Date.now() })
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function getCachedResponse(url) {
  const store = await tx('response_cache', 'readonly')
  return new Promise((resolve, reject) => {
    const req = store.get(url)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
}
