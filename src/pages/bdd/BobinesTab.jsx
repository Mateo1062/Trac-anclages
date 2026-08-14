import { useState, useRef } from 'react'
import { useSupabaseTable } from '../../lib/useSupabaseTable'
import Modal from '../../components/Modal'

/* Bobines de film pour les sacs de pommes de terre lavées (5/10/15/20 kg).
   La liste s'alimente à la main ou par import CSV ; la bobine se choisit
   ensuite sur les RDV planning cochés "Lavé". */

const FORMATS = ['5kg', '10kg', '15kg', '20kg', '25kg']

export default function BobinesTab({ showToast }) {
  const { items, create, update, remove, reload } = useSupabaseTable('db_bobines', 'reference')
  const [editing, setEditing] = useState(null)
  const fileRef = useRef(null)

  function openNew(format) { setEditing({ reference: '', format: format || '', client: '', description: '', stock: 0, vieille: false }) }
  function openEdit(item) { setEditing({ ...item }) }

  async function save() {
    if (!editing.reference?.trim()) { alert('La référence est obligatoire.'); return }
    try {
      if (editing.id) await update(editing.id, editing)
      else await create(editing)
      setEditing(null)
      showToast('✅ Bobine enregistrée')
    } catch (e) { alert(e.message) }
  }
  async function del() {
    if (!confirm('Supprimer cette bobine ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Bobine supprimée')
  }

  /* ── Import CSV : colonnes reference;format;client;description (entête
     facultative, séparateur ; ou , détecté automatiquement) ── */
  async function handleCsv(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const lines = text.split(/\r\n|\n/).map(l => l.trim()).filter(Boolean)
      if (!lines.length) { alert('Fichier vide.'); return }
      const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ','
      const cells = l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, ''))

      // entête ? on la reconnaît si la 1ère ligne contient "ref", "bobine" ou "format"
      let header = null, rows = lines
      if (/ref|bobine|format|client/i.test(lines[0])) { header = cells(lines[0]).map(h => h.toLowerCase()); rows = lines.slice(1) }
      const idx = key => header ? header.findIndex(h => h.includes(key)) : -1
      const iRef = header ? (idx('ref') !== -1 ? idx('ref') : idx('bobine') !== -1 ? idx('bobine') : idx('nom')) : 0
      const iFmt = header ? idx('format') : 1
      const iCli = header ? idx('client') : 2
      const iDes = header ? (idx('desc') !== -1 ? idx('desc') : idx('comment')) : 3
      const iSto = header ? (idx('stock') !== -1 ? idx('stock') : idx('quant')) : -1

      const toInsert = rows.map(l => {
        const c = cells(l)
        const fmtRaw = (iFmt >= 0 ? c[iFmt] : '') || ''
        const fmt = fmtRaw.replace(/\s|KG/gi, s => s.toUpperCase() === 'KG' ? 'kg' : '') // normalise "10 KG" -> "10kg"
        return {
          reference: iRef >= 0 ? c[iRef] : c[0],
          format: FORMATS.includes(fmt) ? fmt : fmtRaw || null,
          client: (iCli >= 0 ? c[iCli] : '') || null,
          description: (iDes >= 0 ? c[iDes] : '') || null,
          stock: iSto >= 0 ? (parseInt(c[iSto]) || 0) : 0,
        }
      }).filter(r => r.reference?.trim())

      if (!toInsert.length) { alert('Aucune bobine reconnue dans ce fichier.'); return }
      if (!confirm(`Importer ${toInsert.length} bobine(s) ?`)) return
      const { supabase } = await import('../../lib/supabase')
      let ok = 0
      for (let i = 0; i < toInsert.length; i += 200) {
        const { error } = await supabase.from('db_bobines').insert(toInsert.slice(i, i + 200))
        if (error) { alert(error.message); break }
        ok += toInsert.slice(i, i + 200).length
      }
      await reload()
      showToast(`✅ ${ok} bobine(s) importée(s)`)
    } catch (err) {
      alert('Erreur lecture CSV : ' + err.message)
    }
  }

  const byFormat = fmt => items.filter(i => (i.format || '') === fmt)
  const autres = items.filter(i => !FORMATS.includes(i.format || ''))

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.4rem 1.8rem' }}>
      <div style={{ display: 'flex', gap: '.6rem', marginBottom: '1.2rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn-sm primary" onClick={() => openNew('')}>+ Nouvelle bobine</button>
        <label className="btn-sm" style={{ cursor: 'pointer' }} title="CSV : reference;format;client;description (entête facultative)">
          📂 Importer CSV
          <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleCsv} />
        </label>
        <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{items.length} bobine(s)</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: '1.2rem' }}>
        {FORMATS.map(fmt => (
          <FormatBlock key={fmt} title={`Sacs ${fmt}`} items={byFormat(fmt)} onAdd={() => openNew(fmt)} onEdit={openEdit} />
        ))}
        {autres.length > 0 && <FormatBlock title="Autres formats" items={autres} onEdit={openEdit} />}
      </div>

      <div style={{ marginTop: '1.2rem', background: 'var(--green-pale)', borderRadius: 10, padding: '.9rem 1rem', fontSize: '.82rem', color: 'var(--green-mid)' }}>
        💡 Ces bobines apparaissent dans le planning : sur un RDV coché « 💧 Lavé », une liste permet de choisir la bobine du chargement.
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier la bobine' : 'Nouvelle bobine'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={420}>
          <div style={{ display: 'grid', gap: '.8rem' }}>
            <div className="form-group"><label>Référence *</label>
              <input autoFocus value={editing.reference} onChange={e => setEditing({ ...editing, reference: e.target.value })} placeholder="ex. AGATA 10kg Carrefour" /></div>
            <div className="form-group"><label>Format</label>
              <select value={editing.format || ''} onChange={e => setEditing({ ...editing, format: e.target.value })}>
                <option value="">—</option>
                {FORMATS.map(f => <option key={f}>{f}</option>)}
              </select></div>
            <div className="form-group"><label>Client / marque</label>
              <input value={editing.client || ''} onChange={e => setEditing({ ...editing, client: e.target.value })} /></div>
            <div className="form-group"><label>Description</label>
              <input value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
            <div className="form-group"><label>Stock (nb de bobines)</label>
              <input type="number" min="0" value={editing.stock ?? 0} onChange={e => setEditing({ ...editing, stock: parseInt(e.target.value) || 0 })} /></div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.85rem' }}>
              <input type="checkbox" checked={!!editing.vieille} onChange={e => setEditing({ ...editing, vieille: e.target.checked })} /> Vieille bobine
            </label>
          </div>
        </Modal>
      )}
    </div>
  )
}

