// Variétés de pomme de terre assignées à une parcelle (module Récolte PDT,
// colonne parcelles.varietes_pdt : jsonb [{ variete, surface, cote }]) —
// centralisé ici pour être affiché à l'identique dans Récolte PDT, la Liste
// des parcelles et la Carte, sans avoir à ressaisir l'info à chaque endroit.
// `cote` = repère libre indiqué par l'utilisateur pour savoir de quel côté du
// champ se trouve cette variété (ex. "Nord", "côté route"…), utile sur la carte
// quand une parcelle a plusieurs variétés.
export function varietesPdtOf(parc) {
  if (Array.isArray(parc?.varietes_pdt) && parc.varietes_pdt.length > 0) {
    return parc.varietes_pdt
      .map(v => ({ variete: v.variete || '', surface: v.surface ?? null, cote: v.cote || '' }))
      .filter(v => v.variete)
  }
  if (parc?.variete_pdt) {
    const rows = [{ variete: parc.variete_pdt, surface: null, cote: '' }]
    if (parc.variete_pdt_2) rows.push({ variete: parc.variete_pdt_2, surface: parc.surface_variete_2 ?? null, cote: '' })
    return rows
  }
  return []
}

// Résumé texte court, ex. "Agata (3.2 ha) + Charlotte (1.8 ha · côté Nord)"
export function varietesPdtLabel(parc) {
  return varietesPdtOf(parc).map(v => {
    const extra = []
    if (v.surface != null) extra.push(`${v.surface} ha`)
    if (v.cote) extra.push(v.cote)
    return extra.length ? `${v.variete} (${extra.join(' · ')})` : v.variete
  }).join(' + ')
}
