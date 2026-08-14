// Pont simple pour "aller voir cette parcelle sur la Carte" depuis une autre
// page (ex. liste des parcelles) — l'appli n'a pas de routing par URL, juste un
// état `section` dans App.jsx, donc on passe par un petit module partagé plutôt
// que par des props (les pages sont rendues indépendamment les unes des autres).
let pendingParcelleId = null
const listeners = new Set()

export function requestGoToParcelle(id) {
  pendingParcelleId = id
  listeners.forEach(l => l(id))
}
export function consumePendingParcelle() {
  const id = pendingParcelleId
  pendingParcelleId = null
  return id
}
export function onGoToParcelleRequest(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
