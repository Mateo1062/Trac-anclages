import { useState } from 'react'
import { useSupabaseTable } from '../../lib/useSupabaseTable'
import Modal from '../../components/Modal'

export default function ChargementsTab({ showToast }) {
  const { items, create, update, remove } = useSupabaseTable('db_chargements', 'libelle')
  const [editing, setEditing] = useState(null) // { id?, libelle, description, type }

  const chargements = items.filter(i => i.type === 'chargement')
  const palettes = items.filter(i => i.type === 'palette')

  function openNew(type) { setEditing({ libelle: '', description: '', type }) }
  function openEdit(item) { setEditing({ ...item }) }

  async function save() {
    if (!editing.libelle?.trim()) { alert('Le libellé est obligatoire.'); return }
    try {
      if (editing.id) await update(editing.id, editing)
      else await create(editing)
      setEditing(null)
      showToast('✅ Enregistré')
    } catch (e) { alert(e.message) }
  }
  async function del() {
    if (!confirm('Supprimer ce type ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Supprimé')
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.4rem 1.8rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '2rem' }}>
        <ListBlock title="Types de chargement" items={chargements} onAdd={() => openNew('chargement')} onEdit={openEdit} />
        <ListBlock title="Types de palette" items={palettes} onAdd={() => openNew('palette')} onEdit={openEdit} />
      </div>
      <div style={{ marginTop: '1.2rem', background: 'var(--green-pale)', borderRadius: 10, padding: '.9rem 1rem', fontSize: '.82rem', color: 'var(--green-mid)' }}>
        💡 Ces types apparaissent dans les listes déroulantes du planning et des fiches frigo.
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier' : `Nouveau ${editing.type === 'palette' ? 'type de palette' : 'type de chargement'}`} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={400}>
          <div style={{ display: 'grid', gap: '.8rem' }}>
            <div className="form-group"><label>Libellé *</label><input autoFocus value={editing.libelle} onChange={e => setEditing({ ...editing, libelle: e.target.value })} placeholder="ex. Vrac, Big-bag, Europe 80×120…" /></div>
            <div className="form-group"><label>Description / Dimensions</label><input value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function ListBlock({ title, items, onAdd, onEdit }) {
  return (
    <div>
      <div style={{ fontSize: '.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', marginBottom: '.6rem' }}>{title}</div>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {items.length === 0 ? (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.85rem' }}>Aucun type</div>
        ) : (
          <table style={{ width: '100%', fontSize: '.85rem' }}>
            <tbody>
              {items.map(item => (
                <tr key={item.id} onClick={() => onEdit(item)} style={{ cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <td style={{ padding: '.6rem 1rem', borderBottom: '1px solid var(--border)' }}><strong>{item.libelle}</strong></td>
                  <td style={{ padding: '.6rem 1rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{item.description || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <button className="btn-sm" style={{ marginTop: '.6rem' }} onClick={onAdd}>+ Ajouter</button>
    </div>
  )
}
