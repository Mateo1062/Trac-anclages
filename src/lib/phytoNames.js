// Nom à afficher/enregistrer pour un produit phyto (db_phyto) : le nom de
// référence EPHY ("nom") sert à l'homologation, mais l'utilisateur achète
// souvent le produit sous un autre nom commercial ("nom_secondaire") — c'est
// CE nom qu'il tape et qu'il veut revoir partout hors Base de données, avec
// le nom de référence entre parenthèses seulement s'il diffère.
export function phytoDisplayName(p) {
  if (!p) return ''
  const nom = (p.nom || '').trim()
  const sec = (p.nom_secondaire || '').trim()
  if (sec && sec.toLowerCase() !== nom.toLowerCase()) return `${sec} (${nom})`
  return nom
}

// Un produit correspond à la recherche s'il matche le nom principal OU le nom
// secondaire — sinon un produit enregistré sous son nom EPHY reste introuvable
// pour qui tape son nom commercial usuel.
export function phytoMatches(p, query) {
  const q = (query || '').trim().toLowerCase()
  if (!q) return true
  return (p.nom || '').toLowerCase().includes(q) || (p.nom_secondaire || '').toLowerCase().includes(q)
}
