import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { ROLES, ROLE_LABELS } from '../../lib/permissions'
import Modal from '../../components/Modal'

export default function UtilisateursTab({ showToast }) {
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [pwTarget, setPwTarget] = useState(null) // { id, display_name } — utilisateur dont on réinitialise le mot de passe
  const [pwValue, setPwValue] = useState('')
  const [pwSaving, setPwSaving] = useState(false)

  async function resetPassword() {
    if (pwValue.length < 6) { alert('Le mot de passe doit faire au moins 6 caractères.'); return }
    setPwSaving(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/admin-set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ userId: pwTarget.id, newPassword: pwValue }),
    })
    const body = await res.json().catch(() => ({}))
    setPwSaving(false)
    if (!res.ok) { alert(body.error || 'Échec de la réinitialisation.'); return }
    showToast('✅ Mot de passe réinitialisé pour ' + (pwTarget.display_name || ''))
    setPwTarget(null)
    setPwValue('')
  }

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('profiles').select('*').order('display_name')
    setProfiles(data || [])
    setLoading(false)
  }

  async function changeRole(p, role) {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', p.id)
    if (error) { alert(error.message); return }
    setProfiles(prev => prev.map(x => x.id === p.id ? { ...x, role } : x))
    showToast('✅ Rôle mis à jour')
  }

  const [editingName, setEditingName] = useState(null) // { id, value }
  async function saveName() {
    const { id, value } = editingName
    const name = value.trim()
    if (!name) { setEditingName(null); return }
    const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', id)
    if (error) { alert(error.message); return }
    setProfiles(prev => prev.map(x => x.id === id ? { ...x, display_name: name } : x))
    setEditingName(null)
    showToast('✅ Nom mis à jour')
  }

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ padding: '1.4rem 1.8rem', flex: 1, overflow: 'auto' }}>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', minWidth: 400, fontSize: '.85rem', borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--cream)' }}>
            <tr>
              {['Utilisateur', 'Rôle', ''].map(h => (
                <th key={h} style={{ padding: '.7rem 1rem', textAlign: 'left', fontSize: '.72rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {profiles.map(p => (
              <tr key={p.id}>
                <td style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  {editingName?.id === p.id ? (
                    <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                      <input
                        autoFocus
                        value={editingName.value}
                        onChange={e => setEditingName({ id: p.id, value: e.target.value })}
                        onKeyDown={e => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditingName(null) }}
                        style={{ fontSize: '.85rem', padding: '.3rem .5rem', maxWidth: 180 }}
                      />
                      <button onClick={saveName} className="btn-sm primary" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>✓</button>
                      <button onClick={() => setEditingName(null)} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>✕</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                      <strong>{p.display_name || '–'}</strong>
                      <button onClick={() => setEditingName({ id: p.id, value: p.display_name || '' })}
                        title="Modifier le nom" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.8rem' }}>✏️</button>
                    </div>
                  )}
                </td>
                <td style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  <select value={p.role || 'operateur'} onChange={e => changeRole(p, e.target.value)} style={{ fontSize: '.82rem' }}>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
                  </select>
                </td>
                <td style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
                  <button className="btn-sm" onClick={() => { setPwTarget(p); setPwValue('') }} style={{ fontSize: '.76rem' }}>🔑 Mot de passe</button>
                </td>
              </tr>
            ))}
            {profiles.length === 0 && (
              <tr><td colSpan={3} style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>Aucun utilisateur.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pwTarget && (
        <Modal title={`🔑 Réinitialiser le mot de passe — ${pwTarget.display_name || ''}`}
          onClose={() => setPwTarget(null)} onSave={pwSaving ? null : resetPassword}
          saveLabel={pwSaving ? 'Enregistrement…' : 'Réinitialiser'} maxWidth={420}>
          <div className="form-group">
            <label>Nouveau mot de passe</label>
            <input type="password" autoFocus value={pwValue} onChange={e => setPwValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') resetPassword() }} placeholder="Au moins 6 caractères" />
          </div>
        </Modal>
      )}
    </div>
  )
}
