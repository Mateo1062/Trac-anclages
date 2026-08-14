import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import useIsMobile from '../lib/useIsMobile'
import { fmtDate } from '../lib/formatDate'

function monthKey(dateStr) { return (dateStr || '').slice(0, 7) }
function monthLabel(key) {
  if (!key) return '—'
  const [y, m] = key.split('-')
  return new Date(+y, +m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
}
// Durée d'un créneau "HH:MM" → "HH:MM", en heures décimales (0 si invalide/incomplet).
function slotHours(debut, fin) {
  if (!debut || !fin) return 0
  const [h1, m1] = debut.split(':').map(Number)
  const [h2, m2] = fin.split(':').map(Number)
  const mins = (h2 * 60 + m2) - (h1 * 60 + m1)
  return mins > 0 ? mins / 60 : 0
}
function totalCreneaux(creneaux) { return (creneaux || []).reduce((s, c) => s + slotHours(c.debut, c.fin), 0) }

export default function HeuresSalaries() {
  const { user, profile, canViewAllHeures } = useAuth()
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const [loading, setLoading] = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [entries, setEntries] = useState([])
  const [profiles, setProfiles] = useState([])
  const [viewUserId, setViewUserId] = useState(null) // null = moi-même
  const [editing, setEditing] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const { data, error } = await supabase.from('heures_salaries').select('*').order('date', { ascending: false })
    if (error) {
      if (/does not exist|relation|could not find/i.test(error.message)) setTableMissing(true)
      setLoading(false)
      return
    }
    setEntries(data || [])
    if (canViewAllHeures) {
      const { data: pr } = await supabase.from('profiles').select('id,display_name').order('display_name')
      setProfiles(pr || [])
    }
    setLoading(false)
  }

  const activeUserId = canViewAllHeures && viewUserId ? viewUserId : user?.id
  const visibleEntries = entries.filter(e => e.user_id === activeUserId).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  const byMonth = Object.values(visibleEntries.reduce((map, e) => {
    const key = monthKey(e.date)
    if (!map[key]) map[key] = { key, total: 0, rows: [] }
    map[key].total += e.heures || 0
    map[key].rows.push(e)
    return map
  }, {})).sort((a, b) => b.key.localeCompare(a.key))

  function openNew() {
    setEditing({ date: new Date().toISOString().split('T')[0], creneaux: [{ debut: '', fin: '' }], observation: '' })
  }
  function openEdit(e) {
    const creneaux = Array.isArray(e.creneaux) && e.creneaux.length ? e.creneaux : [{ debut: '', fin: '' }]
    setEditing({ ...e, creneaux })
  }
  function addCreneau() { setEditing(ed => ({ ...ed, creneaux: [...ed.creneaux, { debut: '', fin: '' }] })) }
  function removeCreneau(i) { setEditing(ed => ({ ...ed, creneaux: ed.creneaux.filter((_, idx) => idx !== i) })) }
  function updateCreneau(i, field, value) {
    setEditing(ed => ({ ...ed, creneaux: ed.creneaux.map((c, idx) => idx === i ? { ...c, [field]: value } : c) }))
  }

  async function save() {
    if (!editing.date) { alert('Date obligatoire.'); return }
    const creneaux = (editing.creneaux || []).filter(c => c.debut && c.fin)
    const invalide = creneaux.some(c => slotHours(c.debut, c.fin) <= 0)
    if (invalide) { alert("Un créneau a une heure de fin avant (ou égale à) l'heure de début — corrige-le."); return }
    const heures = +totalCreneaux(creneaux).toFixed(2)
    if (!heures || heures <= 0) { alert('Ajoute au moins un créneau horaire valide.'); return }
    const payload = { date: editing.date, heures, creneaux, observation: editing.observation || null, user_id: user.id }
    let error, data
    if (editing.id) {
      ;({ error } = await supabase.from('heures_salaries').update(payload).eq('id', editing.id))
    } else {
      ;({ data, error } = await supabase.from('heures_salaries').insert(payload).select().single())
    }
    if (error && /creneaux|column/i.test(error.message)) {
      const { creneaux: _c, ...fallback } = payload
      if (editing.id) { ({ error } = await supabase.from('heures_salaries').update(fallback).eq('id', editing.id)) }
      else { ({ data, error } = await supabase.from('heures_salaries').insert(fallback).select().single()) }
      if (!error) showToast('⚠️ Créneaux non sauvegardés (colonne manquante) — exécute migration_A_EXECUTER_36.sql')
    }
    if (error) { alert(error.message); return }
    if (editing.id) setEntries(prev => prev.map(x => x.id === editing.id ? { ...x, ...payload } : x))
    else setEntries(prev => [data, ...prev])
    setEditing(null)
    showToast('✅ Heures enregistrées')
  }

  async function del() {
    if (!confirm('Supprimer cette saisie ?')) return
    await supabase.from('heures_salaries').delete().eq('id', editing.id)
    setEntries(prev => prev.filter(x => x.id !== editing.id))
    setEditing(null)
    showToast('🗑️ Supprimée')
  }

  const isOwn = activeUserId === user?.id

  if (tableMissing) return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1.5rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>⏱️</div>
        <p style={{ fontSize: '.88rem', color: 'var(--text-muted)' }}>
          Table manquante — exécute <strong>migration_A_EXECUTER_34.sql</strong> dans Supabase → SQL Editor, puis recharge la page.
        </p>
      </div>
    </div>
  )
  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}
      <div style={{ background: 'white', borderBottom: '1px solid var(--border)', padding: isMobile ? '.8rem 1rem' : '.9rem 1.5rem', display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--ink)' }}>⏱️ Heures des salariés</h2>
        {canViewAllHeures && (
          <select value={viewUserId || user?.id} onChange={e => setViewUserId(e.target.value === user?.id ? null : e.target.value)} style={{ fontSize: '.82rem' }}>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.id === user?.id ? `${p.display_name} (moi)` : p.display_name}</option>)}
          </select>
        )}
        {isOwn && <button className="btn-sm primary" onClick={openNew} style={{ marginLeft: canViewAllHeures ? 0 : 'auto' }}>+ Saisir des heures</button>}
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '.8rem' : '1.2rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
        {!isOwn && (
          <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', background: 'var(--cream)', borderRadius: 8, padding: '.6rem .9rem' }}>
            👁️ Consultation seule — tu ne peux modifier que tes propres heures.
          </div>
        )}
        {byMonth.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
            Aucune heure saisie{isOwn ? ' — cliquez "+ Saisir des heures".' : '.'}
          </div>
        ) : byMonth.map(m => (
          <div key={m.key} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ background: 'var(--cream)', padding: '.6rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 700, fontSize: '.86rem', textTransform: 'capitalize' }}>{monthLabel(m.key)}</div>
              <div style={{ fontWeight: 700, fontSize: '.92rem', color: 'var(--green-mid)' }}>{m.total.toFixed(2)} h</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 420, fontSize: '.83rem', borderCollapse: 'collapse' }}>
                <tbody>
                  {m.rows.map(r => (
                    <tr key={r.id} onClick={() => isOwn && openEdit(r)} style={{ cursor: isOwn ? 'pointer' : 'default' }}
                      onMouseEnter={e => { if (isOwn) e.currentTarget.style.background = 'var(--green-pale)' }}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={{ padding: '.5rem .9rem', borderTop: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                      <td style={{ padding: '.5rem .9rem', borderTop: '1px solid var(--border)', fontWeight: 700, whiteSpace: 'nowrap' }}>{r.heures} h</td>
                      <td style={{ padding: '.5rem .9rem', borderTop: '1px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {Array.isArray(r.creneaux) && r.creneaux.length > 0
                          ? r.creneaux.filter(c => c.debut && c.fin).map(c => `${c.debut}–${c.fin}`).join(', ')
                          : ''}
                      </td>
                      <td style={{ padding: '.5rem .9rem', borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}>{r.observation || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier la saisie' : 'Saisir des heures'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={420}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
            <div className="form-group"><label>Date *</label><input type="date" value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} /></div>
            <div className="form-group">
              <label>Créneaux horaires *</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
                {editing.creneaux.map((c, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                    <input type="time" value={c.debut} onChange={e => updateCreneau(i, 'debut', e.target.value)} style={{ flex: 1 }} />
                    <span style={{ color: 'var(--text-muted)' }}>→</span>
                    <input type="time" value={c.fin} onChange={e => updateCreneau(i, 'fin', e.target.value)} style={{ flex: 1 }} />
                    {editing.creneaux.length > 1 && (
                      <button type="button" onClick={() => removeCreneau(i)} className="btn-sm" style={{ padding: '.3rem .5rem', color: 'var(--red)' }} title="Retirer ce créneau">✕</button>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" onClick={addCreneau} className="btn-sm" style={{ marginTop: '.5rem', fontSize: '.78rem' }}>
                + Ajouter un créneau (ex. après la pause déjeuner)
              </button>
              <div style={{ marginTop: '.6rem', fontSize: '.85rem', fontWeight: 700, color: 'var(--green-mid)' }}>
                Total : {totalCreneaux(editing.creneaux).toFixed(2)} h
              </div>
            </div>
            <div className="form-group"><label>Observation</label>
              <textarea rows={2} value={editing.observation || ''} onChange={e => setEditing({ ...editing, observation: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
