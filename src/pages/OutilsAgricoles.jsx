import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import PhotoLightbox from '../components/PhotoLightbox'
import useIsMobile from '../lib/useIsMobile'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { Rows, fmtDateFull } from '../components/DashboardUI'

const TYPE_OPTIONS = ['Tracteur','Pulvérisateur','Semoir','Épandeur','Charrue','Déchaumeur','Décompacteur','Broyeur','Bineuse','Planteuse','Enrouleur','Arracheuse','Plateau','Benne','Télescopique','Autre']
const INTERV_OPTIONS = ['Entretien préventif','Vidange','Réparation','Contrôle technique','Graissage','Remplacement pièce','Révision','Autre']
const SANS_TYPE = 'Sans type'
const TYPE_ICON = {
  'Tracteur':'🚜','Pulvérisateur':'💦','Semoir':'🌱','Épandeur':'🧂','Charrue':'⚒️',
  'Déchaumeur':'🔩','Décompacteur':'⛏️','Broyeur':'🌾','Bineuse':'🌿','Planteuse':'🌱','Enrouleur':'💧','Arracheuse':'🥔','Plateau':'🚚','Benne':'🚛','Télescopique':'🏗️','Autre':'🔧',
  [SANS_TYPE]:'📦',
}

const PAGE_TABS = [
  { key: 'materiel', label: '🚜 Matériel' },
  { key: 'commande', label: '🛒 Commande' },
]

