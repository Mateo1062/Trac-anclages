import { useState } from 'react'
import { supabase } from '../lib/supabase'
import Modal from './Modal'

// Changement de son propre mot de passe — self-service, ne nécessite que la
// session de l'utilisateur connecté (supabase.auth.updateUser), pas de droits
// spéciaux. Pour changer le mot de passe d'un AUTRE utilisateur, voir
// UtilisateursTab.jsx (nécessite la clé service_role côté serveur).
export default function ChangePasswordModal({ onClose }) {
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (pw1.length < 6) { alert('Le mot de passe doit faire au moins 6 caractères.'); return }
    if (pw1 !== pw2) { alert('Les deux mots de passe ne correspondent pas.'); return }
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password: pw1 })
    setSaving(false)
    if (error) { alert(error.message); return }
    alert('✅ Mot de passe changé')
    onClose()
  }

  return (
    <Modal title="🔑 Changer mon mot de passe" onClose={onClose} onSave={saving ? null : save} saveLabel={saving ? 'Enregistrement…' : 'Enregistrer'} maxWidth={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
        <div className="form-group">
          <label>Nouveau mot de passe</label>
          <input type="password" autoFocus value={pw1} onChange={e => setPw1(e.target.value)} placeholder="Au moins 6 caractères" />
        </div>
        <div className="form-group">
          <label>Confirmer le nouveau mot de passe</label>
          <input type="password" value={pw2} onChange={e => setPw2(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save() }} />
        </div>
      </div>
    </Modal>
  )
}
