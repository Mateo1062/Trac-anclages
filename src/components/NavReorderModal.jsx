import { useState } from 'react'
import Modal from './Modal'
import { setGroupOrder } from '../lib/navOrder'

// Réordonnancement du menu principal — flèches haut/bas plutôt qu'un
// glisser-déposer, pour rester fiable au doigt sur mobile (voir la règle du
// projet : dropdown/accordéon plutôt que des interactions fragiles au tactile).
export default function NavReorderModal({ workspaceKey, groups, onClose, onSaved }) {
  const [localGroups, setLocalGroups] = useState(() => groups.map(g => ({ group: g.group, items: [...g.items] })))

  function move(groupIdx, itemIdx, dir) {
    setLocalGroups(prev => {
      const next = prev.map(g => ({ ...g, items: [...g.items] }))
      const items = next[groupIdx].items
      const target = itemIdx + dir
      if (target < 0 || target >= items.length) return prev
      ;[items[itemIdx], items[target]] = [items[target], items[itemIdx]]
      return next
    })
  }

  function save() {
    localGroups.forEach(g => setGroupOrder(workspaceKey, g.group, g.items.map(i => i.id)))
    onSaved()
    onClose()
  }

  return (
    <Modal title="↕️ Réorganiser le menu" onClose={onClose} onSave={save} saveLabel="Enregistrer" maxWidth={440}>
      <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
        Les flèches déplacent un onglet dans sa catégorie.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', maxHeight: '55vh', overflowY: 'auto' }}>
        {localGroups.map((g, gi) => (
          <div key={g.group}>
            <div style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--text-muted)', marginBottom: '.4rem' }}>{g.group}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
              {g.items.map((item, ii) => (
                <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', background: 'var(--cream)', borderRadius: 8, padding: '.5rem .5rem .5rem .8rem', minHeight: 44 }}>
                  <span style={{ flex: 1, fontSize: '.85rem', fontWeight: 600 }}>{item.label}</span>
                  <button disabled={ii === 0} onClick={() => move(gi, ii, -1)} style={{
                    width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.1rem', borderRadius: 8, border: '1.5px solid var(--border)', background: 'white',
                    color: 'var(--ink)', cursor: ii === 0 ? 'default' : 'pointer', opacity: ii === 0 ? .35 : 1,
                  }}>↑</button>
                  <button disabled={ii === g.items.length - 1} onClick={() => move(gi, ii, 1)} style={{
                    width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.1rem', borderRadius: 8, border: '1.5px solid var(--border)', background: 'white',
                    color: 'var(--ink)', cursor: ii === g.items.length - 1 ? 'default' : 'pointer', opacity: ii === g.items.length - 1 ? .35 : 1,
                  }}>↓</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
