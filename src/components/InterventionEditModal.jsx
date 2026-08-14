import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from './Modal'

const INTERV_OPTIONS = ['Entretien préventif', 'Vidange', 'Réparation', 'Contrôle technique', 'Graissage', 'Remplacement pièce', 'Révision', 'Autre']

// Modal de modification/suppression d'une intervention déjà enregistrée (Outils
// agricoles ou Entretien global), réutilisable depuis n'importe quelle page qui
// affiche des interventions (Tableau de bord, TableauBordSalarie…) sans avoir à
// naviguer vers la page d'origine. Édition uniquement (pas de création) — les
// mêmes tables/logique que OutilsAgricoles.jsx / EntretienGlobal.jsx.
export default function InterventionEditModal({ type, intervention, profiles = [], hideCout = false, onClose, onSaved, onDeleted }) {
  const { user } = useAuth()
  const table = type === 'vehicule' ? 'interventions_vehicules' : type === 'batiment' ? 'interventions_batiments' : 'interventions_outils'
  // Les colonnes réelles diffèrent selon la table — voir OutilsAgricoles.jsx /
  // EntretienGlobal.jsx / BatimentsAgricoles.jsx, chacun son propre schéma.
  const supportsKilometrage = type !== 'batiment'
  const supportsHectares = type === 'outil'
  const supportsAFaire = type === 'outil'
  const supportsPhotos = type !== 'vehicule'
  const [m, setM] = useState({
    ...intervention,
    cout: intervention.cout ?? '', kilometrage: intervention.kilometrage ?? '', heures: intervention.heures ?? '',
    hectares: intervention.hectares ?? '', en_attente: !!intervention.en_attente, valide: intervention.valide !== false,
    a_faire: !!intervention.a_faire,
    photos: intervention.photos || [],
  })
  const [saving, setSaving] = useState(false)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'

  // En attente, Effectuée et À faire prochainement (outils uniquement, pas
  // encore sur interventions_vehicules) s'excluent mutuellement.
  function toggleEnAttente(v) { setM(prev => ({ ...prev, en_attente: v, valide: v ? false : prev.valide, a_faire: v ? false : prev.a_faire })) }
  function toggleValide(v) { setM(prev => ({ ...prev, valide: v, en_attente: v ? false : prev.en_attente, a_faire: v ? false : prev.a_faire })) }
  function toggleAFaire(v) { setM(prev => ({ ...prev, a_faire: v, en_attente: v ? false : prev.en_attente, valide: v ? false : prev.valide })) }

  // Photos — uniquement pour les interventions Outils agricoles (colonne absente
  // sur interventions_vehicules pour l'instant).
  async function handlePhotoFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setUploadingPhoto(true)
    for (const file of files) {
      const path = `${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`.replace(/\s+/g, '_')
      const { error } = await supabase.storage.from('intervention-photos').upload(path, file)
      if (error) {
        alert(/not found|bucket/i.test(error.message)
          ? "Bucket de stockage manquant — exécute migration_A_EXECUTER_49.sql dans Supabase → SQL Editor."
          : error.message)
        continue
      }
      const { data } = supabase.storage.from('intervention-photos').getPublicUrl(path)
      setM(prev => ({ ...prev, photos: [...(prev.photos || []), data.publicUrl] }))
    }
    setUploadingPhoto(false)
  }
  function removePhoto(url) { setM(prev => ({ ...prev, photos: (prev.photos || []).filter(p => p !== url) })) }

  async function save() {
    if (!m.description?.trim()) { alert('Description obligatoire.'); return }
    const wasValide = intervention.valide !== false
    const nowValide = !!m.valide
    const payload = {
      date: m.date, type_interv: m.type_interv || null, description: m.description,
      intervenant: m.intervenant || null,
      cout: parseFloat(m.cout) || null,
      ...(supportsKilometrage ? { kilometrage: parseFloat(m.kilometrage) || null } : {}),
      heures: parseFloat(m.heures) || null,
      ...(supportsHectares ? { hectares: parseFloat(m.hectares) || null } : {}),
      ...(supportsPhotos ? { photos: m.photos || [] } : {}),
      prochain_rdv: m.prochain_rdv || null,
      observation: m.observation || null,
      en_attente: !!m.en_attente,
      ...(supportsAFaire ? { a_faire: !!m.a_faire } : {}),
      valide: nowValide,
      updated_by: user?.id || null,
      valide_par: nowValide ? (wasValide ? intervention.valide_par : (user?.id || null)) : null,
      valide_le: nowValide ? (wasValide ? intervention.valide_le : new Date().toISOString()) : null,
    }
    setSaving(true)
    const { error } = await supabase.from(table).update(payload).eq('id', intervention.id)
    setSaving(false)
    if (error) { alert(error.message); return }
    onSaved?.({ ...intervention, ...payload })
    onClose()
  }

  async function del() {
    if (!confirm('Supprimer cette intervention ?')) return
    const { error } = await supabase.from(table).delete().eq('id', intervention.id)
    if (error) { alert(error.message); return }
    onDeleted?.(intervention.id)
    onClose()
  }

  return (
    <Modal title="Modifier l'intervention" onClose={onClose} onSave={saving ? null : save} saveLabel={saving ? 'Enregistrement…' : 'Enregistrer'} onDelete={del} maxWidth={500}>
      {(intervention.created_by || intervention.updated_by || intervention.valide_par) && (
        <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', background: 'var(--cream)', borderRadius: 8, padding: '.5rem .8rem', marginBottom: '.8rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {intervention.created_by && <span>👤 Créée par <strong>{nameOf(intervention.created_by)}</strong></span>}
          {intervention.updated_by && intervention.updated_by !== intervention.created_by && <span>✏️ Modifiée par <strong>{nameOf(intervention.updated_by)}</strong></span>}
          {intervention.valide_par && <span>✅ Validée par <strong>{nameOf(intervention.valide_par)}</strong></span>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
        <div className="form-group" style={{ gridColumn: '1/-1', display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
          {supportsAFaire && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!m.a_faire} onChange={e => toggleAFaire(e.target.checked)} style={{ width: 16, height: 16 }} />
              📋 À faire prochainement — planifiée, pas encore commencée
            </label>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!m.en_attente} onChange={e => toggleEnAttente(e.target.checked)} style={{ width: 16, height: 16 }} />
            ⏳ En attente — ne peut pas être faite dans l'immédiat
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
            <input type="checkbox" checked={!!m.valide} onChange={e => toggleValide(e.target.checked)} style={{ width: 16, height: 16 }} />
            ✅ Effectuée
          </label>
        </div>
        <div className="form-group"><label>Date *</label><input type="date" value={m.date || ''} onChange={e => setM({ ...m, date: e.target.value })} /></div>
        <div className="form-group">
          <label>Type d'intervention</label>
          <select value={m.type_interv || ''} onChange={e => setM({ ...m, type_interv: e.target.value })}>
            <option value="">—</option>
            {INTERV_OPTIONS.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Description *</label>
          <textarea rows={2} value={m.description || ''} onChange={e => setM({ ...m, description: e.target.value })}
            style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
        </div>
        <div className="form-group"><label>Intervenant / Entreprise</label><input value={m.intervenant || ''} onChange={e => setM({ ...m, intervenant: e.target.value })} /></div>
        {!hideCout && <div className="form-group"><label>Coût (€)</label><input type="number" step="0.01" value={m.cout} onChange={e => setM({ ...m, cout: e.target.value })} /></div>}
        {supportsKilometrage && (
          <div className="form-group"><label>Kilométrage relevé</label><input type="number" step="1" value={m.kilometrage} onChange={e => setM({ ...m, kilometrage: e.target.value })} /></div>
        )}
        <div className="form-group"><label>Nombre d'heures</label><input type="number" step="0.1" value={m.heures} onChange={e => setM({ ...m, heures: e.target.value })} /></div>
        {supportsHectares && (
          <div className="form-group"><label>Hectares travaillés</label><input type="number" step="0.01" value={m.hectares} onChange={e => setM({ ...m, hectares: e.target.value })} /></div>
        )}
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Prochain RDV d'entretien</label>
          <input type="date" value={m.prochain_rdv || ''} onChange={e => setM({ ...m, prochain_rdv: e.target.value })} />
        </div>
        <div className="form-group" style={{ gridColumn: '1/-1' }}>
          <label>Observation</label>
          <textarea rows={2} value={m.observation || ''} onChange={e => setM({ ...m, observation: e.target.value })}
            style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
        </div>
        {supportsPhotos && (
          <div className="form-group" style={{ gridColumn: '1/-1' }}>
            <label>📸 Photos</label>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.6rem' }}>
              <label className="btn-sm" style={{ cursor: 'pointer' }}>
                📷 Prendre une photo
                <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handlePhotoFiles} />
              </label>
              <label className="btn-sm" style={{ cursor: 'pointer' }}>
                📁 Depuis les fichiers
                <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handlePhotoFiles} />
              </label>
              {uploadingPhoto && <span style={{ fontSize: '.78rem', color: 'var(--text-muted)', alignSelf: 'center' }}>⏳ Envoi…</span>}
            </div>
            {(m.photos || []).length > 0 && (
              <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
                {m.photos.map((url, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    <a href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
                    </a>
                    <button type="button" onClick={() => removePhoto(url)} title="Retirer cette photo" style={{
                      position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%',
                      background: 'var(--red)', color: 'white', border: '2px solid white', cursor: 'pointer', fontSize: '.65rem', lineHeight: 1, padding: 0,
                    }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
