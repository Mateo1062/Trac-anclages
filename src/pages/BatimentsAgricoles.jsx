import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import PhotoLightbox from '../components/PhotoLightbox'
import useIsMobile from '../lib/useIsMobile'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { fmtDate } from '../lib/formatDate'

const INTERV_OPTIONS = ['Entretien préventif','Réparation','Nettoyage','Contrôle technique','Révision','Autre']

/* Bâtiment — même principe que Outils agricoles (une fiche par bâtiment,
   avec son historique d'interventions), en plus simple : pas de dossiers par
   type (les bâtiments eux-mêmes servent de sous-onglets dans la liste de
   gauche), pas de kilométrage/hectares (non pertinents pour un bâtiment). */
export default function BatimentsAgricoles() {
  const { perms, canViewCosts, user } = useAuth()
  const restreint = !!perms.outilsRestreint
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const { campagneActive, registerCampagnes } = useCampagne()
  const [batiments, setBatiments] = useState([])
  const [activeId, setActiveId]   = useState(null)
  const [interventions, setInterv] = useState([])
  const [profiles, setProfiles]   = useState([])
  const [batimentModal, setBatimentModal] = useState(null)
  const [intervModal, setIntervModal]     = useState(null)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)

  useEffect(() => { loadBatiments(); loadProfiles() }, [])
  useEffect(() => { if (activeId) loadInterv(activeId) }, [activeId, campagneActive])

  async function loadProfiles() {
    const { data } = await supabase.from('profiles').select('id,display_name')
    setProfiles(data || [])
  }
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'

  async function loadBatiments() {
    const { data } = await supabase.from('batiments_agricoles').select('*').order('nom')
    setBatiments(data || [])
    if (data?.length && !activeId) setActiveId(data[0].id)
  }
  async function loadInterv(id) {
    const { data } = await supabase.from('interventions_batiments').select('*').eq('batiment_id', id).order('date', { ascending: false })
    registerCampagnes([...new Set((data || []).map(i => i.campagne).filter(Boolean))])
    setInterv((data || []).filter(i => (i.campagne || defaultCampagne()) === campagneActive))
  }

  /* Bâtiment CRUD */
  function openNewBatiment() { setBatimentModal({ nom: '', notes: '' }) }
  function openEditBatiment(b) { setBatimentModal({ ...b }) }
  async function saveBatiment() {
    if (!batimentModal.nom?.trim()) { alert('Nom obligatoire.'); return }
    const payload = { ...batimentModal }
    delete payload.created_at
    if (batimentModal.id) {
      await supabase.from('batiments_agricoles').update(payload).eq('id', batimentModal.id)
      setBatiments(prev => prev.map(b => b.id === batimentModal.id ? { ...b, ...payload } : b))
    } else {
      const { data, error } = await supabase.from('batiments_agricoles').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setBatiments(prev => [...prev, data])
      setActiveId(data.id)
    }
    setBatimentModal(null)
    showToast('✅ Bâtiment enregistré')
  }
  async function deleteBatiment() {
    if (!confirm(`Supprimer "${batimentModal.nom}" et toutes ses interventions ?`)) return
    await supabase.from('interventions_batiments').delete().eq('batiment_id', batimentModal.id)
    await supabase.from('batiments_agricoles').delete().eq('id', batimentModal.id)
    setBatiments(prev => prev.filter(b => b.id !== batimentModal.id))
    if (activeId === batimentModal.id) setActiveId(null)
    setBatimentModal(null)
    showToast('🗑️ Bâtiment supprimé')
  }

  /* Intervention CRUD */
  function openNewInterv() {
    setIntervModal({ batiment_id: activeId, date: new Date().toISOString().split('T')[0], campagne: campagneActive, type_interv:'', description:'', intervenant:'', cout:'', heures:'', prochain_rdv:'', observation:'', en_attente:false, valide:true, photos:[] })
  }
  function openEditInterv(i) { setIntervModal({ ...i, cout: i.cout??'', heures: i.heures??'', en_attente: !!i.en_attente, valide: i.valide !== false, photos: i.photos || [] }) }
  function toggleEnAttente(v) { setIntervModal(m => ({ ...m, en_attente: v, valide: v ? false : m.valide })) }
  function toggleValide(v) { setIntervModal(m => ({ ...m, valide: v, en_attente: v ? false : m.en_attente })) }

  const [uploadingPhoto, setUploadingPhoto] = useState(false)
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
      setIntervModal(m => ({ ...m, photos: [...(m.photos || []), data.publicUrl] }))
    }
    setUploadingPhoto(false)
  }
  function removePhoto(url) {
    setIntervModal(m => ({ ...m, photos: (m.photos || []).filter(p => p !== url) }))
  }
  async function saveInterv() {
    if (!intervModal.description?.trim()) { alert('Description obligatoire.'); return }
    const existing = intervModal.id ? interventions.find(x => x.id === intervModal.id) : null
    const wasValide = existing ? existing.valide !== false : false
    const nowValide = !!intervModal.valide
    const payload = {
      ...intervModal,
      cout: parseFloat(intervModal.cout) || null,
      heures: parseFloat(intervModal.heures) || null,
      prochain_rdv: intervModal.prochain_rdv || null,
      en_attente: !!intervModal.en_attente,
      valide: nowValide,
      updated_by: user?.id || null,
      valide_par: nowValide ? (wasValide ? existing.valide_par : (user?.id || null)) : null,
      valide_le:  nowValide ? (wasValide ? existing.valide_le  : new Date().toISOString()) : null,
    }
    if (!intervModal.id) payload.created_by = user?.id || null
    delete payload.created_at
    if (intervModal.id) {
      let { error } = await supabase.from('interventions_batiments').update(payload).eq('id', intervModal.id)
      if (error) { alert(error.message); return }
      setInterv(prev => prev.map(i => i.id === intervModal.id ? { ...i, ...payload } : i))
    } else {
      let { data, error } = await supabase.from('interventions_batiments').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setInterv(prev => [data, ...prev])
    }
    setIntervModal(null)
    showToast('✅ Intervention enregistrée')
  }
  async function deleteInterv() {
    if (!confirm('Supprimer cette intervention ?')) return
    await supabase.from('interventions_batiments').delete().eq('id', intervModal.id)
    setInterv(prev => prev.filter(i => i.id !== intervModal.id))
    setIntervModal(null)
    showToast('🗑️ Supprimée')
  }

  const activeBatiment = batiments.find(b => b.id === activeId)

  const today = new Date().toISOString().split('T')[0]
  const upcoming = interventions.filter(i => i.prochain_rdv && i.prochain_rdv >= today).sort((a,b) => a.prochain_rdv.localeCompare(b.prochain_rdv))
  const lastHeures = interventions.find(i => i.heures != null)

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
      {ToastEl}

      {/* Left: liste des bâtiments — chacun sert de "sous-onglet" */}
      {(!isMobile || !activeBatiment) && (
      <div style={{ width: isMobile ? '100%' : 270, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', background:'white', flexShrink:0 }}>
        <div style={{ padding:'.9rem', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <h3 style={{ fontSize:'.95rem', fontWeight:700 }}>Bâtiment</h3>
          {!restreint && <button className="btn-sm primary" onClick={openNewBatiment} style={{ padding:'.35rem .7rem', fontSize:'.78rem' }}>+ Nouveau</button>}
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'.5rem' }}>
          {batiments.map(b => (
            <div key={b.id} onClick={() => setActiveId(b.id)} style={{
              padding:'.7rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3,
              background: activeId===b.id ? 'var(--green-pale)' : 'transparent',
              border: activeId===b.id ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
            }}
            onMouseEnter={e=>{ if(activeId!==b.id) e.currentTarget.style.background='#f5f5f5' }}
            onMouseLeave={e=>{ if(activeId!==b.id) e.currentTarget.style.background='transparent' }}>
              <div style={{ fontWeight:600, fontSize:'.88rem', color: activeId===b.id?'var(--green-mid)':'var(--text-main)' }}>
                🏢 {b.nom}
              </div>
            </div>
          ))}
          {batiments.length===0 && <div style={{ padding:'1rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.82rem' }}>Aucun bâtiment</div>}
        </div>
      </div>
      )}

      {/* Right: detail */}
      {(!isMobile || activeBatiment) && (
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {!activeBatiment ? (
          <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'3rem', marginBottom:'.5rem' }}>🏢</div>
              <p>Sélectionnez ou créez un bâtiment</p>
            </div>
          </div>
        ) : (<>
          <div style={{ background:'var(--green-deep)', padding:'1rem 1.5rem', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, flexWrap:'wrap', gap:'.6rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
              {isMobile && <button className="btn-sm" onClick={()=>setActiveId(null)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>← Retour</button>}
              <h2 style={{ color:'white', fontSize:'1.1rem', fontWeight:700 }}>🏢 {activeBatiment.nom}</h2>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'.7rem' }}>
              <span style={{ fontSize:'.72rem', color:'rgba(255,255,255,.5)', fontWeight:600 }}>🗓️ Interventions {campagneActive}</span>
              {!restreint && <button className="btn-sm" onClick={()=>openEditBatiment(activeBatiment)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>✏️ Modifier</button>}
              <button className="btn-sm primary" onClick={openNewInterv}>+ Intervention</button>
            </div>
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'1.2rem 1.5rem', display:'flex', flexDirection:'column', gap:'1.1rem' }}>
            {activeBatiment.notes && <div style={{ background:'var(--amber-pale)', border:'1px solid var(--amber)', borderRadius:8, padding:'.6rem .8rem', fontSize:'.82rem' }}>{activeBatiment.notes}</div>}

            {upcoming.length > 0 && (
              <div style={{ background:'var(--amber-pale)', border:'1px solid var(--amber)', borderRadius:10, padding:'.8rem 1rem' }}>
                <div style={{ fontWeight:700, fontSize:'.82rem', color:'var(--amber)', marginBottom:'.4rem' }}>⏰ Prochaines échéances</div>
                {upcoming.slice(0,3).map(i => (
                  <div key={i.id} style={{ fontSize:'.8rem', marginBottom:'.2rem' }}>
                    <strong>{i.prochain_rdv}</strong> — {i.type_interv || i.description}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:'.8rem' }}>
              <KpiCard label="Interventions" value={interventions.length} color="var(--green-mid)" />
              {interventions.some(i=>i.en_attente) && <KpiCard label="⏳ En attente" value={interventions.filter(i=>i.en_attente).length} color="var(--amber)" />}
              {interventions.some(i=>i.valide===false && !i.en_attente) && <KpiCard label="À faire" value={interventions.filter(i=>i.valide===false && !i.en_attente).length} color="var(--text-muted)" />}
              {canViewCosts && <KpiCard label="Coût total" value={(interventions.reduce((s,i)=>s+(i.cout||0),0)).toLocaleString('fr-FR',{minimumFractionDigits:2})+' €'} color="var(--blue)" />}
              <KpiCard label="Dernière intervention" value={interventions[0]?.date ? fmtDate(interventions[0].date) : '–'} color="var(--text-muted)" />
              <KpiCard label="Heures relevées" value={lastHeures ? lastHeures.heures.toLocaleString('fr-FR')+' h' : '–'} color="var(--amber)" />
            </div>

            {interventions.length === 0 ? (
              <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
                Aucune intervention enregistrée — cliquez "+ Intervention" pour commencer.
              </div>
            ) : (
              <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
                <table style={{ width:'100%', minWidth:820, fontSize:'.83rem', borderCollapse:'collapse' }}>
                  <thead style={{ background:'var(--cream)' }}>
                    <tr>
                      {['Statut','Date','Saisie à','Type','Description','Intervenant', ...(canViewCosts ? ['Coût'] : []), 'Heures','Prochain RDV','Obs.'].map(h=>(
                        <th key={h} style={{ padding:'.6rem .9rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {interventions.map(i => (
                      <tr key={i.id} onClick={()=>openEditInterv(i)} style={{ cursor:'pointer', background: i.en_attente ? 'var(--amber-pale)' : undefined }}
                        onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                        onMouseLeave={e=>e.currentTarget.style.background = i.en_attente ? 'var(--amber-pale)' : ''}>
                        <td style={td}>
                          {i.en_attente
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--amber)', color:'white', whiteSpace:'nowrap' }}>⏳ En attente</span>
                            : i.valide !== false
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--green-mid)', color:'white', whiteSpace:'nowrap' }}>✅ Effectuée</span>
                            : <span style={{ fontSize:'.68rem', color:'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={td}>{fmtDate(i.date)}</td>
                        <td style={td}>{i.created_at ? new Date(i.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}) : '–'}</td>
                        <td style={td}>{i.type_interv||'–'}</td>
                        <td style={{ ...td, maxWidth:200 }}>
                          <strong>{i.description}</strong>
                          {i.photos?.length > 0 && (
                            <button type="button" title={`Voir ${i.photos.length} photo(s)`}
                              onClick={e => { e.stopPropagation(); setLightboxPhotos(i.photos) }}
                              style={{ marginLeft:'.4rem', fontSize:'.78rem', background:'var(--green-pale)', border:'none', borderRadius:50, padding:'.05rem .45rem', cursor:'pointer' }}>
                              📷{i.photos.length > 1 ? ` ${i.photos.length}` : ''}
                            </button>
                          )}
                        </td>
                        <td style={td}>{i.intervenant||'–'}</td>
                        {canViewCosts && <td style={{...td, fontWeight:600}}>{i.cout!=null ? i.cout.toLocaleString('fr-FR',{minimumFractionDigits:2})+' €' : '–'}</td>}
                        <td style={td}>{i.heures!=null ? i.heures.toLocaleString('fr-FR')+' h' : '–'}</td>
                        <td style={td}>
                          {i.prochain_rdv
                            ? <span style={{ fontWeight:600, color: i.prochain_rdv<=today?'var(--red)':'var(--green-mid)' }}>{i.prochain_rdv}</span>
                            : '–'}
                        </td>
                        <td style={{ ...td, maxWidth:150, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{i.observation||'–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>)}
      </div>
      )}

      {/* Bâtiment modal */}
      {batimentModal && (
        <Modal title={batimentModal.id?'Modifier le bâtiment':'Nouveau bâtiment'} onClose={()=>setBatimentModal(null)} onSave={saveBatiment} onDelete={batimentModal.id?deleteBatiment:null} maxWidth={420}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            <div className="form-group">
              <label>Nom *</label>
              <input autoFocus value={batimentModal.nom} onChange={e=>setBatimentModal({...batimentModal,nom:e.target.value})} placeholder="ex. Station de lavage" />
            </div>
            <div className="form-group">
              <label>Notes</label>
              <textarea rows={2} value={batimentModal.notes||''} onChange={e=>setBatimentModal({...batimentModal,notes:e.target.value})}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* Intervention modal */}
      {intervModal && (
        <Modal title={intervModal.id?'Modifier l\'intervention':'Nouvelle intervention'} onClose={()=>setIntervModal(null)} onSave={saveInterv} onDelete={intervModal.id?deleteInterv:null} maxWidth={500}>
          {intervModal.id && (intervModal.created_by || intervModal.updated_by || intervModal.valide_par) && (
            <div style={{ fontSize:'.72rem', color:'var(--text-muted)', background:'var(--cream)', borderRadius:8, padding:'.5rem .8rem', marginBottom:'.8rem', display:'flex', flexDirection:'column', gap:2 }}>
              {intervModal.created_by && <span>👤 Créée par <strong>{nameOf(intervModal.created_by)}</strong></span>}
              {intervModal.updated_by && intervModal.updated_by !== intervModal.created_by && <span>✏️ Modifiée par <strong>{nameOf(intervModal.updated_by)}</strong></span>}
              {intervModal.valide_par && <span>✅ Validée par <strong>{nameOf(intervModal.valide_par)}</strong>{intervModal.valide_le ? ` le ${new Date(intervModal.valide_le).toLocaleDateString('fr-FR')}` : ''}</span>}
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1', display:'flex', gap:'1.2rem', flexWrap:'wrap' }}>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer' }}>
                <input type="checkbox" checked={!!intervModal.en_attente} onChange={e=>toggleEnAttente(e.target.checked)} style={{ width:16, height:16 }} />
                ⏳ En attente — ne peut pas être faite dans l'immédiat
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer' }}>
                <input type="checkbox" checked={!!intervModal.valide} onChange={e=>toggleValide(e.target.checked)} style={{ width:16, height:16 }} />
                ✅ Effectuée
              </label>
            </div>
            <div className="form-group"><label>Date *</label><input type="date" value={intervModal.date} onChange={e=>setIntervModal({...intervModal,date:e.target.value})} /></div>
            <div className="form-group">
              <label>Type d'intervention</label>
              <select value={intervModal.type_interv} onChange={e=>setIntervModal({...intervModal,type_interv:e.target.value})}>
                <option value="">—</option>
                {INTERV_OPTIONS.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Description *</label>
              <textarea rows={2} value={intervModal.description} onChange={e=>setIntervModal({...intervModal,description:e.target.value})}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
            <div className="form-group"><label>Intervenant / Entreprise</label><input value={intervModal.intervenant} onChange={e=>setIntervModal({...intervModal,intervenant:e.target.value})} placeholder="Nom ou société" /></div>
            {canViewCosts && <div className="form-group"><label>Coût (€)</label><input type="number" step="0.01" value={intervModal.cout} onChange={e=>setIntervModal({...intervModal,cout:e.target.value})} /></div>}
            <div className="form-group"><label>Nombre d'heures</label><input type="number" step="0.1" value={intervModal.heures} onChange={e=>setIntervModal({...intervModal,heures:e.target.value})} placeholder="ex. 3.5" /></div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Prochain RDV d'entretien</label>
              <input type="date" value={intervModal.prochain_rdv||''} onChange={e=>setIntervModal({...intervModal,prochain_rdv:e.target.value})} />
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Observation</label>
              <textarea rows={2} value={intervModal.observation} onChange={e=>setIntervModal({...intervModal,observation:e.target.value})}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>📸 Photos</label>
              <div style={{ display:'flex', gap:'.5rem', flexWrap:'wrap', marginBottom:'.6rem' }}>
                <label className="btn-sm" style={{ cursor:'pointer' }}>
                  📷 Prendre une photo
                  <input type="file" accept="image/*" capture="environment" style={{ display:'none' }} onChange={handlePhotoFiles} />
                </label>
                <label className="btn-sm" style={{ cursor:'pointer' }}>
                  📁 Depuis les fichiers
                  <input type="file" accept="image/*" multiple style={{ display:'none' }} onChange={handlePhotoFiles} />
                </label>
                {uploadingPhoto && <span style={{ fontSize:'.78rem', color:'var(--text-muted)', alignSelf:'center' }}>⏳ Envoi…</span>}
              </div>
              {(intervModal.photos || []).length > 0 && (
                <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap' }}>
                  {intervModal.photos.map((url, i) => (
                    <div key={i} style={{ position:'relative' }}>
                      <a href={url} target="_blank" rel="noreferrer">
                        <img src={url} alt="" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--border)', display:'block' }} />
                      </a>
                      <button type="button" onClick={() => removePhoto(url)} title="Retirer cette photo" style={{
                        position:'absolute', top:-6, right:-6, width:20, height:20, borderRadius:'50%',
                        background:'var(--red)', color:'white', border:'2px solid white', cursor:'pointer', fontSize:'.65rem', lineHeight:1, padding:0,
                      }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      {lightboxPhotos && <PhotoLightbox photos={lightboxPhotos} onClose={() => setLightboxPhotos(null)} />}
    </div>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem', textAlign:'center', borderTop:`3px solid ${color}` }}>
      <div style={{ fontSize:'.68rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.05em', marginBottom:'.2rem' }}>{label}</div>
      <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.3rem', color }}>{value}</div>
    </div>
  )
}

const td = { padding:'.65rem .9rem', borderBottom:'1px solid var(--border)' }
