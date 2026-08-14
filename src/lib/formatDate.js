// Format d'affichage unique pour toutes les dates de l'appli : JJ/MM/AAAA.
// Accepte une date ISO ("2026-04-25"), un Date, ou un timestamp — renvoie '–'
// si vide/invalide plutôt que de laisser passer une chaîne brute non formatée.
export function fmtDate(d) {
  if (!d) return '–'
  const date = d instanceof Date ? d : new Date(d)
  if (isNaN(date.getTime())) return typeof d === 'string' ? d : '–'
  return date.toLocaleDateString('fr-FR')
}
