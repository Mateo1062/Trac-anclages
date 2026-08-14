// Regroupe des lignes interventions_phyto en "interventions" (une visite terrain =
// souvent plusieurs produits appliqués ensemble, ex. un mélange de 6-7 phytos).
// Heuristique : même date + même type (observation + sous_type, ex. Broyage vs
// Labour un même jour ne doivent pas se mélanger) = une seule intervention.
export function groupInterventions(items) {
  const groups = new Map()
  for (const it of items) {
    const key = `${it.date}|${it.observation || ''}|${it.sous_type || ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        date: it.date, type: it.observation || 'Intervention',
        sous_type: it.sous_type, defanage: it.defanage, remarque: it.remarque,
        fourrieres: it.fourrieres, rive: it.rive, items: [],
      })
    }
    groups.get(key).items.push(it)
  }
  return Array.from(groups.values())
}

export function sortGroupsByDateDesc(groups) {
  return groups.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))
}

export function sortGroupsByDateAsc(groups) {
  return groups.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''))
}

// Regroupe des lignes interventions_phyto en évènements terrain, TOUTES parcelles
// confondues (contrairement à groupInterventions ci-dessus, pensé pour une seule
// parcelle) — même date + même parcelle + même type (observation + sous_type) = un
// seul évènement, avec tous les produits utilisés en une fois (ex. plusieurs phytos
// mélangés) rattachés au même évènement plutôt qu'une ligne par produit. Utilisé par
// le tableau de bord (Dernières interventions).
export function groupInterventionsByEvent(items) {
  const groups = new Map()
  for (const it of items) {
    const key = `${it.date}|${it.parcelle_id || it.parcelle || ''}|${it.observation || ''}|${it.sous_type || ''}`
    if (!groups.has(key)) {
      groups.set(key, {
        date: it.date, parcelle: it.parcelle, parcelle_id: it.parcelle_id, culture: it.culture,
        observation: it.observation, sous_type: it.sous_type, defanage: it.defanage, remarque: it.remarque,
        fourrieres: it.fourrieres, rive: it.rive, items: [],
      })
    }
    groups.get(key).items.push(it)
  }
  return Array.from(groups.values())
}
