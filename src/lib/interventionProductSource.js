import { phytoDisplayName } from './phytoNames'

// Détermine, pour un type d'intervention donné, quelle base de produits/stock
// proposer en recherche (produits phyto ou intrants, éventuellement filtrée
// par catégorie) — centralisé ici (au lieu d'une copie par page) pour que
// Carte.jsx et StockInterventions.jsx restent forcément synchronisés. Une
// désynchronisation avait déjà fait disparaître les intrants "Ferti minérale"
// de la recherche après le renommage de catégorie 'ferti' → 'fertilisant'
// (migration 76) : seul Carte.jsx avait été mis à jour, pas ce fichier.
export function productSourceFor(type, phytoProducts, intrants, sousType) {
  if (type === 'Traitement et protection des cultures') {
    return { table: 'db_phyto', items: phytoProducts, label: 'produit phyto' }
  }
  // Broyage (Travail du sol) peut se faire avec un défanage chimique au même
  // passage — un vrai produit phyto (défanant) est alors appliqué, pas juste du
  // travail mécanique : mêmes suggestions/homologation que pour un traitement.
  if (type === 'Travail du sol' && sousType === 'Broyage') {
    return { table: 'db_phyto', items: phytoProducts, label: 'produit de défanage' }
  }
  if (type === 'Ferti minérale et foliaire') {
    return { table: 'db_intrants', items: intrants.filter(i => i.categorie === 'fertilisant'), label: 'intrant (fertilisation)' }
  }
  if (type === 'Fertilisation et amendement organique') {
    return { table: 'db_intrants', items: intrants.filter(i => ['engrais', 'fertilisant'].includes(i.categorie)), label: 'intrant (engrais/ferti)' }
  }
  if (type === 'Plantation') {
    return { table: 'db_intrants', items: intrants.filter(i => ['plants', 'semences'].includes(i.categorie)), label: 'plants/semences' }
  }
  if (type === 'Semis') {
    return { table: 'db_intrants', items: intrants.filter(i => i.categorie === 'semences'), label: 'semence (ex. variété de betterave)' }
  }
  return null // Désherbage mécanique, Récolte, Irrigation… pas de base produit pertinente
}

// Les colonnes utilisées diffèrent entre db_phyto et db_intrants — centralisé
// ici pour ne pas re-brancher ces conditions table==='db_phyto' à chaque appelant.
export function productItemName(item, table) {
  return table === 'db_phyto' ? phytoDisplayName(item) : item.nom
}
export function productItemUnite(item, table) {
  return table === 'db_phyto' ? item.stock_unite : item.unite
}
export function productItemStock(item, table) {
  return table === 'db_phyto' ? item.stock_actuel : item.stock
}
