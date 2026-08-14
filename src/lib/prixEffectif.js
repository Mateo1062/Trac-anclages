// Prix effectif d'un produit (db_phyto ou db_intrants) à une date donnée : si un prix
// prévisionnel avec une date d'effet est renseigné et que la date visée l'a atteint, il
// remplace le prix courant — sinon on garde le prix courant (prix_unitaire).
//
// Volontairement PAS de réécriture automatique de prix_unitaire à la date d'effet : les
// lignes de coût déjà enregistrées gardent pour toujours le prix qu'elles avaient au moment
// de leur saisie (chacune stocke son propre prix_unitaire). Seul un recalcul explicite
// ("Mettre à jour les prix") les touche — et seulement si la date de la ligne elle-même a
// atteint la date d'effet, donc les interventions passées conservent leur prix d'origine.
export function prixEffectif(produit, dateStr) {
  if (!produit) return null
  if (produit.date_effet_prix && produit.prix_previsionnel != null && (!dateStr || dateStr >= produit.date_effet_prix)) {
    return produit.prix_previsionnel
  }
  return produit.prix_unitaire ?? null
}
