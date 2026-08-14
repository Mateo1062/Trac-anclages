// Ordre personnalisé des onglets du menu principal — par poste (le choix d'un
// utilisateur ne doit pas changer le menu de tous les autres), stocké en local
// plutôt qu'en base : c'est une préférence d'affichage, pas une donnée métier.
const STORAGE_KEY = 'tracagri-nav-order-v1'

function readAll() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {} } catch { return {} }
}
function writeAll(all) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch {}
}

// order[workspaceKey][groupName] = [id, id, ...] dans l'ordre souhaité
export function getGroupOrder(workspaceKey, groupName) {
  return readAll()?.[workspaceKey]?.[groupName] || null
}
export function setGroupOrder(workspaceKey, groupName, orderedIds) {
  const all = readAll()
  all[workspaceKey] = all[workspaceKey] || {}
  all[workspaceKey][groupName] = orderedIds
  writeAll(all)
}

// Réordonne les items de chaque groupe selon l'ordre enregistré — les items pas
// encore connus (nouveauté ajoutée depuis) gardent leur position d'origine à la
// suite, plutôt que de disparaître silencieusement.
export function applyCustomOrder(groups, workspaceKey) {
  return groups.map(g => {
    const saved = getGroupOrder(workspaceKey, g.group)
    if (!saved) return g
    const byId = Object.fromEntries(g.items.map(i => [i.id, i]))
    const ordered = saved.map(id => byId[id]).filter(Boolean)
    const missing = g.items.filter(i => !saved.includes(i.id))
    return { ...g, items: [...ordered, ...missing] }
  })
}
