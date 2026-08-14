import { useState, useEffect, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import FloatingDropdown from '../components/FloatingDropdown'
import PhotoLightbox from '../components/PhotoLightbox'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne, isAtOrBeforeCampagne } from '../lib/campagne'
import { phytoDisplayName, phytoMatches } from '../lib/phytoNames'
import { productSourceFor, productItemName, productItemUnite, productItemStock } from '../lib/interventionProductSource'
import { fmtDate } from '../lib/formatDate'

// Anciennement un onglet enfoui dans Commande Phyto ("Stock & Interventions", 4e étape
// sur 6) — extrait ici en page à part entière, indépendante de tout le reste, pour un
// suivi direct du stock produits et des interventions sans passer par le flux Commande Phyto.
//
// Deux sous-onglets bien séparés :
//  - Stock physique : niveaux de stock des produits phyto et des intrants, comme pour
//    les Céréales mais côté intrants.
//  - Interventions : un seul rappel visuel par intervention réelle (regroupement des
//    lignes produit d'un même événement par date+parcelle+type — interventions_phyto
//    stocke une ligne PAR PRODUIT, pas une ligne par intervention), avec détail au clic,
//    sélection multiple et suppression/édition groupées.

const TYPE_ICON = {
  'Traitement et protection des cultures': '🧪',
  'Ferti minérale et foliaire': '🌱',
  'Plantation': '🌾',
  'Fertilisation et amendement organique': '💩',
  'Désherbage mécanique': '🌿',
  'Travail du sol': '🚜',
  'Récolte': '🚛',
  'Irrigation': '💧',
}
// "plants" (plants de pomme de terre) est exclu de cette page : suivi exclusivement
// dans Plants PDT, pour ne pas le dupliquer/mélanger avec le stock intrants général.
const CAT_LABELS = { semences: '🌾 Semences', engrais: '🧪 Engrais', ferti: '💧 Fertilisation', autre: 'Autre' }
// Mêmes listes que Carte.jsx (TYPES_INTERVENTION / SOUS_TYPES_TRAVAIL_SOL) — le champ
// "observation" de interventions_phyto stocke en réalité le TYPE d'intervention (pas
// une note libre, voir le vrai champ "remarque" plus bas).
const TYPES_INTERVENTION = ['Traitement et protection des cultures','Ferti minérale et foliaire','Plantation','Semis','Fertilisation et amendement organique','Désherbage mécanique','Travail du sol','Récolte','Irrigation']
const SOUS_TYPES_TRAVAIL_SOL = ['Déchaumage','Décompactage','Broyage','Labour','Écorouleau']
// Types d'intervention purement mécaniques/manuels, sans produit phyto/intrant
// consommé (juste des outils) — produit et quantité n'y sont pas exigés.
const TYPES_SANS_PRODUIT = ['Travail du sol', 'Désherbage mécanique', 'Récolte', 'Irrigation']
const HOMOL_RANK = { retire: 3, inconnu: 2, ok: 1 }
const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
function formatMonth(ym) {
  const [y, m] = ym.split('-')
  return `${MOIS_FR[parseInt(m, 10) - 1]} ${y}`
}

function groupKey(i) {
  return [i.date || '', i.parcelle_id ?? i.parcelle ?? '', (i.observation || '').trim()].join('|')
}

