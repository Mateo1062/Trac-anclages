// Pont "aller voir ça" depuis le Diagnostic vers n'importe quelle section — même
// principe que lib/mapFocus.js (l'appli n'a pas de routing par URL, juste un état
// `section` dans App.jsx). Le "hint" (référence, nom…) n'est pas ré-injecté
// automatiquement dans la recherche de la page cible (ça demanderait de câbler
// chaque page une par une) : on le copie dans le presse-papier et on affiche où
// le coller, ce qui reste largement plus rapide que de chercher à l'œil.
let listeners = new Set()

export function requestGoToSection(sectionId, hint) {
  if (hint) {
    try { navigator.clipboard?.writeText(hint) } catch { /* presse-papier indisponible, tant pis */ }
  }
  listeners.forEach(l => l(sectionId, hint))
}
export function onGoToSectionRequest(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
