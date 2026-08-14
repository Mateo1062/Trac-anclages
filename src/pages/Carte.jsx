import { useState, useEffect, useRef, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import FloatingDropdown from '../components/FloatingDropdown'
import PhotoLightbox from '../components/PhotoLightbox'
import ParcellesMap, { splitPolygonByLine } from '../components/ParcellesMap'
import CultureLegend from '../components/CultureLegend'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { consumePendingParcelle } from '../lib/mapFocus'
import useIsMobile from '../lib/useIsMobile'
import { phytoDisplayName, phytoMatches } from '../lib/phytoNames'
import { productSourceFor } from '../lib/interventionProductSource'
import { groupInterventions, sortGroupsByDateDesc } from '../lib/groupInterventions'
import { intervTypeLabel } from '../lib/interventionLabels'
import { fmtDate } from '../lib/formatDate'
import InterventionChampEditModal from '../components/InterventionChampEditModal'

const TYPES_INTERVENTION = ['Traitement et protection des cultures','Ferti minérale et foliaire','Plantation','Semis','Fertilisation et amendement organique','Désherbage mécanique','Travail du sol','Récolte','Irrigation']
const IRRIGATION_TYPE_LABEL = { bouche: 'Bouche d\'irrigation', vanne: 'Vanne', puits: 'Puits' }
const SOUS_TYPES_TRAVAIL_SOL = ['Déchaumage','Décompactage','Broyage','Labour','Écorouleau']
const UNITES = ['L','kg','g','mL','T']


const nowHM = () => new Date().toTimeString().slice(0, 5)
// Durée d'une période en heures décimales (fin vide = 0)
function periodeHeures(debut, fin) {
  if (!debut || !fin) return 0
  const [h1, m1] = debut.split(':').map(Number)
  const [h2, m2] = fin.split(':').map(Number)
  return Math.max(0, (h2 * 60 + m2 - h1 * 60 - m1) / 60)
}
const fmtHeures = h => {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60)
  return mm ? `${hh} h ${String(mm).padStart(2, '0')}` : `${hh} h`
}