export default function StockInterventions() {
  const { user } = useAuth()
  const { showToast, ToastEl } = useToast()
  const { campagneActive, registerCampagnes } = useCampagne()
  const [tab, setTab] = useState('stock')
  const [interventions, setInterventions] = useState([])
  const [parcelles, setParcelles] = useState([])
  const [produits, setProduits] = useState([])
  const [intrants, setIntrants] = useState([])
  const [profiles, setProfiles] = useState([]) // pour afficher qui a saisi une intervention
  const [loading, setLoading] = useState(true)
  const [homologationByProduit, setHomologationByProduit] = useState({})
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'

  // Édition d'une ligne produit (nouvelle intervention ou ligne ajoutée/modifiée
  // au sein d'un événement existant)
  const [editingLine, setEditingLine] = useState(null)
  const [produitQ, setProduitQ] = useState('')
  const [showProduitDd, setShowProduitDd] = useState(false)
  const produitInputRef = useRef(null)
  const parcelleInputRef = useRef(null)
  const ligneInputRefs = useRef({})
  const [parcelleQ, setParcelleQ] = useState('')
  const [showParcelleDd, setShowParcelleDd] = useState(false)
  const [outils, setOutils] = useState([])
  const [outilsListeOuverte, setOutilsListeOuverte] = useState(false)
  // Sélection multi-parcelles — uniquement pour une intervention créée "from scratch"
  // (editingLine.multi) : une ligne interventions_phyto est créée par parcelle
  // cochée. En édition d'une ligne existante ou d'ajout de produit à un événement
  // déjà groupé, on reste sur une seule parcelle (celle de l'événement).
  const [multiParcelleIds, setMultiParcelleIds] = useState(new Set())
  const [multiParcelleQ, setMultiParcelleQ] = useState('')
  const [multiParcelleOuvert, setMultiParcelleOuvert] = useState(false)
  // Plusieurs produits sur une même nouvelle intervention (même principe que la
  // carte : une ligne interventions_phyto par produit × par parcelle cochée).
  const [intervLignes, setIntervLignes] = useState([{ produit_nom: '', produit_id: null, quantite: '', unite: 'L' }])
  const [openLigneDropdown, setOpenLigneDropdown] = useState(null)
  // Surface traitée par parcelle (pré-remplie avec la surface de la parcelle,
  // modifiable) + zone concernée (fourrières/rive uniquement) — mêmes champs que
  // sur la carte, appliqués à toutes les parcelles/produits de cette intervention.
  const [intervSurfaceHaByParcelle, setIntervSurfaceHaByParcelle] = useState({})
  const [intervFourrieres, setIntervFourrieres] = useState(false)
  const [intervRive, setIntervRive] = useState(false)
  function addLigne() { setIntervLignes(prev => [...prev, { produit_nom: '', produit_id: null, quantite: '', unite: 'L' }]) }
  function removeLigne(i) { setIntervLignes(prev => prev.filter((_, idx) => idx !== i)) }
  function updateLigne(i, patch) { setIntervLignes(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l)) }

  // Détail d'un événement (groupe de lignes) + sélection multiple pour actions groupées
  const [detailKey, setDetailKey] = useState(null)
  const [selectedKeys, setSelectedKeys] = useState(new Set())
  // Observation de l'événement, modifiable directement depuis le détail d'une
  // intervention (sans passer par l'édition d'un produit précis) — appliquée à
  // toutes les lignes produit du groupe pour rester cohérente.
  const [groupRemarqueDraft, setGroupRemarqueDraft] = useState('')
  const [savingGroupRemarque, setSavingGroupRemarque] = useState(false)

  // Édition groupée d'une sélection d'interventions (voir "✏️ Modifier la
  // sélection") : plutôt qu'un formulaire unique (les événements sélectionnés
  // peuvent avoir des produits différents), une petite boîte à outils
  // d'actions à appliquer d'un coup à toute la sélection.
  const [bulkEditOpen, setBulkEditOpen] = useState(false)
  const [bulkDate, setBulkDate] = useState('')
  const [bulkAddProduit, setBulkAddProduit] = useState({ nom: '', quantite: '', unite: 'L' })
  const [bulkDoseProduit, setBulkDoseProduit] = useState('')
  const [bulkDoseValue, setBulkDoseValue] = useState('')
  const [bulkRemoveProduit, setBulkRemoveProduit] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)

  useEffect(() => { load() }, [campagneActive])

  async function load() {
    setLoading(true)
    const [iv, { data: pa }, { data: ph }, { data: it }, { data: pr }, { data: ou }] = await Promise.all([
      loadAllInterventions(),
      supabase.from('parcelles').select('id,nom,culture_actuelle,campagne,surface').order('nom'),
      supabase.from('db_phyto').select('*').order('nom'),
      supabase.from('db_intrants').select('*').order('nom'),
      supabase.from('profiles').select('id,display_name'),
      supabase.from('outils_agricoles').select('id,nom,type').order('nom'),
    ])
    setInterventions(iv)
    setOutils((ou || []).filter(o => o.type !== 'Enrouleur'))
    // Le parcellaire change à chaque campagne (import DAPLOS) — on ne propose au
    // choix (barre de recherche) que les parcelles de la campagne active.
    setParcelles((pa || []).filter(p => (p.campagne || defaultCampagne()) === campagneActive))
    setProduits(ph || [])
    setIntrants((it || []).filter(i => i.categorie !== 'plants'))
    setProfiles(pr || [])
    registerCampagnes([...new Set(iv.map(r => r.campagne).filter(Boolean))])

    // Vérification d'homologation EPHY — même logique que MesParcelles : repli
    // par nom de produit quand produit_id n'est pas renseigné (saisie tapée sans
    // cliquer la suggestion, cas le plus fréquent sur les interventions existantes).
    const byId = Object.fromEntries((ph || []).map(p => [p.id, p]))
    const byName = Object.fromEntries((ph || []).map(p => [(p.nom || '').trim().toLowerCase(), p]))
    const amms = [...new Set((ph || []).map(p => (p.num_amm || '').trim()).filter(Boolean))]
    let ephyByAmm = {}
    if (amms.length) {
      // delai_rentree_h peut ne pas exister si migration_A_EXECUTER_39.sql n'a pas
      // encore été exécutée — on retente sans cette colonne dans ce cas.
      let { data: ephyRows, error: ephyErr } = await supabase.from('ephy_produits').select('numero_amm,etat_autorisation,delai_rentree_h').in('numero_amm', amms)
      if (ephyErr && /delai_rentree_h|column/i.test(ephyErr.message)) {
        ;({ data: ephyRows } = await supabase.from('ephy_produits').select('numero_amm,etat_autorisation').in('numero_amm', amms))
      }
      ephyByAmm = Object.fromEntries((ephyRows || []).map(e => [e.numero_amm, e]))
    }
    setHomologationByProduit({ byId, byName, ephyByAmm })
    setLoading(false)
  }

  function homologationFor(i) {
    const { byId, byName, ephyByAmm } = homologationByProduit
    if (!byId) return null
    const prod = i.produit_id ? byId[i.produit_id] : byName[(i.produit_nom || '').trim().toLowerCase()]
    if (!prod) return null
    if ((prod.categorie || 'phyto') !== 'phyto') return null
    if (!prod.num_amm?.trim()) return { status: 'inconnu', label: "N° AMM non renseigné", delaiH: null }
    const ephy = ephyByAmm[prod.num_amm.trim()]
    if (!ephy) return { status: 'inconnu', label: 'AMM introuvable dans EPHY', delaiH: null }
    // delai_rentree_h : extrait automatiquement du texte libre EPHY — null si non
    // trouvé/ambigu (pas "aucun délai requis") ; affiché quel que soit le statut
    // d'homologation, le délai physique reste réel même sur un produit retiré.
    const delaiH = ephy.delai_rentree_h ?? null
    if (ephy.etat_autorisation === 'AUTORISE') return { status: 'ok', label: 'Homologué', delaiH }
    return { status: 'retire', label: `Retiré${ephy.etat_autorisation ? ` (${ephy.etat_autorisation})` : ''}`, delaiH }
  }

  // PostgREST plafonne à 1000 lignes par requête par défaut — on pagine pour tout charger.
  async function loadAllInterventions() {
    const all = []
    for (let page = 0; ; page++) {
      const { data, error } = await supabase.from('interventions_phyto').select('*')
        .order('date', { ascending: false }).range(page * 1000, page * 1000 + 999)
      if (error || !data) break
      all.push(...data)
      if (data.length < 1000) break
    }
    return all
  }

  // Une campagne passée ne doit jamais montrer des données saisies dans une
  // campagne ultérieure. Le journal d'interventions est un historique d'événements
  // propres à une seule campagne (égalité stricte, comme MesParcelles), tandis que
  // le stock est cumulatif dans le temps (tout ce qui a été utilisé jusqu'à la
  // campagne consultée, mais pas au-delà — même logique que Céréales).
  const interventionsCampagne = useMemo(
    () => interventions.filter(i => (i.campagne || defaultCampagne()) === campagneActive),
    [interventions, campagneActive]
  )
  const interventionsUpTo = useMemo(
    () => interventions.filter(i => isAtOrBeforeCampagne(i.campagne || defaultCampagne(), campagneActive)),
    [interventions, campagneActive]
  )

  // Regroupement des lignes produit en événements d'intervention réels.
  const groups = useMemo(() => {
    const map = new Map()
    for (const i of interventionsCampagne) {
      const k = groupKey(i)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(i)
    }
    return [...map.entries()].map(([key, rows]) => {
      const first = rows[0]
      const homs = rows.map(homologationFor).filter(Boolean)
      let homolSummary = null
      if (homs.length) {
        const worst = homs.reduce((w, h) => HOMOL_RANK[h.status] > HOMOL_RANK[w.status] ? h : w, homs[0])
        const maxDelai = homs.reduce((m, h) => h.delaiH != null ? Math.max(m ?? 0, h.delaiH) : m, null)
        homolSummary = { ...worst, delaiH: maxDelai }
      }
      return {
        key, rows,
        date: first.date,
        type: first.observation || 'Intervention',
        parcelle: first.parcelle,
        culture: rows.find(r => r.culture)?.culture || '',
        surface_ha: rows.find(r => r.surface_ha != null)?.surface_ha ?? null,
        nbProduits: rows.filter(r => r.produit_nom).length,
        homolSummary,
      }
    }).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  }, [interventionsCampagne, homologationByProduit])

  const detailGroup = groups.find(g => g.key === detailKey) || null
  useEffect(() => { setGroupRemarqueDraft(detailGroup?.rows[0]?.remarque || '') }, [detailKey])
  async function saveGroupRemarque() {
    if (!detailGroup) return
    setSavingGroupRemarque(true)
    const remarque = groupRemarqueDraft.trim() || null
    const ids = detailGroup.rows.map(r => r.id)
    const { error } = await supabase.from('interventions_phyto').update({ remarque }).in('id', ids)
    setSavingGroupRemarque(false)
    if (error) { alert(error.message); return }
    setInterventions(prev => prev.map(i => ids.includes(i.id) ? { ...i, remarque } : i))
    showToast('✅ Observation enregistrée')
  }

  // Filtres liste des interventions — par mois, par parcelle et par type
  // d'intervention, pour retrouver rapidement ce qui s'est passé sans dérouler
  // tout l'historique.
  const [filterMonth, setFilterMonth] = useState('')
  const [filterParcelle, setFilterParcelle] = useState('')
  const [filterType, setFilterType] = useState('')
  // Sélection par plage de dates — pour tout sélectionner d'un coup entre deux
  // dates puis supprimer (au lieu de cocher chaque intervention une par une).
  const [rangeDebut, setRangeDebut] = useState('')
  const [rangeFin, setRangeFin] = useState('')
  function selectRange() {
    if (!rangeDebut || !rangeFin) { alert('Choisis une date de début et une date de fin.'); return }
    const [from, to] = rangeDebut <= rangeFin ? [rangeDebut, rangeFin] : [rangeFin, rangeDebut]
    const matching = groups.filter(g => g.date && g.date >= from && g.date <= to)
    if (matching.length === 0) { alert('Aucune intervention dans cette période.'); return }
    setSelectedKeys(new Set(matching.map(g => g.key)))
  }
  const availableMonths = useMemo(() => [...new Set(groups.map(g => (g.date || '').slice(0, 7)).filter(Boolean))].sort().reverse(), [groups])
  const availableParcelles = useMemo(() => [...new Set(groups.map(g => g.parcelle).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')), [groups])
  const availableTypes = useMemo(() => [...new Set(groups.map(g => g.type).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')), [groups])
  const filteredGroups = useMemo(() => groups.filter(g =>
    (!filterMonth || (g.date || '').slice(0, 7) === filterMonth) &&
    (!filterType || g.type === filterType) &&
    (!filterParcelle || g.parcelle === filterParcelle)
  ), [groups, filterMonth, filterParcelle, filterType])

  function openNew() {
    setEditingLine({ date: new Date().toISOString().split('T')[0], produit_id: null, produit_nom: '', quantite: '', unite: 'L', culture: '', parcelle: '', parcelle_id: null, observation: '', sous_type: '', outil_ids: [], remarque: '', photos: [], multi: true })
    setProduitQ('')
    setParcelleQ('')
    setOutilsListeOuverte(false)
    setMultiParcelleIds(new Set())
    setMultiParcelleQ('')
    setMultiParcelleOuvert(false)
    setIntervLignes([{ produit_nom: '', produit_id: null, quantite: '', unite: 'L' }])
    setOpenLigneDropdown(null)
    setIntervSurfaceHaByParcelle({})
    setIntervFourrieres(false)
    setIntervRive(false)
  }

  function openAddToGroup(g) {
    const first = g.rows[0]
    setEditingLine({ date: first.date, produit_id: null, produit_nom: '', quantite: '', unite: 'L', culture: first.culture || '', parcelle: first.parcelle || '', parcelle_id: first.parcelle_id || null, observation: first.observation || '', sous_type: first.sous_type || '', outil_ids: first.outil_ids || [], remarque: first.remarque || '', photos: first.photos || [] })
    setProduitQ('')
    setParcelleQ(first.parcelle || '')
    setOutilsListeOuverte(false)
  }

  function openEditLine(row) {
    setEditingLine({ ...row, quantite: String(row.quantite), outil_ids: row.outil_ids || [], photos: row.photos || [] })
    setProduitQ(row.produit_nom || '')
    setParcelleQ(row.parcelle || '')
    setOutilsListeOuverte(false)
  }

  // Photos jointes à l'intervention — même principe que pour les Outils
  // agricoles (même bucket de stockage "intervention-photos").
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
      setEditingLine(m => ({ ...m, photos: [...(m.photos || []), data.publicUrl] }))
    }
    setUploadingPhoto(false)
  }
  function removePhoto(url) {
    setEditingLine(m => ({ ...m, photos: (m.photos || []).filter(p => p !== url) }))
  }

  async function saveLine() {
    if (!editingLine.observation?.trim()) { alert("Le type d'intervention est obligatoire."); return }
    const requiresProduit = !TYPES_SANS_PRODUIT.includes(editingLine.observation)

    // Nouvelle intervention "from scratch" : autant de produits que voulu (+ "Ajouter
    // un produit"), croisés avec les parcelles cochées — une ligne interventions_phyto
    // par combinaison produit × parcelle, comme sur la carte.
    if (editingLine.multi && !editingLine.id) {
      const source = productSourceFor(editingLine.observation, produits, intrants, editingLine.sous_type)
      const validLignes = intervLignes.filter(l => l.produit_nom.trim()).map(l => {
        if (l.produit_id || !source) return l
        const typed = l.produit_nom.trim().toLowerCase()
        const match = source.items.find(it => (it.nom || '').trim().toLowerCase() === typed
          || (source.table === 'db_phyto' && (it.nom_secondaire || '').trim().toLowerCase() === typed))
        return match ? { ...l, produit_id: match.id } : l
      })
      if (requiresProduit && validLignes.length === 0) { alert('Ajoutez au moins un produit.'); return }
      if (requiresProduit && validLignes.some(l => !l.quantite || parseFloat(l.quantite) <= 0)) { alert('Chaque produit doit avoir une quantité supérieure à 0.'); return }
      const lignesToWrite = validLignes.length ? validLignes : [null]
      const parcelleTargets = multiParcelleIds.size > 0 ? [...multiParcelleIds].map(pid => parcelles.find(p => p.id === pid)) : [null]
      const sous_type = editingLine.observation === 'Travail du sol' ? (editingLine.sous_type || null) : null
      const outil_ids = editingLine.outil_ids?.length ? editingLine.outil_ids : null

      const rows = parcelleTargets.flatMap(p => lignesToWrite.map(l => ({
        date: editingLine.date,
        produit_id: l?.produit_id || null,
        produit_nom: l?.produit_nom?.trim() || '',
        quantite: l ? (parseFloat(l.quantite) || 0) : 0,
        unite: l?.unite || '',
        culture: editingLine.culture || p?.culture_actuelle || '',
        parcelle: p?.nom || null,
        parcelle_id: p?.id || null,
        observation: editingLine.observation,
        sous_type,
        outil_ids,
        surface_ha: p ? (parseFloat(intervSurfaceHaByParcelle[p.id]) || null) : null,
        fourrieres: intervFourrieres,
        rive: intervRive,
        photos: editingLine.photos?.length ? editingLine.photos : null,
        remarque: editingLine.remarque || null,
        campagne: campagneActive,
        user_id: user?.id || null,
      })))
      try {
        let { data, error } = await supabase.from('interventions_phyto').insert(rows).select()
        if (error && /surface_ha|fourrieres|\brive\b|photos|column/i.test(error.message)) {
          ;({ data, error } = await supabase.from('interventions_phyto').insert(rows.map(({ surface_ha, fourrieres, rive, photos, ...r }) => r)).select())
        }
        let produitLinkLost = false
        if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
          produitLinkLost = true
          ;({ data, error } = await supabase.from('interventions_phyto').insert(rows.map(r => ({ ...r, produit_id: null }))).select())
        }
        if (error) throw error
        setInterventions(prev => [...data, ...prev])
        setEditingLine(null)
        showToast(produitLinkLost
          ? '✅ Enregistré (produit non lié à la Base de données — nom conservé en texte libre)'
          : `✅ ${rows.length > 1 ? rows.length + ' interventions enregistrées' : 'Intervention enregistrée'}`)
      } catch (e) { alert(e.message) }
      return
    }

    if (requiresProduit) {
      if (!editingLine.produit_nom?.trim()) { alert('Le produit est obligatoire.'); return }
      if (!editingLine.quantite || parseFloat(editingLine.quantite) <= 0) { alert('La quantité doit être supérieure à 0.'); return }
    }
    // Nom tapé sans cliquer la suggestion : relie quand même à la base si le nom
    // correspond exactement à un produit connu (phyto OU intrant selon le type
    // d'intervention), sinon la vérification EPHY ne peut jamais s'appliquer.
    let produit_id = editingLine.produit_id
    if (!produit_id) {
      const source = productSourceFor(editingLine.observation, produits, intrants, editingLine.sous_type)
      const typed = editingLine.produit_nom.trim().toLowerCase()
      const match = source?.items.find(it => (it.nom || '').trim().toLowerCase() === typed
        || (source.table === 'db_phyto' && (it.nom_secondaire || '').trim().toLowerCase() === typed))
      if (match) produit_id = match.id
    }
    const payload = {
      ...editingLine, produit_id, quantite: editingLine.quantite ? parseFloat(editingLine.quantite) : 0,
      sous_type: editingLine.observation === 'Travail du sol' ? (editingLine.sous_type || null) : null,
      outil_ids: editingLine.outil_ids?.length ? editingLine.outil_ids : null,
      photos: editingLine.photos?.length ? editingLine.photos : null,
    }
    delete payload.created_at
    delete payload.multi
    try {
      if (editingLine.id) {
        let { error } = await supabase.from('interventions_phyto').update(payload).eq('id', editingLine.id)
        if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
          ;({ error } = await supabase.from('interventions_phyto').update({ ...payload, produit_id: null }).eq('id', editingLine.id))
        }
        if (error) throw error
        setInterventions(prev => prev.map(i => i.id === editingLine.id ? { ...i, ...payload } : i))
      } else {
        let { data, error } = await supabase.from('interventions_phyto').insert({ ...payload, campagne: campagneActive, user_id: user?.id || null }).select().single()
        if (error && /produit_id|foreign key|fkey/i.test(error.message)) {
          ;({ data, error } = await supabase.from('interventions_phyto').insert({ ...payload, produit_id: null, campagne: campagneActive, user_id: user?.id || null }).select().single())
        }
        if (error) throw error
        setInterventions(prev => [data, ...prev])
      }
      setEditingLine(null)
      showToast('✅ Intervention enregistrée')
    } catch (e) { alert(e.message) }
  }

  async function delLine() {
    if (!confirm('Supprimer ce produit de l\'intervention ?')) return
    const wasOnlyLine = detailGroup && detailGroup.rows.length === 1
    const { error } = await supabase.from('interventions_phyto').delete().eq('id', editingLine.id)
    if (error) { alert('Échec de la suppression : ' + error.message); return }
    setInterventions(prev => prev.filter(i => i.id !== editingLine.id))
    setEditingLine(null)
    if (wasOnlyLine) setDetailKey(null)
    showToast('🗑️ Produit supprimé')
  }

  async function deleteGroup(g) {
    if (!confirm(`Supprimer toute l'intervention du ${fmtDate(g.date)} (${g.rows.length} produit${g.rows.length > 1 ? 's' : ''}) ?`)) return
    const ids = g.rows.map(r => r.id)
    const { error } = await supabase.from('interventions_phyto').delete().in('id', ids)
    if (error) { alert('Échec de la suppression : ' + error.message); return }
    setInterventions(prev => prev.filter(i => !ids.includes(i.id)))
    setDetailKey(null)
    setSelectedKeys(prev => { const s = new Set(prev); s.delete(g.key); return s })
    showToast('🗑️ Intervention supprimée')
  }

  async function deleteSelection() {
    const selGroups = groups.filter(g => selectedKeys.has(g.key))
    const ids = selGroups.flatMap(g => g.rows.map(r => r.id))
    if (!ids.length) return
    if (!confirm(`Supprimer ${selGroups.length} intervention${selGroups.length > 1 ? 's' : ''} sélectionnée${selGroups.length > 1 ? 's' : ''} ?`)) return
    // Un `.in('id', ids)` avec des centaines d'identifiants peut dépasser les
    // limites de taille d'URL/requête d'un coup — on découpe en lots de 200
    // pour rester fiable même sur une sélection d'un mois entier, et on
    // vérifie l'erreur de chaque lot au lieu de supposer que ça a marché.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { error } = await supabase.from('interventions_phyto').delete().in('id', chunk)
      if (error) { alert('Échec de la suppression (partielle) : ' + error.message); await load(); return }
    }
    setInterventions(prev => prev.filter(i => !ids.includes(i.id)))
    setSelectedKeys(new Set())
    showToast('🗑️ Interventions supprimées')
  }

  // Écrit `patch` sur tous les ids fournis, par lots de 200 (voir deleteSelection).
  async function bulkPatch(ids, patch) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { error } = await supabase.from('interventions_phyto').update(patch).in('id', chunk)
      if (error) { alert('Échec (partiel) : ' + error.message); await load(); return false }
    }
    return true
  }

  const selGroups = groups.filter(g => selectedKeys.has(g.key))
  // Produits présents dans la sélection courante — sert de liste pour "modifier
  // la dose" / "retirer" (on ne peut cibler que ce qui existe réellement).
  const produitsInSelection = [...new Set(selGroups.flatMap(g => g.rows.map(r => r.produit_nom).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'fr'))

  async function applyBulkDate() {
    if (!bulkDate) { alert('Choisis une date.'); return }
    const ids = selGroups.flatMap(g => g.rows.map(r => r.id))
    if (!ids.length) return
    if (!confirm(`Changer la date de ${selGroups.length} intervention(s) vers le ${fmtDate(bulkDate)} ?`)) return
    setBulkBusy(true)
    const ok = await bulkPatch(ids, { date: bulkDate })
    setBulkBusy(false)
    if (!ok) return
    setInterventions(prev => prev.map(i => ids.includes(i.id) ? { ...i, date: bulkDate } : i))
    showToast(`✅ Date mise à jour sur ${selGroups.length} intervention(s)`)
    setBulkDate('')
  }

  async function applyBulkAddProduit() {
    const nom = bulkAddProduit.nom.trim()
    if (!nom) { alert('Nom du produit obligatoire.'); return }
    if (!selGroups.length) return
    if (!confirm(`Ajouter "${nom}" à ${selGroups.length} intervention(s) ?`)) return
    const typed = nom.toLowerCase()
    const matchPhyto = produits.find(p => (phytoDisplayName(p) || '').trim().toLowerCase() === typed || (p.nom_secondaire || '').trim().toLowerCase() === typed)
    const matchIntrant = !matchPhyto ? intrants.find(i => (i.nom || '').trim().toLowerCase() === typed) : null
    const produit_id = matchPhyto?.id || matchIntrant?.id || null
    const quantite = bulkAddProduit.quantite ? parseFloat(bulkAddProduit.quantite) : null
    const rows = selGroups.map(g => {
      const first = g.rows[0]
      return {
        date: first.date, observation: first.observation, sous_type: first.sous_type, defanage: first.defanage,
        parcelle_id: first.parcelle_id, parcelle: first.parcelle, culture: first.culture, campagne: first.campagne,
        surface_ha: first.surface_ha, outil_ids: first.outil_ids, remarque: first.remarque,
        produit_id, produit_nom: nom, quantite, unite: bulkAddProduit.unite,
        user_id: user?.id || null,
      }
    })
    setBulkBusy(true)
    // produit_id ne référence que db_phyto (pas db_intrants) — si le nom tapé
    // correspond en fait à un intrant, l'insert échoue sur la contrainte de clé
    // étrangère : on retente alors sans produit_id plutôt que de tout annuler.
    let { error } = await supabase.from('interventions_phyto').insert(rows)
    if (error && /produit_id|foreign key|violates/i.test(error.message)) {
      ;({ error } = await supabase.from('interventions_phyto').insert(rows.map(({ produit_id, ...r }) => r)))
    }
    setBulkBusy(false)
    if (error) { alert('Échec : ' + error.message); return }
    await load()
    showToast(`✅ "${nom}" ajouté à ${selGroups.length} intervention(s)`)
    setBulkAddProduit({ nom: '', quantite: '', unite: 'L' })
  }

  async function applyBulkDose() {
    if (!bulkDoseProduit) { alert('Choisis un produit.'); return }
    if (bulkDoseValue === '' || isNaN(parseFloat(bulkDoseValue))) { alert('Saisis une dose valide.'); return }
    const rowsToUpdate = selGroups.flatMap(g => g.rows.filter(r => r.produit_nom === bulkDoseProduit))
    const ids = rowsToUpdate.map(r => r.id)
    if (!ids.length) return
    const val = parseFloat(bulkDoseValue)
    if (!confirm(`Mettre la dose de "${bulkDoseProduit}" à ${val} sur ${ids.length} ligne(s) ?`)) return
    setBulkBusy(true)
    const ok = await bulkPatch(ids, { quantite: val })
    setBulkBusy(false)
    if (!ok) return
    setInterventions(prev => prev.map(i => ids.includes(i.id) ? { ...i, quantite: val } : i))
    showToast(`✅ Dose mise à jour sur ${ids.length} ligne(s)`)
    setBulkDoseProduit(''); setBulkDoseValue('')
  }

  async function applyBulkRemoveProduit() {
    if (!bulkRemoveProduit) { alert('Choisis un produit.'); return }
    const rowsToRemove = selGroups.flatMap(g => g.rows.filter(r => r.produit_nom === bulkRemoveProduit))
    const ids = rowsToRemove.map(r => r.id)
    if (!ids.length) return
    if (!confirm(`Retirer "${bulkRemoveProduit}" de ${ids.length} intervention(s) ? Si c'était le seul produit d'une intervention, elle disparaîtra entièrement.`)) return
    setBulkBusy(true)
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { error } = await supabase.from('interventions_phyto').delete().in('id', chunk)
      if (error) { alert('Échec (partiel) : ' + error.message); await load(); setBulkBusy(false); return }
    }
    setBulkBusy(false)
    setInterventions(prev => prev.filter(i => !ids.includes(i.id)))
    showToast(`🗑️ "${bulkRemoveProduit}" retiré de ${ids.length} intervention(s)`)
    setBulkRemoveProduit('')
  }

  function toggleSelect(key) {
    setSelectedKeys(prev => {
      const s = new Set(prev)
      if (s.has(key)) s.delete(key); else s.add(key)
      return s
    })
  }

  // Stock théorique restant par produit phyto
  // Un stock à 0/vide veut dire "pas encore renseigné" (pas "épuisé") — on
  // n'affiche l'alerte de rupture qu'une fois un stock de départ réellement saisi.
  const stockRows = produits
    .filter(p => p.stock_actuel > 0)
    .map(p => {
      const utilise = interventionsUpTo.filter(i => i.produit_id === p.id).reduce((s, i) => s + (i.quantite || 0), 0)
      const reste = p.stock_actuel - utilise
      const pct = p.stock_actuel > 0 ? Math.max(0, Math.min(100, (reste / p.stock_actuel) * 100)) : 0
      return { ...p, utilise, reste, pct, rupture: reste <= 0, bas: reste > 0 && pct <= 20 }
    })
    .sort((a, b) => a.pct - b.pct)

  const alertes = stockRows.filter(p => p.rupture || p.bas)
  const intrantsAvecStock = intrants.filter(i => i.stock != null).sort((a, b) => a.nom.localeCompare(b.nom))

  // Base de recherche (phyto ou intrants) selon le type d'intervention choisi —
  // voir interventionProductSource.js, partagé avec Carte.jsx pour ne jamais
  // se désynchroniser (un intrant type "Ferti minérale" avait ainsi disparu de
  // la recherche après un renommage de catégorie non répercuté ici).
  const produitSource = editingLine ? productSourceFor(editingLine.observation, produits, intrants, editingLine.sous_type) : null
  // Broyage (Travail du sol) peut inclure un défanage chimique au même passage —
  // laisse alors ajouter un produit (voir productSourceFor), contrairement aux
  // autres sous-types de travail du sol qui n'en ont jamais.
  const editingLineCanHaveProduit = editingLine && (
    !TYPES_SANS_PRODUIT.includes(editingLine.observation) ||
    (editingLine.observation === 'Travail du sol' && editingLine.sous_type === 'Broyage')
  )
  const produitMatches = produitQ.length > 0 && produitSource
    ? produitSource.items.filter(p => produitSource.table === 'db_phyto' ? phytoMatches(p, produitQ) : (p.nom || '').toLowerCase().includes(produitQ.toLowerCase())).slice(0, 8)
    : []

  if (loading) return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {ToastEl}
      <div style={{ background:'white', borderBottom:'1px solid var(--border)', padding:'.9rem 1.5rem', display:'flex', alignItems:'center', gap:'.6rem', flexWrap:'wrap' }}>
        <h2 style={{ fontSize:'1.05rem', fontWeight:700, margin:0, color:'var(--ink)' }}>📦 Stock & Interventions</h2>
        <span style={{ fontSize:'.76rem', color:'var(--text-muted)', fontWeight:600 }}>🗓️ {campagneActive}</span>
        <button className="btn-sm" onClick={load} style={{ marginLeft:'auto' }}>🔄 Actualiser</button>
      </div>
      {campagneActive !== defaultCampagne() && (
        <div style={{ fontSize:'.7rem', color:'var(--amber)', padding:'.35rem 1.5rem', background:'#fff8e8', borderBottom:'1px solid var(--border)' }}>
          🗓️ Campagne passée : le stock affiché tient compte de tout ce qui a été utilisé jusqu'à cette campagne, sans rien inclure des campagnes suivantes.
        </div>
      )}

      <div style={{ background:'white', borderBottom:'2px solid var(--border)', padding:'0 1.5rem', display:'flex', gap:'.25rem', flexShrink:0, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
        {[['stock', '📦 Stock physique'], ['interventions', `🔧 Interventions (${groups.length})`], ['recap', '📊 Récap']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding:'.6rem 1.2rem', background:'none', border:'none', whiteSpace:'nowrap', flexShrink:0,
            borderBottom: tab === k ? '2.5px solid var(--green-mid)' : '2.5px solid transparent',
            marginBottom:'-2px', fontWeight: tab === k ? 700 : 500, color: tab === k ? 'var(--green-mid)' : 'var(--text-muted)',
            fontSize:'.86rem', cursor:'pointer',
          }}>{l}</button>
        ))}
      </div>

      {tab === 'stock' && (
        <div style={{ flex:1, overflow:'auto', padding:'1.4rem 1.5rem', display:'flex', flexDirection:'column', gap:'1.4rem' }}>

          {/* Alertes stock */}
          <section>
            <SectionTitle>Alertes stock (phyto)</SectionTitle>
            {alertes.length === 0 ? (
              <div style={{ background:'var(--green-pale)', border:'1px solid var(--green-accent)', borderRadius:12, padding:'1rem 1.2rem', fontSize:'.85rem', color:'var(--green-mid)', fontWeight:600 }}>
                ✅ Aucune alerte — tous les stocks suivis sont suffisants.
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'.6rem' }}>
                {alertes.map(p => (
                  <div key={p.id} style={{ background: p.rupture ? '#fdf0ef' : '#fff8e8', border: `1px solid ${p.rupture ? 'var(--red)' : 'var(--amber)'}`, borderRadius:10, padding:'.8rem 1.1rem', fontSize:'.85rem', color: p.rupture ? 'var(--red)' : 'var(--amber)', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'1rem', flexWrap:'wrap' }}>
                    <span>{p.rupture ? '🔴' : '🟠'} <strong>{p.nom}</strong> — {p.rupture ? 'stock épuisé' : `stock bas (${p.pct.toFixed(0)}%)`}</span>
                    <span style={{ fontWeight:700, whiteSpace:'nowrap' }}>{p.reste.toFixed(2)} / {p.stock_actuel} {p.stock_unite}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Stock phyto */}
          <section>
            <SectionTitle>Stock produits phytosanitaires</SectionTitle>
            {stockRows.length === 0 ? (
              <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.85rem' }}>
                Aucun produit avec un stock renseigné. Ajoutez un stock initial depuis Base de données &gt; Phytosanitaires.
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:'.8rem' }}>
                {stockRows.map(p => (
                  <div key={p.id} style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem', borderLeft:`4px solid ${p.rupture ? 'var(--red)' : p.bas ? 'var(--amber)' : 'var(--green-accent)'}` }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'.5rem', gap:'.5rem' }}>
                      <strong style={{ fontSize:'.88rem' }}>{p.nom}</strong>
                      <span style={{ fontWeight:700, color: p.rupture ? 'var(--red)' : 'var(--green-mid)', whiteSpace:'nowrap' }}>{p.reste.toFixed(2)} {p.stock_unite}</span>
                    </div>
                    <div style={{ height:8, background:'var(--cream-dark)', borderRadius:50, overflow:'hidden' }}>
                      <div style={{ height:'100%', borderRadius:50, width:`${p.pct}%`, background: p.rupture ? 'var(--red)' : p.bas ? 'var(--amber)' : 'var(--green-accent)' }} />
                    </div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:'.3rem' }}>
                      Utilisé {p.utilise.toFixed(2)} / {p.stock_actuel} {p.stock_unite}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Stock intrants */}
          <section>
            <SectionTitle>Stock intrants (semences, plants, engrais, fertilisation)</SectionTitle>
            {intrantsAvecStock.length === 0 ? (
              <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.85rem' }}>
                Aucun intrant avec un stock renseigné. Ajoutez un stock depuis Base de données &gt; Intrants.
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(240px, 1fr))', gap:'.8rem' }}>
                {intrantsAvecStock.map(i => (
                  <div key={i.id} style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'.4rem', gap:'.5rem' }}>
                      <strong style={{ fontSize:'.88rem' }}>{i.nom}</strong>
                      <span style={{ fontWeight:700, color:'var(--green-mid)', whiteSpace:'nowrap' }}>{i.stock} {i.unite}</span>
                    </div>
                    <div style={{ display:'flex', gap:'.4rem', alignItems:'center', flexWrap:'wrap' }}>
                      <span style={{ fontSize:'.7rem', fontWeight:600, padding:'.15rem .5rem', borderRadius:50, background:'var(--cream)', color:'var(--text-muted)' }}>
                        {CAT_LABELS[i.categorie] || i.categorie || 'Autre'}
                      </span>
                      {i.fournisseur && <span style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{i.fournisseur}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'interventions' && (
        <div style={{ flex:1, overflow:'auto', padding:'1.4rem 1.5rem', display:'flex', flexDirection:'column', gap:'1rem' }}>
          <div style={{ fontSize:'.7rem', color:'var(--text-muted)' }}>
            ⏱️ Le délai avant rentrée est extrait automatiquement du texte libre des fiches EPHY — à vérifier sur l'étiquette du produit en cas de doute.
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:'.5rem', flexWrap:'wrap', background:'var(--cream)', borderRadius:10, padding:'.6rem .8rem' }}>
            <span style={{ fontSize:'.8rem', fontWeight:600, color:'var(--text-muted)' }}>🗓️ Sélectionner une période :</span>
            <input type="date" value={rangeDebut} onChange={e => setRangeDebut(e.target.value)} style={{ maxWidth:150 }} />
            <span style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>→</span>
            <input type="date" value={rangeFin} onChange={e => setRangeFin(e.target.value)} style={{ maxWidth:150 }} />
            <button className="btn-sm primary" onClick={selectRange}>Sélectionner cette période</button>
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:'.6rem', flexWrap:'wrap' }}>
            <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={{ maxWidth:180 }}>
              <option value="">📅 Tous les mois</option>
              {availableMonths.map(m => <option key={m} value={m}>{formatMonth(m)}</option>)}
            </select>
            <select value={filterParcelle} onChange={e => setFilterParcelle(e.target.value)} style={{ maxWidth:220 }}>
              <option value="">📍 Toutes les parcelles</option>
              {availableParcelles.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ maxWidth:240 }}>
              <option value="">🔧 Tous les types</option>
              {availableTypes.map(t => <option key={t} value={t}>{TYPE_ICON[t] || '📋'} {t}</option>)}
            </select>
            {(filterMonth || filterParcelle || filterType) && (
              <button className="btn-sm" onClick={() => { setFilterMonth(''); setFilterParcelle(''); setFilterType('') }}>✕ Réinitialiser</button>
            )}
            {selectedKeys.size > 0 ? (
              <>
                <span style={{ fontSize:'.84rem', fontWeight:700, color:'var(--ink)' }}>{selectedKeys.size} sélectionnée{selectedKeys.size > 1 ? 's' : ''}</span>
                <button className="btn-sm" onClick={() => setSelectedKeys(new Set())}>Annuler la sélection</button>
                <button className="btn-sm" onClick={() => setBulkEditOpen(true)} style={{ marginLeft:'auto' }}>✏️ Modifier la sélection</button>
                <button className="btn-sm danger" onClick={deleteSelection}>🗑️ Supprimer la sélection</button>
              </>
            ) : (
              <button className="btn-sm primary" onClick={openNew} style={{ marginLeft:'auto' }}>+ Intervention</button>
            )}
          </div>

          {(filterMonth || filterParcelle || filterType) && (
            <div style={{ fontSize:'.76rem', color:'var(--text-muted)' }}>
              {filteredGroups.length} intervention{filteredGroups.length > 1 ? 's' : ''} trouvée{filteredGroups.length > 1 ? 's' : ''} sur {groups.length}
            </div>
          )}

          {groups.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.85rem' }}>
              Aucune intervention enregistrée.
            </div>
          ) : filteredGroups.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.85rem' }}>
              Aucune intervention ne correspond à ce filtre.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'.6rem' }}>
              {filteredGroups.map(g => (
                <div key={g.key} style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'.9rem 1.1rem', display:'flex', alignItems:'center', gap:'.9rem', cursor:'pointer', flexWrap:'wrap' }}
                  onClick={() => setDetailKey(g.key)}>
                  <input type="checkbox" checked={selectedKeys.has(g.key)} onClick={e => e.stopPropagation()} onChange={() => toggleSelect(g.key)}
                    style={{ width:18, height:18, flexShrink:0, cursor:'pointer' }} />
                  <div style={{ fontWeight:700, fontSize:'.85rem', minWidth:88 }}>{fmtDate(g.date)}</div>
                  <div style={{ fontSize:'1.3rem', flexShrink:0 }}>{TYPE_ICON[g.type] || '📋'}</div>
                  <div style={{ flex:'1 1 200px', minWidth:0 }}>
                    <div style={{ fontWeight:600, fontSize:'.85rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{g.type}</div>
                    <div style={{ fontSize:'.76rem', color:'var(--text-muted)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                      {g.parcelle || '–'}{g.culture ? ` · ${g.culture}` : ''}{g.surface_ha ? ` · ${g.surface_ha} ha` : ''}
                    </div>
                  </div>
                  {g.nbProduits > 0 && (
                    <span style={{ fontSize:'.7rem', fontWeight:700, padding:'.2rem .6rem', borderRadius:50, background:'var(--cream)', color:'var(--text-muted)', flexShrink:0 }}>
                      {g.nbProduits} produit{g.nbProduits > 1 ? 's' : ''}
                    </span>
                  )}
                  {g.homolSummary && (
                    <span style={{
                      fontSize:'.7rem', fontWeight:700, padding:'.2rem .6rem', borderRadius:50, flexShrink:0,
                      background: g.homolSummary.status === 'ok' ? 'var(--green-pale)' : g.homolSummary.status === 'retire' ? '#fdf0ef' : 'var(--amber-pale, #fef3c7)',
                      color: g.homolSummary.status === 'ok' ? 'var(--green-mid)' : g.homolSummary.status === 'retire' ? 'var(--red)' : 'var(--amber)',
                    }}>
                      {g.homolSummary.status === 'ok' ? '✅' : g.homolSummary.status === 'retire' ? '⚠️' : '❓'}
                      {g.homolSummary.delaiH != null ? ` ⏱️${g.homolSummary.delaiH}h` : ''}
                    </span>
                  )}
                  <span style={{ color:'var(--text-muted)', flexShrink:0 }}>›</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'recap' && (
        <div style={{ flex:1, overflow:'auto', padding:'1.4rem 1.5rem' }}>
          <RecapInterventions groups={groups} interventionsCampagne={interventionsCampagne} produits={produits} intrants={intrants} profiles={profiles}
            onOpenGroup={g => { setTab('interventions'); setDetailKey(g.key) }} />
        </div>
      )}

      {/* Édition groupée de la sélection — voir bulkPatch/applyBulk* : chaque
          action ci-dessous s'applique d'un coup à toutes les interventions
          cochées (ou aux lignes produit correspondantes parmi elles). */}
      {bulkEditOpen && (
        <Modal title={`✏️ Modifier ${selGroups.length} intervention${selGroups.length > 1 ? 's' : ''}`} onClose={() => setBulkEditOpen(false)} maxWidth={520}>
          <div style={{ display:'flex', flexDirection:'column', gap:'1.1rem' }}>
            <section style={{ border:'1px solid var(--border)', borderRadius:10, padding:'.8rem .9rem' }}>
              <div style={{ fontSize:'.8rem', fontWeight:700, marginBottom:'.5rem' }}>📅 Changer la date</div>
              <div style={{ display:'flex', gap:'.5rem', flexWrap:'wrap' }}>
                <input type="date" value={bulkDate} onChange={e => setBulkDate(e.target.value)} style={{ flex:'1 1 160px' }} />
                <button className="btn-sm primary" onClick={applyBulkDate} disabled={bulkBusy || !bulkDate}>Appliquer à toute la sélection</button>
              </div>
            </section>

            <section style={{ border:'1px solid var(--border)', borderRadius:10, padding:'.8rem .9rem' }}>
              <div style={{ fontSize:'.8rem', fontWeight:700, marginBottom:'.5rem' }}>➕ Ajouter un produit</div>
              <div style={{ display:'flex', gap:'.5rem', flexWrap:'wrap' }}>
                <input value={bulkAddProduit.nom} onChange={e => setBulkAddProduit({ ...bulkAddProduit, nom: e.target.value })} placeholder="Nom du produit" style={{ flex:'1 1 160px' }} />
                <input type="number" step="0.01" value={bulkAddProduit.quantite} onChange={e => setBulkAddProduit({ ...bulkAddProduit, quantite: e.target.value })} placeholder="Dose" style={{ width:90 }} />
                <input value={bulkAddProduit.unite} onChange={e => setBulkAddProduit({ ...bulkAddProduit, unite: e.target.value })} placeholder="Unité" style={{ width:70 }} />
              </div>
              <button className="btn-sm primary" onClick={applyBulkAddProduit} disabled={bulkBusy || !bulkAddProduit.nom.trim()} style={{ marginTop:'.5rem' }}>
                Ajouter à toute la sélection
              </button>
            </section>

            {produitsInSelection.length > 0 && (
              <section style={{ border:'1px solid var(--border)', borderRadius:10, padding:'.8rem .9rem' }}>
                <div style={{ fontSize:'.8rem', fontWeight:700, marginBottom:'.5rem' }}>⚖️ Modifier la dose d'un produit</div>
                <div style={{ display:'flex', gap:'.5rem', flexWrap:'wrap' }}>
                  <select value={bulkDoseProduit} onChange={e => setBulkDoseProduit(e.target.value)} style={{ flex:'1 1 160px' }}>
                    <option value="">Choisir un produit…</option>
                    {produitsInSelection.map(nom => <option key={nom} value={nom}>{nom}</option>)}
                  </select>
                  <input type="number" step="0.01" value={bulkDoseValue} onChange={e => setBulkDoseValue(e.target.value)} placeholder="Nouvelle dose" style={{ width:110 }} />
                </div>
                <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:'.3rem' }}>
                  S'applique à toutes les lignes de la sélection utilisant ce produit.
                </div>
                <button className="btn-sm primary" onClick={applyBulkDose} disabled={bulkBusy || !bulkDoseProduit} style={{ marginTop:'.5rem' }}>
                  Appliquer
                </button>
              </section>
            )}

            {produitsInSelection.length > 0 && (
              <section style={{ border:'1px solid var(--border)', borderRadius:10, padding:'.8rem .9rem' }}>
                <div style={{ fontSize:'.8rem', fontWeight:700, marginBottom:'.5rem' }}>➖ Retirer un produit</div>
                <div style={{ display:'flex', gap:'.5rem', flexWrap:'wrap' }}>
                  <select value={bulkRemoveProduit} onChange={e => setBulkRemoveProduit(e.target.value)} style={{ flex:'1 1 160px' }}>
                    <option value="">Choisir un produit…</option>
                    {produitsInSelection.map(nom => <option key={nom} value={nom}>{nom}</option>)}
                  </select>
                  <button className="btn-sm danger" onClick={applyBulkRemoveProduit} disabled={bulkBusy || !bulkRemoveProduit}>
                    Retirer de la sélection
                  </button>
                </div>
              </section>
            )}
          </div>
        </Modal>
      )}

      {/* Détail d'un événement d'intervention */}
      {detailGroup && (
        <Modal title={`${TYPE_ICON[detailGroup.type] || '📋'} ${detailGroup.type} — ${fmtDate(detailGroup.date)}`} onClose={() => setDetailKey(null)} maxWidth={620}>
          <div style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
            <div style={{ fontSize:'.82rem', color:'var(--text-muted)', display:'flex', gap:'1rem', flexWrap:'wrap' }}>
              <span>📍 {detailGroup.parcelle || '–'}</span>
              {detailGroup.culture && <span>🌾 {detailGroup.culture}</span>}
              {detailGroup.surface_ha != null && <span>📐 {detailGroup.surface_ha} ha</span>}
              {detailGroup.rows[0]?.user_id && <span>👤 Saisie par {nameOf(detailGroup.rows[0].user_id)}</span>}
            </div>
            {detailGroup.rows[0]?.outil_ids?.length > 0 && (
              <div style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                🔧 {outils.filter(o => detailGroup.rows[0].outil_ids.includes(o.id)).map(o => o.nom).join(', ')}
              </div>
            )}
            <div className="form-group">
              <label>💬 Observation</label>
              <textarea rows={2} value={groupRemarqueDraft} onChange={e => setGroupRemarqueDraft(e.target.value)}
                placeholder="ex. conditions météo, remarque particulière…"
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
              {groupRemarqueDraft !== (detailGroup.rows[0]?.remarque || '') && (
                <button className="btn-sm primary" style={{ marginTop:'.4rem' }} onClick={saveGroupRemarque} disabled={savingGroupRemarque}>
                  {savingGroupRemarque ? '⏳ Enregistrement…' : '✅ Enregistrer l\'observation'}
                </button>
              )}
            </div>
            {detailGroup.rows[0]?.photos?.length > 0 && (
              <button type="button" onClick={() => setLightboxPhotos(detailGroup.rows[0].photos)}
                style={{ alignSelf:'flex-start', fontSize:'.78rem', background:'var(--green-pale)', border:'none', borderRadius:50, padding:'.2rem .6rem', cursor:'pointer' }}>
                📷 Voir {detailGroup.rows[0].photos.length} photo{detailGroup.rows[0].photos.length > 1 ? 's' : ''}
              </button>
            )}

            <div style={{ display:'flex', flexDirection:'column', gap:'.5rem' }}>
              {detailGroup.rows.map(r => {
                const homol = homologationFor(r)
                return (
                  <div key={r.id} style={{ border:'1px solid var(--border)', borderRadius:10, padding:'.7rem .9rem', display:'flex', alignItems:'center', gap:'.8rem', flexWrap:'wrap' }}>
                    <div style={{ flex:'1 1 160px', minWidth:0 }}>
                      <div style={{ fontWeight:700, fontSize:'.86rem' }}>
                        {r.produit_nom || (r.observation === 'Travail du sol' && r.sous_type) || '— (sans produit)'}
                      </div>
                      {r.produit_nom && <div style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>{r.quantite} {r.unite}</div>}
                    </div>
                    {homol && (
                      <div style={{ display:'flex', flexDirection:'column', gap:'.2rem', alignItems:'flex-start' }}>
                        <span style={{
                          fontSize:'.68rem', fontWeight:700, padding:'.12rem .5rem', borderRadius:50,
                          background: homol.status === 'ok' ? 'var(--green-pale)' : homol.status === 'retire' ? '#fdf0ef' : 'var(--amber-pale, #fef3c7)',
                          color: homol.status === 'ok' ? 'var(--green-mid)' : homol.status === 'retire' ? 'var(--red)' : 'var(--amber)',
                        }}>
                          {homol.status === 'ok' ? '✅' : homol.status === 'retire' ? '⚠️' : '❓'} {homol.label}
                        </span>
                        {homol.delaiH != null ? (
                          <span style={{ fontSize:'.64rem', fontWeight:700, color:'var(--blue, #3968b3)' }}>⏱️ {homol.delaiH}h avant rentrée</span>
                        ) : (
                          <span style={{ fontSize:'.6rem', color:'var(--text-muted)', fontStyle:'italic' }}>⏱️ délai à vérifier</span>
                        )}
                      </div>
                    )}
                    <button className="btn-sm" onClick={() => openEditLine(r)}>✏️</button>
                  </div>
                )
              })}
            </div>

            <div style={{ display:'flex', justifyContent:'space-between', gap:'.6rem', flexWrap:'wrap' }}>
              <button className="btn-sm" onClick={() => openAddToGroup(detailGroup)}>+ Ajouter un produit</button>
              <button className="btn-sm danger" onClick={() => deleteGroup(detailGroup)}>🗑️ Supprimer toute l'intervention</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Modal édition/ajout d'une ligne produit */}
      {editingLine && (
        <Modal title={editingLine.id ? 'Modifier le produit' : 'Nouvelle intervention phyto'} onClose={() => setEditingLine(null)} onSave={saveLine} onDelete={editingLine.id ? delLine : null} maxWidth={480}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group">
              <label>Type d'intervention *</label>
              <select value={editingLine.observation || ''} onChange={e => setEditingLine({ ...editingLine, observation: e.target.value, sous_type: '' })}>
                <option value="">-- Choisir --</option>
                {TYPES_INTERVENTION.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Date *</label><input type="date" value={editingLine.date} onChange={e => setEditingLine({ ...editingLine, date: e.target.value })} /></div>
            {editingLine.observation === 'Travail du sol' && (
              <div className="form-group">
                <label>Sous-type</label>
                <select value={editingLine.sous_type || ''} onChange={e => setEditingLine({ ...editingLine, sous_type: e.target.value })}>
                  <option value="">-- Choisir --</option>
                  {SOUS_TYPES_TRAVAIL_SOL.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            {editingLineCanHaveProduit && (
              editingLine.multi ? (
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Produits *</label>
                  <div style={{ display:'flex', flexDirection:'column', gap:'.5rem' }}>
                    {intervLignes.map((l, i) => {
                      const matches = l.produit_nom.trim().length > 0 && produitSource
                        ? produitSource.items.filter(p => produitSource.table === 'db_phyto' ? phytoMatches(p, l.produit_nom) : (p.nom || '').toLowerCase().includes(l.produit_nom.toLowerCase())).slice(0, 8)
                        : []
                      return (
                        <div key={i} style={{ display:'flex', gap:'.4rem', alignItems:'center', flexWrap:'wrap' }}>
                          <div style={{ flex:'2 1 160px', minWidth:0, position:'relative' }}>
                            <input ref={el => (ligneInputRefs.current[i] = el)} placeholder="🔍 Rechercher un produit…" value={l.produit_nom} style={{ width:'100%' }}
                              onChange={e => { updateLigne(i, { produit_nom: e.target.value, produit_id: null }); setOpenLigneDropdown(i) }}
                              onFocus={() => setOpenLigneDropdown(i)}
                              onBlur={() => setTimeout(() => setOpenLigneDropdown(cur => cur === i ? null : cur), 200)} />
                            {openLigneDropdown === i && matches.length > 0 && (
                              <FloatingDropdown anchorRef={{ current: ligneInputRefs.current[i] }}>
                                {matches.map(p => {
                                  const nom = productItemName(p, produitSource.table)
                                  const stock = productItemStock(p, produitSource.table)
                                  const unite = productItemUnite(p, produitSource.table)
                                  return (
                                    <div key={p.id} onMouseDown={() => { updateLigne(i, { produit_nom: nom, produit_id: p.id, unite: unite || l.unite }); setOpenLigneDropdown(null) }}
                                      style={{ padding:'.5rem .8rem', cursor:'pointer', fontSize:'.82rem', borderBottom:'1px solid var(--border)' }}>
                                      <strong>{nom}</strong>{stock != null && <span style={{ color:'var(--text-muted)' }}> — stock {stock} {unite}</span>}
                                    </div>
                                  )
                                })}
                              </FloatingDropdown>
                            )}
                          </div>
                          <input type="number" step="0.01" style={{ flex:'1 1 70px', minWidth:70 }} value={l.quantite} onChange={e => updateLigne(i, { quantite: e.target.value })} placeholder="Qté" />
                          <select style={{ width:64, flexShrink:0 }} value={l.unite || 'L'} onChange={e => updateLigne(i, { unite: e.target.value })}>
                            {['L','kg','g','mL'].map(u => <option key={u} value={u}>{u}</option>)}
                          </select>
                          <button type="button" onClick={() => removeLigne(i)} disabled={intervLignes.length === 1}
                            style={{ background:'none', border:'none', cursor: intervLignes.length === 1 ? 'not-allowed' : 'pointer', color:'var(--red)', fontSize:'1.1rem', opacity: intervLignes.length === 1 ? .3 : 1, flexShrink:0 }}>✕</button>
                        </div>
                      )
                    })}
                  </div>
                  <button type="button" className="btn-sm" onClick={addLigne} style={{ marginTop:'.5rem' }}>+ Ajouter un produit</button>
                </div>
              ) : (
                <>
                  <div className="form-group" style={{ gridColumn:'1/-1', position:'relative' }}>
                    <label>Produit *</label>
                    <input ref={produitInputRef} placeholder="🔍 Rechercher un produit…" value={produitQ}
                      onChange={e => { setProduitQ(e.target.value); setEditingLine({ ...editingLine, produit_nom: e.target.value, produit_id: null }); setShowProduitDd(true) }}
                      onFocus={() => setShowProduitDd(true)}
                      onBlur={() => setTimeout(() => setShowProduitDd(false), 200)} />
                    {showProduitDd && produitMatches.length > 0 && (
                      <FloatingDropdown anchorRef={produitInputRef}>
                        {produitMatches.map(p => {
                          const nom = productItemName(p, produitSource.table)
                          const stock = productItemStock(p, produitSource.table)
                          const unite = productItemUnite(p, produitSource.table)
                          return (
                            <div key={p.id} onMouseDown={() => { setProduitQ(nom); setEditingLine({ ...editingLine, produit_nom: nom, produit_id: p.id, unite: unite || editingLine.unite }); setShowProduitDd(false) }}
                              style={{ padding:'.55rem 1rem', cursor:'pointer', fontSize:'.84rem', borderBottom:'1px solid var(--border)' }}>
                              <strong>{nom}</strong>{stock != null && <span style={{ color:'var(--text-muted)' }}> — stock {stock} {unite}</span>}
                            </div>
                          )
                        })}
                      </FloatingDropdown>
                    )}
                  </div>
                  <div className="form-group"><label>Quantité utilisée *</label>
                    <div style={{ display:'flex', gap:'.4rem' }}>
                      <input type="number" step="0.01" style={{ flex:'1 1 0', minWidth:0 }} value={editingLine.quantite} onChange={e => setEditingLine({ ...editingLine, quantite: e.target.value })} placeholder="ex. 5" />
                      <select style={{ width:64, flexShrink:0 }} value={editingLine.unite || 'L'} onChange={e => setEditingLine({ ...editingLine, unite: e.target.value })}>
                        {['L','kg','g','mL'].map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </div>
                </>
              )
            )}
            <div className="form-group"><label>Culture</label><input value={editingLine.culture || ''} onChange={e => setEditingLine({ ...editingLine, culture: e.target.value })} placeholder="ex. Blé" /></div>
            {editingLine.multi ? (
              <div className="form-group" style={{ gridColumn:'1/-1' }}>
                {(() => {
                  const nomsChoisis = parcelles.filter(p => multiParcelleIds.has(p.id)).map(p => p.nom)
                  const parcellesFiltrees = parcelles.filter(p => p.nom.toLowerCase().includes(multiParcelleQ.toLowerCase()))
                  return (
                    <>
                      <button type="button" onClick={() => setMultiParcelleOuvert(v => !v)} style={{
                        display:'flex', alignItems:'center', justifyContent:'space-between', width:'100%',
                        background:'var(--cream)', border:'1px solid var(--border)', borderRadius:8,
                        padding:'.55rem .8rem', cursor:'pointer', textAlign:'left',
                      }}>
                        <span style={{ fontSize:'.84rem', fontWeight:600 }}>
                          📍 Parcelles {nomsChoisis.length > 0 ? `(${nomsChoisis.length})` : '(optionnel)'}
                        </span>
                        <span style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>{multiParcelleOuvert ? '▾ Réduire' : '▸ Choisir'}</span>
                      </button>
                      {!multiParcelleOuvert && nomsChoisis.length > 0 && (
                        <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginTop:'.35rem' }}>{nomsChoisis.join(', ')}</div>
                      )}
                      {multiParcelleOuvert && (
                        <div style={{ border:'1px solid var(--border)', borderTop:'none', borderRadius:'0 0 8px 8px', overflow:'hidden' }}>
                          <input placeholder="🔍 Rechercher une parcelle…" value={multiParcelleQ} onChange={e => setMultiParcelleQ(e.target.value)}
                            style={{ width:'100%', padding:'.5rem .7rem', border:'none', borderBottom:'1px solid var(--border)', fontSize:'.84rem', outline:'none' }} />
                          <div style={{ display:'flex', flexDirection:'column', gap:'.2rem', maxHeight:220, overflowY:'auto', padding:'.4rem' }}>
                            {parcellesFiltrees.length === 0 && (
                              <div style={{ padding:'.5rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.78rem' }}>Aucune parcelle trouvée.</div>
                            )}
                            {parcellesFiltrees.map(p => {
                              const checked = multiParcelleIds.has(p.id)
                              return (
                                <label key={p.id} onClick={() => {
                                  setMultiParcelleIds(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next })
                                  setIntervSurfaceHaByParcelle(prev => prev[p.id] != null ? prev : { ...prev, [p.id]: p.surface != null ? String(p.surface) : '' })
                                }}
                                  style={{ display:'flex', alignItems:'center', gap:'.5rem', padding:'.35rem .5rem', borderRadius:6, cursor:'pointer', fontSize:'.84rem', background: checked ? 'var(--green-pale)' : 'transparent' }}>
                                  <span>{checked ? '✅' : '⬜'}</span>
                                  <span style={{ flex:1 }}>{p.nom}</span>
                                  {p.culture_actuelle && <span style={{ color:'var(--text-muted)', fontSize:'.76rem' }}>({p.culture_actuelle})</span>}
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>
            ) : (
              <div className="form-group" style={{ position:'relative' }}>
                <label>Parcelle</label>
                <input ref={parcelleInputRef} placeholder="🔍 Rechercher une parcelle…" value={parcelleQ}
                  onChange={e => { setParcelleQ(e.target.value); setEditingLine({ ...editingLine, parcelle: e.target.value, parcelle_id: null }); setShowParcelleDd(true) }}
                  onFocus={() => setShowParcelleDd(true)}
                  onBlur={() => setTimeout(() => setShowParcelleDd(false), 200)} />
                {showParcelleDd && parcelleQ.length > 0 && parcelles.filter(p => p.nom.toLowerCase().includes(parcelleQ.toLowerCase())).length > 0 && (
                  <FloatingDropdown anchorRef={parcelleInputRef}>
                    {parcelles.filter(p => p.nom.toLowerCase().includes(parcelleQ.toLowerCase())).slice(0,8).map(p => (
                      <div key={p.id} onMouseDown={() => { setParcelleQ(p.nom); setEditingLine({ ...editingLine, parcelle: p.nom, parcelle_id: p.id, culture: editingLine.culture || p.culture_actuelle || '' }); setShowParcelleDd(false) }}
                        style={{ padding:'.55rem 1rem', cursor:'pointer', fontSize:'.84rem', borderBottom:'1px solid var(--border)' }}>
                        <strong>{p.nom}</strong>{p.culture_actuelle && <span style={{ color:'var(--text-muted)' }}> — {p.culture_actuelle}</span>}
                      </div>
                    ))}
                  </FloatingDropdown>
                )}
              </div>
            )}
            {editingLine.multi && multiParcelleIds.size > 0 && (
              <div className="form-group" style={{ gridColumn:'1/-1' }}>
                <label>Surface traitée par parcelle (ha)</label>
                <p style={{ fontSize:'.72rem', color:'var(--text-muted)', margin:'0 0 .5rem' }}>Pré-remplie avec la surface de chaque parcelle — modifiable.</p>
                <div style={{ display:'flex', flexDirection:'column', gap:'.4rem' }}>
                  {[...multiParcelleIds].map(pid => {
                    const p = parcelles.find(pp => pp.id === pid)
                    if (!p) return null
                    return (
                      <div key={pid} style={{ display:'flex', alignItems:'center', gap:'.5rem', padding:'.4rem .6rem', background:'var(--cream)', borderRadius:8 }}>
                        <strong style={{ flex:1, fontSize:'.82rem' }}>{p.nom}</strong>
                        <input type="number" step="0.01" min="0" style={{ width:80 }}
                          value={intervSurfaceHaByParcelle[pid] ?? ''}
                          onChange={e => setIntervSurfaceHaByParcelle(prev => ({ ...prev, [pid]: e.target.value }))} placeholder="ha" />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {editingLine.multi && (
              <div className="form-group" style={{ gridColumn:'1/-1' }}>
                <label>Zone concernée (optionnel)</label>
                <div style={{ display:'flex', gap:'1.2rem' }}>
                  <label style={{ display:'flex', alignItems:'center', gap:'.5rem', fontWeight:500, cursor:'pointer' }}>
                    <input type="checkbox" checked={intervFourrieres} onChange={e => setIntervFourrieres(e.target.checked)} />
                    Fourrières uniquement
                  </label>
                  <label style={{ display:'flex', alignItems:'center', gap:'.5rem', fontWeight:500, cursor:'pointer' }}>
                    <input type="checkbox" checked={intervRive} onChange={e => setIntervRive(e.target.checked)} />
                    Rive uniquement
                  </label>
                </div>
              </div>
            )}
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              {outils.length === 0 ? (
                <>
                  <label>Outils utilisés (optionnel)</label>
                  <span style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>Aucun outil enregistré — ajoutez-en dans Outils agricoles.</span>
                </>
              ) : (() => {
                const nomsChoisis = outils.filter(o => (editingLine.outil_ids || []).includes(o.id)).map(o => o.nom)
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
                        {outils.map(o => {
                          const checked = (editingLine.outil_ids || []).includes(o.id)
                          return (
                            <label key={o.id} style={{ display:'flex', alignItems:'center', gap:'.5rem', padding:'.35rem .5rem', borderRadius:6, cursor:'pointer', fontSize:'.84rem', background: checked ? 'var(--green-pale)' : 'transparent' }}>
                              <input type="checkbox" checked={checked}
                                onChange={() => setEditingLine(prev => ({ ...prev, outil_ids: checked ? prev.outil_ids.filter(id => id !== o.id) : [...(prev.outil_ids || []), o.id] }))} />
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
            <div className="form-group" style={{ gridColumn:'1/-1' }}><label>Remarque (optionnel)</label>
              <textarea rows={2} value={editingLine.remarque || ''} onChange={e => setEditingLine({ ...editingLine, remarque: e.target.value })}
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
              {(editingLine.photos || []).length > 0 && (
                <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap' }}>
                  {editingLine.photos.map((url, i) => (
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

function SectionTitle({ children }) {
  return <div style={{ fontSize:'.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', marginBottom:'.7rem' }}>{children}</div>
}

// Étiquettes de catégorie produit (mêmes codes que Base de données / Coût de
// revient) — utilisées uniquement pour la vue "Par catégorie produit" du récap.
const RECAP_CAT_LABEL = {
  fongicide: '🍄 Fongicide', herbicide: '🌿 Herbicide', insecticide: '🐛 Insecticide',
  adjuvant: '💧 Adjuvant', regulateur: '📏 Régulateur de croissance', oligo: '⚗️ Oligo-élément',
  engrais: '🌾 Engrais', semences: '🌱 Semences', fertilisant: '💧 Fertilisant', ferti: '💧 Fertilisant',
}
// Retrouve la catégorie d'une ligne produit par son produit_id (phyto) si connu,
// sinon par correspondance de nom dans Phyto puis Intrants — une ligne dont le
// produit vient d'Intrants n'a jamais de produit_id valide (voir le correctif de
// la contrainte de clé étrangère), le nom reste donc la seule piste fiable.
function categorieLabelForRow(r, produits, intrants) {
  const nameLower = (r.produit_nom || '').trim().toLowerCase()
  const p = (r.produit_id && produits.find(x => x.id === r.produit_id))
    || produits.find(x => (x.nom || '').trim().toLowerCase() === nameLower || (x.nom_secondaire || '').trim().toLowerCase() === nameLower)
    || intrants.find(x => (x.nom || '').trim().toLowerCase() === nameLower)
  const cat = (p?.categorie || '').trim().toLowerCase()
  return RECAP_CAT_LABEL[cat] || 'Autre / non classé'
}

const RECAP_VUES = [
  { key: 'date', label: '📅 Par date' },
  { key: 'type', label: '🔧 Par type d\'intervention' },
  { key: 'categorie', label: '🧪 Par catégorie produit' },
  { key: 'parcelle', label: '📍 Par parcelle' },
  { key: 'utilisateur', label: '👤 Par utilisateur' },
]

// Récap visuel des interventions de la campagne active — histogramme cliquable
// (une barre = une valeur pour la vue choisie), le clic sur une barre déroule la
// liste des interventions concernées juste en dessous, avec accès direct au
// détail complet (bascule vers l'onglet Interventions + ouvre l'événement).
// La vue "Par utilisateur" sert de carnet de suivi — qui a fait quoi, sans
// avoir à noter ça à part.
function RecapInterventions({ groups, interventionsCampagne, produits, intrants, profiles, onOpenGroup }) {
  const [vue, setVue] = useState('date')
  const [activeKey, setActiveKey] = useState(null)
  const nameOf = id => profiles?.find(p => p.id === id)?.display_name || 'Non renseigné'

  const bars = useMemo(() => {
    if (vue === 'date') {
      const map = new Map()
      for (const g of groups) {
        const k = (g.date || '').slice(0, 7)
        if (!k) continue
        map.set(k, (map.get(k) || 0) + 1)
      }
      return [...map.entries()].map(([key, value]) => ({ key, label: formatMonth(key), value })).sort((a, b) => a.key.localeCompare(b.key))
    }
    if (vue === 'type') {
      const map = new Map()
      for (const g of groups) map.set(g.type, (map.get(g.type) || 0) + 1)
      return [...map.entries()].map(([key, value]) => ({ key, label: `${TYPE_ICON[key] || '📋'} ${key}`, value })).sort((a, b) => b.value - a.value)
    }
    if (vue === 'parcelle') {
      const map = new Map()
      for (const g of groups) {
        const k = g.parcelle || '(sans parcelle)'
        map.set(k, (map.get(k) || 0) + 1)
      }
      return [...map.entries()].map(([key, value]) => ({ key, label: key, value })).sort((a, b) => b.value - a.value)
    }
    if (vue === 'utilisateur') {
      const map = new Map()
      for (const g of groups) {
        const k = g.rows[0]?.user_id || '(non renseigné)'
        map.set(k, (map.get(k) || 0) + 1)
      }
      return [...map.entries()].map(([key, value]) => ({ key, label: key === '(non renseigné)' ? '❓ Non renseigné' : `👤 ${nameOf(key)}`, value })).sort((a, b) => b.value - a.value)
    }
    const map = new Map()
    for (const r of interventionsCampagne) {
      if (!r.produit_nom) continue
      const label = categorieLabelForRow(r, produits, intrants)
      map.set(label, (map.get(label) || 0) + 1)
    }
    return [...map.entries()].map(([key, value]) => ({ key, label: key, value })).sort((a, b) => b.value - a.value)
  }, [vue, groups, interventionsCampagne, produits, intrants, profiles])

  const max = Math.max(1, ...bars.map(b => b.value))

  const matchingGroups = useMemo(() => {
    if (!activeKey) return []
    if (vue === 'date') return groups.filter(g => (g.date || '').slice(0, 7) === activeKey)
    if (vue === 'type') return groups.filter(g => g.type === activeKey)
    if (vue === 'parcelle') return groups.filter(g => (g.parcelle || '(sans parcelle)') === activeKey)
    if (vue === 'utilisateur') return groups.filter(g => (g.rows[0]?.user_id || '(non renseigné)') === activeKey)
    return groups.filter(g => g.rows.some(r => r.produit_nom && categorieLabelForRow(r, produits, intrants) === activeKey))
  }, [activeKey, vue, groups, produits, intrants])

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
      <div style={{ display:'flex', gap:'.4rem', flexWrap:'wrap' }}>
        {RECAP_VUES.map(v => (
          <button key={v.key} className="btn-sm" onClick={() => { setVue(v.key); setActiveKey(null) }}
            style={vue === v.key ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)' } : {}}>
            {v.label}
          </button>
        ))}
      </div>

      {bars.length === 0 ? (
        <div style={{ textAlign:'center', padding:'2.5rem', background:'white', borderRadius:12, border:'2px dashed var(--border)', color:'var(--text-muted)' }}>
          Aucune donnée pour cette vue.
        </div>
      ) : (
        <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1.1rem 1.2rem', display:'flex', flexDirection:'column', gap:'.7rem' }}>
          {bars.map(b => {
            const isActive = activeKey === b.key
            return (
              <div key={b.key} onClick={() => setActiveKey(isActive ? null : b.key)} style={{ cursor:'pointer' }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:'.82rem', marginBottom:'.25rem' }}>
                  <span style={{ fontWeight: isActive ? 700 : 500, color: isActive ? 'var(--green-mid)' : 'var(--text-main)' }}>{b.label}</span>
                  <span style={{ fontWeight:700 }}>{b.value}</span>
                </div>
                <div style={{ height:10, background:'var(--cream)', borderRadius:6, overflow:'hidden' }}>
                  <div style={{ height:'100%', width:`${(b.value / max) * 100}%`, background: isActive ? 'var(--green-mid)' : 'var(--green-accent)', borderRadius:6, transition:'width .4s ease, background .2s ease' }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {activeKey && (
        <div style={{ background:'var(--cream)', border:'1px solid var(--border)', borderRadius:12, padding:'.8rem 1rem', display:'flex', flexDirection:'column', gap:'.4rem' }}>
          <div style={{ fontSize:'.72rem', fontWeight:700, color:'var(--text-muted)', textTransform:'uppercase' }}>
            {matchingGroups.length} intervention{matchingGroups.length > 1 ? 's' : ''} — {bars.find(b => b.key === activeKey)?.label || activeKey}
          </div>
          {matchingGroups.slice(0, 30).map(g => (
            <div key={g.key} onClick={() => onOpenGroup(g)}
              style={{ display:'flex', alignItems:'center', gap:'.6rem', background:'white', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem', cursor:'pointer', flexWrap:'wrap' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
              onMouseLeave={e => e.currentTarget.style.background = 'white'}>
              <span style={{ fontSize:'.72rem', color:'var(--text-muted)', flexShrink:0 }}>{fmtDate(g.date)}</span>
              <span style={{ fontSize:'1rem', flexShrink:0 }}>{TYPE_ICON[g.type] || '📋'}</span>
              <span style={{ fontWeight:600, fontSize:'.82rem', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.type}</span>
              <span style={{ fontSize:'.76rem', color:'var(--text-muted)', flexShrink:0 }}>{g.parcelle || '—'}</span>
              {vue !== 'utilisateur' && <span style={{ fontSize:'.72rem', color:'var(--text-muted)', flexShrink:0 }}>👤 {nameOf(g.rows[0]?.user_id)}</span>}
              <span style={{ color:'var(--text-muted)', flexShrink:0 }}>›</span>
            </div>
          ))}
          {matchingGroups.length > 30 && <div style={{ fontSize:'.76rem', color:'var(--text-muted)', textAlign:'center' }}>+ {matchingGroups.length - 30} autre{matchingGroups.length - 30 > 1 ? 's' : ''}…</div>}
        </div>
      )}
    </div>
  )
}