function FormatBlock({ title, items, onAdd, onEdit }) {
  return (
    <div>
      <div style={{ fontSize: '.8rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-muted)', marginBottom: '.6rem' }}>
        🎞️ {title} <span style={{ fontWeight: 400 }}>({items.length})</span>
      </div>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
        {items.length === 0 ? (
          <div style={{ padding: '1.2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.82rem' }}>Aucune bobine</div>
        ) : (
          <table style={{ width: '100%', fontSize: '.84rem' }}>
            <tbody>
              {items.map(item => (
                <tr key={item.id} onClick={() => onEdit(item)} style={{ cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <td style={{ padding: '.55rem .9rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.6rem' }}>
                    <div>
                      <strong>{item.reference}</strong>{item.vieille && <span style={{ marginLeft: '.4rem', fontSize: '.68rem', color: 'var(--amber)', fontWeight: 700 }}>ANCIENNE</span>}
                      {(item.client || item.description) && (
                        <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{[item.client, item.description].filter(Boolean).join(' · ')}</div>
                      )}
                    </div>
                    {item.stock != null && (
                      <span style={{ fontSize: '.8rem', fontWeight: 700, color: item.stock > 0 ? 'var(--green-mid)' : 'var(--red)', flexShrink: 0 }}>{item.stock}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {onAdd && <button className="btn-sm" style={{ marginTop: '.5rem' }} onClick={onAdd}>+ Ajouter</button>}
    </div>
  )
}