export default function Carte() {
  const { user, perms, isAdmin, isManager, profile } = useAuth()
  const canHeuresArrachage = perms.carteHeuresArrachage !== false
  const parcellesReadOnly = !!perms.parcellesReadOnly
  const canGroupParcelles = isManager // isManager couvre déjà isAdmin (voir AuthContext)
  // Regroupement visuel manuel des parcelles sur la carte (masque les
  // délimitations entre les membres d'un même groupe, affiche le nom du
  // groupe à la place) — admin/manager voient toujours le détail parcelle par
  // parcelle ; tous les autres profils voient les groupes fusionnés.
  const hideParcelleDelimitations = !canGroupParcelles
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const [pageTab, setPageTab] = useState('carte') // 'carte' | 'heures'
  // allParcelles : tout, toutes campagnes confondues (chargé une fois). `parcelles`
  // (utilisé partout ci-dessous — carte, listes, sélecteurs) n'affiche que celles de
  // la campagne active — un parcellaire différent par campagne (ex. import historique
  // d'une ancienne campagne) ne se mélange pas avec le plan actuel.
  const [allParcelles, setAllParcelles] = useState([])
  const setParcelles = setAllParcelles
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [editingInterventions, setEditingInterventions] = useState([])
  const [editingChampGroup, setEditingChampGroup] = useState(null) // groupe d'interventions_phyto en cours de modification
  // Campagne (année agricole) — chaque intervention créée est tagguée avec la
  // campagne active — globale à toute l'appli (menu principal).
  const { campagneActive, setCampagneActive } = useCampagne()
  // Mémoïsé : sans ça, ce tableau change de référence à CHAQUE rendu de Carte()
  // (nouveau .filter() à chaque fois), ce qui redéclenche l'effet de ParcellesMap
  // qui reconstruit les couches et recadre (fitBounds) la carte — provoquant un
  // dézoom visible à chaque sélection de parcelle/produit pendant la création
  // d'une intervention (ces sélections sont de simples changements d'état qui
  // font re-rendre Carte(), sans que le parcellaire ait réellement changé).
  const parcelles = useMemo(
    () => allParcelles.filter(p => (p.campagne || defaultCampagne()) === campagneActive),
    [allParcelles, campagneActive]
  )

  // Mode intervention : sélection multi-parcelles + annotation groupée
  const [interventionMode, setInterventionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  // Groupes de parcelles (regroupement manuel, voir migration_A_EXECUTER_86.sql)
  const [groupes, setGroupes] = useState([])
  const groupesById = useMemo(() => Object.fromEntries(groupes.map(g => [g.id, g])), [groupes])
  const [groupMode, setGroupMode] = useState(false)
  const [groupModal, setGroupModal] = useState(null) // { nom, memberIds, reuseGroupId }
  // Liste déroulante des parcelles (recherche par nom) — alternative au clic direct
  // sur la carte pour sélectionner : clique une parcelle dans la liste pour la
  // sélectionner ET recentrer la carte dessus (repère visuel avant d'annoter).
  const [parcelleListeOuverte, setParcelleListeOuverte] = useState(false)
  const [parcelleListeQ, setParcelleListeQ] = useState('')
  const [intervModalOpen, setIntervModalOpen] = useState(false)
  const [intervDate, setIntervDate] = useState(new Date().toISOString().split('T')[0])
  const [intervType, setIntervType] = useState('')
  const [intervSousType, setIntervSousType] = useState('')
  const [intervDefanage, setIntervDefanage] = useState(false)
  const [intervRemarque, setIntervRemarque] = useState('')
  const [intervFourrieres, setIntervFourrieres] = useState(false)
  const [intervRive, setIntervRive] = useState(false)
  const [intervOutilIds, setIntervOutilIds] = useState([])
  const [outilsListeOuverte, setOutilsListeOuverte] = useState(false)
  const [intervLignes, setIntervLignes] = useState([{ produit_nom: '', produit_id: null, quantite: '', unite: 'L' }])
  const ligneInputRefs = useRef({})
  const [intervPhotos, setIntervPhotos] = useState([])
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)
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
      setIntervPhotos(prev => [...prev, data.publicUrl])
    }
    setUploadingPhoto(false)
  }
  function removeIntervPhoto(url) {
    setIntervPhotos(prev => prev.filter(p => p !== url))
  }
  const [saving, setSaving] = useState(false)
  const [phytoProducts, setPhytoProducts] = useState([])
  const [intrants, setIntrants] = useState([])
  const [profiles, setProfiles] = useState([]) // pour afficher qui a saisi chaque intervention
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'
  const [outils, setOutils] = useState([])
  const [openLigneDropdown, setOpenLigneDropdown] = useState(null) // index de la ligne dont la liste de suggestions est ouverte

  // Surface traitée (hectares) — saisie libre par parcelle, ou calculée en
  // dessinant une ou plusieurs zones sur la carte pour CETTE parcelle précise
  // (bords de route, chemin, éoliennes… peuvent être traités différemment) —
  // possible même en sélection multiple : la sélection des parcelles reste
  // intacte pendant qu'on dessine, on choisit juste pour laquelle on dessine.
  const [intervSurfaceHaByParcelle, setIntervSurfaceHaByParcelle] = useState({}) // { [parcelleId]: string }
  const [zonesByParcelle, setZonesByParcelle] = useState({}) // { [parcelleId]: { shapes, ha, geojson } }
  const [drawingParcelleId, setDrawingParcelleId] = useState(null)
  const [drawMode, setDrawMode] = useState(false)
  const [drawState, setDrawState] = useState(null) // progression en direct depuis la carte
  const mapRef = useRef(null)

  // ── Redessiner entièrement le contour d'une parcelle (admin uniquement) —
  // même moteur de dessin que la zone traitée ci-dessus, mais SANS contrainte
  // au contour existant (drawBoundary=null) puisque c'est justement ce contour
  // qu'on remplace : sert à corriger une parcelle mal placée/mal importée. ──
  const [redrawParcelleId, setRedrawParcelleId] = useState(null)

  // ── Diviser une parcelle en plusieurs morceaux (admin uniquement) — réutilise
  // le moteur de tracé de LIGNE (comme le réseau d'irrigation) : la ligne tracée
  // sert de "coup de cutter" à travers le contour de la parcelle. On calcule un
  // aperçu (splitPreview) avant tout écriture en base, pour laisser confirmer/
  // ajuster les noms des morceaux avant de valider. ──
  const [splittingParcelleId, setSplittingParcelleId] = useState(null)
  const [splitPreview, setSplitPreview] = useState(null) // { parcelle, pieces: [{ geometry, areaHa, nom }] }

  // ── Dessiner une TOUTE NOUVELLE parcelle (admin uniquement) — même moteur
  // de dessin libre que le redessin, mais aboutit à une modale de nommage
  // (nom + infos) puis un insert au lieu d'un update sur une parcelle existante. ──
  const [creatingParcelle, setCreatingParcelle] = useState(false)
  const [newParcelleModal, setNewParcelleModal] = useState(null) // { nom, entite, commune, culture_actuelle, geometrie, surface }

  // ── Points d'irrigation (bouches, vannes, puits) — mode "placement" : cliquer
  // sur la carte pose un point (choix du type + nom ensuite) ; affichage/masquage
  // via la case dédiée dans le panneau des calques (topright), pas ici. ──
  const [irrigationPoints, setIrrigationPoints] = useState([])
  const [irrigationDrawMode, setIrrigationDrawMode] = useState(false)
  const [editingIrrigation, setEditingIrrigation] = useState(null) // { id?, type, nom, notes, lat, lng }

  // ── Réseau d'irrigation (lignes/tuyaux) — mode "tracé" : clic = point,
  // glisser pour ajuster, "Terminer" (≥2 points) demande un nom puis enregistre. ──
  const [irrigationLines, setIrrigationLines] = useState([])
  const [lineDrawMode, setLineDrawMode] = useState(false)
  const [lineDrawState, setLineDrawState] = useState(null)
  const [reshapingLineId, setReshapingLineId] = useState(null) // id de la ligne existante en cours de modification de tracé
  const [editingLine, setEditingLine] = useState(null) // { id?, nom, notes, geometrie, longueur_m }

  // ── Points d'intervention libres — marquer un endroit précis sur la carte
  // (hors parcelle/outil), même principe que les points d'irrigation. ──
  const [interventionPoints, setInterventionPoints] = useState([])
  const [interventionDrawMode, setInterventionDrawMode] = useState(false)
  const [editingInterventionPoint, setEditingInterventionPoint] = useState(null) // { id?, date_intervention, description, notes, lat, lng }

  // Mode heures d'arrachage : même principe que le mode Intervention mais la
  // sélection est UNIQUE — cliquer une parcelle ouvre directement la saisie.
  const [heuresMode, setHeuresMode] = useState(false)
  const [heures, setHeures] = useState([])            // toutes les périodes enregistrées
  const [heuresMissing, setHeuresMissing] = useState(false)
  const [editingHeures, setEditingHeures] = useState(null) // { date, parcelle_id, parcelle_nom, periodes:[{debut,fin}], observation }

  useEffect(() => { load() }, [])

  // "Aller sur la carte" depuis la liste des parcelles (Base de données) —
  // bascule si besoin sur la campagne de la parcelle visée (le parcellaire
  // change d'une campagne à l'autre), puis recentre la carte dessus une fois
  // sa forme construite (le composant carte reconstruit ses calques de façon
  // asynchrone, d'où les tentatives répétées plutôt qu'un seul essai).
  const focusHandledRef = useRef(false)
  useEffect(() => {
    if (focusHandledRef.current || !allParcelles.length) return
    const id = consumePendingParcelle()
    focusHandledRef.current = true
    if (!id) return
    setPageTab('carte')
    const target = allParcelles.find(p => p.id === id)
    if (target) {
      const targetCampagne = target.campagne || defaultCampagne()
      if (targetCampagne !== campagneActive) setCampagneActive(targetCampagne)
    }
    let attempts = 0
    const tryFocus = () => {
      attempts++
      const ok = mapRef.current?.focusParcelle(id)
      if (!ok && attempts < 20) setTimeout(tryFocus, 150)
    }
    setTimeout(tryFocus, 200)
  }, [allParcelles])

  async function load() {
    setLoading(true)
    const [{ data }, { data: phyto }, { data: intr }, { data: out }, irrig, irrigLines, intervPts, { data: prof }, groupesRes] = await Promise.all([
      supabase.from('parcelles').select('*').order('nom'),
      supabase.from('db_phyto').select('*').order('nom'),
      supabase.from('db_intrants').select('*').order('nom'),
      supabase.from('outils_agricoles').select('id,nom,type').order('nom'),
      supabase.from('irrigation_points').select('*'),
      supabase.from('irrigation_lines').select('*'),
      supabase.from('intervention_points').select('*'),
      supabase.from('profiles').select('id,display_name'),
      supabase.from('parcelle_groupes').select('*'),
    ])
    setParcelles(data || [])
    setPhytoProducts(phyto || [])
    setIntrants(intr || [])
    setOutils(out || [])
    setProfiles(prof || [])
    // Table pas encore créée (migration 86 non exécutée) → pas de groupement,
    // reste silencieux plutôt que de bloquer le chargement du reste.
    if (!groupesRes.error) setGroupes(groupesRes.data || [])
    // Table pas encore créée (migration 59 non exécutée) → vide, normal. Sinon
    // (erreur passagère réseau/cache schéma) on garde les points déjà affichés
    // plutôt que de les faire tous disparaître le temps d'un rechargement raté.
    const tableMissing = e => /relation|does not exist|could not find the table/i.test(e?.message || '')
    if (!irrig.error) setIrrigationPoints(irrig.data || [])
    else if (tableMissing(irrig.error)) setIrrigationPoints([])
    else console.error('irrigation_points:', irrig.error.message)
    if (!irrigLines.error) setIrrigationLines(irrigLines.data || [])
    else if (tableMissing(irrigLines.error)) setIrrigationLines([])
    else console.error('irrigation_lines:', irrigLines.error.message)
    if (!intervPts.error) setInterventionPoints(intervPts.data || [])
    else if (tableMissing(intervPts.error)) setInterventionPoints([])
    else console.error('intervention_points:', intervPts.error.message)
    loadHeures()
    setLoading(false)
  }

  async function loadHeures() {
    const { data, error } = await supabase.from('heures_arrachage').select('*')
      .order('date', { ascending: false }).order('debut')
    if (error && /does not exist|relation|could not find the table/i.test(error.message)) { setHeuresMissing(true); return }
    setHeures(data || [])
  }

  async function save() {
    const { id, ...payload } = editing
    await supabase.from('parcelles').update(payload).eq('id', id)
    setEditing(null)
    load()
  }

  // Ouvre la fiche parcelle depuis la carte (popup "✏️ Modifier") — avec son
  // historique d'interventions (Traitement, Fertilisation, Travail du sol…),
  // comme dans la liste des parcelles, pour voir ce qui a déjà été fait sur ce
  // champ sans changer d'onglet.
  function openEditParcelle(p) {
    setEditing(p)
    setEditingInterventions([])
    reloadInterventionsFor(p.id)
  }
  function reloadInterventionsFor(parcelleId) {
    supabase.from('interventions_phyto').select('*').eq('parcelle_id', parcelleId).order('date', { ascending: false })
      .then(({ data }) => setEditingInterventions(data || []))
  }
  function openChampGroup(g) {
    setEditingChampGroup({
      date: g.date, observation: g.type, sous_type: g.sous_type, defanage: g.defanage,
      parcelle: editing?.nom, parcelle_id: editing?.id, culture: g.items[0]?.culture,
      items: g.items,
    })
  }

  // Vue d'une parcelle groupée (voir migration_A_EXECUTER_86.sql) cliquée sur la
  // carte par un utilisateur non admin/manager (les délimitations sont masquées
  // pour lui, voir hideParcelleDelimitations) — même principe que Parcelles.jsx :
  // ça doit se comporter comme UNE parcelle, avec ses interventions consultables
  // et modifiables, regroupées à travers toutes les vraies parcelles du groupe.
  const [viewingGroup, setViewingGroup] = useState(null)
  const [viewingGroupInterventions, setViewingGroupInterventions] = useState([])
  function openViewingGroup(members) {
    setViewingGroup({ nom: groupesById[members[0].groupe_id]?.nom || members[0].nom, members })
    setViewingGroupInterventions([])
    reloadViewingGroupInterventions(members.map(m => m.id))
  }
  function reloadViewingGroupInterventions(memberIds) {
    supabase.from('interventions_phyto').select('*').in('parcelle_id', memberIds).order('date', { ascending: false })
      .then(({ data }) => setViewingGroupInterventions(data || []))
  }
  function openViewingGroupChamp(g) {
    setEditingChampGroup({
      date: g.date, observation: g.type, sous_type: g.sous_type, defanage: g.defanage,
      parcelle: viewingGroup.nom, items: g.items,
      parcelleTargets: viewingGroup.members.map(p => ({ id: p.id, nom: p.nom, culture: p.culture_actuelle, campagne: p.campagne })),
    })
  }

  /* ── Mode intervention ── */
  function toggleInterventionMode() {
    setInterventionMode(v => !v)
    setHeuresMode(false)
    setGroupMode(false)
    setSelectedIds(new Set())
    setParcelleListeOuverte(false)
    setParcelleListeQ('')
  }

  /* ── Groupes de parcelles (regroupement manuel, admin/manager) ── */
  function toggleGroupMode() {
    setGroupMode(v => !v)
    setInterventionMode(false)
    setHeuresMode(false)
    setSelectedIds(new Set())
  }
  // Ouvre la fenêtre de nommage : si toute la sélection appartient déjà à un
  // seul et même groupe existant, on le renomme/complète (reuseGroupId) au
  // lieu d'en créer un nouveau. Si la sélection chevauche plusieurs groupes
  // différents, un nouveau groupe est créé avec les parcelles sélectionnées
  // (les groupes d'origine gardent leurs autres membres non sélectionnés).
  function openGroupModal() {
    if (selectedIds.size < 2) { showToast('Sélectionne au moins 2 parcelles à regrouper 🎯'); return }
    const selectedParcelles = parcelles.filter(p => selectedIds.has(p.id))
    const existingGroupIds = [...new Set(selectedParcelles.map(p => p.groupe_id).filter(Boolean))]
    const reuseGroupId = existingGroupIds.length === 1 ? existingGroupIds[0] : null
    setGroupModal({
      nom: reuseGroupId ? (groupesById[reuseGroupId]?.nom || '') : '',
      memberIds: [...selectedIds],
      reuseGroupId,
      mergingMultiple: existingGroupIds.length > 1,
    })
  }
  async function saveGroup() {
    const nom = groupModal.nom.trim()
    if (!nom) { alert('Nom du groupe obligatoire.'); return }
    try {
      let groupeId = groupModal.reuseGroupId
      if (groupeId) {
        const { error } = await supabase.from('parcelle_groupes').update({ nom }).eq('id', groupeId)
        if (error) throw error
        setGroupes(prev => prev.map(g => g.id === groupeId ? { ...g, nom } : g))
      } else {
        const { data, error } = await supabase.from('parcelle_groupes').insert({ nom, created_by: user?.id || null }).select().single()
        if (error) throw error
        groupeId = data.id
        setGroupes(prev => [...prev, data])
      }
      const { error } = await supabase.from('parcelles').update({ groupe_id: groupeId }).in('id', groupModal.memberIds)
      if (error) throw error
      setAllParcelles(prev => prev.map(p => groupModal.memberIds.includes(p.id) ? { ...p, groupe_id: groupeId } : p))
      showToast(`✅ Groupe "${nom}" enregistré (${groupModal.memberIds.length} parcelle(s))`)
      setGroupModal(null)
      setSelectedIds(new Set())
    } catch (e) {
      alert(/relation|does not exist|could not find the table|groupe_id/i.test(e.message)
        ? "Table manquante — exécute migration_A_EXECUTER_86.sql dans Supabase → SQL Editor."
        : e.message)
    }
  }
  async function removeFromGroup() {
    const selectedParcelles = parcelles.filter(p => selectedIds.has(p.id) && p.groupe_id)
    if (!selectedParcelles.length) { showToast('Aucune parcelle sélectionnée n\'appartient à un groupe.'); return }
    if (!confirm(`Retirer ${selectedParcelles.length} parcelle(s) de son/leur groupe ?`)) return
    const ids = selectedParcelles.map(p => p.id)
    const { error } = await supabase.from('parcelles').update({ groupe_id: null }).in('id', ids)
    if (error) { alert(error.message); return }
    setAllParcelles(prev => prev.map(p => ids.includes(p.id) ? { ...p, groupe_id: null } : p))
    setSelectedIds(new Set())
    showToast('✅ Retiré du groupe')
  }

  /* ── Points d'irrigation ── */
  function toggleIrrigationDrawMode() {
    setIrrigationDrawMode(v => !v)
    setLineDrawMode(false)
    setInterventionDrawMode(false)
    setInterventionMode(false)
    setHeuresMode(false)
    setGroupMode(false)
    setSelectedIds(new Set())
  }
  function handleAddIrrigationPoint(latlng) {
    setEditingIrrigation({ type: 'bouche', nom: '', notes: '', lat: latlng.lat, lng: latlng.lng })
  }
  function handleSelectIrrigationPoint(p) {
    setEditingIrrigation({ ...p })
  }
  async function handleMoveIrrigationPoint(p, latlng) {
    const payload = { lat: latlng.lat, lng: latlng.lng }
    const { error } = await supabase.from('irrigation_points').update(payload).eq('id', p.id)
    if (error) { alert(error.message); return }
    setIrrigationPoints(prev => prev.map(x => x.id === p.id ? { ...x, ...payload } : x))
    showToast(`✅ ${IRRIGATION_TYPE_LABEL[p.type]} déplacé${p.nom ? ` — ${p.nom}` : ''}`)
  }
  async function saveIrrigationPoint() {
    const e = editingIrrigation
    const payload = { type: e.type, nom: e.nom?.trim() || null, notes: e.notes?.trim() || null, lat: e.lat, lng: e.lng }
    let error
    if (e.id) {
      ;({ error } = await supabase.from('irrigation_points').update(payload).eq('id', e.id))
      if (!error) setIrrigationPoints(prev => prev.map(p => p.id === e.id ? { ...p, ...payload } : p))
    } else {
      let data
      ;({ data, error } = await supabase.from('irrigation_points').insert({ ...payload, created_by: user?.id || null }).select().single())
      if (!error) setIrrigationPoints(prev => [...prev, data])
    }
    if (error) {
      alert(/relation|does not exist|could not find the table/i.test(error.message)
        ? 'Table manquante — exécute migration_A_EXECUTER_59.sql dans Supabase → SQL Editor.'
        : error.message)
      return
    }
    setEditingIrrigation(null)
    showToast(`✅ ${IRRIGATION_TYPE_LABEL[e.type]} enregistré${e.id ? '' : ' — clique la carte pour en ajouter un autre'}`)
  }
  async function deleteIrrigationPoint() {
    if (!confirm('Supprimer ce point ?')) return
    const { error } = await supabase.from('irrigation_points').delete().eq('id', editingIrrigation.id)
    if (error) { alert(error.message); return }
    setIrrigationPoints(prev => prev.filter(p => p.id !== editingIrrigation.id))
    setEditingIrrigation(null)
    showToast('🗑️ Point supprimé')
  }

  /* ── Points d'intervention libres ── */
  function toggleInterventionDrawMode() {
    setInterventionDrawMode(v => !v)
    setIrrigationDrawMode(false)
    setLineDrawMode(false)
    setInterventionMode(false)
    setHeuresMode(false)
    setGroupMode(false)
    setSelectedIds(new Set())
  }
  function handleAddInterventionPoint(latlng) {
    setEditingInterventionPoint({ date_intervention: new Date().toISOString().split('T')[0], description: '', notes: '', lat: latlng.lat, lng: latlng.lng })
  }
  function handleSelectInterventionPoint(p) {
    setEditingInterventionPoint({ ...p })
  }
  async function handleMoveInterventionPoint(p, latlng) {
    const payload = { lat: latlng.lat, lng: latlng.lng }
    const { error } = await supabase.from('intervention_points').update(payload).eq('id', p.id)
    if (error) { alert(error.message); return }
    setInterventionPoints(prev => prev.map(x => x.id === p.id ? { ...x, ...payload } : x))
    showToast(`✅ Point déplacé${p.description ? ` — ${p.description}` : ''}`)
  }
  async function saveInterventionPoint() {
    const e = editingInterventionPoint
    const payload = { date_intervention: e.date_intervention || null, description: e.description?.trim() || null, notes: e.notes?.trim() || null, lat: e.lat, lng: e.lng }
    let error
    if (e.id) {
      ;({ error } = await supabase.from('intervention_points').update(payload).eq('id', e.id))
      if (!error) setInterventionPoints(prev => prev.map(p => p.id === e.id ? { ...p, ...payload } : p))
    } else {
      let data
      ;({ data, error } = await supabase.from('intervention_points').insert({ ...payload, created_by: user?.id || null }).select().single())
      if (!error) setInterventionPoints(prev => [...prev, data])
    }
    if (error) {
      alert(/relation|does not exist|could not find the table/i.test(error.message)
        ? 'Table manquante — exécute migration_A_EXECUTER_63.sql dans Supabase → SQL Editor.'
        : error.message)
      return
    }
    setEditingInterventionPoint(null)
    showToast(`✅ Intervention enregistrée${e.id ? '' : ' — clique la carte pour en ajouter une autre'}`)
  }
  async function deleteInterventionPoint() {
    if (!confirm('Supprimer ce point ?')) return
    const { error } = await supabase.from('intervention_points').delete().eq('id', editingInterventionPoint.id)
    if (error) { alert(error.message); return }
    setInterventionPoints(prev => prev.filter(p => p.id !== editingInterventionPoint.id))
    setEditingInterventionPoint(null)
    showToast('🗑️ Point supprimé')
  }

  /* ── Réseau d'irrigation (lignes) ── */
  function toggleLineDrawMode() {
    setLineDrawMode(v => !v)
    setReshapingLineId(null)
    setSplittingParcelleId(null)
    setIrrigationDrawMode(false)
    setInterventionDrawMode(false)
    setInterventionMode(false)
    setHeuresMode(false)
    setGroupMode(false)
    setSelectedIds(new Set())
    setLineDrawState(null)
  }
  function handleLineDrawn(state) {
    setLineDrawState(state)
    if (state?.done) {
      setLineDrawMode(false)
      if (reshapingLineId) { finishReshapeLine(state); return }
      if (splittingParcelleId) { computeSplitPreview(state); return }
      setEditingLine({ notes: '', couleur: '#2980b9', geometrie: state.geojson, longueur_m: state.lengthM })
    }
  }

  /* ── Diviser une parcelle (admin uniquement) ── */
  function startSplitParcelle(p) {
    setEditing(null)
    setSplittingParcelleId(p.id)
    setReshapingLineId(null)
    setLineDrawState(null)
    setLineDrawMode(true)
  }
  function cancelSplitDraw() {
    mapRef.current?.cancelLineDraw()
    setLineDrawMode(false)
    setLineDrawState(null)
    setSplittingParcelleId(null)
  }
  // Calcule l'aperçu de découpe (aucune écriture en base à ce stade) — la ligne
  // tracée (state.geojson, LineString) sert de plan de coupe à travers le
  // contour réel de la parcelle. Le plus grand morceau garde le nom d'origine
  // (suffixe le plus proche de "garder l'identité" de la parcelle), les autres
  // sont numérotés B, C… et deviendront de nouvelles parcelles à la validation.
  function computeSplitPreview(state) {
    const pid = splittingParcelleId
    setSplittingParcelleId(null)
    const parcelle = parcelles.find(p => p.id === pid)
    if (!parcelle?.geometrie) { alert('Cette parcelle n\'a pas de contour tracé.'); return }
    const linePts = (state.geojson?.coordinates || []).map(([lng, lat]) => ({ lat, lng }))
    const pieces = splitPolygonByLine(parcelle.geometrie, linePts)
    if (!pieces) {
      alert('La ligne tracée ne coupe pas ce contour en plusieurs morceaux — retrace une ligne qui traverse bien la parcelle de part en part.')
      return
    }
    const sorted = pieces.slice().sort((a, b) => b.areaHa - a.areaHa)
    setSplitPreview({
      parcelle,
      pieces: sorted.map((pc, i) => ({ ...pc, nom: i === 0 ? parcelle.nom : `${parcelle.nom} - ${String.fromCharCode(65 + i)}` })),
    })
  }
  function updateSplitPieceNom(i, nom) {
    setSplitPreview(prev => ({ ...prev, pieces: prev.pieces.map((pc, idx) => idx === i ? { ...pc, nom } : pc) }))
  }
  // Le premier morceau (le plus grand) GARDE l'id de la parcelle d'origine — tout
  // l'historique (interventions, fiches de coût de revient…) reste donc rattaché
  // à ce morceau sans rien migrer. Les autres deviennent de nouvelles parcelles
  // indépendantes (aucun historique, comme une parcelle fraîchement créée).
  async function confirmSplit() {
    const { parcelle, pieces } = splitPreview
    if (pieces.some(pc => !pc.nom?.trim())) { alert('Chaque morceau doit avoir un nom.'); return }
    const [keep, ...rest] = pieces
    const { error: updateError } = await supabase.from('parcelles')
      .update({ nom: keep.nom.trim(), geometrie: keep.geometry, surface: +keep.areaHa.toFixed(2) })
      .eq('id', parcelle.id)
    if (updateError) { alert(updateError.message); return }
    if (rest.length) {
      const rows = rest.map(pc => ({
        nom: pc.nom.trim(), entite: parcelle.entite || null, commune: parcelle.commune || null,
        culture_actuelle: parcelle.culture_actuelle || null, culture_precedente: parcelle.culture_precedente || null,
        surface: +pc.areaHa.toFixed(2), geometrie: pc.geometry, campagne: parcelle.campagne || campagneActive,
      }))
      const { error: insertError } = await supabase.from('parcelles').insert(rows)
      if (insertError) { alert(`Le morceau principal a été enregistré, mais la création des autres a échoué : ${insertError.message}`); setSplitPreview(null); load(); return }
    }
    setSplitPreview(null)
    showToast(`✂️ "${parcelle.nom}" divisée en ${pieces.length} morceaux`)
    load()
  }
  function handleSelectIrrigationLine(l) {
    setEditingLine({ ...l })
  }
  // Modifie le tracé d'une ligne déjà enregistrée : recharge ses points comme
  // sommets déplaçables (au lieu de repartir de zéro), garde nom/couleur/notes.
  function startReshapeLine(line) {
    setEditingLine(null)
    setReshapingLineId(line.id)
    setLineDrawState(null)
    setLineDrawMode(true)
  }
  useEffect(() => {
    if (!reshapingLineId) return
    const line = irrigationLines.find(l => l.id === reshapingLineId)
    if (!line?.geometrie?.coordinates) return
    const latlngs = line.geometrie.coordinates.map(([lng, lat]) => ({ lat, lng }))
    mapRef.current?.seedLinePoints(latlngs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reshapingLineId])
  async function finishReshapeLine(state) {
    const id = reshapingLineId
    setReshapingLineId(null)
    const payload = { geometrie: state.geojson, longueur_m: state.lengthM }
    const { error } = await supabase.from('irrigation_lines').update(payload).eq('id', id)
    if (error) { alert(error.message); return }
    setIrrigationLines(prev => prev.map(l => l.id === id ? { ...l, ...payload } : l))
    showToast('✅ Tracé mis à jour')
  }
  async function saveIrrigationLine() {
    const e = editingLine
    const payload = { notes: e.notes?.trim() || null, couleur: e.couleur || '#2980b9', geometrie: e.geometrie, longueur_m: e.longueur_m ?? null }
    let error, migrationHint = false
    if (e.id) {
      ;({ error } = await supabase.from('irrigation_lines').update(payload).eq('id', e.id))
      if (error && /couleur|column/i.test(error.message)) {
        migrationHint = true
        const { couleur, ...fallback } = payload
        ;({ error } = await supabase.from('irrigation_lines').update(fallback).eq('id', e.id))
      }
      if (!error) setIrrigationLines(prev => prev.map(l => l.id === e.id ? { ...l, ...payload } : l))
    } else {
      let data
      ;({ data, error } = await supabase.from('irrigation_lines').insert({ ...payload, created_by: user?.id || null }).select().single())
      if (error && /couleur|column/i.test(error.message)) {
        migrationHint = true
        const { couleur, ...fallback } = payload
        ;({ data, error } = await supabase.from('irrigation_lines').insert({ ...fallback, created_by: user?.id || null }).select().single())
      }
      if (!error) setIrrigationLines(prev => [...prev, data])
    }
    if (error) {
      alert(/relation|does not exist|could not find the table/i.test(error.message)
        ? 'Table manquante — exécute migration_A_EXECUTER_60.sql dans Supabase → SQL Editor.'
        : error.message)
      return
    }
    setEditingLine(null)
    showToast(migrationHint
      ? '✅ Ligne enregistrée (⚠️ couleur non enregistrée — exécute migration_A_EXECUTER_62.sql)'
      : '✅ Ligne du réseau enregistrée')
  }
  async function deleteIrrigationLine() {
    if (!confirm('Supprimer cette ligne ?')) return
    const { error } = await supabase.from('irrigation_lines').delete().eq('id', editingLine.id)
    if (error) { alert(error.message); return }
    setIrrigationLines(prev => prev.filter(l => l.id !== editingLine.id))
    setEditingLine(null)
    showToast('🗑️ Ligne supprimée')
  }

  function toggleSelect(parcelleId) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(parcelleId) ? next.delete(parcelleId) : next.add(parcelleId)
      return next
    })
  }
  function openIntervModal() {
    if (selectedIds.size === 0) { showToast('Sélectionnez d\'abord une ou plusieurs parcelles sur la carte 🎯'); return }
    setIntervDate(new Date().toISOString().split('T')[0])
    setIntervType('')
    setIntervSousType('')
    setIntervDefanage(false)
    setIntervRemarque('')
    setIntervFourrieres(false)
    setIntervRive(false)
    setIntervOutilIds([])
    setOutilsListeOuverte(false)
    setIntervLignes([{ produit_nom: '', produit_id: null, quantite: '', unite: 'L' }])
    setIntervPhotos([])
    const selectedParcelles = parcelles.filter(p => selectedIds.has(p.id))
    const defaults = {}
    selectedParcelles.forEach(p => { defaults[p.id] = p.surface != null ? String(p.surface) : '' })
    setIntervSurfaceHaByParcelle(defaults)
    setZonesByParcelle({})
    setDrawState(null)
    setDrawMode(false)
    setDrawingParcelleId(null)
    setIntervModalOpen(true)
  }

  // ── Dessin de la (ou des) zone(s) traitée(s) sur la carte, POUR UNE parcelle
  // précise (drawingParcelleId) — la sélection multiple des parcelles reste
  // intacte pendant ce temps, on choisit juste pour laquelle on dessine.
  // ParcellesMap permet de valider plusieurs formes successives avant "Terminer"
  // (bord de route, chemin, éoliennes…), chacune contrainte au contour réel de
  // cette parcelle. ──
  function startDrawFor(parcelleId) {
    setDrawingParcelleId(parcelleId)
    setDrawState(null)
    setIntervModalOpen(false) // on dessine sur la carte, la modale se rouvrira après
    setDrawMode(true)
  }
  function cancelDrawing() {
    mapRef.current?.cancelDraw()
    setDrawMode(false)
    if (redrawParcelleId) { setRedrawParcelleId(null); return }
    if (creatingParcelle) { setCreatingParcelle(false); return }
    setDrawingParcelleId(null)
    setIntervModalOpen(true)
  }
  function handleZoneDrawn(state) {
    setDrawState(state)
    if (state?.done) {
      if (redrawParcelleId) { finishRedrawParcelle(state); return }
      if (creatingParcelle) {
        setDrawMode(false)
        setCreatingParcelle(false)
        setNewParcelleModal({ nom: '', entite: '', commune: '', culture_actuelle: '', geometrie: state.geojson, surface: +state.ha.toFixed(2) })
        return
      }
      const pid = drawingParcelleId
      setZonesByParcelle(prev => ({ ...prev, [pid]: { shapes: state.shapes, ha: state.ha, geojson: state.geojson } }))
      setIntervSurfaceHaByParcelle(prev => ({ ...prev, [pid]: state.ha.toFixed(2) }))
      setDrawMode(false)
      setDrawingParcelleId(null)
      setIntervModalOpen(true) // on rouvre la modale, la zone est calculée
      const nom = parcelles.find(p => p.id === pid)?.nom || ''
      showToast(`✏️ ${nom} — ${state.shapes} forme(s), ${state.ha.toFixed(2)} ha`)
    }
  }
  // Démarre le redessin du contour réel d'une parcelle (admin uniquement) — le
  // contour existant n'est PAS pris comme limite (contrairement au dessin de
  // zone traitée), puisque c'est justement lui qu'on remplace.
  function startRedrawParcelle(p) {
    setEditing(null)
    setRedrawParcelleId(p.id)
    setDrawState(null)
    setDrawMode(true)
  }
  async function finishRedrawParcelle(state) {
    const pid = redrawParcelleId
    const nom = parcelles.find(p => p.id === pid)?.nom || ''
    setDrawMode(false)
    setRedrawParcelleId(null)
    const { error } = await supabase.from('parcelles').update({ geometrie: state.geojson }).eq('id', pid)
    if (error) { alert(error.message); return }
    showToast(`✅ Contour de "${nom}" redessiné (${state.ha.toFixed(2)} ha tracés)`)
    load()
  }
  // Dessine et crée une toute nouvelle parcelle (admin uniquement) — même
  // moteur libre que le redessin, mais insère une nouvelle ligne au lieu de
  // remplacer le contour d'une parcelle existante.
  function startNewParcelle() {
    setIrrigationDrawMode(false)
    setLineDrawMode(false)
    setInterventionDrawMode(false)
    setInterventionMode(false)
    setHeuresMode(false)
    setGroupMode(false)
    setSelectedIds(new Set())
    setEditing(null)
    setCreatingParcelle(true)
    setDrawState(null)
    setDrawMode(true)
  }
  function toggleNewParcelleDraw() {
    if (creatingParcelle) { cancelDrawing(); return }
    startNewParcelle()
  }
  async function saveNewParcelle() {
    const e = newParcelleModal
    if (!e.nom?.trim()) { alert('Nom obligatoire.'); return }
    const payload = {
      nom: e.nom.trim(), entite: e.entite?.trim() || null, commune: e.commune?.trim() || null,
      culture_actuelle: e.culture_actuelle?.trim() || null,
      surface: e.surface !== '' && e.surface != null ? +e.surface : null,
      geometrie: e.geometrie,
      campagne: campagneActive,
    }
    const { error } = await supabase.from('parcelles').insert(payload)
    if (error) { alert(error.message); return }
    setNewParcelleModal(null)
    showToast(`✅ Parcelle "${payload.nom}" créée${payload.surface != null ? ` (${payload.surface} ha)` : ''}`)
    load()
  }
  function clearZoneFor(parcelleId) {
    setZonesByParcelle(prev => { const n = { ...prev }; delete n[parcelleId]; return n })
  }
  function addLigne() {
    setIntervLignes(prev => [...prev, { produit_nom: '', produit_id: null, quantite: '', unite: 'L' }])
  }
  function removeLigne(i) {
    setIntervLignes(prev => prev.filter((_, idx) => idx !== i))
  }
  function updateLigne(i, patch) {
    setIntervLignes(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))
  }
  // Sélection d'un produit depuis la base (phyto ou intrant) : mémorise le lien
  // produit_id (pour le suivi de stock) et pré-remplit l'unité si connue.
  function selectLigneProduct(i, item, table) {
    const unite = table === 'db_phyto' ? (item.stock_unite || 'L') : (item.unite || 'kg')
    const nom = table === 'db_phyto' ? phytoDisplayName(item) : item.nom
    updateLigne(i, { produit_nom: nom, produit_id: item.id, unite })
    setOpenLigneDropdown(null)
  }

  // Écrit une intervention (même date + même type = un seul "événement") sur
  // toutes les parcelles sélectionnées, avec tous les produits saisis — elle
  // apparaîtra automatiquement dans la fiche parcellaire de chacune (Coût de
  // revient lit interventions_phyto par parcelle_id).
  async function saveIntervention() {
    if (!intervDate) { alert('Date obligatoire.'); return }
    if (!intervType.trim()) { alert('Type d\'intervention obligatoire.'); return }
    if (intervType === 'Travail du sol' && !intervSousType) { alert('Choisis le sous-type de travail du sol (déchaumage, décompactage, broyage, labour).'); return }
    // Certains types (Désherbage mécanique, Récolte, Irrigation, Travail du sol) n'ont
    // pas de base produit associée — le produit n'est alors pas obligatoire.
    const source = productSourceFor(intervType, phytoProducts, intrants)
    // Si l'utilisateur a tapé le nom exact d'un produit connu sans cliquer la
    // suggestion (produit_id resté vide), on le relie quand même à la base ici —
    // sinon la vérification d'homologation EPHY ne peut jamais s'appliquer.
    const validLignes = intervLignes.filter(l => l.produit_nom.trim()).map(l => {
      if (l.produit_id || !source) return l
      const typed = l.produit_nom.trim().toLowerCase()
      const match = source.items.find(it => it.nom.trim().toLowerCase() === typed
        || (source.table === 'db_phyto' && (it.nom_secondaire || '').trim().toLowerCase() === typed))
      return match ? { ...l, produit_id: match.id } : l
    })
    if (source && validLignes.length === 0) { alert('Ajoutez au moins un produit.'); return }
    const lignesToWrite = validLignes.length ? validLignes : [null]

    setSaving(true)
    const selectedParcelles = parcelles.filter(p => selectedIds.has(p.id))
    // Chaque parcelle a sa propre surface (et éventuellement ses propres zones
    // dessinées) — utile quand un même événement traite plusieurs parcelles
    // différemment (bord de route, chemin, éoliennes…).
    const rows = selectedParcelles.flatMap(p => {
      const surfaceHaParsed = parseFloat(intervSurfaceHaByParcelle[p.id])
      const surfaceHa = Number.isFinite(surfaceHaParsed) ? surfaceHaParsed : null
      const zoneGeo = zonesByParcelle[p.id]?.geojson || null
      return lignesToWrite.map(l => ({
        date: intervDate,
        produit_id: l?.produit_id || null,
        produit_nom: l?.produit_nom?.trim() || intervSousType || intervType,
        quantite: l ? (parseFloat(l.quantite) || null) : null,
        unite: l?.unite || null,
        culture: p.culture_actuelle || '',
        parcelle: p.nom,
        parcelle_id: p.id,
        observation: intervType,
        sous_type: intervType === 'Travail du sol' ? intervSousType : null,
        defanage: intervSousType === 'Broyage' ? intervDefanage : null,
        outil_ids: intervOutilIds.length ? intervOutilIds : null,
        campagne: campagneActive,
        surface_ha: surfaceHa,
        zone_geometrie: zoneGeo,
        remarque: intervRemarque?.trim() || null,
        fourrieres: intervFourrieres,
        rive: intervRive,
        photos: intervPhotos.length ? intervPhotos : null,
        user_id: user?.id || null,
      }))
    })

    let { error } = await supabase.from('interventions_phyto').insert(rows)
    let migrationHint = false
    if (error && /remarque|fourrieres|\brive\b|photos/i.test(error.message)) {
      ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(({ remarque, fourrieres, rive, photos, ...r }) => r)))
      if (!error) alert("Colonnes remarque/fourrières/rive/photos manquantes — exécute migration_A_EXECUTER_69.sql (et migration_A_EXECUTER_82.sql pour les photos) dans Supabase → SQL Editor pour pouvoir enregistrer ces informations. Intervention enregistrée sans.")
    }
    if (error && /surface_ha|zone_geometrie|sous_type|defanage|outil_ids|campagne|column/i.test(error.message)) {
      // colonnes pas encore créées (migration non exécutée) — on retente sans, pour ne pas bloquer la saisie
      migrationHint = true
      ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(({ surface_ha, zone_geometrie, sous_type, defanage, outil_ids, campagne, remarque, fourrieres, rive, photos, ...r }) => r)))
    }
    // produit_id référence uniquement Base de données > Phytosanitaires — un produit
    // choisi depuis Intrants (Ferti minérale, Semis, Plantation…) n'a pas d'id valide
    // pour cette colonne : on retente sans le lien (le nom du produit reste saisi en
    // texte libre) plutôt que de bloquer tout l'enregistrement.
    if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
      ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(r => ({ ...r, produit_id: null }))))
      if (!error) alert("Le(s) produit(s) choisi(s) depuis Intrants ne peuvent pas être liés à la Base de données sur cette colonne — enregistrés en texte libre à la place, sans lien direct.")
    }
    setSaving(false)
    if (error) { alert(error.message); return }
    setIntervModalOpen(false)
    setSelectedIds(new Set())
    setDrawState(null)
    setZonesByParcelle({})
    showToast(migrationHint
      ? `✅ Intervention enregistrée (⚠️ surface non enregistrée — exécute migration_A_EXECUTER_6.sql)`
      : `✅ Intervention enregistrée sur ${selectedParcelles.length} parcelle(s)`)
  }

  /* ── Heures d'arrachage ── */
  function openHeuresFor(parcelle, date = new Date().toISOString().split('T')[0]) {
    // Reprend les périodes déjà saisies pour cette parcelle ce jour-là (édition)
    const existing = heures.filter(h => h.date === date && (parcelle ? h.parcelle_id === parcelle.id : false))
    setEditingHeures({
      date,
      parcelle_id: parcelle?.id || '',
      parcelle_nom: parcelle?.nom || '',
      periodes: existing.length ? existing.map(h => ({ debut: h.debut, fin: h.fin || '' })) : [{ debut: '', fin: '' }],
      observation: existing[0]?.observation || '',
    })
  }
  async function saveHeures() {
    const e = editingHeures
    if (!e.parcelle_id) { alert('Choisis une parcelle.'); return }
    if (!e.date) { alert('Date obligatoire.'); return }
    const periodes = e.periodes.filter(p => p.debut)
    if (!periodes.length) { alert('Saisis au moins une heure de début.'); return }
    const parc = parcelles.find(p => p.id === e.parcelle_id)
    // Remplace les périodes du jour pour cette parcelle (édition simple)
    const { error: e1 } = await supabase.from('heures_arrachage').delete().eq('date', e.date).eq('parcelle_id', e.parcelle_id)
    if (e1) { alert(e1.message); return }
    const rows = periodes.map(p => ({
      date: e.date, parcelle_id: e.parcelle_id, parcelle_nom: parc?.nom || e.parcelle_nom,
      debut: p.debut, fin: p.fin || null, observation: e.observation?.trim() || null, user_id: user?.id || null,
    }))
    const { error: e2 } = await supabase.from('heures_arrachage').insert(rows)
    if (e2) {
      alert(/does not exist|relation|could not find the table/i.test(e2.message)
        ? 'Table heures_arrachage manquante — exécute migration_A_EXECUTER_4.sql dans Supabase → SQL Editor.'
        : e2.message)
      return
    }
    setEditingHeures(null)
    loadHeures()
    showToast('⏱️ Heures enregistrées')
  }
  async function deleteHeuresJour() {
    const e = editingHeures
    if (!confirm(`Supprimer toutes les heures du ${fmtDate(e.date)} sur ${e.parcelle_nom} ?`)) return
    await supabase.from('heures_arrachage').delete().eq('date', e.date).eq('parcelle_id', e.parcelle_id)
    setEditingHeures(null)
    loadHeures()
    showToast('🗑️ Heures supprimées')
  }

  // Regroupe les périodes par (date, parcelle) pour le tableau
  const heuresGroupes = Object.values(heures.reduce((map, h) => {
    const key = `${h.date}|${h.parcelle_id || h.parcelle_nom}`
    if (!map[key]) map[key] = { date: h.date, parcelle_id: h.parcelle_id, parcelle_nom: h.parcelle_nom, observation: h.observation, periodes: [] }
    map[key].periodes.push(h)
    return map
  }, {}))

  if (loading) return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Chargement de la carte…</div>

  const thS = { padding:'.5rem .8rem', fontSize:'.7rem', fontWeight:700, textAlign:'left', background:'var(--green-pale)', color:'var(--green-deep)', whiteSpace:'nowrap' }
  const tdS = { padding:'.5rem .8rem', fontSize:'.8rem', borderBottom:'1px solid var(--border)' }

  return (
    <div style={interventionMode
      // Plein écran par-dessus tout le reste de l'appli (menu/en-tête masqués derrière)
      // pendant le mode Intervention — plus de place pour sélectionner les parcelles
      // sur la carte. "✕ Quitter le mode Intervention" (barre de mode ci-dessous) ramène
      // à l'affichage normal.
      ? { position:'fixed', inset:0, zIndex:9000, background:'var(--white)', display:'flex', flexDirection:'column' }
      : { display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }
    }>
      {ToastEl}

      {/* Sous-onglets Carte / Tableau d'heures — masqués en mode Intervention plein écran */}
      {!interventionMode && (
      <div style={{ background:'white', borderBottom:'2px solid var(--border)', padding:'0 1rem', display:'flex', gap:'.25rem', flexShrink:0 }}>
        {[['carte','🗺️ Carte'], ...(canHeuresArrachage ? [['heures','⏱️ Tableau d\'heures']] : [])].map(([k,l]) => (
          <button key={k} onClick={() => setPageTab(k)} style={{
            padding:'.6rem 1rem', background:'none', border:'none',
            borderBottom: pageTab===k ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor:'pointer', fontSize:'.85rem', fontWeight: pageTab===k ? 700 : 500,
            color: pageTab===k ? 'var(--green-mid)' : 'var(--text-muted)', marginBottom:-2
          }}>{l}</button>
        ))}
      </div>
      )}

      {pageTab === 'carte' && (
        <>
          {/* Barre de mode — masquée en mode Intervention (remplacée par des boutons
              flottants directement sur la carte, voir plus bas) */}
          {!interventionMode && (
          <div style={{ padding:'.6rem 1.2rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'.7rem', flexWrap:'wrap' }}>
            <button className="btn-sm" onClick={toggleInterventionMode}>
              🧪 Intervention
            </button>
            {canHeuresArrachage && (
            <button className="btn-sm" onClick={() => { setHeuresMode(v => !v); setInterventionMode(false); setGroupMode(false); setSelectedIds(new Set()) }}
              style={heuresMode ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {heuresMode ? '✕ Quitter le mode Heures' : '⏱️ Heures d\'arrachage'}
            </button>
            )}
            {canGroupParcelles && (
            <button className="btn-sm" onClick={toggleGroupMode}
              style={groupMode ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {groupMode ? '✕ Quitter le mode Groupes' : '🔗 Grouper des parcelles'}
            </button>
            )}
            {groupMode && (
              <span style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                Clique plusieurs parcelles à fusionner visuellement pour les autres utilisateurs, puis "Former un groupe"
              </span>
            )}
            {heuresMode && (
              <span style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                Clique sur UNE parcelle pour saisir les heures d'arrachage du jour (début / fin / reprise…)
              </span>
            )}
            {isAdmin && (
            <button className="btn-sm" onClick={toggleNewParcelleDraw}
              style={creatingParcelle ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {creatingParcelle ? '✕ Quitter le dessin' : '➕ Nouvelle parcelle'}
            </button>
            )}
            {isAdmin && (
            <button className="btn-sm" onClick={toggleIrrigationDrawMode}
              style={irrigationDrawMode ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {irrigationDrawMode ? '✕ Quitter le placement' : '💧 Points d\'irrigation'}
            </button>
            )}
            {irrigationDrawMode && (
              <span style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                Clique sur la carte pour poser un point (bouche, vanne, puits) — affichage/masquage via le panneau des calques (en haut à droite)
              </span>
            )}
            {isAdmin && (
            <button className="btn-sm" onClick={toggleLineDrawMode}
              style={lineDrawMode ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {lineDrawMode ? '✕ Quitter le tracé' : '🚰 Réseau d\'irrigation'}
            </button>
            )}
            <button className="btn-sm" onClick={toggleInterventionDrawMode}
              style={interventionDrawMode ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)', fontWeight:700 } : {}}>
              {interventionDrawMode ? '✕ Quitter le placement' : '🔧 Marquer une intervention'}
            </button>
            {interventionDrawMode && (
              <span style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                Clique sur la carte pour marquer l'endroit — affichage/masquage via le panneau des calques
              </span>
            )}
          </div>
          )}

          <div style={{ flex:1, overflow:'hidden', position:'relative' }}>
            {/* Mode Intervention plein écran : seul le bouton "Quitter" flotte, seul,
                directement sur la carte — pas d'heures d'arrachage, pas d'onglets. Le
                compteur de sélection + "Annoter l'intervention" flottent à part, en bas,
                et n'apparaissent que si des parcelles sont sélectionnées (nécessaire pour
                pouvoir continuer, mais bien séparés du bouton Quitter). */}
            {interventionMode && (
              <>
                {/* bottom-left : zoom Leaflet = top-left, sélecteur de couches = top-right,
                    CultureLegend = bottom-right — seul le bas-gauche est vraiment libre.
                    Icône seule sur mobile (texte complet trop large, chevauchait le
                    panneau de sélection/annotation) ; décalé de la zone de geste du bas
                    (env(safe-area-inset-bottom)) pour ne pas gêner/être coupé. */}
                <button className="btn-sm" onClick={toggleInterventionMode} title="Quitter le mode Intervention" style={{
                  position:'absolute', bottom:'calc(10px + env(safe-area-inset-bottom))', left:12, zIndex:1000,
                  background:'var(--amber)', color:'white', borderColor:'var(--amber)', fontWeight:700,
                  boxShadow:'var(--shadow-md)', padding: isMobile ? '.5rem .6rem' : undefined,
                }}>
                  {isMobile ? '✕' : '✕ Quitter le mode Intervention'}
                </button>
                <div style={{
                  position:'absolute', bottom:'calc(10px + env(safe-area-inset-bottom))', zIndex:1000,
                  left: isMobile ? 56 : '50%', right: isMobile ? 12 : 'auto',
                  transform: isMobile ? 'none' : 'translateX(-50%)',
                  display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap', justifyContent:'center',
                  background:'white', borderRadius: isMobile ? 12 : 50, padding:'.4rem .5rem .4rem .8rem', boxShadow:'var(--shadow-md)',
                }}>
                  <span style={{ fontSize:'.78rem', color:'var(--text-muted)', whiteSpace:'nowrap' }}>
                    {selectedIds.size > 0 ? `${selectedIds.size} sélectionnée(s)` : 'Cliquez sur les parcelles à traiter'}
                  </span>
                  <button className="btn-sm" onClick={() => setParcelleListeOuverte(v => !v)}
                    style={parcelleListeOuverte ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)' } : {}}>
                    📋 {isMobile ? '' : 'Liste'}
                  </button>
                  {selectedIds.size > 0 && (
                    <button className="btn-sm" onClick={() => setSelectedIds(new Set())}>Désélectionner</button>
                  )}
                  <button className="btn-sm primary" onClick={openIntervModal} disabled={selectedIds.size === 0}>
                    + Annoter {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                  </button>
                </div>
              </>
            )}
            {/* Mode Groupes : sélectionne plusieurs parcelles puis les fusionne visuellement
                sous un seul nom pour tous les profils sauf admin/manager (voir
                hideParcelleDelimitations). Pas plein écran — juste une barre flottante,
                comme le mode Heures. */}
            {groupMode && (
              <div style={{
                position:'absolute', bottom:'calc(10px + env(safe-area-inset-bottom))', zIndex:1000,
                left:'50%', transform:'translateX(-50%)',
                display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap', justifyContent:'center',
                background:'white', borderRadius: isMobile ? 12 : 50, padding:'.4rem .5rem .4rem .8rem', boxShadow:'var(--shadow-md)',
                maxWidth: isMobile ? 'calc(100vw - 24px)' : 'none',
              }}>
                <span style={{ fontSize:'.78rem', color:'var(--text-muted)', whiteSpace:'nowrap' }}>
                  {selectedIds.size > 0 ? `${selectedIds.size} sélectionnée(s)` : 'Cliquez sur les parcelles à regrouper'}
                </span>
                {selectedIds.size > 0 && (
                  <>
                    <button className="btn-sm" onClick={() => setSelectedIds(new Set())}>Désélectionner</button>
                    {parcelles.some(p => selectedIds.has(p.id) && p.groupe_id) && (
                      <button className="btn-sm" onClick={removeFromGroup}>Retirer du groupe</button>
                    )}
                  </>
                )}
                <button className="btn-sm primary" onClick={openGroupModal} disabled={selectedIds.size < 2}>
                  🔗 Former un groupe {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                </button>
              </div>
            )}
            {/* Liste des parcelles (recherche) — alternative au clic direct sur la carte :
                cliquer une ligne sélectionne/désélectionne ET recentre la carte dessus
                (repère visuel avant d'annoter). En Modal (plutôt qu'un panneau flottant
                posé directement sur la carte) : un champ texte superposé au canevas
                Leaflet ne recevait pas le focus sur certains appareils. */}
            {interventionMode && parcelleListeOuverte && (() => {
              const parcellesFiltrees = parcelles
                .filter(p => p.nom.toLowerCase().includes(parcelleListeQ.toLowerCase()))
                .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
              return (
                <Modal title="📋 Choisir des parcelles" onClose={() => setParcelleListeOuverte(false)} maxWidth={420}>
                  <input autoFocus placeholder="🔍 Rechercher une parcelle…" value={parcelleListeQ}
                    onChange={e => setParcelleListeQ(e.target.value)}
                    style={{ width:'100%', padding:'.55rem .8rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', marginBottom:'.7rem' }} />
                  <div style={{ maxHeight:'50vh', overflowY:'auto', display:'flex', flexDirection:'column', gap:'.15rem' }}>
                    {parcellesFiltrees.length === 0 && (
                      <div style={{ padding:'1rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.8rem' }}>Aucune parcelle trouvée.</div>
                    )}
                    {parcellesFiltrees.map(p => {
                      const checked = selectedIds.has(p.id)
                      return (
                        <div key={p.id} onClick={() => { toggleSelect(p.id); mapRef.current?.focusParcelle(p.id) }}
                          style={{ display:'flex', alignItems:'center', gap:'.5rem', padding:'.5rem .6rem', borderRadius:8, cursor:'pointer', fontSize:'.85rem', background: checked ? 'var(--green-pale)' : 'transparent' }}
                          onMouseEnter={e => { if (!checked) e.currentTarget.style.background = '#f5f5f5' }}
                          onMouseLeave={e => { if (!checked) e.currentTarget.style.background = 'transparent' }}>
                          <span>{checked ? '✅' : '⬜'}</span>
                          <span style={{ flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.nom}</span>
                          {p.culture_actuelle && <span style={{ color:'var(--text-muted)', fontSize:'.76rem', flexShrink:0 }}>{p.culture_actuelle}</span>}
                        </div>
                      )
                    })}
                  </div>
                </Modal>
              )
            })()}
            {/* En mode Heures, le clic direct sur une parcelle (comme le mode
                Intervention) ouvre aussitôt la saisie — pas de popup intermédiaire. */}
            <ParcellesMap
              ref={mapRef}
              parcelles={parcelles}
              onSelect={openEditParcelle}
              onSelectGroup={openViewingGroup}
              hideEntite={parcellesReadOnly}
              readOnly={parcellesReadOnly}
              hideDelimitations={hideParcelleDelimitations}
              groupesById={groupesById}
              groupClickSelectsAll={!heuresMode}
              selectMode={interventionMode || heuresMode || groupMode}
              selectedIds={selectedIds}
              onToggleSelect={id => heuresMode ? openHeuresFor(parcelles.find(p => p.id === id)) : toggleSelect(id)}
              drawMode={drawMode}
              onZoneDrawn={handleZoneDrawn}
              drawBoundary={drawingParcelleId ? parcelles.find(p => p.id === drawingParcelleId)?.geometrie : null}
              irrigationPoints={irrigationPoints}
              irrigationDrawMode={irrigationDrawMode}
              onAddIrrigationPoint={handleAddIrrigationPoint}
              onSelectIrrigationPoint={handleSelectIrrigationPoint}
              onMoveIrrigationPoint={handleMoveIrrigationPoint}
              canEditIrrigation={isAdmin}
              irrigationLines={irrigationLines}
              lineDrawMode={lineDrawMode}
              onLineDrawn={handleLineDrawn}
              onSelectIrrigationLine={handleSelectIrrigationLine}
              interventionPoints={interventionPoints}
              interventionDrawMode={interventionDrawMode}
              onAddInterventionPoint={handleAddInterventionPoint}
              onSelectInterventionPoint={handleSelectInterventionPoint}
              onMoveInterventionPoint={handleMoveInterventionPoint}
            />
            <CultureLegend codes={parcelles.flatMap(p => [p.culture_actuelle, p.culture_precedente])} />

            {/* Panneau flottant de dessin de la/les zone(s) traitée(s) (la modale
                d'intervention est temporairement masquée pendant qu'on trace sur la
                carte — la sélection des parcelles, elle, ne bouge pas) : "Valider
                cette forme" fige un polygone (vert) et permet d'en tracer un autre
                (bord de route, chemin, éoliennes…) avant de Terminer. */}
            {drawMode && (
              <div style={{
                position:'absolute', top:12, left:'50%', transform:'translateX(-50%)', zIndex:1000,
                background:'white', border:'1.5px solid var(--amber)', borderRadius:12, padding:'.8rem 1.1rem',
                boxShadow:'var(--shadow-md)', display:'flex', flexDirection:'column', gap:'.5rem', maxWidth:460,
              }}>
                <span style={{ fontSize:'.82rem', fontWeight:600 }}>
                  {redrawParcelleId
                    ? <>🖊️ Nouveau contour pour <strong>{parcelles.find(p => p.id === redrawParcelleId)?.nom}</strong> — cliquez pour poser des points, glissez-les pour ajuster (libre, non contraint)</>
                    : creatingParcelle
                    ? <>➕ Nouvelle parcelle — cliquez pour poser les points du contour, glissez-les pour ajuster (libre, non contraint)</>
                    : <>✏️ Zone(s) pour <strong>{parcelles.find(p => p.id === drawingParcelleId)?.nom}</strong> — cliquez pour poser des points, glissez-les pour ajuster (bloqués dans la parcelle)</>}
                </span>
                <div style={{ fontSize:'.76rem', color:'var(--text-muted)' }}>
                  Forme en cours : {drawState?.points || 0} point{(drawState?.points || 0) > 1 ? 's' : ''}
                </div>
                {drawState?.shapes > 0 && (
                  <div style={{ display:'flex', flexDirection:'column', gap:'.25rem' }}>
                    {drawState.shapesList.map((sh, i) => (
                      <div key={i} style={{ display:'flex', alignItems:'center', gap:'.5rem', fontSize:'.76rem', background:'var(--cream)', borderRadius:6, padding:'.25rem .55rem' }}>
                        <span style={{ flex:1 }}>Forme {i + 1} — {sh.ha.toFixed(2)} ha</span>
                        <button className="btn-sm" onClick={() => mapRef.current?.removeShapeAt(i)} style={{ color:'var(--red)', padding:'.1rem .4rem' }} title="Supprimer cette forme">✕</button>
                      </div>
                    ))}
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', fontWeight:600 }}>
                      Total : {(drawState.committedHa || 0).toFixed(2)} ha
                    </div>
                  </div>
                )}
                <div style={{ display:'flex', gap:'.4rem', flexWrap:'wrap' }}>
                  <button className="btn-sm" onClick={() => mapRef.current?.undoLastPoint()} disabled={!drawState?.points}>↩ Dernier point</button>
                  <button className="btn-sm" onClick={() => mapRef.current?.commitShape()} disabled={!drawState?.points || drawState.points < 3}>
                    ✓ Valider cette forme
                  </button>
                  <button className="btn-sm" onClick={cancelDrawing} style={{ color:'var(--red)', marginLeft:'auto' }}>Annuler</button>
                  <button className="btn-sm primary" onClick={() => mapRef.current?.finishDraw()}
                    disabled={!(drawState?.shapes > 0 || (drawState?.points || 0) >= 3)}>
                    ✓✓ Terminer
                  </button>
                </div>
              </div>
            )}

            {/* Panneau flottant de tracé du réseau d'irrigation — même principe que
                le dessin de zone, mais une simple ligne (pas de fermeture en polygone,
                pas de contrainte au contour d'une parcelle). */}
            {lineDrawMode && (
              <div style={{
                position:'absolute', top:12, left:'50%', transform:'translateX(-50%)', zIndex:1000,
                background:'white', border:'1.5px solid var(--amber)', borderRadius:12, padding:'.8rem 1.1rem',
                boxShadow:'var(--shadow-md)', display:'flex', flexDirection:'column', gap:'.5rem', maxWidth:460,
              }}>
                <span style={{ fontSize:'.82rem', fontWeight:600 }}>
                  {splittingParcelleId
                    ? <>✂️ Ligne de coupe pour <strong>{parcelles.find(p => p.id === splittingParcelleId)?.nom}</strong> — tracez une ligne qui traverse la parcelle de part en part</>
                    : reshapingLineId ? '🖊️ Modification du tracé' : '🚰 Tracé du réseau d\'irrigation — cliquez pour poser des points, glissez-les pour ajuster (libre, non contraint)'}
                </span>
                <div style={{ fontSize:'.76rem', color:'var(--text-muted)' }}>
                  {lineDrawState?.points || 0} point{(lineDrawState?.points || 0) > 1 ? 's' : ''}
                </div>
                <div style={{ display:'flex', gap:'.4rem', flexWrap:'wrap' }}>
                  <button className="btn-sm" onClick={() => mapRef.current?.undoLastLinePoint()} disabled={!lineDrawState?.points}>↩ Dernier point</button>
                  <button className="btn-sm" onClick={() => { if (splittingParcelleId) { cancelSplitDraw(); return } mapRef.current?.cancelLineDraw(); setLineDrawMode(false); setLineDrawState(null); setReshapingLineId(null) }} style={{ color:'var(--red)', marginLeft:'auto' }}>Annuler</button>
                  <button className="btn-sm primary" onClick={() => mapRef.current?.finishLineDraw()} disabled={!lineDrawState?.points || lineDrawState.points < 2}>
                    ✓✓ Terminer
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {pageTab === 'heures' && (
        <div style={{ flex:1, overflow:'auto', padding:'1rem 1.2rem' }}>
          {heuresMissing ? (
            <div style={{ background:'var(--amber-pale)', border:'1.5px solid var(--amber)', borderRadius:10, padding:'1rem 1.4rem', fontSize:'.85rem' }}>
              ⚠️ Table <strong>heures_arrachage</strong> manquante — exécute <code>migration_A_EXECUTER_4.sql</code> dans Supabase → SQL Editor, puis recharge la page.
            </div>
          ) : (
            <>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.8rem', flexWrap:'wrap', gap:'.5rem' }}>
                <span style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>
                  Heures d'arrachage par parcelle — chaque jour peut avoir plusieurs périodes (début / arrêt / reprise / arrêt).
                </span>
                <button className="btn-sm primary" onClick={() => openHeuresFor(null)}>+ Saisie d'heures</button>
              </div>
              {heuresGroupes.length === 0 ? (
                <div style={{ textAlign:'center', color:'var(--text-muted)', padding:'2.5rem', fontStyle:'italic' }}>
                  Aucune heure saisie — clique "+ Saisie d'heures" ou utilise le mode ⏱️ sur la carte.
                </div>
              ) : (
                <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
                  <div style={{ overflowX:'auto' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', minWidth:560 }}>
                      <thead><tr>
                        <th style={thS}>Date</th><th style={thS}>Parcelle</th><th style={thS}>Périodes</th>
                        <th style={{ ...thS, textAlign:'right' }}>Total</th><th style={thS}>Observation</th>
                      </tr></thead>
                      <tbody>
                        {heuresGroupes.map(g => {
                          const total = g.periodes.reduce((s, p) => s + periodeHeures(p.debut, p.fin), 0)
                          const enCours = g.periodes.some(p => !p.fin)
                          return (
                            <tr key={`${g.date}-${g.parcelle_id}`} style={{ cursor:'pointer' }}
                              onClick={() => openHeuresFor(parcelles.find(p => p.id === g.parcelle_id) || { id: g.parcelle_id, nom: g.parcelle_nom }, g.date)}
                              onMouseEnter={e => e.currentTarget.style.background='var(--green-pale)'}
                              onMouseLeave={e => e.currentTarget.style.background=''}>
                              <td style={{ ...tdS, whiteSpace:'nowrap' }}>{new Date(g.date + 'T00:00:00').toLocaleDateString('fr-FR')}</td>
                              <td style={{ ...tdS, fontWeight:600 }}>{g.parcelle_nom || '—'}</td>
                              <td style={tdS}>
                                {g.periodes.map((p, i) => (
                                  <span key={i} style={{ display:'inline-block', marginRight:'.5rem', padding:'.1rem .5rem', borderRadius:50, background: p.fin ? 'var(--cream)' : 'var(--amber-pale)', fontSize:'.75rem', fontWeight:600 }}>
                                    {p.debut} → {p.fin || 'en cours…'}
                                  </span>
                                ))}
                              </td>
                              <td style={{ ...tdS, textAlign:'right', fontWeight:700, color: enCours ? 'var(--amber)' : 'var(--green-mid)', whiteSpace:'nowrap' }}>
                                {fmtHeures(total)}{enCours ? ' ⏳' : ''}
                              </td>
                              <td style={{ ...tdS, color:'var(--text-muted)' }}>{g.observation || ''}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Modal fiche parcelle (mode normal) */}
      {editing && (
        <Modal title={editing.nom} onClose={()=>setEditing(null)} onSave={parcellesReadOnly ? null : save} maxWidth={480}>
          <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group"><label>Nom</label><input disabled={parcellesReadOnly} value={editing.nom||''} onChange={e=>setEditing({...editing, nom:e.target.value})} /></div>
            {!parcellesReadOnly && (
            <div className="form-group"><label>Entité</label><input value={editing.entite||''} onChange={e=>setEditing({...editing, entite:e.target.value})} /></div>
            )}
            <div className="form-group"><label>Surface (ha)</label><input disabled={parcellesReadOnly} type="number" step="0.01" value={editing.surface??''} onChange={e=>setEditing({...editing, surface: e.target.value ? +e.target.value : null})} /></div>
            <div className="form-group"><label>Commune</label><input disabled={parcellesReadOnly} value={editing.commune||''} onChange={e=>setEditing({...editing, commune:e.target.value})} /></div>
            <div className="form-group"><label>Culture actuelle</label><input disabled={parcellesReadOnly} value={editing.culture_actuelle||''} onChange={e=>setEditing({...editing, culture_actuelle:e.target.value})} /></div>
            <div className="form-group"><label>Culture précédente</label><input disabled={parcellesReadOnly} value={editing.culture_precedente||''} onChange={e=>setEditing({...editing, culture_precedente:e.target.value})} /></div>
          </div>

          {isAdmin && (
            <div style={{ marginTop:'.9rem', display:'flex', gap:'.5rem', flexWrap:'wrap' }}>
              <button className="btn-sm" onClick={() => startRedrawParcelle(editing)} title="Retrace entièrement l'emplacement de cette parcelle sur la carte">
                🖊️ Redessiner cette parcelle
              </button>
              <button className="btn-sm" onClick={() => startSplitParcelle(editing)} title="Trace une ligne pour couper cette parcelle en plusieurs morceaux">
                ✂️ Diviser cette parcelle
              </button>
            </div>
          )}

          <div style={{ marginTop:'1.2rem', paddingTop:'1rem', borderTop:'1px solid var(--border)' }}>
            <div style={{ fontSize:'.8rem', fontWeight:700, color:'var(--text-muted)', marginBottom:'.5rem' }}>
              🔄 Interventions sur cette parcelle ({editingInterventions.length})
            </div>
            {editingInterventions.length === 0 ? (
              <div style={{ fontSize:'.8rem', color:'var(--text-muted)', fontStyle:'italic' }}>Aucune intervention enregistrée.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'.4rem', maxHeight:280, overflowY:'auto' }}>
                {sortGroupsByDateDesc(groupInterventions(editingInterventions)).map((g, gi) => {
                  const produitNoms = g.items.map(it => it.produit_nom).filter(Boolean)
                  return (
                  <div key={gi} onClick={() => openChampGroup(g)}
                    style={{ display:'flex', flexDirection:'column', gap:'.2rem', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem', cursor:'pointer' }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}>
                    <div style={{ display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap' }}>
                      <span style={{ fontSize:'.68rem', color:'var(--text-muted)', whiteSpace:'nowrap', flexShrink:0 }}>{fmtDate(g.date)}</span>
                      <span style={{ fontWeight:600, fontSize:'.8rem', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {intervTypeLabel({ observation: g.type, sous_type: g.sous_type, defanage: g.defanage })}
                      </span>
                      <span style={{ fontSize:'.7rem', color:'var(--text-muted)', flexShrink:0 }}>{g.items.length} produit{g.items.length>1?'s':''}</span>
                      {g.items[0]?.user_id && (
                        <span style={{ fontSize:'.68rem', color:'var(--text-muted)', flexShrink:0, whiteSpace:'nowrap' }}>👤 {nameOf(g.items[0].user_id)}</span>
                      )}
                      <span style={{ fontSize:'.72rem', color:'var(--green-mid)', flexShrink:0 }}>✏️</span>
                    </div>
                    {produitNoms.length > 0 && (
                      <div style={{ fontSize:'.74rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {produitNoms.join(', ')}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </Modal>
      )}

      {newParcelleModal && (
        <Modal title="Nouvelle parcelle" onClose={() => setNewParcelleModal(null)} onSave={saveNewParcelle} maxWidth={480}>
          <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginBottom:'.8rem' }}>
            📐 Contour tracé — {newParcelleModal.surface} ha
          </div>
          <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}><label>Nom *</label>
              <input autoFocus value={newParcelleModal.nom} onChange={e=>setNewParcelleModal({...newParcelleModal, nom:e.target.value})} />
            </div>
            <div className="form-group"><label>Entité</label>
              <input value={newParcelleModal.entite} onChange={e=>setNewParcelleModal({...newParcelleModal, entite:e.target.value})} />
            </div>
            <div className="form-group"><label>Surface (ha)</label>
              <input type="number" step="0.01" value={newParcelleModal.surface} onChange={e=>setNewParcelleModal({...newParcelleModal, surface: e.target.value ? +e.target.value : null})} />
            </div>
            <div className="form-group"><label>Commune</label>
              <input value={newParcelleModal.commune} onChange={e=>setNewParcelleModal({...newParcelleModal, commune:e.target.value})} />
            </div>
            <div className="form-group"><label>Culture actuelle</label>
              <input value={newParcelleModal.culture_actuelle} onChange={e=>setNewParcelleModal({...newParcelleModal, culture_actuelle:e.target.value})} />
            </div>
          </div>
        </Modal>
      )}

      {splitPreview && (
        <Modal title={`✂️ Diviser "${splitPreview.parcelle.nom}"`} onClose={() => setSplitPreview(null)} onSave={confirmSplit} maxWidth={480}>
          <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginBottom:'.9rem' }}>
            {splitPreview.pieces.length} morceaux détectés — le premier garde le nom et l'historique (interventions, coût de revient…) de la parcelle d'origine ; les autres seront créés comme de nouvelles parcelles.
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:'.6rem' }}>
            {splitPreview.pieces.map((pc, i) => (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:'.6rem', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem' }}>
                <span style={{ fontSize:'1.1rem' }}>{i === 0 ? '🟢' : '🆕'}</span>
                <input value={pc.nom} onChange={e => updateSplitPieceNom(i, e.target.value)} style={{ flex:1 }} placeholder="Nom du morceau" />
                <span style={{ fontSize:'.78rem', color:'var(--text-muted)', whiteSpace:'nowrap' }}>{pc.areaHa.toFixed(2)} ha</span>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* Vue d'une parcelle groupée cliquée sur la carte (utilisateur non
          admin/manager, délimitations masquées) — se comporte comme une vraie
          parcelle : juste le nom et la surface, avec ses interventions
          consultables et modifiables (voir openViewingGroup/Champ ci-dessus). */}
      {viewingGroup && (
        <Modal title={viewingGroup.nom} onClose={() => setViewingGroup(null)} maxWidth={480}>
          <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group"><label>Nom</label><input disabled value={viewingGroup.nom} /></div>
            <div className="form-group"><label>Surface (ha)</label>
              <input disabled value={viewingGroup.members.reduce((s, m) => s + (parseFloat(m.surface) || 0), 0).toFixed(2)} />
            </div>
          </div>

          <div style={{ marginTop:'1.2rem', paddingTop:'1rem', borderTop:'1px solid var(--border)' }}>
            <div style={{ fontSize:'.8rem', fontWeight:700, color:'var(--text-muted)', marginBottom:'.5rem' }}>
              🔄 Interventions sur cette parcelle ({viewingGroupInterventions.length})
            </div>
            {viewingGroupInterventions.length === 0 ? (
              <div style={{ fontSize:'.8rem', color:'var(--text-muted)', fontStyle:'italic' }}>Aucune intervention enregistrée.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'.4rem', maxHeight:280, overflowY:'auto' }}>
                {sortGroupsByDateDesc(groupInterventions(viewingGroupInterventions)).map((g, gi) => {
                  const produitNoms = g.items.map(it => it.produit_nom).filter(Boolean)
                  return (
                  <div key={gi} onClick={() => openViewingGroupChamp(g)}
                    style={{ display:'flex', flexDirection:'column', gap:'.2rem', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem', cursor:'pointer' }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}>
                    <div style={{ display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap' }}>
                      <span style={{ fontSize:'.68rem', color:'var(--text-muted)', whiteSpace:'nowrap', flexShrink:0 }}>{fmtDate(g.date)}</span>
                      <span style={{ fontWeight:600, fontSize:'.8rem', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {intervTypeLabel({ observation: g.type, sous_type: g.sous_type, defanage: g.defanage })}
                      </span>
                      <span style={{ fontSize:'.7rem', color:'var(--text-muted)', flexShrink:0 }}>{g.items.length} produit{g.items.length>1?'s':''}</span>
                      {g.items[0]?.user_id && (
                        <span style={{ fontSize:'.68rem', color:'var(--text-muted)', flexShrink:0, whiteSpace:'nowrap' }}>👤 {nameOf(g.items[0].user_id)}</span>
                      )}
                      <span style={{ fontSize:'.72rem', color:'var(--green-mid)', flexShrink:0 }}>✏️</span>
                    </div>
                    {produitNoms.length > 0 && (
                      <div style={{ fontSize:'.74rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {produitNoms.join(', ')}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </Modal>
      )}

      {editingChampGroup && (
        <InterventionChampEditModal
          event={editingChampGroup}
          title={viewingGroup ? `Modifier — ${viewingGroup.nom}` : undefined}
          parcelleTargets={editingChampGroup.parcelleTargets}
          onClose={() => setEditingChampGroup(null)}
          onSaved={() => { if (editing) reloadInterventionsFor(editing.id); if (viewingGroup) reloadViewingGroupInterventions(viewingGroup.members.map(m => m.id)) }}
          onDeleted={() => { if (editing) reloadInterventionsFor(editing.id); if (viewingGroup) reloadViewingGroupInterventions(viewingGroup.members.map(m => m.id)) }}
        />
      )}

      {/* Modal de nommage du groupe de parcelles */}
      {groupModal && (
        <Modal title={groupModal.reuseGroupId ? 'Renommer / compléter le groupe' : 'Former un groupe de parcelles'}
          onClose={() => setGroupModal(null)} onSave={saveGroup} saveLabel="Enregistrer" maxWidth={420}>
          <div className="form-group">
            <label>Nom du groupe *</label>
            <input autoFocus value={groupModal.nom} onChange={e => setGroupModal({ ...groupModal, nom: e.target.value })} placeholder="ex. Les Jacquemards" />
          </div>
          <p style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: '.6rem' }}>
            {groupModal.mergingMultiple
              ? "Les parcelles sélectionnées appartiennent à plusieurs groupes différents — elles seront réunies dans un nouveau groupe sous ce nom (les autres membres de leurs anciens groupes n'en font pas partie)."
              : `Les ${groupModal.memberIds.length} parcelle(s) sélectionnée(s) n'afficheront plus qu'un seul nom, "${groupModal.nom || '…'}", sans délimitation entre elles pour tous les utilisateurs sauf l'admin et les managers.`}
          </p>
        </Modal>
      )}

      {/* Modal point d'irrigation (nouveau ou existant) */}
      {editingIrrigation && (
        <Modal title={editingIrrigation.id ? 'Modifier le point' : 'Nouveau point d\'irrigation'} onClose={() => setEditingIrrigation(null)}
          onSave={saveIrrigationPoint} onDelete={editingIrrigation.id ? deleteIrrigationPoint : null} maxWidth={420}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            <div className="form-group">
              <label>Type *</label>
              <select value={editingIrrigation.type} onChange={e => setEditingIrrigation({ ...editingIrrigation, type: e.target.value })}>
                {Object.entries(IRRIGATION_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Nom / repère</label>
              <input autoFocus value={editingIrrigation.nom || ''} onChange={e => setEditingIrrigation({ ...editingIrrigation, nom: e.target.value })} placeholder="ex. Bouche Marais Nord" />
            </div>
            <div className="form-group"><label>Notes</label>
              <textarea rows={3} value={editingIrrigation.notes || ''} onChange={e => setEditingIrrigation({ ...editingIrrigation, notes: e.target.value })}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal ligne du réseau d'irrigation (nouvelle ou existante) */}
      {editingLine && (
        <Modal title={editingLine.id ? 'Modifier la ligne' : 'Nouvelle ligne d\'irrigation'} onClose={() => setEditingLine(null)}
          onSave={saveIrrigationLine} onDelete={editingLine.id ? deleteIrrigationLine : null} maxWidth={420}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            {editingLine.longueur_m != null && (
              <div style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>📏 Longueur : {editingLine.longueur_m.toFixed(0)} m</div>
            )}
            <div className="form-group">
              <label>Couleur du tracé</label>
              <div style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
                <input autoFocus type="color" value={editingLine.couleur || '#2980b9'} onChange={e => setEditingLine({ ...editingLine, couleur: e.target.value })}
                  style={{ width:40, height:32, padding:0, border:'1px solid var(--border)', borderRadius:6, cursor:'pointer' }} />
                <div style={{ display:'flex', gap:'.35rem' }}>
                  {['#2980b9','#27ae60','#e74c3c','#f39c12','#8e44ad','#2c3e50'].map(c => (
                    <button key={c} type="button" onClick={() => setEditingLine({ ...editingLine, couleur: c })}
                      title={c} style={{
                        width:22, height:22, borderRadius:'50%', background:c, cursor:'pointer', padding:0,
                        border: (editingLine.couleur || '#2980b9') === c ? '2px solid var(--ink)' : '1px solid rgba(0,0,0,.2)',
                      }} />
                  ))}
                </div>
              </div>
            </div>
            <div className="form-group"><label>Notes</label>
              <textarea rows={3} value={editingLine.notes || ''} onChange={e => setEditingLine({ ...editingLine, notes: e.target.value })}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
            {editingLine.id && (
              <button type="button" className="btn-sm" onClick={() => startReshapeLine(editingLine)}>
                🖊️ Modifier le tracé
              </button>
            )}
          </div>
        </Modal>
      )}

      {/* Modal point d'intervention libre (nouveau ou existant) */}
      {editingInterventionPoint && (
        <Modal title={editingInterventionPoint.id ? 'Modifier l\'intervention' : 'Nouvelle intervention'} onClose={() => setEditingInterventionPoint(null)}
          onSave={saveInterventionPoint} onDelete={editingInterventionPoint.id ? deleteInterventionPoint : null} maxWidth={420}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            <div className="form-group"><label>Date</label>
              <input type="date" value={editingInterventionPoint.date_intervention || ''} onChange={e => setEditingInterventionPoint({ ...editingInterventionPoint, date_intervention: e.target.value })} />
            </div>
            <div className="form-group"><label>Description</label>
              <input autoFocus value={editingInterventionPoint.description || ''} onChange={e => setEditingInterventionPoint({ ...editingInterventionPoint, description: e.target.value })} placeholder="ex. Fuite réparée, arbre abattu…" />
            </div>
            <div className="form-group"><label>Notes</label>
              <textarea rows={3} value={editingInterventionPoint.notes || ''} onChange={e => setEditingInterventionPoint({ ...editingInterventionPoint, notes: e.target.value })}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal saisie des heures d'arrachage (parcelle UNIQUE) */}
      {editingHeures && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setEditingHeures(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-hdr">
              <h3>⏱️ Heures d'arrachage{editingHeures.parcelle_nom ? ` — ${editingHeures.parcelle_nom}` : ''}</h3>
              <button className="modal-close" onClick={() => setEditingHeures(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ overflowY:'auto', maxHeight:'65vh' }}>
              <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem', marginBottom:'.9rem' }}>
                <div className="form-group">
                  <label>Date *</label>
                  <input type="date" value={editingHeures.date} onChange={e=>setEditingHeures({...editingHeures, date:e.target.value})} />
                </div>
                <div className="form-group">
                  <label>Parcelle * (unique)</label>
                  <select value={editingHeures.parcelle_id}
                    onChange={e => {
                      const p = parcelles.find(x => x.id === e.target.value)
                      setEditingHeures({ ...editingHeures, parcelle_id: e.target.value, parcelle_nom: p?.nom || '' })
                    }}>
                    <option value="">— Choisir —</option>
                    {parcelles.map(p => <option key={p.id} value={p.id}>{p.nom}{!parcellesReadOnly && p.entite ? ` · ${p.entite}` : ''}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ fontSize:'.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', marginBottom:'.4rem' }}>
                Périodes de travail
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:'.5rem', marginBottom:'.7rem' }}>
                {editingHeures.periodes.map((p, i) => (
                  <div key={i} style={{ display:'flex', gap:'.45rem', alignItems:'center' }}>
                    <span style={{ fontSize:'.72rem', color:'var(--text-muted)', width:52 }}>{i === 0 ? 'Début' : 'Reprise'}</span>
                    <input type="time" value={p.debut} style={{ flex:1 }}
                      onChange={e => setEditingHeures(h => ({ ...h, periodes: h.periodes.map((x, idx) => idx===i ? { ...x, debut: e.target.value } : x) }))} />
                    <button className="btn-sm" title="Maintenant" style={{ padding:'.25rem .4rem', fontSize:'.66rem' }}
                      onClick={() => setEditingHeures(h => ({ ...h, periodes: h.periodes.map((x, idx) => idx===i ? { ...x, debut: nowHM() } : x) }))}>⏱</button>
                    <span style={{ color:'var(--text-muted)' }}>→</span>
                    <input type="time" value={p.fin} style={{ flex:1 }}
                      onChange={e => setEditingHeures(h => ({ ...h, periodes: h.periodes.map((x, idx) => idx===i ? { ...x, fin: e.target.value } : x) }))} />
                    <button className="btn-sm" title="Maintenant" style={{ padding:'.25rem .4rem', fontSize:'.66rem' }}
                      onClick={() => setEditingHeures(h => ({ ...h, periodes: h.periodes.map((x, idx) => idx===i ? { ...x, fin: nowHM() } : x) }))}>⏱</button>
                    <button onClick={() => setEditingHeures(h => ({ ...h, periodes: h.periodes.filter((_, idx) => idx !== i) }))}
                      disabled={editingHeures.periodes.length === 1}
                      style={{ background:'none', border:'none', cursor: editingHeures.periodes.length===1?'not-allowed':'pointer', color:'var(--red)', opacity: editingHeures.periodes.length===1?.3:1 }}>✕</button>
                  </div>
                ))}
              </div>
              <button className="btn-sm" onClick={() => setEditingHeures(h => ({ ...h, periodes: [...h.periodes, { debut: '', fin: '' }] }))}>
                + Reprise (nouvelle période)
              </button>
              <div style={{ marginTop:'.6rem', fontSize:'.8rem', color:'var(--green-mid)', fontWeight:600 }}>
                Total : {fmtHeures(editingHeures.periodes.reduce((s, p) => s + periodeHeures(p.debut, p.fin), 0))}
              </div>
              <div className="form-group" style={{ marginTop:'.7rem' }}>
                <label>Observation</label>
                <input value={editingHeures.observation||''} onChange={e=>setEditingHeures({...editingHeures, observation:e.target.value})} placeholder="ex. panne, météo…" />
              </div>
            </div>
            <div className="modal-foot">
              {editingHeures.parcelle_id && heures.some(h => h.date === editingHeures.date && h.parcelle_id === editingHeures.parcelle_id) && (
                <button className="btn-danger" onClick={deleteHeuresJour}>Supprimer</button>
              )}
              <button className="btn-sm" onClick={() => setEditingHeures(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={saveHeures}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}

      {/* Saisie d'intervention (mode Intervention) — plein écran pour un meilleur
          confort de saisie (beaucoup de champs : outils, surfaces par parcelle,
          produits…) ; un seul bouton pour revenir en arrière ("Annuler"), pas de
          ✕ redondant. */}
      {intervModalOpen && (
        <div style={{ position:'fixed', inset:0, zIndex:9000, background:'var(--white)', display:'flex', flexDirection:'column' }}>
          <div style={{
            background: 'linear-gradient(135deg, var(--soil), var(--soil-light))', color:'white', flexShrink:0,
            padding:'calc(1rem + env(safe-area-inset-top)) 1.5rem 1rem', display:'flex', alignItems:'center', justifyContent:'space-between', gap:'1rem',
          }}>
            <h3 style={{ fontSize:'1.05rem', fontWeight:700 }}>🧪 Intervention sur {selectedIds.size} parcelle(s)</h3>
            <button className="btn-sm" onClick={() => setIntervModalOpen(false)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', flexShrink:0 }}>Annuler</button>
          </div>
            <div style={{ flex:1, overflowY:'auto', padding:'1.2rem 1.5rem' }}>
              <div style={{ background:'var(--cream)', borderRadius:8, padding:'.6rem .9rem', marginBottom:'1rem', fontSize:'.8rem' }}>
                {parcelles.filter(p => selectedIds.has(p.id)).map(p => p.nom).join(', ')}
              </div>
              <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem', marginBottom:'1rem' }}>
                <div className="form-group">
                  <label>Date *</label>
                  <input type="date" value={intervDate} onChange={e=>setIntervDate(e.target.value)} />
                </div>
                <div className="form-group">
                  <label>Type d'intervention *</label>
                  <select value={intervType} onChange={e=>{ setIntervType(e.target.value); setIntervSousType(''); setIntervDefanage(false) }}>
                    <option value="">-- Choisir --</option>
                    {TYPES_INTERVENTION.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {intervType === 'Travail du sol' && (
                  <div className="form-group">
                    <label>Sous-type *</label>
                    <select value={intervSousType} onChange={e=>{ setIntervSousType(e.target.value); setIntervDefanage(false) }}>
                      <option value="">-- Choisir --</option>
                      {SOUS_TYPES_TRAVAIL_SOL.map(s=><option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                {intervSousType === 'Broyage' && (
                  <div className="form-group">
                    <label>&nbsp;</label>
                    <label style={{ display:'flex', alignItems:'center', gap:'.5rem', fontWeight:500, cursor:'pointer' }}>
                      <input type="checkbox" checked={intervDefanage} onChange={e=>setIntervDefanage(e.target.checked)} />
                      Défanage effectué au même passage
                    </label>
                  </div>
                )}
              </div>

              <div className="form-group" style={{ marginBottom:'1rem' }}>
                <label>Zone de la parcelle concernée (optionnel)</label>
                <div style={{ display:'flex', gap:'1.2rem' }}>
                  <label style={{ display:'flex', alignItems:'center', gap:'.5rem', fontWeight:500, cursor:'pointer' }}>
                    <input type="checkbox" checked={intervFourrieres} onChange={e=>setIntervFourrieres(e.target.checked)} />
                    Fourrières
                  </label>
                  <label style={{ display:'flex', alignItems:'center', gap:'.5rem', fontWeight:500, cursor:'pointer' }}>
                    <input type="checkbox" checked={intervRive} onChange={e=>setIntervRive(e.target.checked)} />
                    Rive
                  </label>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom:'1rem' }}>
                {(() => {
                  // Enrouleurs d'irrigation — pas de traçabilité prévue sur la carte
                  // pour ceux-là, on ne les propose pas ici.
                  const outilsSelectionnables = outils.filter(o => o.type !== 'Enrouleur')
                  if (outilsSelectionnables.length === 0) {
                    return (
                      <>
                        <label>Outils utilisés (optionnel)</label>
                        <span style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>Aucun outil enregistré — ajoutez-en dans Outils agricoles.</span>
                      </>
                    )
                  }
                  const nomsChoisis = outilsSelectionnables.filter(o => intervOutilIds.includes(o.id)).map(o => o.nom)
                  return (
                    <>
                      <button type="button" onClick={() => setOutilsListeOuverte(v => !v)} style={{
                        display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%',
                        background:'var(--cream)', border:'1px solid var(--border)', borderRadius:8,
                        padding:'.55rem .8rem', cursor:'pointer', textAlign:'left',
                      }}>
                        <span style={{ fontSize:'.84rem', fontWeight:600 }}>
                          🔧 Outils utilisés {nomsChoisis.length > 0 ? `(${nomsChoisis.length})` : '(optionnel)'}
                        </span>
                        <span style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>{outilsListeOuverte ? '▾ Réduire' : '▸ Choisir'}</span>
                      </button>
                      {!outilsListeOuverte && nomsChoisis.length > 0 && (
                        <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginTop:'.35rem' }}>{nomsChoisis.join(', ')}</div>
                      )}
                      {outilsListeOuverte && (
                        <div style={{ display:'flex', flexDirection:'column', gap:'.2rem', maxHeight:220, overflowY:'auto', border:'1px solid var(--border)', borderTop:'none', borderRadius:'0 0 8px 8px', padding:'.4rem' }}>
                          {outilsSelectionnables.map(o => {
                            const checked = intervOutilIds.includes(o.id)
                            return (
                              <label key={o.id} style={{ display:'flex', alignItems:'center', gap:'.5rem', padding:'.35rem .5rem', borderRadius:6, cursor:'pointer', fontSize:'.84rem', background: checked ? 'var(--green-pale)' : 'transparent' }}>
                                <input type="checkbox" checked={checked}
                                  onChange={() => setIntervOutilIds(prev => checked ? prev.filter(id=>id!==o.id) : [...prev, o.id])} />
                                <span>{o.nom}</span>
                                {o.type && <span style={{ color:'var(--text-muted)', fontSize:'.76rem' }}>({o.type})</span>}
                              </label>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>

              <div className="form-group" style={{ marginBottom:'1rem' }}>
                <label>Surface traitée par parcelle (ha)</label>
                <p style={{ fontSize:'.72rem', color:'var(--text-muted)', margin:'0 0 .5rem' }}>
                  Pré-remplie avec la surface de chaque parcelle — modifiable, ou dessine une ou plusieurs zones sur la carte
                  (bord de route, chemin, éoliennes…) pour calculer la surface exacte de chacune.
                </p>
                <div style={{ display:'flex', flexDirection:'column', gap:'.4rem' }}>
                  {parcelles.filter(p => selectedIds.has(p.id)).map(p => {
                    const zone = zonesByParcelle[p.id]
                    return (
                      <div key={p.id} style={{ display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap', padding:'.4rem .6rem', background:'var(--cream)', borderRadius:8 }}>
                        <strong style={{ flex:'1 1 120px', fontSize:'.82rem' }}>{p.nom}</strong>
                        <input type="number" step="0.01" min="0" style={{ width:80 }}
                          value={intervSurfaceHaByParcelle[p.id] ?? ''}
                          onChange={e => setIntervSurfaceHaByParcelle(prev => ({ ...prev, [p.id]: e.target.value }))} placeholder="ha" />
                        <button type="button" className="btn-sm" onClick={() => startDrawFor(p.id)}>✏️ Dessiner</button>
                        {zone ? (
                          <>
                            <span style={{ fontSize:'.74rem', color:'var(--green-mid)', fontWeight:600 }}>
                              📐 {zone.shapes} forme{zone.shapes > 1 ? 's' : ''} — {zone.ha.toFixed(2)} ha
                            </span>
                            <button type="button" onClick={() => clearZoneFor(p.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red)', fontSize:'.74rem' }}>✕</button>
                          </>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div style={{ fontSize:'.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', marginBottom:'.3rem' }}>
                Produits appliqués ensemble{!productSourceFor(intervType, phytoProducts, intrants) ? ' (optionnel)' : ''}
              </div>
              {(() => {
                const source = productSourceFor(intervType, phytoProducts, intrants)
                return (
                  <>
                    <div style={{ fontSize:'.74rem', color:'var(--text-muted)', marginBottom:'.5rem' }}>
                      {source
                        ? `🔗 Recherche liée à la base "${source.label}" — le stock sera décompté automatiquement.`
                        : 'Pas de base produit pour ce type d\'intervention — laisse vide si non pertinent.'}
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', gap:'.6rem', marginBottom:'.8rem' }}>
                      {intervLignes.map((l, i) => {
                        // Sans texte tapé : propose directement tous les produits de la base
                        // (triés A→Z) au lieu d'attendre une saisie — sinon ça ne "propose"
                        // jamais rien tant qu'on ne connaît pas déjà le nom exact.
                        const matches = source
                          ? (l.produit_nom.trim().length > 0
                              ? source.items.filter(it => source.table === 'db_phyto'
                                  ? phytoMatches(it, l.produit_nom)
                                  : it.nom.toLowerCase().includes(l.produit_nom.toLowerCase()))
                              : source.items.slice().sort((a, b) =>
                                  (source.table === 'db_phyto' ? phytoDisplayName(a) : a.nom).localeCompare(source.table === 'db_phyto' ? phytoDisplayName(b) : b.nom, 'fr'))
                            ).slice(0, 20)
                          : []
                        return (
                          <div key={i} style={{ display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap' }}>
                            <div style={{ flex:'3 1 200px', minWidth:0, position:'relative' }}>
                              <input
                                ref={el => (ligneInputRefs.current[i] = el)}
                                style={{ width:'100%', padding:'.6rem .85rem', fontSize:'.9rem' }}
                                value={l.produit_nom}
                                onChange={e => { updateLigne(i, { produit_nom: e.target.value, produit_id: null }); setOpenLigneDropdown(i) }}
                                onFocus={() => setOpenLigneDropdown(i)}
                                onBlur={() => setTimeout(() => setOpenLigneDropdown(cur => cur === i ? null : cur), 200)}
                                placeholder={source ? `🔍 ${source.label}…` : 'Produit'}
                              />
                              {source && openLigneDropdown === i && matches.length > 0 && (
                                <FloatingDropdown anchorRef={{ current: ligneInputRefs.current[i] }} maxHeight={260}>
                                  {matches.map(it => (
                                    <div key={it.id} onMouseDown={() => selectLigneProduct(i, it, source.table)}
                                      style={{ padding:'.6rem .9rem', cursor:'pointer', fontSize:'.86rem', borderBottom:'1px solid var(--border)' }}>
                                      <strong>{source.table === 'db_phyto' ? phytoDisplayName(it) : it.nom}</strong>
                                      {source.table === 'db_phyto' && it.stock_actuel != null && <span style={{ color:'var(--text-muted)' }}> — stock {it.stock_actuel} {it.stock_unite}</span>}
                                      {source.table === 'db_intrants' && it.stock != null && <span style={{ color:'var(--text-muted)' }}> — stock {it.stock} {it.unite}</span>}
                                    </div>
                                  ))}
                                </FloatingDropdown>
                              )}
                              {source && l.produit_id && (
                                <span style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', fontSize:'.72rem', color:'var(--green-mid)' }} title="Lié à la base">🔗</span>
                              )}
                            </div>
                            <input style={{ flex:'1 1 70px', minWidth:70 }} type="number" step="0.01" value={l.quantite} onChange={e=>updateLigne(i,{quantite:e.target.value})} placeholder="Qté" />
                            <select style={{ width:70, flexShrink:0 }} value={l.unite} onChange={e=>updateLigne(i,{unite:e.target.value})}>
                              {UNITES.map(u=><option key={u}>{u}</option>)}
                            </select>
                            <button onClick={() => removeLigne(i)} disabled={intervLignes.length===1}
                              style={{ background:'none', border:'none', cursor: intervLignes.length===1?'not-allowed':'pointer', color:'var(--red)', fontSize:'1rem', opacity: intervLignes.length===1?.3:1, flexShrink:0 }}>✕</button>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )
              })()}
              <button className="btn-sm" onClick={addLigne}>+ Ajouter un produit</button>

              <div className="form-group" style={{ marginTop:'1.2rem' }}>
                <label>Observation (optionnel)</label>
                <textarea rows={2} value={intervRemarque} onChange={e=>setIntervRemarque(e.target.value)}
                  placeholder="ex. conditions météo, remarque particulière…"
                  style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
              </div>
              <div className="form-group" style={{ marginTop:'1rem' }}>
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
                {intervPhotos.length > 0 && (
                  <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap' }}>
                    {intervPhotos.map((url, i) => (
                      <div key={i} style={{ position:'relative' }}>
                        <a href={url} target="_blank" rel="noreferrer">
                          <img src={url} alt="" style={{ width:72, height:72, objectFit:'cover', borderRadius:8, border:'1px solid var(--border)', display:'block' }} />
                        </a>
                        <button type="button" onClick={() => removeIntervPhoto(url)} title="Retirer cette photo" style={{
                          position:'absolute', top:-6, right:-6, width:20, height:20, borderRadius:'50%',
                          background:'var(--red)', color:'white', border:'2px solid white', cursor:'pointer', fontSize:'.65rem', lineHeight:1, padding:0,
                        }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          <div style={{ padding:'1rem 1.5rem calc(1rem + env(safe-area-inset-bottom))', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end', flexShrink:0 }}>
            <button className="btn-sm primary" onClick={saveIntervention} disabled={saving}>
              {saving ? '⏳ Enregistrement…' : `✓ Enregistrer sur ${selectedIds.size} parcelle(s)`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
