// Libellé du type d'une intervention champ (interventions_phyto), affiché en
// petite en-tête au-dessus du détail de l'intervention (Tableau de bord,
// Carte…). Pour "Broyage", précise si un défanage a aussi été fait au même
// passage (colonne defanage, migration_A_EXECUTER_58.sql).
export function intervTypeLabel(i) {
  if (i?.sous_type === 'Broyage') return i.defanage ? 'Broyage + Défanage' : 'Broyage'
  return i?.sous_type || i?.observation || i?.produit_nom || 'Intervention'
}
