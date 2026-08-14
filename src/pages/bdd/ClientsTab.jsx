import { useState } from 'react'
import { useSupabaseTable } from '../../lib/useSupabaseTable'
import DataTable from '../../components/DataTable'
import Modal from '../../components/Modal'

const EMPTY = { nom: '', adresse: '', code_postal: '', ville: '', pays: 'France', telephone: '', email: '' }

export default function ClientsTab({ showToast }) {
  const { items, create, update, remove } = useSupabaseTable('clients', 'nom')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)

  const filtered = items.filter(c => c.nom.toLowerCase().includes(search.toLowerCase()))

  function openNew() { setEditing({ ...EMPTY }) }
  function openEdit(c) { setEditing({ ...c }) }

  async function save() {
    if (!editing.nom?.trim()) { alert('Le nom est obligatoire.'); return }
    try {
      if (editing.id) await update(editing.id, editing)
      else await create(editing)
      setEditing(null)
      showToast('✅ Client enregistré')
    } catch (e) { alert(e.message) }
  }
  async function del() {
    if (!confirm('Supprimer ce client ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Client supprimé')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '1rem 1.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem' }}>
        <input type="text" placeholder="🔍 Rechercher un client…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '.5rem .9rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', width: '100%', maxWidth: 300, flex: '1 1 200px', outline: 'none' }} />
        <button className="btn-sm primary" onClick={openNew}>+ Nouveau client</button>
      </div>
      <div style={{ padding: '0 1.8rem 1.8rem' }}>
        <DataTable
          emptyMessage="Aucun client enregistré"
          onRowClick={openEdit}
          columns={[
            { key: 'nom', label: 'Nom', render: c => <strong>{c.nom}</strong> },
            { key: 'adresse', label: 'Adresse' },
            { key: 'code_postal', label: 'CP' },
            { key: 'ville', label: 'Ville' },
            { key: 'pays', label: 'Pays' },
          ]}
          rows={filtered}
        />
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier le client' : 'Nouveau client'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={500}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Nom *</label><input autoFocus value={editing.nom} onChange={e => setEditing({ ...editing, nom: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Adresse</label><input value={editing.adresse || ''} onChange={e => setEditing({ ...editing, adresse: e.target.value })} /></div>
            <div className="form-group"><label>Code postal</label><input value={editing.code_postal || ''} onChange={e => setEditing({ ...editing, code_postal: e.target.value })} /></div>
            <div className="form-group"><label>Ville</label><input value={editing.ville || ''} onChange={e => setEditing({ ...editing, ville: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Pays</label><input value={editing.pays || ''} onChange={e => setEditing({ ...editing, pays: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Téléphone</label><input value={editing.telephone || ''} onChange={e => setEditing({ ...editing, telephone: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Email</label><input value={editing.email || ''} onChange={e => setEditing({ ...editing, email: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </div>
  )
}
