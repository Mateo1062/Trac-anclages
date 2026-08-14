import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import Modal from './Modal'
import FloatingDropdown from './FloatingDropdown'
import PhotoLightbox from './PhotoLightbox'
import { phytoDisplayName } from '../lib/phytoNames'

const SOUS_TYPES_TRAVAIL_SOL = ['Déchaumage', 'Décompactage', 'Broyage', 'Labour', 'Écorouleau']

// Modal de modification d'une intervention champ (interventions_phyto) déjà
// enregistrée — un évènement (date + parcelle + type) regroupe souvent plusieurs
// lignes/produits (ex. mélange de plusieurs phytos), chacune une ligne de la
// table : on les modifie/ajoute/retire toutes ensemble ici, réutilisable depuis
// n'importe quelle page (Tableau de bord…) sans repasser par la Carte.
export default function InterventionChampEditModal({ event, onClose, onSaved, onDeleted, title, parcelleTargets }) {
  const { user } = useAuth()
  const [date, setDate] = useState(event.date || '')
  const [sousType, setSousType] = useState(event.sous_type || '')
  const [defanage, setDefanage] = useState(!!event.defanage)
  const [remarque, setRemarque] = useState(event.remarque || event.items?.[0]?.remarque || '')
  const [fourrieres, setFourrieres] = useState(!!(event.fourrieres ?? event.items?.[0]?.fourrieres))
  const [rive, setRive] = useState(!!(event.rive ?? event.items?.[0]?.rive))
  const [photos, setPhotos] = useState(event.photos || event.items?.[0]?.photos || [])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)
  const [lignes, setLignes] = useState(event.items.map(it => ({
    id: it.id, produit_nom: it.produit_nom || '', produit_id: it.produit_id ?? null,
    quantite: it.quantite ?? '', unite: it.unite || '',
  })))
  const [removedIds, setRemovedIds] = useState([])
  const [saving, setSaving] = useState(false)
  const [phytoProducts, setPhytoProducts] = useState([])
  const [intrants, setIntrants] = useState([])
  const [openDropdown, setOpenDropdown] = useState(null)
  const ligneInputRefs = useRef({})

  useEffect(() => { (async () => {
    const [{ data: phyto }, { data: intr }] = await Promise.all([
      supabase.from('db_phyto').select('id,nom,nom_secondaire'),
      supabase.from('db_intrants').select('id,nom'),
    ])
    setPhytoProducts(phyto || [])
    setIntrants(intr || [])
  })() }, [])

  function updateLigne(i, patch) { setLignes(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l)) }
  function addLigne() { setLignes(prev => [...prev, { id: null, produit_nom: '', produit_id: null, quantite: '', unite: '' }]) }
  function removeLigne(i) {
    setLignes(prev => {
      const l = prev[i]
      if (l.id) setRemovedIds(r => [...r, l.id])
      return prev.filter((_, idx) => idx !== i)
    })
  }
  function pickProduit(i, nom) {
    const match = [...phytoProducts, ...intrants].find(p => phytoDisplayName(p) === nom || p.nom === nom)
    updateLigne(i, { produit_nom: nom, produit_id: match?.id ?? null })
  }

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
      setPhotos(prev => [...prev, data.publicUrl])
    }
    setUploadingPhoto(false)
  }
  function removePhoto(url) { setPhotos(prev => prev.filter(p => p !== url)) }

  async function save() {
    if (!date) { alert('Date obligatoire.'); return }
    setSaving(true)
    const first = event.items[0]
    const shared = {
      date, sous_type: sousType || null, defanage: sousType === 'Broyage' ? defanage : null,
      remarque: remarque?.trim() || null, fourrieres, rive, photos: photos.length ? photos : null,
    }
    let missingCols = false
    const stripMissing = obj => { const { remarque, fourrieres, rive, photos, ...r } = obj; return r }

    for (const l of lignes.filter(l => l.id)) {
      const payload = {
        ...shared,
        produit_nom: l.produit_nom?.trim() || sousType || event.observation,
        produit_id: l.produit_id ?? null,
        quantite: l.quantite !== '' ? parseFloat(l.quantite) : null,
        unite: l.unite || null,
      }
      let { error } = await supabase.from('interventions_phyto').update(payload).eq('id', l.id)
      if (error && /remarque|fourrieres|\brive\b|photos/i.test(error.message)) {
        missingCols = true
        ;({ error } = await supabase.from('interventions_phyto').update(stripMissing(payload)).eq('id', l.id))
      }
      // produit_id ne peut référencer que Base de données > Phytosanitaires — un
      // produit choisi depuis Intrants (Ferti/Semis/Fertilisant…) n'a pas d'id valide
      // pour cette colonne : on retente sans lien plutôt que de bloquer l'enregistrement.
      if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
        ;({ error } = await supabase.from('interventions_phyto').update({ ...payload, produit_id: null }).eq('id', l.id))
      }
      if (error) { alert(error.message); setSaving(false); return }
    }

    const newLignes = lignes.filter(l => !l.id && l.produit_nom.trim())
    if (newLignes.length) {
      // Cible de création : une vraie parcelle par défaut (celle du premier
      // produit de l'évènement), ou TOUTES les parcelles du groupe si cet
      // évènement est affiché depuis une vue fusionnée (voir Parcelles.jsx) —
      // sinon un produit ajouté depuis cette vue n'atterrirait que sur une
      // seule des vraies parcelles du groupe, invisible pour les autres.
      const targets = parcelleTargets?.length
        ? parcelleTargets
        : [{ id: first.parcelle_id, nom: first.parcelle, culture: first.culture, campagne: first.campagne }]
      const rows = targets.flatMap(t => newLignes.map(l => ({
        ...shared,
        produit_id: l.produit_id ?? null, produit_nom: l.produit_nom.trim(),
        quantite: l.quantite !== '' ? parseFloat(l.quantite) : null, unite: l.unite || null,
        culture: t.culture, parcelle: t.nom, parcelle_id: t.id,
        observation: event.observation, campagne: t.campagne, user_id: user?.id || null,
      })))
      let { error } = await supabase.from('interventions_phyto').insert(rows)
      if (error && /remarque|fourrieres|\brive\b|photos/i.test(error.message)) {
        missingCols = true
        ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(stripMissing)))
      }
      if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
        ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(r => ({ ...r, produit_id: null }))))
      }
      if (error) { alert(error.message); setSaving(false); return }
    }
    if (missingCols) alert("Colonnes remarque/fourrières/rive manquantes — exécute migration_A_EXECUTER_69.sql dans Supabase → SQL Editor pour pouvoir enregistrer ces informations.")

    if (removedIds.length) {
      const { error } = await supabase.from('interventions_phyto').delete().in('id', removedIds)
      if (error) { alert(error.message); setSaving(false); return }
    }

    setSaving(false)
    onSaved?.()
    onClose()
  }

  async function delAll() {
    if (!confirm('Supprimer toute cette intervention (tous les produits) ?')) return
    const ids = event.items.map(it => it.id)
    const { error } = await supabase.from('interventions_phyto').delete().in('id', ids)
    if (error) { alert(error.message); return }
    onDeleted?.(ids)
    onClose()
  }

  return (
    <>
    <Modal title={title || `Modifier — ${event.parcelle || 'Parcelle supprimée'}`} onClose={onClose}
      onSave={saving ? null : save} saveLabel={saving ? 'Enregistrement…' : 'Enregistrer'} onDelete={delAll} maxWidth={560}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem', marginBottom: '1.1rem' }}>
        <div className="form-group"><label>Date *</label><input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
        <div className="form-group"><label>Type d'intervention</label><input value={event.observation || ''} disabled /></div>
        {event.observation === 'Travail du sol' && (
          <div className="form-group"><label>Sous-type</label>
            <select value={sousType} onChange={e => { setSousType(e.target.value); if (e.target.value !== 'Broyage') setDefanage(false) }}>
              <option value="">-- Choisir --</option>
              {SOUS_TYPES_TRAVAIL_SOL.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {sousType === 'Broyage' && (
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={defanage} onChange={e => setDefanage(e.target.checked)} />
              Défanage effectué au même passage
            </label>
          </div>
        )}
        <div className="form-group">
          <label>Zone de la parcelle concernée</label>
          <div style={{ display: 'flex', gap: '1.2rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={fourrieres} onChange={e => setFourrieres(e.target.checked)} />
              Fourrières
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={rive} onChange={e => setRive(e.target.checked)} />
              Rive
            </label>
          </div>
        </div>
      </div>

      <div className="form-group" style={{ marginBottom: '1.1rem' }}>
        <label>Observation</label>
        <textarea rows={2} value={remarque} onChange={e => setRemarque(e.target.value)}
          placeholder="ex. conditions météo, remarque particulière…"
          style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
      </div>

      <div style={{ marginBottom: '.5rem', fontSize: '.8rem', fontWeight: 700, color: 'var(--text-muted)' }}>Produits</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '.8rem' }}>
        {lignes.map((l, i) => {
          const q = l.produit_nom.trim().toLowerCase()
          const matches = q.length > 0
            ? [...phytoProducts.map(p => ({ id: p.id, nom: phytoDisplayName(p) })), ...intrants.map(p => ({ id: p.id, nom: p.nom }))]
                .filter(p => p.nom.toLowerCase().includes(q)).slice(0, 8)
            : []
          return (
            // Nom du produit sur sa propre ligne pleine largeur — sur une seule
            // ligne avec quantité/unité, le champ produit devenait trop étroit
            // pour lire un nom complet une fois saisi (surtout mobile).
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem' }}>
              <div style={{ position: 'relative' }}>
                <input ref={el => (ligneInputRefs.current[i] = el)} style={{ width: '100%' }} value={l.produit_nom}
                  onChange={e => { pickProduit(i, e.target.value); setOpenDropdown(i) }}
                  onFocus={() => setOpenDropdown(i)}
                  onBlur={() => setTimeout(() => setOpenDropdown(cur => cur === i ? null : cur), 200)}
                  placeholder="Produit" />
                {openDropdown === i && matches.length > 0 && (
                  <FloatingDropdown anchorRef={{ current: ligneInputRefs.current[i] }}>
                    {matches.map(p => (
                      <div key={p.id} onMouseDown={() => { pickProduit(i, p.nom); setOpenDropdown(null) }}
                        style={{ padding: '.5rem .8rem', cursor: 'pointer', fontSize: '.82rem', borderBottom: '1px solid var(--border)' }}>
                        {p.nom}
                      </div>
                    ))}
                  </FloatingDropdown>
                )}
              </div>
              <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                <input style={{ flex: 1, minWidth: 0 }} type="number" step="0.01" value={l.quantite}
                  onChange={e => updateLigne(i, { quantite: e.target.value })} placeholder="Qté" />
                <input style={{ flex: 1, minWidth: 0 }} value={l.unite} onChange={e => updateLigne(i, { unite: e.target.value })} placeholder="Unité" />
                <button type="button" onClick={() => removeLigne(i)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red,#c0392b)', fontSize: '.95rem', flexShrink: 0 }}>✕</button>
              </div>
            </div>
          )
        })}
        {lignes.length === 0 && <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucun produit — ajoutez-en un ou enregistrez sans produit.</div>}
        <button type="button" className="btn-sm" style={{ alignSelf: 'flex-start' }} onClick={addLigne}>+ Ajouter un produit</button>
      </div>

      <div className="form-group">
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
        {photos.length > 0 && (
          <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
            {photos.map((url, i) => (
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
    </Modal>
    {lightboxPhotos && <PhotoLightbox photos={lightboxPhotos} onClose={() => setLightboxPhotos(null)} />}
    </>
  )
}