export default function OutilsAgricoles() {
  const { perms, canSeePrix, canViewCosts, user } = useAuth()
  const restreint = !!perms.outilsRestreint // pas d'édition dossier, ajout d'intervention uniquement (indépendant de canViewCosts, qui masque uniquement le champ Coût)
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const { campagneActive, registerCampagnes } = useCampagne()
  const [pageTab, setPageTab]       = useState('materiel')
  const [outils, setOutils]         = useState([])
  const [activeType, setActiveType] = useState(null) // dossier par type d'outil (tracteur, pulvérisateur…)
  const [activeId, setActiveId]     = useState(null)
  const [interventions, setInterv]  = useState([])
  const [profiles, setProfiles]     = useState([]) // pour afficher qui a créé/modifié/validé
  const [search, setSearch]         = useState('')
  const [outilModal, setOutilModal] = useState(null)
  const [intervModal, setIntervModal] = useState(null)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)

  useEffect(() => { loadOutils(); loadProfiles() }, [])
  // Le matériel (outils_agricoles) est permanent ; l'historique d'interventions,
  // lui, repart à vide à chaque changement de campagne.
  useEffect(() => { if (activeId) loadInterv(activeId) }, [activeId, campagneActive])

  async function loadProfiles() {
    const { data } = await supabase.from('profiles').select('id,display_name')
    setProfiles(data || [])
  }
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'

  async function loadOutils() {
    const { data } = await supabase.from('outils_agricoles').select('*').order('nom')
    setOutils(data || [])
  }
  async function loadInterv(id) {
    // Fetch TOUTES les interventions de l'outil puis filtre côté client : un
    // .eq('campagne', X) côté serveur exclurait celles dont campagne est encore
    // NULL (colonne ajoutée après coup) — même convention que Céréales/CoutRevient.
    const { data } = await supabase.from('interventions_outils').select('*').eq('outil_id', id).order('date', { ascending: false })
    registerCampagnes([...new Set((data || []).map(i => i.campagne).filter(Boolean))])
    setInterv((data || []).filter(i => (i.campagne || defaultCampagne()) === campagneActive))
  }

  /* Outil CRUD */
  function openNewOutil() { setOutilModal({ nom:'', type: (activeType && activeType!==SANS_TYPE) ? activeType : '', marque:'', modele:'', num_serie:'', annee:'', cout_ha:'', notes:'' }) }
  function openEditOutil(o) { setOutilModal({ ...o, cout_ha: o.cout_ha ?? '' }) }
  async function saveOutil() {
    if (!outilModal.nom?.trim()) { alert('Nom obligatoire.'); return }
    const payload = { ...outilModal, annee: outilModal.annee ? parseInt(outilModal.annee) : null, cout_ha: outilModal.cout_ha !== '' ? parseFloat(outilModal.cout_ha) : null }
    delete payload.created_at
    if (outilModal.id) {
      await supabase.from('outils_agricoles').update(payload).eq('id', outilModal.id)
      setOutils(prev => prev.map(o => o.id===outilModal.id ? {...o,...payload} : o))
    } else {
      const { data, error } = await supabase.from('outils_agricoles').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setOutils(prev => [...prev, data])
      setActiveId(data.id)
    }
    setOutilModal(null)
    showToast('✅ Outil enregistré')
  }
  async function deleteOutil() {
    if (!confirm(`Supprimer "${outilModal.nom}" et toutes ses interventions ?`)) return
    await supabase.from('interventions_outils').delete().eq('outil_id', outilModal.id)
    await supabase.from('outils_agricoles').delete().eq('id', outilModal.id)
    setOutils(prev => prev.filter(o => o.id!==outilModal.id))
    if (activeId===outilModal.id) setActiveId(null)
    setOutilModal(null)
    showToast('🗑️ Outil supprimé')
  }

  /* Intervention CRUD */
  function openNewInterv() {
    setIntervModal({ outil_id: activeId, date: new Date().toISOString().split('T')[0], campagne: campagneActive, type_interv:'', description:'', intervenant:'', cout:'', kilometrage:'', heures:'', hectares:'', prochain_rdv:'', prochaine_vidange_heures:'', observation:'', en_attente:false, valide:true, a_faire:false, photos:[] })
  }
  function openEditInterv(i) { setIntervModal({ ...i, cout: i.cout??'', kilometrage: i.kilometrage??'', heures: i.heures??'', hectares: i.hectares??'', prochaine_vidange_heures: i.prochaine_vidange_heures??'', en_attente: !!i.en_attente, valide: i.valide !== false, a_faire: !!i.a_faire, photos: i.photos || [] }) }
  // En attente, Effectuée et À faire prochainement s'excluent mutuellement — trois
  // statuts distincts : "en attente" = bloqué (pièce manquante...), "à faire
  // prochainement" = planifié mais pas encore commencé, "effectuée" = fait.
  function toggleEnAttente(v) { setIntervModal(m => ({ ...m, en_attente: v, valide: v ? false : m.valide, a_faire: v ? false : m.a_faire })) }
  function toggleValide(v) { setIntervModal(m => ({ ...m, valide: v, en_attente: v ? false : m.en_attente, a_faire: v ? false : m.a_faire })) }
  function toggleAFaire(v) { setIntervModal(m => ({ ...m, a_faire: v, en_attente: v ? false : m.en_attente, valide: v ? false : m.valide })) }

  // Photos jointes à l'intervention — prises en direct ou choisies depuis les
  // fichiers du téléphone. Uploadées immédiatement (bucket public dédié), avant
  // même l'enregistrement de l'intervention elle-même.
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  async function handlePhotoFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // permet de reprendre exactement la même photo juste après
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
    // valide_par/valide_le ne sont (re)posés que lors du passage effectif à
    // "Effectuée" — une simple modification d'un autre champ, sur une
    // intervention déjà validée, ne doit pas réattribuer la validation à
    // celui qui vient de modifier autre chose.
    const existing = intervModal.id ? interventions.find(x => x.id === intervModal.id) : null
    const wasValide = existing ? existing.valide !== false : false
    const nowValide = !!intervModal.valide
    const payload = {
      ...intervModal,
      cout: parseFloat(intervModal.cout)||null,
      kilometrage: parseFloat(intervModal.kilometrage)||null,
      heures: parseFloat(intervModal.heures)||null,
      hectares: parseFloat(intervModal.hectares)||null,
      prochain_rdv: intervModal.prochain_rdv || null,
      prochaine_vidange_heures: parseFloat(intervModal.prochaine_vidange_heures)||null,
      en_attente: !!intervModal.en_attente,
      a_faire: !!intervModal.a_faire,
      valide: nowValide,
      updated_by: user?.id || null,
      valide_par: nowValide ? (wasValide ? existing.valide_par : (user?.id || null)) : null,
      valide_le:  nowValide ? (wasValide ? existing.valide_le  : new Date().toISOString()) : null,
    }
    if (!intervModal.id) payload.created_by = user?.id || null
    delete payload.created_at
    if (intervModal.id) {
      let { error } = await supabase.from('interventions_outils').update(payload).eq('id', intervModal.id)
      if (error && /en_attente|valide|created_by|updated_by|valide_par|valide_le|photos|campagne|prochaine_vidange_heures|a_faire|column/i.test(error.message)) {
        const { campagne, en_attente, valide, created_by, updated_by, valide_par, valide_le, photos, prochaine_vidange_heures, a_faire, ...fallback } = payload
        ;({ error } = await supabase.from('interventions_outils').update(fallback).eq('id', intervModal.id))
      }
      if (error) { alert(error.message); return }
      setInterv(prev => prev.map(i => i.id===intervModal.id ? {...i,...payload} : i))
    } else {
      let { data, error } = await supabase.from('interventions_outils').insert(payload).select().single()
      if (error && /en_attente|valide|created_by|updated_by|valide_par|valide_le|photos|campagne|prochaine_vidange_heures|a_faire|column/i.test(error.message)) {
        const { campagne, en_attente, valide, created_by, updated_by, valide_par, valide_le, photos, prochaine_vidange_heures, a_faire, ...fallback } = payload
        ;({ data, error } = await supabase.from('interventions_outils').insert(fallback).select().single())
      }
      if (error) { alert(error.message); return }
      setInterv(prev => [data, ...prev])
    }
    setIntervModal(null)
    showToast('✅ Intervention enregistrée')
  }
  async function deleteInterv() {
    if (!confirm('Supprimer cette intervention ?')) return
    await supabase.from('interventions_outils').delete().eq('id', intervModal.id)
    setInterv(prev => prev.filter(i => i.id!==intervModal.id))
    setIntervModal(null)
    showToast('🗑️ Supprimée')
  }

  const activeOutil = outils.find(o => o.id===activeId)
  const typeOf = o => o.type?.trim() || SANS_TYPE
  const filtered = outils
    .filter(o => !activeType || typeOf(o) === activeType)
    .filter(o => o.nom.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr', { sensitivity: 'base' }))
  // Dossiers par type — un dossier par type déjà utilisé (+ les types prédéfinis même vides, pour pouvoir y ranger direct)
  const usedTypes = [...new Set(outils.map(typeOf))]
  const folderTypes = [...new Set([...TYPE_OPTIONS, ...usedTypes])]
    .filter(t => usedTypes.includes(t) || TYPE_OPTIONS.includes(t))
  const folders = folderTypes.map(t => ({ type: t, count: outils.filter(o => typeOf(o) === t).length }))
    .filter(f => f.count > 0 || TYPE_OPTIONS.includes(f.type))
    .sort((a, b) => a.type.localeCompare(b.type, 'fr'))

  /* Next interventions alert */
  const today = new Date().toISOString().split('T')[0]
  const upcoming = interventions.filter(i => i.prochain_rdv && i.prochain_rdv >= today).sort((a,b) => a.prochain_rdv.localeCompare(b.prochain_rdv))

  /* Derniers relevés (interventions triées par date desc) */
  const lastKm      = interventions.find(i => i.kilometrage != null)
  const lastHeures   = interventions.find(i => i.heures != null)
  const lastHectares = interventions.find(i => i.hectares != null)
  // Prochaine vidange (en heures moteur, pas une date) — la plus récemment
  // renseignée fait foi ; reste calculé par rapport au dernier relevé d'heures.
  const nextVidange = interventions.find(i => i.prochaine_vidange_heures != null)
  const resteVidange = nextVidange && lastHeures ? +(nextVidange.prochaine_vidange_heures - lastHeures.heures).toFixed(1) : null

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {ToastEl}

      {/* Tabs */}
      <div className="tab-scroll-fade" style={{ background:'white', borderBottom:'2px solid var(--border)', display:'flex', gap:'.1rem', padding:'0 1.5rem', flexShrink:0, overflowX:'auto' }}>
        {PAGE_TABS.map(t => (
          <button key={t.key} onClick={()=>setPageTab(t.key)} style={{
            padding:'.55rem 1.1rem', background:'none', border:'none', whiteSpace:'nowrap',
            borderBottom: pageTab===t.key ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor:'pointer', fontSize:'.84rem', fontWeight: pageTab===t.key ? 700 : 500,
            color: pageTab===t.key ? 'var(--green-mid)' : 'var(--text-muted)',
            marginBottom:-2, transition:'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {pageTab === 'commande' && (
        <CommandeTab outils={outils} restreint={restreint} showToast={showToast} canSeePrix={canSeePrix} />
      )}

      {pageTab === 'materiel' && (
      <div style={{ display:'flex', flex:1, overflow:'hidden' }}>

      {/* Left: dossiers par type, puis outils du dossier — sur mobile, masqué une fois un outil sélectionné */}
      {(!isMobile || !activeOutil) && (
      <div style={{ width: isMobile ? '100%' : 270, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', background:'white', flexShrink:0 }}>
        {!activeType ? (
          <>
            <div style={{ padding:'.9rem', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <h3 style={{ fontSize:'.95rem', fontWeight:700 }}>Outils agricoles</h3>
              {!restreint && <button className="btn-sm primary" onClick={openNewOutil} style={{ padding:'.35rem .7rem', fontSize:'.78rem' }}>+ Nouveau</button>}
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:'.5rem' }}>
              {folders.map(f => (
                <div key={f.type} onClick={()=>setActiveType(f.type)} style={{
                  padding:'.7rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3,
                  display:'flex', alignItems:'center', gap:'.6rem', border:'1.5px solid transparent',
                }}
                onMouseEnter={e=>e.currentTarget.style.background='#f5f5f5'}
                onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                  <span style={{ fontSize:'1.3rem' }}>{TYPE_ICON[f.type] || '📁'}</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:600, fontSize:'.86rem' }}>{f.type}</div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{f.count} outil{f.count>1?'s':''}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding:'.9rem', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:'.5rem' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <button className="btn-sm" onClick={()=>{ setActiveType(null); setSearch('') }} style={{ padding:'.3rem .6rem', fontSize:'.76rem' }}>← Dossiers</button>
                {!restreint && <button className="btn-sm primary" onClick={openNewOutil} style={{ padding:'.35rem .7rem', fontSize:'.78rem' }}>+ Nouveau</button>}
              </div>
              <div style={{ fontWeight:700, fontSize:'.9rem', display:'flex', alignItems:'center', gap:'.4rem' }}>
                <span>{TYPE_ICON[activeType] || '📁'}</span> {activeType}
              </div>
              <input type="text" placeholder="🔍 Rechercher…" value={search} onChange={e=>setSearch(e.target.value)}
                style={{ padding:'.45rem .8rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.82rem', outline:'none' }} />
            </div>
            <div style={{ flex:1, overflowY:'auto', padding:'.5rem' }}>
              {filtered.map(o => (
                <div key={o.id} onClick={()=>setActiveId(o.id)} style={{
                  padding:'.7rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3,
                  background: activeId===o.id ? 'var(--green-pale)' : 'transparent',
                  border: activeId===o.id ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
                }}
                onMouseEnter={e=>{ if(activeId!==o.id) e.currentTarget.style.background='#f5f5f5' }}
                onMouseLeave={e=>{ if(activeId!==o.id) e.currentTarget.style.background='transparent' }}>
                  <div style={{ fontWeight:600, fontSize:'.88rem', color: activeId===o.id?'var(--green-mid)':'var(--text-main)' }}>
                    {o.nom}
                  </div>
                  <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:2 }}>
                    {[o.marque, o.modele, o.annee].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))}
              {filtered.length===0 && <div style={{ padding:'1rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.82rem' }}>Aucun outil</div>}
            </div>
          </>
        )}
      </div>
      )}

      {/* Right: detail — on mobile, only shown once a tool is selected */}
      {(!isMobile || activeOutil) && (
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {!activeOutil ? (
          <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'3rem', marginBottom:'.5rem' }}>🚜</div>
              <p>Sélectionnez ou créez un outil agricole</p>
            </div>
          </div>
        ) : (<>
          {/* Header */}
          <div style={{ background:'var(--green-deep)', padding:'1rem 1.5rem', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0, flexWrap:'wrap', gap:'.6rem' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
              {isMobile && <button className="btn-sm" onClick={()=>setActiveId(null)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>← Retour</button>}
              <div>
                <h2 style={{ color:'white', fontSize:'1.1rem', fontWeight:700 }}>{activeOutil.nom}</h2>
                <span style={{ color:'rgba(255,255,255,.5)', fontSize:'.78rem' }}>
                  {[activeOutil.type, activeOutil.marque, activeOutil.modele, activeOutil.annee].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'.7rem' }}>
              <span style={{ fontSize:'.72rem', color:'rgba(255,255,255,.5)', fontWeight:600 }}>🗓️ Interventions {campagneActive}</span>
              {!restreint && <button className="btn-sm" onClick={()=>openEditOutil(activeOutil)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>✏️ Modifier</button>}
              <button className="btn-sm primary" onClick={openNewInterv}>+ Intervention</button>
            </div>
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'1.2rem 1.5rem', display:'flex', flexDirection:'column', gap:'1.1rem' }}>
            {/* Outil info chips */}
            <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap' }}>
              {[['Type', activeOutil.type],['Marque', activeOutil.marque],['Modèle', activeOutil.modele],['N° série', activeOutil.num_serie],['Année', activeOutil.annee], ...(canSeePrix ? [['Coût/ha', activeOutil.cout_ha != null ? `${activeOutil.cout_ha} €` : null]] : [])].filter(([,v])=>v).map(([k,v]) => (
                <div key={k} style={{ background:'white', border:'1px solid var(--border)', borderRadius:8, padding:'.4rem .7rem', fontSize:'.82rem' }}>
                  <div style={{ color:'var(--text-muted)', fontSize:'.7rem', textTransform:'uppercase' }}>{k}</div>
                  <div style={{ fontWeight:600 }}>{v}</div>
                </div>
              ))}
              {activeOutil.notes && <div style={{ background:'var(--amber-pale)', border:'1px solid var(--amber)', borderRadius:8, padding:'.4rem .7rem', fontSize:'.82rem', flex:1 }}>{activeOutil.notes}</div>}
            </div>

            {/* Prochaines interventions à effectuer — planifiées (date de RDV ou seuil
                d'heures moteur), une catégorie à part de "⏳ En attente" (qui reflète un
                blocage ponctuel signalé à la main, pas une échéance à venir prévisible). */}
            {(upcoming.length > 0 || nextVidange) && (
              <div style={{
                background: nextVidange && resteVidange != null && resteVidange <= 0 ? '#fdf0ef' : 'var(--amber-pale)',
                border: `1px solid ${nextVidange && resteVidange != null && resteVidange <= 0 ? 'var(--red)' : 'var(--amber)'}`,
                borderRadius: 10, padding: '.8rem 1rem',
              }}>
                <div style={{ fontWeight:700, fontSize:'.82rem', color: nextVidange && resteVidange != null && resteVidange <= 0 ? 'var(--red)' : 'var(--amber)', marginBottom:'.4rem' }}>
                  📅 Prochaines interventions à effectuer
                </div>
                {upcoming.slice(0,3).map(i => (
                  <div key={i.id} style={{ fontSize:'.8rem', marginBottom:'.2rem' }}>
                    <strong>{i.prochain_rdv}</strong> — {i.type_interv || i.description}
                  </div>
                ))}
                {nextVidange && (
                  <div style={{ fontSize:'.8rem', marginTop: upcoming.length > 0 ? '.4rem' : 0 }}>
                    🛢️ <strong>Vidange à {nextVidange.prochaine_vidange_heures.toLocaleString('fr-FR')} h</strong> —{' '}
                    {resteVidange != null
                      ? (resteVidange <= 0
                          ? <strong style={{ color:'var(--red)' }}>dépassée de {Math.abs(resteVidange).toLocaleString('fr-FR')} h (dernier relevé {lastHeures.heures.toLocaleString('fr-FR')} h)</strong>
                          : `reste ${resteVidange.toLocaleString('fr-FR')} h (dernier relevé ${lastHeures.heures.toLocaleString('fr-FR')} h)`)
                      : 'aucun relevé d\'heures pour l\'instant'}
                  </div>
                )}
              </div>
            )}

            {/* KPIs */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:'.8rem' }}>
              <KpiCard label="Interventions" value={interventions.length} color="var(--green-mid)" />
              {interventions.some(i=>i.en_attente) && <KpiCard label="⏳ En attente" value={interventions.filter(i=>i.en_attente).length} color="var(--amber)" />}
              {interventions.some(i=>i.a_faire) && <KpiCard label="📋 À faire prochainement" value={interventions.filter(i=>i.a_faire).length} color="var(--blue, #2563eb)" />}
              {canViewCosts && <KpiCard label="Coût total" value={(interventions.reduce((s,i)=>s+(i.cout||0),0)).toLocaleString('fr-FR',{minimumFractionDigits:2})+' €'} color="var(--blue)" />}
              <KpiCard label="Dernière intervention" value={interventions[0]?.date ? fmtDateFull(interventions[0].date) : '–'} color="var(--text-muted)" />
              <KpiCard label="Kilométrage relevé" value={lastKm ? lastKm.kilometrage.toLocaleString('fr-FR')+' km' : '–'} color="var(--amber)" />
              <KpiCard label="Heures relevées" value={lastHeures ? lastHeures.heures.toLocaleString('fr-FR')+' h' : '–'} color="var(--amber)" />
              <KpiCard label="Hectares travaillés" value={lastHectares ? lastHectares.hectares.toLocaleString('fr-FR')+' ha' : '–'} color="var(--amber)" />
            </div>

            {/* Interventions — liste compacte cliquable sur mobile (le tableau large
                ne s'utilise bien qu'au clavier/souris), tableau détaillé sur ordinateur.
                Dans les deux cas, cliquer une intervention l'ouvre pour modification. */}
            {interventions.length === 0 ? (
              <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
                Aucune intervention enregistrée — cliquez "+ Intervention" pour commencer.
              </div>
            ) : isMobile ? (
              <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'.3rem .5rem' }}>
                <Rows onPhotos={setLightboxPhotos} rows={interventions.map(i => ({
                  date: fmtDateFull(i.date),
                  main: [i.type_interv, i.description].filter(Boolean).join(' · ') || '—',
                  badge: i.en_attente ? '⏳ en attente' : i.a_faire ? '📋 à faire prochainement' : (i.valide !== false ? '✅ effectuée' : null),
                  badgeBg: i.en_attente ? 'var(--amber-pale)' : i.a_faire ? '#dbeafe' : 'var(--green-pale)',
                  badgeColor: i.en_attente ? 'var(--amber)' : i.a_faire ? 'var(--blue, #2563eb)' : 'var(--green-mid)',
                  right: (canViewCosts && i.cout != null) ? `${i.cout.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} €` : null,
                  photos: i.photos,
                  onClick: () => openEditInterv(i),
                }))} />
              </div>
            ) : (
              <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
                <table style={{ width:'100%', minWidth:960, fontSize:'.83rem', borderCollapse:'collapse' }}>
                  <thead style={{ background:'var(--cream)' }}>
                    <tr>
                      {['Statut','Date','Saisie à','Type','Description','Intervenant', ...(canViewCosts ? ['Coût'] : []), 'Km','Heures','Ha','Prochain RDV','Obs.'].map(h=>(
                        <th key={h} style={{ padding:'.6rem .9rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {interventions.map(i => (
                      <tr key={i.id} onClick={()=>openEditInterv(i)} style={{ cursor:'pointer', background: i.en_attente ? 'var(--amber-pale)' : i.a_faire ? '#dbeafe' : undefined }}
                        onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                        onMouseLeave={e=>e.currentTarget.style.background = i.en_attente ? 'var(--amber-pale)' : i.a_faire ? '#dbeafe' : ''}>
                        <td style={td}>
                          {i.en_attente
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--amber)', color:'white', whiteSpace:'nowrap' }}>⏳ En attente</span>
                            : i.a_faire
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--blue, #2563eb)', color:'white', whiteSpace:'nowrap' }}>📋 À faire prochainement</span>
                            : i.valide !== false
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--green-mid)', color:'white', whiteSpace:'nowrap' }}>✅ Effectuée</span>
                            : <span style={{ fontSize:'.68rem', color:'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={td}>{fmtDateFull(i.date)}</td>
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
                        <td style={td}>{i.kilometrage!=null ? i.kilometrage.toLocaleString('fr-FR')+' km' : '–'}</td>
                        <td style={td}>{i.heures!=null ? i.heures.toLocaleString('fr-FR')+' h' : '–'}</td>
                        <td style={td}>{i.hectares!=null ? i.hectares.toLocaleString('fr-FR')+' ha' : '–'}</td>
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
      </div>
      )}

      {/* Outil modal */}
      {outilModal && (
        <Modal title={outilModal.id?'Modifier l\'outil':'Nouvel outil agricole'} onClose={()=>setOutilModal(null)} onSave={saveOutil} onDelete={outilModal.id?deleteOutil:null} maxWidth={480}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Nom *</label>
              <input autoFocus value={outilModal.nom} onChange={e=>setOutilModal({...outilModal,nom:e.target.value})} placeholder="ex. Claas Axion 960" />
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={outilModal.type} onChange={e=>setOutilModal({...outilModal,type:e.target.value})}>
                <option value="">—</option>
                {TYPE_OPTIONS.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Marque</label><input value={outilModal.marque} onChange={e=>setOutilModal({...outilModal,marque:e.target.value})} /></div>
            <div className="form-group"><label>Modèle</label><input value={outilModal.modele} onChange={e=>setOutilModal({...outilModal,modele:e.target.value})} /></div>
            <div className="form-group"><label>N° de série</label><input value={outilModal.num_serie} onChange={e=>setOutilModal({...outilModal,num_serie:e.target.value})} /></div>
            <div className="form-group"><label>Année</label><input type="number" value={outilModal.annee} onChange={e=>setOutilModal({...outilModal,annee:e.target.value})} placeholder="2020" /></div>
            {canSeePrix && (
              <div className="form-group">
                <label>Coût / ha (€)</label>
                <input type="number" step="0.01" value={outilModal.cout_ha} onChange={e=>setOutilModal({...outilModal,cout_ha:e.target.value})} placeholder="ex. 25" />
              </div>
            )}
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Notes</label>
              <textarea rows={2} value={outilModal.notes} onChange={e=>setOutilModal({...outilModal,notes:e.target.value})}
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
                <input type="checkbox" checked={!!intervModal.a_faire} onChange={e=>toggleAFaire(e.target.checked)} style={{ width:16, height:16 }} />
                📋 À faire prochainement — planifiée, pas encore commencée
              </label>
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
            <div className="form-group"><label>Kilométrage relevé</label><input type="number" step="1" value={intervModal.kilometrage} onChange={e=>setIntervModal({...intervModal,kilometrage:e.target.value})} placeholder="ex. 12500" /></div>
            <div className="form-group"><label>Nombre d'heures</label><input type="number" step="0.1" value={intervModal.heures} onChange={e=>setIntervModal({...intervModal,heures:e.target.value})} placeholder="ex. 850.5" /></div>
            <div className="form-group"><label>Hectares travaillés</label><input type="number" step="0.01" value={intervModal.hectares} onChange={e=>setIntervModal({...intervModal,hectares:e.target.value})} placeholder="ex. 45.20" /></div>
            <div className="form-group"><label>Prochain RDV d'entretien</label>
              <input type="date" value={intervModal.prochain_rdv||''} onChange={e=>setIntervModal({...intervModal,prochain_rdv:e.target.value})} />
            </div>
            <div className="form-group"><label>Heures pour la prochaine vidange</label>
              <input type="number" step="0.1" value={intervModal.prochaine_vidange_heures} onChange={e=>setIntervModal({...intervModal,prochaine_vidange_heures:e.target.value})} placeholder="ex. 1000" />
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

/* ── Onglet Commande : pièces à commander, rattachées à un outil précis ou
   classées "Autre" si ce n'est pas pour un outil agricole. ── */
const COMMANDE_STATUTS = [
  { key: 'en_attente', label: 'En attente', color: 'var(--amber)' },
  { key: 'commande',   label: 'Commandée', color: 'var(--blue, #2563eb)' },
  { key: 'recue',      label: 'Reçue',     color: 'var(--green-mid)' },
]
const STATUT_LABEL = Object.fromEntries(COMMANDE_STATUTS.map(s => [s.key, s.label]))
const STATUT_COLOR = Object.fromEntries(COMMANDE_STATUTS.map(s => [s.key, s.color]))

function CommandeTab({ outils, restreint, showToast, canSeePrix }) {
  const [commandes, setCommandes] = useState([])
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState(null)
  const [filterStatut, setFilterStatut] = useState('all')
  const [filterCat, setFilterCat] = useState('all')
  const [tableMissing, setTableMissing] = useState(false)

  useEffect(() => { load() }, [])
  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('outils_pieces_commande').select('*').order('created_at', { ascending: false })
    if (error && /does not exist|relation|could not find the table/i.test(error.message)) setTableMissing(true)
    setCommandes(data || [])
    setLoading(false)
  }

  function openNew() {
    setEditing({
      nom: '', categorie: 'autre', outil_id: '', quantite: '', fournisseur: '',
      prix_estime: '', statut: 'en_attente', date_demande: new Date().toISOString().split('T')[0],
      date_commande: '', date_reception: '', observation: '',
    })
  }
  function openEdit(c) { setEditing({ ...c, quantite: c.quantite ?? '', prix_estime: c.prix_estime ?? '', outil_id: c.outil_id || '' }) }

  async function save() {
    if (!editing.nom?.trim()) { alert('Le nom de la pièce est obligatoire.'); return }
    const payload = {
      nom: editing.nom.trim(),
      categorie: editing.categorie === 'outil' ? 'outil' : 'autre',
      outil_id: editing.categorie === 'outil' ? (editing.outil_id || null) : null,
      quantite: parseFloat(editing.quantite) || null,
      fournisseur: editing.fournisseur || null,
      prix_estime: parseFloat(editing.prix_estime) || null,
      statut: editing.statut || 'en_attente',
      date_demande: editing.date_demande || null,
      date_commande: editing.statut !== 'en_attente' ? (editing.date_commande || null) : null,
      date_reception: editing.statut === 'recue' ? (editing.date_reception || null) : null,
      observation: editing.observation || null,
    }
    if (editing.id) {
      const { error } = await supabase.from('outils_pieces_commande').update(payload).eq('id', editing.id)
      if (error) { alert(error.message); return }
      setCommandes(prev => prev.map(c => c.id === editing.id ? { ...c, ...payload } : c))
    } else {
      const { data, error } = await supabase.from('outils_pieces_commande').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setCommandes(prev => [data, ...prev])
    }
    setEditing(null)
    showToast('✅ Demande enregistrée')
  }

  async function del() {
    if (!confirm('Supprimer cette demande ?')) return
    await supabase.from('outils_pieces_commande').delete().eq('id', editing.id)
    setCommandes(prev => prev.filter(c => c.id !== editing.id))
    setEditing(null)
    showToast('🗑️ Supprimée')
  }

  const displayed = commandes
    .filter(c => filterStatut === 'all' || c.statut === filterStatut)
    .filter(c => filterCat === 'all' || c.categorie === filterCat)

  const outilNom = id => outils.find(o => o.id === id)?.nom || '–'
  const counts = COMMANDE_STATUTS.map(s => ({ ...s, n: commandes.filter(c => c.statut === s.key).length }))

  if (tableMissing) {
    return (
      <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)', padding:'2rem', textAlign:'center' }}>
        ⚠️ Exécute <strong>migration_A_EXECUTER_45.sql</strong> dans Supabase → SQL Editor pour activer le suivi des pièces à commander.
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding:'1rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', gap:'.6rem', alignItems:'center', flexWrap:'wrap' }}>
        <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap' }}>
          {counts.map(s => (
            <div key={s.key} style={{ background:'var(--cream)', borderRadius:9, padding:'.4rem .8rem', borderTop:`3px solid ${s.color}`, minWidth:100 }}>
              <div style={{ fontSize:'.65rem', color:'var(--text-muted)', textTransform:'uppercase' }}>{s.label}</div>
              <div style={{ fontWeight:700, fontSize:'.95rem' }}>{s.n}</div>
            </div>
          ))}
        </div>
        <button className="btn-sm primary" onClick={openNew} style={{ marginLeft:'auto' }}>+ Nouvelle demande</button>
      </div>

      <div style={{ padding:'.7rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', gap:'.5rem', flexWrap:'wrap', alignItems:'center' }}>
        {[['all','Tous'], ...COMMANDE_STATUTS.map(s=>[s.key,s.label])].map(([k,l]) => (
          <button key={k} className="btn-sm" onClick={()=>setFilterStatut(k)} style={filterStatut===k?{background:'var(--green-mid)',color:'white',borderColor:'var(--green-mid)'}:{}}>{l}</button>
        ))}
        <span style={{ width:1, alignSelf:'stretch', background:'var(--border)', margin:'0 .3rem' }} />
        {[['all','Tous'],['outil','Outil'],['autre','Autre']].map(([k,l]) => (
          <button key={k} className="btn-sm" onClick={()=>setFilterCat(k)} style={filterCat===k?{background:'var(--amber)',color:'white',borderColor:'var(--amber)'}:{}}>{l}</button>
        ))}
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
        {loading ? null : displayed.length === 0 ? (
          <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
            Aucune demande — cliquez "+ Nouvelle demande" pour signaler une pièce à commander.
          </div>
        ) : (
          <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
            <table style={{ width:'100%', minWidth:820, fontSize:'.83rem', borderCollapse:'collapse' }}>
              <thead style={{ background:'var(--cream)' }}>
                <tr>
                  {['Pièce','Concerne','Qté','Fournisseur', ...(canSeePrix ? ['Prix estimé'] : []), 'Statut','Demandée le'].map(h=>(
                    <th key={h} style={{ padding:'.6rem .9rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map(c => (
                  <tr key={c.id} onClick={()=>openEdit(c)} style={{ cursor:'pointer' }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}>
                    <td style={td}><strong>{c.nom}</strong></td>
                    <td style={td}>{c.categorie==='outil' ? `🚜 ${outilNom(c.outil_id)}` : '📦 Autre'}</td>
                    <td style={td}>{c.quantite ?? '–'}</td>
                    <td style={td}>{c.fournisseur || '–'}</td>
                    {canSeePrix && <td style={td}>{c.prix_estime != null ? c.prix_estime.toLocaleString('fr-FR',{minimumFractionDigits:2})+' €' : '–'}</td>}
                    <td style={td}>
                      <span style={{ fontSize:'.7rem', fontWeight:700, padding:'.15rem .55rem', borderRadius:50, background:(STATUT_COLOR[c.statut]||'var(--text-muted)')+'22', color:STATUT_COLOR[c.statut]||'var(--text-muted)' }}>
                        {STATUT_LABEL[c.statut] || c.statut}
                      </span>
                    </td>
                    <td style={td}>{c.date_demande || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={editing.id?'Modifier la demande':'Nouvelle demande de pièce'} onClose={()=>setEditing(null)} onSave={save} onDelete={editing.id?del:null} maxWidth={520}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Pièce *</label>
              <input autoFocus value={editing.nom} onChange={e=>setEditing({...editing,nom:e.target.value})} placeholder="ex. Courroie alternateur" />
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Concerne</label>
              <div style={{ display:'flex', gap:'1rem', marginTop:'.3rem', flexWrap:'wrap' }}>
                <label style={{ display:'flex', alignItems:'center', gap:'.4rem', fontSize:'.85rem', cursor:'pointer' }}>
                  <input type="radio" checked={editing.categorie!=='outil'} onChange={()=>setEditing({...editing,categorie:'autre',outil_id:''})} /> 📦 Autre (hors outil)
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:'.4rem', fontSize:'.85rem', cursor:'pointer' }}>
                  <input type="radio" checked={editing.categorie==='outil'} onChange={()=>setEditing({...editing,categorie:'outil'})} /> 🚜 Outil agricole
                </label>
              </div>
            </div>
            {editing.categorie === 'outil' && (
              <div className="form-group" style={{ gridColumn:'1/-1' }}>
                <label>Outil concerné</label>
                <select value={editing.outil_id||''} onChange={e=>setEditing({...editing,outil_id:e.target.value})}>
                  <option value="">— Choisir —</option>
                  {outils.map(o=><option key={o.id} value={o.id}>{o.nom}{o.type?` (${o.type})`:''}</option>)}
                </select>
              </div>
            )}
            <div className="form-group"><label>Quantité</label><input type="number" step="1" value={editing.quantite} onChange={e=>setEditing({...editing,quantite:e.target.value})} placeholder="ex. 2" /></div>
            <div className="form-group"><label>Fournisseur</label><input value={editing.fournisseur||''} onChange={e=>setEditing({...editing,fournisseur:e.target.value})} /></div>
            {canSeePrix && <div className="form-group"><label>Prix estimé (€)</label><input type="number" step="0.01" value={editing.prix_estime} onChange={e=>setEditing({...editing,prix_estime:e.target.value})} /></div>}
            <div className="form-group">
              <label>Statut</label>
              <select value={editing.statut} onChange={e=>setEditing({...editing,statut:e.target.value})}>
                {COMMANDE_STATUTS.map(s=><option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Demandée le</label><input type="date" value={editing.date_demande||''} onChange={e=>setEditing({...editing,date_demande:e.target.value})} /></div>
            {editing.statut !== 'en_attente' && (
              <div className="form-group"><label>Commandée le</label><input type="date" value={editing.date_commande||''} onChange={e=>setEditing({...editing,date_commande:e.target.value})} /></div>
            )}
            {editing.statut === 'recue' && (
              <div className="form-group"><label>Reçue le</label><input type="date" value={editing.date_reception||''} onChange={e=>setEditing({...editing,date_reception:e.target.value})} /></div>
            )}
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Observation</label>
              <textarea rows={2} value={editing.observation||''} onChange={e=>setEditing({...editing,observation:e.target.value})}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
          </div>
        </Modal>
      )}
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
