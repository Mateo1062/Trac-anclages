// Pont simple entre l'enregistrement du service worker (main.jsx, hors arbre React)
// et le bandeau d'alerte (UpdateBanner) qui doit s'afficher partout dans l'appli.
let pendingReload = null
const listeners = new Set()

export function setPendingReload(fn) {
  pendingReload = fn
  listeners.forEach(l => l())
}
export function getPendingReload() { return pendingReload }
export function onPendingReloadChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }
