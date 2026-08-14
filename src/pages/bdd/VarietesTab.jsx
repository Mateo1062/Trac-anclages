import { useState } from 'react'
import { useSupabaseTable } from '../../lib/useSupabaseTable'
import { supabase } from '../../lib/supabase'
import DataTable from '../../components/DataTable'
import Modal from '../../components/Modal'

const EMPTY = { variete: '', lot: '', calibre: '', origine: '' }
const PALETTE = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a']

export default function VarietesTab({ showToast }) {
  const { items, create, update, remove } = useSupabaseTable('db_varietes', 'variete')
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)

  const filtered = items.filter(v =>
    v.variete.toLowerCase().includes(search.toLowerCase()) ||
    (v.lot || '').toLowerCase().includes(search.toLowerCase())
  )

  function openNew() { setEditing({ ...EMPTY }) }
  function openEdit(v) { setEditing({ ...v }) }

  // Auto-create a matching lot_fiche for the Frigos module when a new variety is created —
  // seulement si un lot est renseigné : une variété sans lot ne correspond à rien de
  // physique dans les frigos, elle n'a pas sa place dans la liste des fiches de lots.
  async function createMatchingFiche(v) {
    if (!v.lot?.trim()) return
    try {
      const { data: existing } = await supabase.from('lot_fiches').select('id').eq('variety', v.variete).eq('lot', v.lot).maybeSingle()
      if (existing) return
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)]
      await supabase.from('lot_fiches').insert({ variety: v.variete, lot: v.lot, palox: 1, color, date: new Date().toISOString().split('T')[0] })
    } catch (e) { console.warn('Fiche auto non créée:', e) }
  }

  async function save() {
    if (!editing.variete?.trim()) { alert('La variété est obligatoire.'); return }
    try {
      if (editing.id) {
        await update(editing.id, editing)
      } else {
        const created = await create(editing)
        await createMatchingFiche(created)
        showToast(created.lot?.trim() ? '✅ Variété enregistrée + fiche créée dans Frigos' : '✅ Variété enregistrée')
        setEditing(null)
        return
      }
      setEditing(null)
      showToast('✅ Variété enregistrée')
    } catch (e) { alert(e.message) }
  }
  async function del() {
    if (!confirm('Supprimer cette variété ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Supprimée')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'auto' }}>
      <div style={{ padding: '1rem 1.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem' }}>
        <input type="text" placeholder="🔍 Rechercher une variété ou un lot…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '.5rem .9rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', width: '100%', maxWidth: 300, flex: '1 1 200px', outline: 'none' }} />
        <button className="btn-sm primary" onClick={openNew}>+ Nouvelle variété / lot</button>
      </div>
      <div style={{ padding: '0 1.8rem 1.8rem' }}>
        <DataTable
          emptyMessage="Aucune variété enregistrée"
          onRowClick={openEdit}
          columns={[
            { key: 'variete', label: 'Variété', render: v => <strong>{v.variete}</strong> },
            { key: 'lot', label: 'N° Lot' },
            { key: 'calibre', label: 'Calibre' },
            { key: 'origine', label: 'Origine / Parcelle' },
          ]}
          rows={filtered}
        />
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier la variété' : 'Nouvelle variété / lot'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={460}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Variété *</label><input autoFocus value={editing.variete} onChange={e => setEditing({ ...editing, variete: e.target.value })} placeholder="ex. Bintje, Agria, Monalisa…" /></div>
            <div className="form-group"><label>N° de lot</label><input value={editing.lot || ''} onChange={e => setEditing({ ...editing, lot: e.target.value })} placeholder="LOT-2026-001" /></div>
            <div className="form-group">
              <label>Calibre</label>
              <select value={editing.calibre || ''} onChange={e => setEditing({ ...editing, calibre: e.target.value })}>
                <option value="">-- Non spécifié --</option>
                <option>28/35</option><option>35/45</option><option>45/55</option>
                <option>55/65</option><option>65/75</option><option>75+</option>
              </select>
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Parcelle / Origine</label><input value={editing.origine || ''} onChange={e => setEditing({ ...editing, origine: e.target.value })} placeholder="ex. Rosée Nord" /></div>
          </div>
          {!editing.id && (
            <div style={{ marginTop: '.8rem', padding: '.6rem .8rem', background: 'var(--green-pale)', borderRadius: 8, fontSize: '.78rem', color: 'var(--green-mid)' }}>
              💡 Une fiche de lot sera créée automatiquement pour pouvoir l'utiliser dans le module Frigos.
            </div>
          )}
        </Modal>
      )}
    </div>
  )
}
