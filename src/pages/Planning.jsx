import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/useToast'
import { useAuth } from '../lib/AuthContext'
import { printLogoHtml } from '../lib/printLogo'
import { logCongeHistorique } from '../lib/congesHistorique'
import { useCampagne } from '../lib/CampagneContext'
import { fmtDate } from '../lib/formatDate'
import PhotoLightbox from '../components/PhotoLightbox'

const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
const LIEU_COLORS = ['#4a9050','#3498db','#e67e22','#9b59b6','#e74c3c','#1abc9c','#f39c12','#2980b9','#8e44ad','#16a085']
// Garantit une couleur distincte pour chaque nouveau lieu de chargement (pas de doublon tant qu'il reste une couleur libre)
function nextLieuColor(existingLieux) {
  const used = new Set((existingLieux || []).map(l => l.couleur))
  const free = LIEU_COLORS.find(c => !used.has(c))
  return free || LIEU_COLORS[(existingLieux?.length || 0) % LIEU_COLORS.length]
}
// Couleur stable et propre à chaque lieu saisi manuellement (dérivée du nom, sans passer par la liste enregistrée)
function manualLieuColor(nom) {
  let hash = 0
  for (let i = 0; i < nom.length; i++) hash = (hash * 31 + nom.charCodeAt(i)) >>> 0
  return `hsl(${hash % 360}, 62%, 42%)`
}

// Résout le lieu affichable (nom+couleur) d'un chargement externe, qu'il soit lié à un
// lieu enregistré ou saisi librement — utilisé pour la confirmation d'achat imprimable.
function resolveLieu(item, lieux) {
  const lr = lieux.find(l => l.id === item.lieu_chargement_id)
  if (lr) return { nom: lr.nom, couleur: lr.couleur }
  const manuel = item.lieu_chargement_manuel?.trim()
  return manuel ? { nom: manuel, manual: true } : null
}

// Résout l'adresse d'un client pour la confirmation d'achat imprimable — priorité à la fiche
// client à jour dans la base (via client_id) plutôt qu'à un éventuel instantané figé sur
// l'item, pour toujours afficher l'adresse la plus récente quand elle existe.
function resolveClientAddress(item, clients) {
  const c = item.client_id ? clients.find(c => c.id === item.client_id) : null
  if (c) return { client_adresse: c.adresse || '', client_cp: c.code_postal || '', client_ville: c.ville || '', client_pays: c.pays || '' }
  return { client_adresse: item.client_adresse || '', client_cp: item.client_cp || '', client_ville: item.client_ville || '', client_pays: item.client_pays || '' }
}
// Formate l'adresse d'affichage pour la confirmation d'achat — même sans adresse postale
// complète, on affiche au moins ville + pays quand ils sont connus (utile pour les clients
// export où seule la fiche pays/ville est renseignée).
function formatClientAddress(item) {
  const line1 = [item.client_adresse, item.client_cp].filter(Boolean).join(', ')
  const line2 = [item.client_ville, item.client_pays].filter(Boolean).join(', ')
  return [line1, line2].filter(Boolean).join(' — ')
}

// Lien pour un point GPS individuel — priorité à une URL collée directement (ex. lien Google
// Maps partagé), sinon reconstruit un lien à partir de la latitude/longitude.
function pointLink(p) {
  if (!p) return null
  if (p.url && p.url.trim()) return p.url.trim()
  if (p.lat != null && p.lat !== '' && p.lng != null && p.lng !== '') return `https://www.google.com/maps?q=${p.lat},${p.lng}`
  return null
}
// Lien Google Maps pour un ou plusieurs points GPS attachés à un chargement — un seul point
// ouvre son lien direct, plusieurs points (tous avec lat/lng) ouvrent un itinéraire passant par
// chacun ; sinon on retombe sur le lien du premier point valide.
function gpsPointsMapUrl(points) {
  const valid = (points || []).filter(p => pointLink(p))
  if (!valid.length) return null
  if (valid.length === 1) return pointLink(valid[0])
  const allHaveCoords = valid.every(p => p.lat != null && p.lat !== '' && p.lng != null && p.lng !== '')
  if (allHaveCoords) return `https://www.google.com/maps/dir/${valid.map(p => `${p.lat},${p.lng}`).join('/')}`
  return pointLink(valid[0])
}
// Points GPS d'un lieu de chargement — nouveau champ multi-points (gps_points), avec repli sur
// l'ancien point unique (lat/lng/gps_url) pour les lieux enregistrés avant ce changement.
function lieuGpsPoints(l) {
  if (!l) return []
  if (Array.isArray(l.gps_points) && l.gps_points.length) return l.gps_points
  const legacy = pointLink({ lat: l.lat, lng: l.lng, url: l.gps_url })
  return legacy ? [{ lat: l.lat, lng: l.lng, url: l.gps_url, label: '' }] : []
}

function getMonday(d) {
  const date = new Date(d)
  const day = date.getDay()
  const diff = day === 0 ? -6 : 1 - day
  date.setDate(date.getDate() + diff)
  date.setHours(0, 0, 0, 0)
  return date
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
// ATTENTION : ne jamais utiliser d.toISOString() ici — ça convertit en UTC et
// décale la date d'un jour en France selon l'heure locale (le bug "camion saisi
// le 15, enregistré le 14"). On reconstruit la date à partir des composants LOCAUX.
function toDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function toSlot(h, m) { return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
// Affichage compact des variétés/lots d'un RDV — plusieurs possibles sur un même camion
function varietesLabel(rdv) {
  const list = (rdv.varietes || []).filter(v => v.variete?.trim())
  if (!list.length) return rdv.variete || ''
  return list.map(v => v.lot ? `${v.variete} (${v.lot})` : v.variete).join(', ')
}
const CONGES_EMPLOYES = ['Morgan', 'Thierry', 'Vivien', 'Samuel']
function formatWeekLabel(monday) {
  const sunday = addDays(monday, 6)
  return `${monday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} — ${sunday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`
}

export default function Planning() {
  const { canSeePlanningExterne, canSeeSortiesHistorique, perms } = useAuth()
  const { showToast, ToastEl } = useToast()
  const [tab, setTab] = useState('semaine')
  // Rôle restreint à un seul lieu de chargement (ex. Xavier — FP Légumes) : accès
  // au seul onglet Planning, aucun des autres sous-onglets même s'ils seraient
  // sinon visibles par défaut (Sorties camion n'est pas conditionné par
  // planningHideExterne, qui doit justement rester désactivé pour lui — il ne
  // voit QUE des chargements extérieurs).
  const restreintUnLieu = !!perms.planningOnlyLieuNom
  const canSeeSortiesTab = canSeeSortiesHistorique && !restreintUnLieu
  // Xavier a aussi accès à l'onglet MC CAIN, filtré exactement de la même façon
  // que le planning principal (même lieu uniquement) — mais pas Confirmations
  // d'achat ni Récap MC CAIN, réservés aux managers.
  const canSeeExterneTab = canSeePlanningExterne || restreintUnLieu

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}
      {/* Tabs */}
      <div style={{ background: 'var(--green-deep)', display: 'flex', gap: '.2rem', padding: '.5rem .7rem 0', overflowX: 'auto', flexShrink: 0, WebkitOverflowScrolling: 'touch' }}>
        <PlanTab active={tab === 'semaine'} onClick={() => setTab('semaine')}>📅 Planning</PlanTab>
        {canSeeExterneTab && (
          <PlanTab active={tab === 'externe'} onClick={() => setTab('externe')}>🚛 Chargements MC CAIN</PlanTab>
        )}
        {canSeePlanningExterne && (
          <PlanTab active={tab === 'confirmations'} onClick={() => setTab('confirmations')}>🧾 Confirmations d'achat</PlanTab>
        )}
        {canSeePlanningExterne && (
          <PlanTab active={tab === 'recap'} onClick={() => setTab('recap')}>📊 Récap MC CAIN</PlanTab>
        )}
        {canSeeSortiesTab && (
          <PlanTab active={tab === 'sorties'} onClick={() => setTab('sorties')}>📦 Sorties camion</PlanTab>
        )}
      </div>

      {tab === 'semaine' && <PlanningSemaine showToast={showToast} />}
      {tab === 'externe' && canSeeExterneTab && <PlanningExterne showToast={showToast} />}
      {tab === 'confirmations' && canSeePlanningExterne && <ConfirmationsAchatTab showToast={showToast} />}
      {tab === 'recap' && canSeePlanningExterne && <RecapMcCainTab />}
      {tab === 'sorties' && canSeeSortiesTab && <SortiesCamion />}
    </div>
  )
}

function PlanTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '.55rem 1rem', borderRadius: '8px 8px 0 0', border: '2px solid rgba(255,255,255,.2)',
        borderBottom: 'none', background: active ? 'var(--green-accent)' : 'rgba(255,255,255,.1)',
        cursor: 'pointer', fontSize: '.8rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0,
        color: active ? 'white' : 'rgba(255,255,255,.8)', transition: 'all .15s'
      }}
    >
      {children}
    </button>
  )
}

/* ════════════════ PLANNING SEMAINE ════════════════ */
function useIsMobilePlanning() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)
  useEffect(() => {
    const fn = () => setM(window.innerWidth < 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return m
}

function PlanningSemaine({ showToast }) {
  const { perms } = useAuth()
  const { campagneActive } = useCampagne()
  const readOnly = !!perms.planningReadOnly
  const canPrepareValide = !!perms.planningCanPrepareValide
  const hideExterne = !!perms.planningHideExterne
  // Rôle restreint à un seul lieu de chargement (ex. Xavier — "FP Légumes") : ne
  // voit que les RDV dont le lieu résolu correspond exactement à ce nom, rien
  // d'autre — voir matchesOnlyLieu, appliqué à la fois au chargement de la
  // semaine et à la recherche.
  const onlyLieuNom = (perms.planningOnlyLieuNom || '').trim().toLowerCase()
  const canUploadCmr = !!perms.planningCanUploadCmr
  const isMobile = useIsMobilePlanning()
  const [refDate, setRefDate]       = useState(new Date())
  const [dayIndex, setDayIndex]     = useState(() => { const d = new Date().getDay(); return d === 0 ? 6 : d - 1 }) // mobile: which day of week is shown
  const [rdvs, setRdvs]             = useState({})
  const [clients, setClients]       = useState([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [modalOpen, setModalOpen]   = useState(false)
  const [editingRdv, setEditingRdv] = useState(null)

  // Drag-and-drop state
  const [dragging, setDragging]     = useState(null) // { rdv, fromDate, fromSlot }
  const [dragOver, setDragOver]     = useState(null) // { dateKey, slot }
  const [dragPos, setDragPos]       = useState({ x: 0, y: 0 })
  const scrollRef                   = useRef(null)

  // Lieux de chargement (code couleur chargements extérieur)
  const [lieux, setLieux]           = useState([])
  const [lieuModalOpen, setLieuModalOpen] = useState(false)
  const [newLieu, setNewLieu]       = useState({ nom: '', couleur: LIEU_COLORS[0] })
  // Rôle restreint à un seul lieu (ex. Xavier) : ne doit même pas voir
  // l'EXISTENCE des autres lieux (légende, filtres…), pas juste leurs
  // chargements — voir onlyLieuNom.
  const visibleLieux = onlyLieuNom ? lieux.filter(l => l.nom.trim().toLowerCase() === onlyLieuNom) : lieux

  // Contrats (pour lier un camion expédié à un contrat en cours)
  const [contrats, setContrats]     = useState([])

  // Congés des 4 salariés — rappel visuel dans le planning, sur la même table/schéma
  // que l'onglet Congés de Global GAP (salarie_id lié au registre des salariés), pour
  // qu'un congé posé ici apparaisse bien là-bas aussi.
  const [salariesList, setSalariesList] = useState([])
  const [conges, setConges]         = useState([])
  const [congesModalOpen, setCongesModalOpen] = useState(false)
  const [congesSalarie, setCongesSalarie] = useState(null) // { id, nom, prenom }
  const [newConge, setNewConge]     = useState({ date_debut: '', date_fin: '', type: 'Congé payé', observation: '' })

  function openLieuModal() {
    setNewLieu({ nom: '', couleur: nextLieuColor(lieux), scope: 'planning' })
    setLieuModalOpen(true)
  }

  async function loadSalariesEtConges() {
    const [{ data: sal }, { data: cg, error }] = await Promise.all([
      supabase.from('salaries').select('id,nom,prenom'),
      supabase.from('conges').select('*').order('date_debut'),
    ])
    setSalariesList(sal || [])
    if (error) { setConges([]); return }
    setConges(cg || [])
  }

  // Résout le salarié du registre correspondant à un des 4 prénoms suivis ici
  // (le nom/prénom peut être stocké dans un ordre différent selon la fiche).
  function salarieForName(name) {
    const n = name.trim().toLowerCase()
    return salariesList.find(s => (s.prenom || '').trim().toLowerCase() === n || (s.nom || '').trim().toLowerCase() === n)
  }

  function openCongesFor(sal) {
    setCongesSalarie(sal)
    setNewConge({ date_debut: '', date_fin: '', type: 'Congé payé', observation: '' })
    setCongesModalOpen(true)
  }

  async function addConge() {
    if (!congesSalarie) { alert('Salarié introuvable dans le registre Global GAP.'); return }
    if (!newConge.date_debut || !newConge.date_fin) { alert('Dates de début et de fin requises.'); return }
    const { data, error } = await supabase.from('conges')
      .insert({ salarie_id: congesSalarie.id, type: newConge.type || 'Congé payé', date_debut: newConge.date_debut, date_fin: newConge.date_fin, observation: newConge.observation || null })
      .select().single()
    if (error) {
      alert(/relation|does not exist|column/i.test(error.message)
        ? 'Table congés manquante — exécute migration_A_EXECUTER_9.sql dans Supabase → SQL Editor.'
        : error.message)
      return
    }
    setConges(prev => [...prev, data].sort((a, b) => a.date_debut.localeCompare(b.date_debut)))
    setNewConge({ date_debut: '', date_fin: '', type: 'Congé payé', observation: '' })
    logCongeHistorique({ conge_id: data.id, salarie_id: data.salarie_id, action: 'creation', type: data.type, date_debut: data.date_debut, date_fin: data.date_fin, source: 'planning' })
    showToast('✅ Congé ajouté')
  }

  async function removeConge(c) {
    if (!confirm('Supprimer ce congé ?')) return
    const { error } = await supabase.from('conges').delete().eq('id', c.id)
    if (error) { alert(error.message); return }
    setConges(prev => prev.filter(x => x.id !== c.id))
    logCongeHistorique({ conge_id: c.id, salarie_id: c.salarie_id, action: 'suppression', type: c.type, date_debut: c.date_debut, date_fin: c.date_fin, source: 'planning' })
  }

  const monday = getMonday(refDate)

  useEffect(() => { loadClients(); loadLieux(); loadContrats(); loadSalariesEtConges() }, [])
  // `lieux` en dépendance : nécessaire pour que matchesOnlyLieu (résolution du
  // nom de lieu depuis lieu_chargement_id) filtre correctement dès que la liste
  // des lieux charge, au lieu de filtrer une première fois sur un tableau encore
  // vide (lieux charge en parallèle, pas garanti d'être prêt avant loadWeek).
  useEffect(() => { loadWeek(monday) }, [refDate, lieux])
  useEffect(() => () => {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
  }, [])

  async function loadClients() {
    const { data } = await supabase.from('clients').select('*').order('nom')
    setClients(data || [])
  }

  async function loadContrats() {
    const { data } = await supabase.from('contrats').select('id,reference,client_nom,variete,date_debut,date_fin').eq('statut', 'en_cours').order('reference')
    setContrats(data || [])
  }

  async function loadLieux() {
    const { data } = await supabase.from('lieux_chargement').select('*').or('scope.is.null,scope.eq.planning').order('nom')
    setLieux(data || [])
  }

  async function saveLieu() {
    if (!newLieu.nom?.trim()) { alert('Nom requis.'); return }
    const { data, error } = await supabase.from('lieux_chargement').insert(newLieu).select().single()
    if (error) { alert(error.message); return }
    setLieux(prev => [...prev, data])
    setLieuModalOpen(false)
    setNewLieu({ nom: '', couleur: LIEU_COLORS[0], scope: 'planning' })
    showToast('✅ Lieu ajouté')
  }

  async function removeLieu(l) {
    if (!confirm(`Supprimer le lieu "${l.nom}" ? Les RDV qui l'utilisent perdront ce code couleur.`)) return
    const { error } = await supabase.from('lieux_chargement').delete().eq('id', l.id)
    if (error) { alert(error.message); return }
    setLieux(prev => prev.filter(x => x.id !== l.id))
    loadWeek(monday)
    showToast('🗑️ Lieu supprimé')
  }

  function getLieu(rdv) { return lieux.find(l => l.id === rdv?.lieu_chargement_id) }
  // Combine : lieu enregistré (avec couleur dédiée) OU saisie manuelle libre (couleur neutre, bordure pointillée)
  function getLieuDisplay(rdv) {
    const l = getLieu(rdv)
    if (l) return { nom: l.nom, couleur: l.couleur, manual: false }
    const manuel = rdv?.lieu_chargement_manuel?.trim()
    if (manuel) return { nom: manuel, couleur: manualLieuColor(manuel), manual: true }
    return null
  }

  function isExterne(r) { return !!(r.lieu_chargement_id || r.lieu_chargement_manuel?.trim()) }

  // Rôle restreint à un seul lieu (ex. Xavier — FP Légumes) : ne laisse passer
  // que les RDV dont le lieu résolu (enregistré ou saisi manuellement) matche
  // exactement ce nom — comparaison insensible à la casse.
  function matchesOnlyLieu(r) {
    if (!onlyLieuNom) return true
    const nom = (getLieuDisplay(r)?.nom || '').trim().toLowerCase()
    return nom === onlyLieuNom
  }

  async function loadWeek(weekMonday) {
    const start = toDateKey(weekMonday)
    const end   = toDateKey(addDays(weekMonday, 6))
    const { data } = await supabase.from('planning_rdv').select('*').gte('date', start).lte('date', end)
    const map = {}
    ;(data || []).forEach(r => {
      if (hideExterne && isExterne(r)) return
      if (!matchesOnlyLieu(r)) return
      if (!map[r.date]) map[r.date] = {}
      map[r.date][r.time_slot] = r
    })
    setRdvs(map)
  }

  function openNewRdv(dateKey, slot) {
    setEditingRdv({ date: dateKey, time_slot: slot, client_id: null, client_nom: '',
      variete: '', lot: '', varietes: [{ variete: '', lot: '' }], calibre: '', type_chargement: '', type_palette: '',
      quantite: '', nb_camions: 1, lave: false, a_confirmer: false, prepare: false, valide: false,
      lieu_chargement_id: null, lieu_chargement_manuel: '', contrat_id: null, tonnage: '',
      ref_chargement: '', immatriculation: '', negociant: '', prix_ht: '',
      observation: '', note_privee: '' })
    setModalOpen(true)
  }
  function openEditRdv(rdv) {
    // Reprise depuis les anciens champs variete/lot (RDV créés avant la saisie multi-variétés)
    const varietes = Array.isArray(rdv.varietes) && rdv.varietes.length ? rdv.varietes : [{ variete: rdv.variete || '', lot: rdv.lot || '' }]
    setEditingRdv({ ...rdv, varietes })
    setModalOpen(true)
  }

  async function togglePrepare(rdv, e) {
    e.stopPropagation()
    const prepare = !rdv.prepare
    const { error } = await supabase.from('planning_rdv').update({ prepare }).eq('id', rdv.id)
    if (error) { alert(error.message); return }
    setRdvs(prev => ({ ...prev, [rdv.date]: { ...prev[rdv.date], [rdv.time_slot]: { ...rdv, prepare } } }))
  }

  async function toggleValide(rdv, e) {
    e.stopPropagation()
    const valide = !rdv.valide
    const { error } = await supabase.from('planning_rdv').update({ valide }).eq('id', rdv.id)
    if (error) { alert(error.message); return }
    setRdvs(prev => ({ ...prev, [rdv.date]: { ...prev[rdv.date], [rdv.time_slot]: { ...rdv, valide } } }))
    if (valide && rdv.tonnage) await ensureBonSortie(rdv)
  }

  // Crée automatiquement un bon de sortie (si pas déjà fait) pour ce camion validé,
  // afin de pouvoir ensuite y ajouter le prix et le n° de facture interne.
  async function ensureBonSortie(rdv) {
    const { data: existing } = await supabase.from('bons_sortie').select('id').eq('planning_rdv_id', rdv.id).maybeSingle()
    if (existing) return
    const payload = {
      date: rdv.date, client_id: rdv.client_id, client_nom: rdv.client_nom,
      contrat_id: rdv.contrat_id || null,
      variete: rdv.variete, calibre: rdv.calibre, type_chargement: rdv.type_chargement,
      quantite: rdv.nb_camions ? `${rdv.nb_camions} camion${rdv.nb_camions > 1 ? 's' : ''}` : '',
      poids_brut: rdv.tonnage, tare_pct: 0, poids_net: rdv.tonnage,
      planning_rdv_id: rdv.id,
      campagne: campagneActive,
    }
    let { error } = await supabase.from('bons_sortie').insert(payload)
    if (error && /campagne|column/i.test(error.message)) {
      const { campagne, ...fallback } = payload
      ;({ error } = await supabase.from('bons_sortie').insert(fallback))
    }
    if (error) console.error('ensureBonSortie', error)
    else showToast('🚚 Bon de sortie créé pour ce camion')
  }

  async function saveRdv() {
    if (!editingRdv.client_nom?.trim()) { alert('Veuillez sélectionner un client.'); return }

    // Remove old slot/date entry if date or slot changed
    const payload = { ...editingRdv }
    delete payload.created_at
    delete payload._origDate
    delete payload._origSlot
    payload.tonnage = payload.tonnage ? parseFloat(payload.tonnage) : null
    payload.prix_ht = payload.prix_ht ? parseFloat(payload.prix_ht) : null
    payload.contrat_id = payload.contrat_id || null
    // Sacs : ne garde que les lignes complètes (palettes > 0)
    if (Array.isArray(payload.sacs)) {
      payload.sacs = payload.sacs
        .filter(s => (parseInt(s.palettes) || 0) > 0)
        .map(s => ({ format: s.format || '25kg', palettes: parseInt(s.palettes) || 0, par_palette: parseInt(s.par_palette) || null }))
      if (!payload.sacs.length) payload.sacs = null
    }
    // Variétés/lots : plusieurs possibles sur un même camion — variete/lot (legacy,
    // toujours renseignés depuis la 1ère ligne) restent à jour pour la recherche et
    // l'affichage des cartes RDV qui ne connaissent que ces deux champs.
    if (Array.isArray(payload.varietes)) {
      payload.varietes = payload.varietes.filter(v => v.variete?.trim())
      payload.variete = payload.varietes[0]?.variete || ''
      payload.lot = payload.varietes[0]?.lot || ''
      if (!payload.varietes.length) payload.varietes = null
    }

    // If date/slot changed on existing rdv, remove the old entry
    const origDate = editingRdv._origDate
    const origSlot = editingRdv._origSlot
    const dateChanged = origDate && (origDate !== payload.date || origSlot !== payload.time_slot)

    const migrationHint = msg => /varietes|column/i.test(msg) && !/lot|palox_prevision|sacs/i.test(msg)
      ? 'Colonne varietes manquante — exécute migration_A_EXECUTER_18.sql dans Supabase → SQL Editor.'
      : /lot|palox_prevision|sacs|could not find|column/i.test(msg)
        ? 'Colonnes lot / palox_prevision / sacs manquantes — exécute migration_A_EXECUTER_4.sql dans Supabase → SQL Editor.'
        : msg
    let saved
    if (payload.id) {
      const { error } = await supabase.from('planning_rdv').update(payload).eq('id', payload.id)
      if (error) { alert(migrationHint(error.message)); return }
      saved = payload
    } else {
      const { data, error } = await supabase.from('planning_rdv').insert(payload).select().single()
      if (error) { alert(migrationHint(error.message)); return }
      saved = data
    }

    setRdvs(prev => {
      const next = { ...prev }
      // Remove old position if moved
      if (dateChanged && next[origDate]?.[origSlot]) {
        next[origDate] = { ...next[origDate] }
        delete next[origDate][origSlot]
      }
      if (!next[saved.date]) next[saved.date] = {}
      next[saved.date] = { ...next[saved.date], [saved.time_slot]: saved }
      return next
    })

    // If new date is outside current week, navigate to it
    const savedMonday = getMonday(new Date(saved.date))
    const curMonday   = getMonday(refDate)
    if (toDateKey(savedMonday) !== toDateKey(curMonday)) {
      setRefDate(new Date(saved.date))
    }

    setModalOpen(false)
    showToast('✅ RDV enregistré')
    if (saved.valide && saved.tonnage) await ensureBonSortie(saved)
  }

  // Photos CMR — jointes directement depuis la carte du RDV (pas besoin d'ouvrir
  // la fiche complète, inaccessible en lecture seule) ; voir planningCanUploadCmr.
  // Même bucket de stockage que les autres photos d'intervention de l'appli.
  const [lightboxPhotos, setLightboxPhotos] = useState(null)
  const [uploadingCmrId, setUploadingCmrId] = useState(null)
  async function handleCmrPhotoFiles(rdv, e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setUploadingCmrId(rdv.id)
    let photos = rdv.photos || []
    for (const file of files) {
      const path = `cmr-${Date.now()}-${Math.random().toString(36).slice(2)}-${file.name}`.replace(/\s+/g, '_')
      const { error } = await supabase.storage.from('intervention-photos').upload(path, file)
      if (error) {
        alert(/not found|bucket/i.test(error.message)
          ? "Bucket de stockage manquant — exécute migration_A_EXECUTER_49.sql dans Supabase → SQL Editor."
          : error.message)
        continue
      }
      const { data } = supabase.storage.from('intervention-photos').getPublicUrl(path)
      photos = [...photos, data.publicUrl]
    }
    const { error } = await supabase.from('planning_rdv').update({ photos }).eq('id', rdv.id)
    setUploadingCmrId(null)
    if (error) {
      alert(/photos|column/i.test(error.message)
        ? "Colonne photos manquante — exécute migration_A_EXECUTER_87.sql dans Supabase → SQL Editor."
        : error.message)
      return
    }
    setRdvs(prev => ({ ...prev, [rdv.date]: { ...prev[rdv.date], [rdv.time_slot]: { ...rdv, photos } } }))
    showToast('📎 CMR ajoutée')
  }

  async function deleteRdv() {
    if (!editingRdv?.id || !confirm('Supprimer ce RDV ?')) return
    await supabase.from('planning_rdv').delete().eq('id', editingRdv.id)
    setRdvs(prev => {
      const next = { ...prev }
      if (next[editingRdv.date]) delete next[editingRdv.date][editingRdv.time_slot]
      return next
    })
    setModalOpen(false)
    showToast('🗑️ RDV supprimé')
  }

  async function runSearch(q) {
    setSearchQuery(q)
    if (!q || q.length < 2) { setSearchResults([]); return }
    const { data } = await supabase.from('planning_rdv').select('*')
      .or(`client_nom.ilike.%${q}%,variete.ilike.%${q}%`)
      .order('date', { ascending: false }).limit(20)
    let results = data || []
    if (hideExterne) results = results.filter(r => !isExterne(r))
    results = results.filter(matchesOnlyLieu)
    setSearchResults(results)
  }

  function goToWeekOf(dateStr) {
    if (!dateStr) return
    setRefDate(new Date(dateStr))
    setSearchResults([])
    setSearchQuery('')
  }

  /* ── Drag handlers (pointer events — clic gauche maintenu ou tactile) ── */
  const dragInfoRef = useRef(null)   // { rdv, fromDate, fromSlot, startX, startY, active }
  const dragOverRef = useRef(null)   // { dateKey, slot } — source de vérité pendant le drag

  function handleCardPointerDown(e, rdv, dateKey, slot) {
    if (e.pointerType === 'mouse' && e.button !== 0) return // clic gauche uniquement
    e.stopPropagation()
    dragInfoRef.current = { rdv, fromDate: dateKey, fromSlot: slot, startX: e.clientX, startY: e.clientY, active: false }
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
  }

  function handleWindowPointerMove(e) {
    const info = dragInfoRef.current
    if (!info) return
    const dx = e.clientX - info.startX, dy = e.clientY - info.startY
    if (!info.active) {
      if (Math.hypot(dx, dy) < 6) return // seuil avant de considérer que c'est un déplacement
      info.active = true
      setDragging({ rdv: info.rdv, fromDate: info.fromDate, fromSlot: info.fromSlot })
    }
    e.preventDefault()
    setDragPos({ x: e.clientX, y: e.clientY })
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const cell = el && el.closest('[data-slot]')
    if (cell) {
      const d = { dateKey: cell.dataset.date, slot: cell.dataset.slot }
      dragOverRef.current = d
      setDragOver(d)
    } else {
      dragOverRef.current = null
      setDragOver(null)
    }
  }

  async function handleWindowPointerUp() {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
    const info = dragInfoRef.current
    dragInfoRef.current = null
    if (!info) return
    if (!info.active) {
      // Pas de déplacement significatif → c'était un simple clic : ouvrir l'édition
      openEditRdv(info.rdv)
      return
    }
    const target = dragOverRef.current
    dragOverRef.current = null
    setDragging(null)
    setDragOver(null)
    if (target) await performMove(info.rdv, info.fromDate, info.fromSlot, target.dateKey, target.slot)
  }

  async function performMove(rdv, fromDate, fromSlot, targetDate, targetSlot) {
    if (fromDate === targetDate && fromSlot === targetSlot) return
    if (rdvs[targetDate]?.[targetSlot]) {
      showToast('⚠️ Ce créneau est déjà occupé')
      return
    }
    const { error } = await supabase.from('planning_rdv').update({ date: targetDate, time_slot: targetSlot }).eq('id', rdv.id)
    if (error) { alert(error.message); return }

    setRdvs(prev => {
      const next = { ...prev }
      if (next[fromDate]) { next[fromDate] = { ...next[fromDate] }; delete next[fromDate][fromSlot] }
      if (!next[targetDate]) next[targetDate] = {}
      next[targetDate] = { ...next[targetDate], [targetSlot]: { ...rdv, date: targetDate, time_slot: targetSlot } }
      return next
    })
    showToast(`✅ RDV déplacé → ${targetDate} ${targetSlot}`)
  }

  const isDropTarget = (dateKey, slot) => dragOver?.dateKey === dateKey && dragOver?.slot === slot

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Nav bar */}
      <div style={{ padding: isMobile ? '.5rem .7rem' : '.7rem 1.2rem', background: 'var(--soil,#1c2b1a)', display: 'flex', alignItems: 'center', gap: isMobile ? '.4rem' : '.6rem', flexWrap: 'wrap' }}>
        {isMobile ? (
          <>
            <button className="btn-sm" style={navBtnStyle} onClick={() => {
              if (dayIndex === 0) { setRefDate(addDays(refDate, -7)); setDayIndex(6) } else setDayIndex(dayIndex - 1)
            }}>‹</button>
            <span style={{ fontWeight:700, fontSize:'.82rem', color:'white', flex:1, textAlign:'center' }}>
              {DAYS[dayIndex]} {addDays(monday, dayIndex).toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}
            </span>
            <button className="btn-sm" style={navBtnStyle} onClick={() => {
              if (dayIndex === 6) { setRefDate(addDays(refDate, 7)); setDayIndex(0) } else setDayIndex(dayIndex + 1)
            }}>›</button>
            <button className="btn-sm" onClick={() => { setRefDate(new Date()); const d = new Date().getDay(); setDayIndex(d===0?6:d-1) }}
              style={{ background:'var(--leaf,#3d7a42)', color:'white', borderColor:'var(--sprout,#a8d4a0)', fontWeight:700, fontSize:'.72rem', padding:'.35rem .6rem' }}>
              Auj.
            </button>
            {/* Sélecteur de semaine — pour sauter directement à une semaine sur mobile/tablette */}
            <input type="week"
              value={(() => { const d = new Date(monday); d.setDate(d.getDate() + 3); const w1 = new Date(d.getFullYear(),0,1); const wk = Math.ceil((((d - w1) / 86400000) + w1.getDay()+1) / 7); return `${d.getFullYear()}-W${String(wk).padStart(2,'0')}` })()}
              onChange={e => {
                if (!e.target.value) return
                const [y,w] = e.target.value.split('-W').map(Number)
                const jan4 = new Date(y,0,4)
                const mon  = getMonday(jan4)
                setRefDate(addDays(mon,(w-1)*7))
                setDayIndex(0)
              }}
              style={{ ...navInputStyle, width:130, flexBasis:'100%' }}
            />
          </>
        ) : (
          <>
            <button className="btn-sm" style={navBtnStyle} onClick={() => setRefDate(addDays(refDate, -7))}>‹</button>
            <button className="btn-sm" style={navBtnStyle} onClick={() => setRefDate(addDays(refDate, 7))}>›</button>
            <span style={{ fontWeight: 700, fontSize: '.95rem', color: 'white', minWidth: 200 }}>Semaine du {formatWeekLabel(monday)}</span>
            <button className="btn-sm" onClick={() => setRefDate(new Date())}
              style={{ background:'var(--leaf,#3d7a42)', color:'white', borderColor:'var(--sprout,#a8d4a0)', fontWeight:700 }}>
              Aujourd'hui
            </button>
            <input type="week"
              onChange={e => {
                const [y,w] = e.target.value.split('-W').map(Number)
                const jan4 = new Date(y,0,4)
                const mon  = getMonday(jan4)
                setRefDate(addDays(mon,(w-1)*7))
              }}
              style={{ ...navInputStyle, width:130 }}
            />
            {/* Légende lieux de chargement extérieur */}
            {!hideExterne && (
            <div style={{ display:'flex', gap:'.6rem', alignItems:'center', flexWrap:'wrap' }}>
              {visibleLieux.map(l => (
                <span key={l.id} style={{ fontSize:'.7rem', color:'white', display:'flex', alignItems:'center', gap:'.3rem' }}>
                  <span style={{ width:9, height:9, borderRadius:3, background:l.couleur, display:'inline-block' }} /> {l.nom}
                  {!readOnly && (
                  <button onClick={() => removeLieu(l)} title="Supprimer ce lieu"
                    style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', fontSize:'.75rem', padding:0, lineHeight:1 }}
                    onMouseEnter={e=>e.currentTarget.style.color='#e74c3c'}
                    onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,.4)'}>✕</button>
                  )}
                </span>
              ))}
              {!readOnly && (
              <button className="btn-sm" onClick={openLieuModal}
                style={{ fontSize:'.68rem', padding:'.22rem .55rem', background:'rgba(255,255,255,.1)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>
                + Lieu ext.
              </button>
              )}
            </div>
            )}
            <div style={{ marginLeft:'auto', position:'relative' }}>
              <input type="text" placeholder="🔍 Client, variété…" value={searchQuery}
                onChange={e => runSearch(e.target.value)} style={{ ...navInputStyle, width:240 }} />
              {searchResults.length > 0 && (
                <div style={{ position:'absolute', right:0, top:'calc(100% + 4px)', width:340, background:'white', border:'1px solid var(--straw,#e8e4d6)', borderRadius:10, boxShadow:'0 4px 20px rgba(0,0,0,.1)', zIndex:400, maxHeight:320, overflowY:'auto' }}>
                  {searchResults.map(r => (
                    <div key={r.id} onClick={() => goToWeekOf(r.date)}
                      style={{ padding:'.6rem .9rem', cursor:'pointer', borderBottom:'1px solid var(--straw,#e8e4d6)', fontSize:'.82rem' }}>
                      <strong>{r.client_nom}</strong> — {fmtDate(r.date)} {r.time_slot}<br/>
                      <span style={{ color:'var(--stone,#5c6b54)' }}>{r.variete} {r.type_chargement}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Rappel congés des 4 salariés — masqué pour un rôle restreint à un seul
          lieu de chargement (ex. Xavier) : hors de son périmètre. */}
      {!onlyLieuNom && (
      <div style={{ padding:'.4rem .7rem', background:'var(--cream,#f4f1e6)', display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap', borderBottom:'1px solid var(--straw,#e8e4d6)' }}>
        <span style={{ fontSize:'.7rem', fontWeight:700, color:'var(--stone,#5c6b54)' }}>🏖️ Congés :</span>
        {CONGES_EMPLOYES.map(emp => {
          const sal = salarieForName(emp)
          const today = toDateKey(new Date())
          const mine = sal ? conges.filter(c => c.salarie_id === sal.id).sort((a,b)=>a.date_debut.localeCompare(b.date_debut)) : []
          const enCours = mine.find(c => c.date_debut <= today && c.date_fin >= today)
          const prochain = !enCours ? mine.find(c => c.date_debut > today) : null
          const bg = enCours ? 'var(--amber-pale,#fbe8c8)' : (prochain ? 'rgba(52,152,219,.12)' : 'var(--paper,white)')
          const border = enCours ? 'var(--amber,#c9922c)' : (prochain ? '#3498db' : 'var(--straw,#e8e4d6)')
          const color = enCours ? 'var(--amber,#8a6318)' : (prochain ? '#2471a3' : 'var(--stone,#5c6b54)')
          return (
            <button key={emp} disabled={readOnly} onClick={() => sal ? openCongesFor(sal) : alert(`"${emp}" introuvable dans le registre salariés (Global GAP) — ajoute-le d'abord là-bas.`)}
              style={{ background: bg, border: `1.5px solid ${border}`, color, borderRadius:50, padding:'.3rem .7rem', fontSize:'.72rem', fontWeight:600, cursor: readOnly ? 'default' : 'pointer', display:'flex', alignItems:'center', gap:'.35rem' }}>
              {emp}
              {enCours && <span>· en congé jusqu'au {new Date(enCours.date_fin).toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}</span>}
              {prochain && <span>· prochain le {new Date(prochain.date_debut).toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}</span>}
            </button>
          )
        })}
      </div>
      )}

      {/* Mobile: légende lieux + bouton ajout */}
      {isMobile && !hideExterne && (
        <div style={{ padding:'.4rem .7rem', background:'var(--soil,#1c2b1a)', display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap', borderTop:'1px solid rgba(255,255,255,.1)' }}>
          {visibleLieux.map(l => (
            <span key={l.id} style={{ fontSize:'.66rem', color:'white', display:'flex', alignItems:'center', gap:'.25rem' }}>
              <span style={{ width:8, height:8, borderRadius:2, background:l.couleur, display:'inline-block' }} /> {l.nom}
              {!readOnly && (
              <button onClick={() => removeLieu(l)} title="Supprimer ce lieu"
                style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', fontSize:'.72rem', padding:0, lineHeight:1 }}>✕</button>
              )}
            </span>
          ))}
          {!readOnly && (
          <button className="btn-sm" onClick={openLieuModal}
            style={{ fontSize:'.64rem', padding:'.18rem .5rem', background:'rgba(255,255,255,.1)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>
            + Lieu ext.
          </button>
          )}
        </div>
      )}

      {/* Mobile search row (own line, full width) */}
      {isMobile && (
        <div style={{ padding:'.5rem .7rem', background:'white', borderBottom:'1px solid var(--straw)', position:'relative' }}>
          <input type="text" placeholder="🔍 Rechercher client, variété…" value={searchQuery}
            onChange={e => runSearch(e.target.value)}
            style={{ width:'100%', padding:'.5rem .8rem', border:'1.5px solid var(--straw)', borderRadius:8, fontSize:'.82rem', outline:'none' }} />
          {searchResults.length > 0 && (
            <div style={{ position:'absolute', left:8, right:8, top:'calc(100% + 2px)', background:'white', border:'1px solid var(--straw)', borderRadius:10, boxShadow:'var(--shadow-md)', zIndex:400, maxHeight:280, overflowY:'auto' }}>
              {searchResults.map(r => (
                <div key={r.id} onClick={() => { goToWeekOf(r.date); const dd = new Date(r.date).getDay(); setDayIndex(dd===0?6:dd-1) }}
                  style={{ padding:'.6rem .9rem', cursor:'pointer', borderBottom:'1px solid var(--straw)', fontSize:'.82rem' }}>
                  <strong>{r.client_nom}</strong> — {fmtDate(r.date)} {r.time_slot}<br/>
                  <span style={{ color:'var(--stone)' }}>{r.variete} {r.type_chargement}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Drag hint */}
      {dragging && (
        <div style={{ background:'var(--leaf,#3d7a42)', color:'white', fontSize:'.78rem', padding:'.35rem 1rem', textAlign:'center', flexShrink:0 }}>
          Déplacez «&nbsp;<strong>{dragging.rdv.client_nom}</strong>&nbsp;» vers un créneau libre — relâchez pour confirmer
        </div>
      )}

      {isMobile ? (
        /* ── MOBILE: single-day list view ── */
        <div style={{ flex:1, overflow:'auto', padding:'.4rem .6rem' }}>
          {Array.from({ length:34 }).map((_,idx) => {
            const totalMin = 5*60 + idx*30
            const h = Math.floor(totalMin/60), m = totalMin%60
            const slot = toSlot(h,m)
            const dateKey = toDateKey(addDays(monday, dayIndex))
            const rdv = rdvs[dateKey]?.[slot]
            return (
              <div key={slot} data-date={dateKey} data-slot={slot}
                onClick={() => !readOnly && !rdv && !dragging && openNewRdv(dateKey, slot)}
                style={{
                  display:'flex', alignItems:'center', gap:'.7rem', padding:'.55rem .3rem',
                  borderBottom:'1px solid var(--straw)', cursor: readOnly ? 'default' : 'pointer', minHeight:42,
                  background: isDropTarget(dateKey, slot) ? (rdv ? 'rgba(192,57,43,.08)' : 'rgba(61,122,66,.12)') : 'transparent',
                }}>
                <span style={{ width:42, flexShrink:0, fontSize:'.7rem', fontWeight:700, color:'var(--fog)' }}>{slot}</span>
                {rdv ? (() => {
                  const lieu = getLieuDisplay(rdv)
                  return (
                  <div onPointerDown={e => !readOnly && handleCardPointerDown(e, rdv, dateKey, slot)}
                    style={{
                    flex:1, borderRadius:8, padding:'.5rem .7rem', cursor:'grab', touchAction:'none', userSelect:'none',
                    opacity: dragging?.rdv?.id===rdv.id ? .4 : rdv.valide ? .65 : 1,
                    background: rdv.valide ? '#e6e6e6' : rdv.a_confirmer ? '#fffbf0' : lieu && !lieu.manual ? lieu.couleur + '18' : 'var(--green-pale)',
                    borderLeft:`3px ${lieu?.manual && !rdv.valide ? 'dashed' : 'solid'} ${rdv.valide ? '#9e9e9e' : rdv.a_confirmer ? 'var(--amber)' : lieu ? lieu.couleur : 'var(--leaf)'}`,
                  }}>
                    <div style={{ fontWeight:700, fontSize:'.85rem', display:'flex', alignItems:'center', gap:'.4rem', flexWrap:'wrap' }}>
                      <span style={{ textDecoration: rdv.valide ? 'line-through' : 'none', color: rdv.valide ? '#777' : undefined }}>{rdv.client_nom}</span>
                      {rdv.lave && <span title={rdv.bobine ? `Lavé — bobine : ${rdv.bobine}` : 'Lavé'} style={{ fontSize:'.8rem' }}>💧</span>}
                      {lieu && (
                        <span style={{
                          fontSize:'.66rem', fontWeight:700, padding:'.05rem .45rem', borderRadius:50,
                          color: lieu.manual ? lieu.couleur : 'white',
                          background: lieu.manual ? 'transparent' : lieu.couleur,
                          border: lieu.manual ? `1.5px dashed ${lieu.couleur}` : 'none',
                        }}>📍 {lieu.nom}</span>
                      )}
                      {(!readOnly || canPrepareValide || canUploadCmr) && (
                      <span style={{ marginLeft:'auto', display:'flex', gap:'.3rem', flexShrink:0, alignItems:'center' }}>
                        {rdv.photos?.length > 0 && (
                          <button type="button" title={`Voir ${rdv.photos.length} photo(s) CMR`}
                            onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setLightboxPhotos(rdv.photos) }}
                            style={{ border:'none', cursor:'pointer', padding:'.1rem .3rem', borderRadius:5, fontSize:'.7rem', background:'rgba(52,152,219,.12)' }}>
                            📎{rdv.photos.length}
                          </button>
                        )}
                        {(!readOnly || canPrepareValide) && (<>
                        <button title={rdv.prepare ? 'Marquer non préparé' : 'Marquer préparé'}
                          onPointerDown={e => e.stopPropagation()} onClick={e => togglePrepare(rdv, e)}
                          style={{ border:'none', cursor:'pointer', padding:'.1rem .3rem', borderRadius:5, fontSize:'.72rem',
                            opacity: rdv.prepare ? 1 : .35, background: rdv.prepare ? 'rgba(52,152,219,.15)' : 'transparent' }}>📦</button>
                        <button title={rdv.valide ? 'Annuler la validation' : 'Valider le chargement'}
                          onPointerDown={e => e.stopPropagation()} onClick={e => toggleValide(rdv, e)}
                          style={{ border:'none', cursor:'pointer', padding:'.1rem .3rem', borderRadius:5, fontSize:'.72rem',
                            opacity: rdv.valide ? 1 : .35, background: rdv.valide ? 'rgba(46,204,113,.18)' : 'transparent' }}>✅</button>
                        </>)}
                        {(!readOnly || canUploadCmr) && (
                          <label title="Joindre la CMR (photo)" onPointerDown={e => e.stopPropagation()}
                            style={{ display:'inline-flex', alignItems:'center', cursor: uploadingCmrId===rdv.id ? 'wait' : 'pointer',
                              padding:'.1rem .3rem', borderRadius:5, fontSize:'.72rem', background:'rgba(155,89,182,.15)' }}>
                            {uploadingCmrId===rdv.id ? '⏳' : '📷'}
                            <input type="file" accept="image/*" capture="environment" multiple style={{ display:'none' }}
                              disabled={uploadingCmrId===rdv.id} onChange={e => handleCmrPhotoFiles(rdv, e)} />
                          </label>
                        )}
                      </span>
                      )}
                    </div>
                    <div style={{ fontSize:'.74rem', color:'var(--stone)' }}>{varietesLabel(rdv)} {rdv.type_chargement ? '· '+rdv.type_chargement : ''}{rdv.ref_chargement ? ' · 📄 '+rdv.ref_chargement : ''}</div>
                  </div>
                  )
                })() : (
                  <div style={{ flex:1, fontSize:'.76rem', color:'var(--fog,#c8c0a8)' }}>+ Ajouter un RDV</div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* ── DESKTOP: full week grid ── */
        <div ref={scrollRef} style={{ flex:1, overflow:'auto' }}>
          <div style={{ display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', minWidth:900 }}>
            {/* Sticky header */}
            <div style={{ position:'sticky', top:0, gridColumn:'1/-1', display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', zIndex:50, background:'var(--soil,#1c2b1a)' }}>
              <div style={{ height:40 }} />
              {DAYS.map((d,i) => {
                const day     = addDays(monday,i)
                const isToday = toDateKey(day) === toDateKey(new Date())
                return (
                  <div key={d} style={{ height:40, display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'.8rem', fontWeight:700,
                    color: isToday ? 'var(--sprout,#a8d4a0)' : 'rgba(255,255,255,.88)',
                    borderLeft:'1px solid rgba(255,255,255,.12)',
                    background: isToday ? 'rgba(255,255,255,.08)' : 'transparent' }}>
                    {d} {day.getDate()}
                  </div>
                )
              })}
            </div>

            {/* Time slots: 5h–21h30 every 30min */}
            {Array.from({ length:34 }).map((_,idx) => {
              const totalMin = 5*60 + idx*30
              const h = Math.floor(totalMin/60), m = totalMin%60
              const slot    = toSlot(h,m)
              const isHour  = m === 0
              return (
                <div key={slot} style={{ display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', gridColumn:'1/-1' }}>
                  {/* Hour label */}
                  <div style={{ height:36, display:'flex', alignItems:'flex-start', justifyContent:'flex-end',
                    paddingRight:6, fontSize:'.68rem', fontWeight:600, color:'var(--fog,#8a9a82)',
                    borderBottom: isHour ? '1px solid var(--straw,#e8e4d6)' : '1px dashed #e0ddd4',
                    background:'var(--field,#f2f0e8)' }}>
                    {isHour ? slot : ''}
                  </div>
                  {DAYS.map((_d,dayIdx) => {
                    const dateKey = toDateKey(addDays(monday,dayIdx))
                    const rdv     = rdvs[dateKey]?.[slot]
                    const isOver  = isDropTarget(dateKey,slot)
                    return (
                      <div key={dayIdx} data-date={dateKey} data-slot={slot}
                        onClick={() => !readOnly && !dragging && !rdv && openNewRdv(dateKey,slot)}
                        style={{ height:36, position:'relative', cursor: readOnly ? 'default' : dragging ? 'copy' : 'pointer',
                          borderBottom: isHour ? '1px solid var(--straw,#e8e4d6)' : '1px dashed #e0ddd4',
                          borderLeft:'1px solid var(--straw,#e8e4d6)',
                          background: isOver && !rdv ? 'rgba(61,122,66,.12)' :
                                      isOver && rdv  ? 'rgba(192,57,43,.08)' : 'transparent',
                          outline: isOver ? `2px solid ${rdv ? '#c0392b' : 'var(--leaf,#3d7a42)'}` : 'none',
                          outlineOffset:-2, transition:'background .1s' }}
                        onMouseEnter={e => { if(!rdv && !dragging) e.currentTarget.style.background='var(--green-pale,#eaf5ea)' }}
                        onMouseLeave={e => { if(!rdv && !isOver) e.currentTarget.style.background='' }}>
                        {rdv && (() => {
                          const lieu = getLieuDisplay(rdv)
                          return (
                          <div
                            onPointerDown={e => !readOnly && handleCardPointerDown(e,rdv,dateKey,slot)}
                            title={lieu ? `📍 Chargement extérieur — ${lieu.nom}${lieu.manual ? ' (saisie libre)' : ''}` : undefined}
                            style={{ position:'absolute', inset:'2px 3px', borderRadius:6, padding:'.15rem .45rem',
                              background: rdv.valide ? '#e6e6e6' : rdv.a_confirmer ? '#fffbf0' : lieu && !lieu.manual ? lieu.couleur + '18' : 'white',
                              borderLeft:`3px ${lieu?.manual && !rdv.valide ? 'dashed' : 'solid'} ${rdv.valide ? '#9e9e9e' : rdv.a_confirmer ? 'var(--amber,#c47c1a)' : lieu ? lieu.couleur : 'var(--leaf,#3d7a42)'}`,
                              boxShadow:'0 1px 4px rgba(0,0,0,.09)', overflow:'hidden', fontSize:'.68rem',
                              cursor:'grab', touchAction:'none', userSelect:'none',
                              opacity: dragging?.rdv?.id===rdv.id ? 0.45 : rdv.valide ? 0.7 : 1,
                              transition:'opacity .15s' }}>
                            <div style={{ fontWeight:700, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', display:'flex', alignItems:'center', gap:'.3rem' }}>
                              <span style={{ overflow:'hidden', textOverflow:'ellipsis', flex:1, minWidth:0,
                                textDecoration: rdv.valide ? 'line-through' : 'none', color: rdv.valide ? '#777' : undefined }}>{rdv.client_nom}</span>
                              {rdv.lave && <span title={rdv.bobine ? `Lavé — bobine : ${rdv.bobine}` : 'Lavé'} style={{ flexShrink:0 }}>💧</span>}
                              {lieu && (
                                <span style={{
                                  fontSize:'.6rem', fontWeight:800, padding:'0 .35rem', borderRadius:50, flexShrink:0,
                                  color: lieu.manual ? lieu.couleur : 'white',
                                  background: lieu.manual ? 'transparent' : lieu.couleur,
                                  border: lieu.manual ? `1.2px dashed ${lieu.couleur}` : 'none',
                                }}>{lieu.nom}</span>
                              )}
                              {(!readOnly || canPrepareValide || canUploadCmr) && (
                              <span style={{ display:'flex', gap:2, flexShrink:0, alignItems:'center' }}>
                                {rdv.photos?.length > 0 && (
                                  <button type="button" title={`Voir ${rdv.photos.length} photo(s) CMR`}
                                    onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setLightboxPhotos(rdv.photos) }}
                                    style={{ border:'none', cursor:'pointer', padding:'0 .15rem', borderRadius:4, fontSize:'.6rem', lineHeight:1, background:'rgba(52,152,219,.15)' }}>
                                    📎{rdv.photos.length}
                                  </button>
                                )}
                                {(!readOnly || canPrepareValide) && (<>
                                <button title={rdv.prepare ? 'Marquer non préparé' : 'Marquer préparé'}
                                  onPointerDown={e => e.stopPropagation()} onClick={e => togglePrepare(rdv, e)}
                                  style={{ border:'none', cursor:'pointer', padding:'0 .15rem', borderRadius:4, fontSize:'.62rem', lineHeight:1,
                                    opacity: rdv.prepare ? 1 : .3, background: rdv.prepare ? 'rgba(52,152,219,.18)' : 'transparent' }}>📦</button>
                                <button title={rdv.valide ? 'Annuler la validation' : 'Valider le chargement'}
                                  onPointerDown={e => e.stopPropagation()} onClick={e => toggleValide(rdv, e)}
                                  style={{ border:'none', cursor:'pointer', padding:'0 .15rem', borderRadius:4, fontSize:'.62rem', lineHeight:1,
                                    opacity: rdv.valide ? 1 : .3, background: rdv.valide ? 'rgba(46,204,113,.2)' : 'transparent' }}>✅</button>
                                </>)}
                                {(!readOnly || canUploadCmr) && (
                                  <label title="Joindre la CMR (photo)" onPointerDown={e => e.stopPropagation()}
                                    style={{ display:'inline-flex', alignItems:'center', cursor: uploadingCmrId===rdv.id ? 'wait' : 'pointer',
                                      padding:'0 .15rem', borderRadius:4, fontSize:'.62rem', lineHeight:1, background:'rgba(155,89,182,.18)' }}>
                                    {uploadingCmrId===rdv.id ? '⏳' : '📷'}
                                    <input type="file" accept="image/*" capture="environment" multiple style={{ display:'none' }}
                                      disabled={uploadingCmrId===rdv.id} onChange={e => handleCmrPhotoFiles(rdv, e)} />
                                  </label>
                                )}
                              </span>
                              )}
                            </div>
                            <div style={{ color:'var(--stone,#5c6b54)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{varietesLabel(rdv)}</div>
                          </div>
                          )
                        })()}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {modalOpen && editingRdv && (
        <RdvModal rdv={editingRdv} setRdv={setEditingRdv} clients={clients} lieux={lieux} contrats={contrats}
          onSave={saveRdv} onDelete={editingRdv.id ? deleteRdv : null}
          onNewLieu={openLieuModal}
          onClose={() => setModalOpen(false)} />
      )}

      {lieuModalOpen && (
        <LieuModal newLieu={newLieu} setNewLieu={setNewLieu} onSave={saveLieu} onClose={() => setLieuModalOpen(false)} />
      )}

      {lightboxPhotos && <PhotoLightbox photos={lightboxPhotos} onClose={() => setLightboxPhotos(null)} />}

      {congesModalOpen && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setCongesModalOpen(false)}>
          <div className="modal" style={{ maxWidth:440 }}>
            <div className="modal-hdr">
              <h3>🏖️ Congés — {congesSalarie?.prenom} {congesSalarie?.nom}</h3>
              <button className="modal-close" onClick={() => setCongesModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ overflowY:'auto', maxHeight:'65vh' }}>
              <p style={{ color:'var(--stone)', fontSize:'.76rem', marginTop:0 }}>Visible aussi dans Global GAP → Congés.</p>
              {conges.filter(c => c.salarie_id === congesSalarie?.id).length === 0 && (
                <p style={{ color:'var(--stone)', fontSize:'.82rem' }}>Aucun congé enregistré.</p>
              )}
              {conges.filter(c => c.salarie_id === congesSalarie?.id).map(c => (
                <div key={c.id} style={{ display:'flex', alignItems:'center', gap:'.6rem', padding:'.5rem 0', borderBottom:'1px solid var(--straw,#e8e4d6)' }}>
                  <div style={{ flex:1, fontSize:'.82rem' }}>
                    <strong>{new Date(c.date_debut).toLocaleDateString('fr-FR')} → {new Date(c.date_fin).toLocaleDateString('fr-FR')}</strong>
                    <div style={{ color:'var(--stone)', fontSize:'.76rem' }}>{c.type}{c.observation ? ` · ${c.observation}` : ''}</div>
                  </div>
                  <button className="btn-sm" onClick={() => removeConge(c)} style={{ color:'#c0392b' }}>🗑️</button>
                </div>
              ))}
              <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.7rem', marginTop:'1rem' }}>
                <div className="form-group"><label>Début</label><input type="date" value={newConge.date_debut} onChange={e=>setNewConge({...newConge, date_debut:e.target.value})} /></div>
                <div className="form-group"><label>Fin</label><input type="date" value={newConge.date_fin} onChange={e=>setNewConge({...newConge, date_fin:e.target.value})} /></div>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Type</label>
                  <input list="types-conge-planning" value={newConge.type} onChange={e=>setNewConge({...newConge, type:e.target.value})} />
                  <datalist id="types-conge-planning">{['Congé payé','RTT','Maladie','Sans solde','Formation','Autre'].map(t=><option key={t} value={t}/>)}</datalist>
                </div>
                <div className="form-group" style={{ gridColumn:'1/-1' }}><label>Observation (optionnel)</label><input type="text" value={newConge.observation} onChange={e=>setNewConge({...newConge, observation:e.target.value})} placeholder="ex. congés d'été" /></div>
              </div>
              <button className="btn-primary" onClick={addConge} style={{ marginTop:'.8rem', width:'100%' }}>+ Ajouter ce congé</button>
            </div>
          </div>
        </div>
      )}

      {/* Fantôme suivant le curseur/doigt pendant le déplacement */}
      {dragging && (
        <div style={{
          position:'fixed', left:dragPos.x, top:dragPos.y, transform:'translate(-50%,-135%)',
          pointerEvents:'none', zIndex:9999, background:'var(--leaf,#3d7a42)', color:'white',
          padding:'.4rem .8rem', borderRadius:8, fontSize:'.78rem', fontWeight:700,
          boxShadow:'0 6px 18px rgba(0,0,0,.28)', whiteSpace:'nowrap',
        }}>
          {dragging.rdv.client_nom}
        </div>
      )}
    </div>
  )
}

const navBtnStyle = { background: 'rgba(255,255,255,.12)', borderColor: 'rgba(255,255,255,.3)', color: 'white', fontSize: '1rem' }
const navInputStyle = { padding: '.38rem .8rem', border: '1.5px solid rgba(255,255,255,.3)', borderRadius: 7, fontSize: '.82rem', outline: 'none', background: 'rgba(255,255,255,.1)', color: 'white' }

function RdvModal({ rdv, setRdv, clients, lieux = [], contrats = [], onSave, onDelete, onNewLieu, onClose }) {
  const [clientSearch, setClientSearch] = useState(rdv.client_nom || '')
  const [showDropdown, setShowDropdown] = useState(false)

  // Stock frigos (variétés/lots réellement présents) — sert à limiter les choix
  // de variété/lot pour un chargement interne. Les chargements extérieurs
  // (lieu_chargement_id renseigné) restent en saisie libre : le stock frigo
  // ne les concerne pas.
  const [caveStock, setCaveStock] = useState([]) // [{variety, lot}]
  useEffect(() => {
    supabase.from('cave_cells').select('variety,lot').gt('palox', 0)
      .then(({ data }) => setCaveStock(data || []))
  }, [])
  // Base de données Variétés (BDD > Variétés) — sert de repli quand une variété n'est
  // plus (ou pas encore) en stock dans les frigos ; le lot n'y est pas obligatoire.
  const [dbVarietes, setDbVarietes] = useState([])
  useEffect(() => {
    supabase.from('db_varietes').select('variete,lot').then(({ data }) => setDbVarietes(data || []))
  }, [])
  const isExterieur = !!rdv.lieu_chargement_id
  const stockVarietes = [...new Set(caveStock.map(c => (c.variety || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'))
  // Suggestions de variété : d'abord ce qui est réellement en stock dans les frigos, puis
  // en repli les variétés connues de la base de données — jamais une liste fermée : on
  // reste en saisie libre pour pouvoir saisir une variété/lot externe qu'on n'a pas.
  const varieteSuggestions = [...new Set([
    ...stockVarietes,
    ...dbVarietes.map(v => (v.variete || '').trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, 'fr'))

  // Bobines (film sacs lavés) — chargées à l'ouverture du modal, pour proposer
  // le choix de la bobine quand le camion est coché "Lavé".
  const [bobines, setBobines] = useState([])
  useEffect(() => {
    supabase.from('db_bobines').select('reference,format,client').order('reference')
      .then(({ data }) => setBobines(data || []))
  }, [])
  const matches = clientSearch.length > 0
    ? clients.filter(c => c.nom.toLowerCase().includes(clientSearch.toLowerCase())).slice(0,8)
    : []

  // ── Prévision palox : tire au sort des cases des frigos correspondant à la
  // variété (et au lot si renseigné). Objectif ~28T par camion (équivalent à
  // 14 palox de 2T), plafond 32T (16 palox de 2T) — mais chaque case peut
  // désormais contenir des palox de 2T OU 1,2T (poids_palox), donc le calcul
  // se fait en tonnage réel et non plus en simple comptage de palox : un
  // camion chargé en 1,2T contiendra logiquement plus de palox pour le même
  // poids total.
  const TONNAGE_OBJECTIF_CAMION = 28
  const TONNAGE_MAX_CAMION = 32
  const [prevLoading, setPrevLoading] = useState(false)
  async function genererPrevision() {
    const varietes = (rdv.varietes || []).filter(v => v.variete?.trim())
    if (!varietes.length) { alert('Renseigne d\'abord au moins une variété.'); return }
    setPrevLoading(true)
    const [{ data: cells }, { data: frigosData }] = await Promise.all([
      supabase.from('cave_cells').select('*'),
      supabase.from('frigos').select('id,name'),
    ])
    setPrevLoading(false)
    const frigoName = Object.fromEntries((frigosData || []).map(f => [f.id, f.name]))
    // Plusieurs variétés/lots possibles sur un même camion — on cumule les cases
    // correspondant à chacune (sans doublon si une case matche plusieurs critères).
    const seenCellIds = new Set()
    const matching = []
    for (const { variete, lot } of varietes) {
      const v = variete.trim().toLowerCase()
      const l = (lot || '').trim().toLowerCase()
      for (const c of (cells || [])) {
        if (seenCellIds.has(c.cell_id)) continue
        if (!(c.variety || '').trim().toLowerCase().includes(v)) continue
        if (l && !(c.lot || '').trim().toLowerCase().includes(l)) continue
        if (!(c.palox || 0) > 0) continue
        seenCellIds.add(c.cell_id)
        matching.push(c)
      }
    }
    if (!matching.length) {
      // Pas une erreur — normal en tout début de campagne, avant la première
      // récolte, de n'avoir encore aucun palox en stock correspondant.
      const desc = varietes.map(v => `"${v.variete}"${v.lot ? ` (lot ${v.lot})` : ''}`).join(', ')
      showToast(`Aucun palox ${desc} en stock pour l'instant`)
      return
    }
    // Mélange aléatoire puis cumul jusqu'à l'objectif (en tonnes), sans jamais
    // dépasser le plafond (une case trop lourde pour tenir dessous est sautée,
    // on tente la suivante).
    const target = TONNAGE_OBJECTIF_CAMION * (rdv.nb_camions || 1)
    const cap = TONNAGE_MAX_CAMION * (rdv.nb_camions || 1)
    const shuffled = [...matching].sort(() => Math.random() - 0.5)
    const picked = []
    let total = 0
    let totalPalox = 0
    for (const c of shuffled) {
      if (total >= target) break
      const poids = c.poids_palox || 2 // cases anciennes / colonne pas encore migrée : 2T par défaut
      const nb = c.palox || 0
      const t = nb * poids
      if (total + t > cap) continue
      picked.push({
        cell_id: c.cell_id, frigo: frigoName[c.frigo_id] || '?',
        label: c.cell_id.split('_').slice(1).join(' '),
        palox: nb, poids_palox: poids, tonnage: t, variety: c.variety, lot: c.lot || '', color: c.color || '#3fc95c',
      })
      total += t
      totalPalox += nb
    }
    picked.sort((a, b) => a.frigo.localeCompare(b.frigo, 'fr', { numeric: true }) || a.label.localeCompare(b.label, 'fr', { numeric: true }))
    setRdv(r => ({ ...r, palox_prevision: { target, cap, total, totalPalox, cells: picked, genere_le: new Date().toISOString() } }))
  }

  // ── Génération automatique de la prévision : dès que la variété (ou le lot,
  // ou le nombre de camions) est saisie ou modifiée, la prévision se retire
  // toute seule — plus besoin de cliquer sur un bouton. On saute le tout
  // premier rendu (ouverture d'un RDV existant) pour ne pas re-tirer une
  // prévision déjà générée sans que rien n'ait changé, et on débounce pour
  // ne pas relancer la requête à chaque frappe.
  const varietesKey = JSON.stringify((rdv.varietes || []).map(v => ({ variete: v.variete, lot: v.lot })))
  const skipFirstRunRef = useRef(true)
  const debounceRef = useRef(null)
  useEffect(() => {
    if (skipFirstRunRef.current) { skipFirstRunRef.current = false; return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { genererPrevision() }, 700)
    return () => clearTimeout(debounceRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varietesKey, rdv.nb_camions])

  // ── Sacs multiples (camion lavé) : liste { format, palettes } ──
  const SAC_FORMATS = ['5kg', '10kg', '15kg', '20kg', '25kg']
  const sacs = Array.isArray(rdv.sacs) ? rdv.sacs : []
  const setSac = (i, patch) => setRdv({ ...rdv, sacs: sacs.map((s, idx) => idx === i ? { ...s, ...patch } : s) })

  // Track original date/slot to detect changes
  const origDate = useRef(rdv.date)
  const origSlot = useRef(rdv.time_slot)
  useEffect(() => {
    if (rdv.id && !rdv._origDate) {
      setRdv(r => ({ ...r, _origDate: r.date, _origSlot: r.time_slot }))
    }
  }, [])

  // Generate 30-min slot options 5h–21h30
  const slotOptions = []
  for (let h=5; h<22; h++) for (let m of [0,30]) slotOptions.push(toSlot(h,m))

  const dateChanged = rdv.id && rdv.date !== origDate.current
  const slotChanged = rdv.id && rdv.time_slot !== origSlot.current

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth:560 }}>
        <div className="modal-hdr">
          <h3>{rdv.id ? 'Modifier le RDV' : `Nouveau RDV — ${rdv.time_slot}`}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Client */}
          <div className="form-group" style={{ marginBottom:'1rem', position:'relative' }}>
            <label>Client *</label>
            <input type="text" value={clientSearch} autoFocus
              onChange={e => { setClientSearch(e.target.value); setShowDropdown(true); setRdv({...rdv, client_nom:e.target.value, client_id:null}) }}
              onFocus={() => setShowDropdown(true)}
              onBlur={() => setTimeout(()=>setShowDropdown(false),200)}
              placeholder="🔍 Rechercher un client…" />
            {showDropdown && matches.length > 0 && (
              <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'white', border:'1px solid var(--straw)', borderRadius:8, boxShadow:'var(--shadow-md)', zIndex:200, maxHeight:160, overflowY:'auto' }}>
                {matches.map(c => (
                  <div key={c.id} onMouseDown={() => { setClientSearch(c.nom); setRdv({...rdv, client_nom:c.nom, client_id:c.id}) }}
                    style={{ padding:'.55rem 1rem', cursor:'pointer', fontSize:'.84rem', borderBottom:'1px solid var(--straw)' }}>
                    <strong>{c.nom}</strong>{c.ville && <span style={{ color:'var(--stone)' }}> — {c.ville}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Date & Heure — modifiables, avec indicateur si changé */}
          <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem', marginBottom:'.8rem' }}>
            <div className="form-group">
              <label>📅 Date {dateChanged && <span style={{ color:'var(--amber)', fontSize:'.65rem', fontWeight:600, marginLeft:4 }}>modifiée — naviguera vers cette semaine</span>}</label>
              <input type="date" value={rdv.date}
                onChange={e => setRdv({...rdv, date:e.target.value})}
                style={{ borderColor: dateChanged ? 'var(--amber)' : undefined }} />
            </div>
            <div className="form-group">
              <label>🕐 Heure {slotChanged && <span style={{ color:'var(--amber)', fontSize:'.65rem', fontWeight:600, marginLeft:4 }}>modifiée</span>}</label>
              <select value={rdv.time_slot} onChange={e => setRdv({...rdv, time_slot:e.target.value})}
                style={{ borderColor: slotChanged ? 'var(--amber)' : undefined }}>
                {slotOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Alerte déplacement */}
          {rdv.id && (dateChanged || slotChanged) && (
            <div style={{ background:'var(--amber-pale)', border:'1px solid var(--amber)', borderRadius:8, padding:'.6rem .9rem', marginBottom:'.9rem', fontSize:'.8rem', color:'var(--amber)', display:'flex', gap:'.5rem', alignItems:'center' }}>
              ⚠️ Le RDV sera déplacé vers <strong>{fmtDate(rdv.date)} {rdv.time_slot}</strong>.
              {dateChanged && ' L\'affichage passera à la semaine correspondante.'}
            </div>
          )}

          <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Variété(s) / lot(s) {(rdv.varietes?.length || 0) > 1 ? `— ${rdv.varietes.length}` : ''}</label>
              <div style={{ display:'flex', flexDirection:'column', gap:'.5rem' }}>
                {(rdv.varietes || [{ variete:'', lot:'' }]).map((v, i) => {
                  // Lots suggérés pour la variété de cette ligne : d'abord les lots réellement
                  // en stock dans les frigos, puis en repli ceux connus de la BDD Variétés —
                  // jamais restrictif, on peut toujours saisir un lot qu'on n'a pas.
                  const sameVariety = nom => !v.variete || (nom || '').trim().toLowerCase() === v.variete.trim().toLowerCase()
                  const rowLots = [...new Set([
                    ...caveStock.filter(c => sameVariety(c.variety)).map(c => (c.lot||'').trim()).filter(Boolean),
                    ...dbVarietes.filter(d => sameVariety(d.variete)).map(d => (d.lot||'').trim()).filter(Boolean),
                  ])].sort((a,b)=>a.localeCompare(b,'fr'))
                  const rows = rdv.varietes || [{ variete:'', lot:'' }]
                  const setRow = patch => setRdv({ ...rdv, varietes: rows.map((x,idx)=>idx===i?{...x,...patch}:x) })
                  const varieteListId = `variete-suggestions-${i}`
                  const lotListId = `lot-suggestions-${i}`
                  return (
                    <div key={i} style={{ display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap' }}>
                      <input style={{ flex:1, minWidth:140 }} type="text" list={varieteListId} value={v.variete||''}
                        onChange={e=>setRow({ variete:e.target.value })} placeholder={isExterieur ? 'Variété (libre)' : 'Variété — frigos puis BDD'} />
                      <datalist id={varieteListId}>{varieteSuggestions.map(sv => <option key={sv} value={sv} />)}</datalist>
                      <input style={{ flex:1, minWidth:120 }} type="text" list={lotListId} value={v.lot||''}
                        onChange={e=>setRow({ lot:e.target.value })} placeholder={isExterieur ? 'Lot (libre)' : 'ex. TALLOT'} />
                      <datalist id={lotListId}>{rowLots.map(l => <option key={l} value={l} />)}</datalist>
                      {rows.length > 1 && (
                        <button type="button" onClick={() => setRdv({ ...rdv, varietes: rows.filter((_,idx)=>idx!==i) })}
                          style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red,#c0392b)', fontSize:'.95rem' }}>✕</button>
                      )}
                    </div>
                  )
                })}
                <button type="button" className="btn-sm" style={{ alignSelf:'flex-start' }}
                  onClick={() => setRdv({ ...rdv, varietes: [...(rdv.varietes || [{ variete:'', lot:'' }]), { variete:'', lot:'' }] })}>
                  + Ajouter une variété
                </button>
              </div>
            </div>
            <div className="form-group"><label>Calibre</label><input type="text" value={rdv.calibre||''} onChange={e=>setRdv({...rdv,calibre:e.target.value})} placeholder="ex. 35/55" /></div>
            <div className="form-group">
              <label>Type de chargement</label>
              <select value={rdv.type_chargement||''} onChange={e=>setRdv({...rdv,type_chargement:e.target.value})}>
                <option value="">-- Choisir --</option>
                {['Vrac','Big-bag','Big-bag lavé','Palox','Palox lavé','Sac 10kg','Sac 15kg','Sac 20kg','Sac 25kg'].map(o=><option key={o}>{o}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Nbre camions</label><input type="number" min={1} value={rdv.nb_camions||1} onChange={e=>setRdv({...rdv,nb_camions:parseInt(e.target.value)||1})} /></div>
            <div className="form-group">
              <label>📄 Contrat lié (optionnel)</label>
              <select value={rdv.contrat_id || ''} onChange={e=>setRdv({...rdv, contrat_id: e.target.value || null})}>
                <option value="">— Aucun —</option>
                {contrats.map(c => {
                  const dates = c.date_debut ? ` · ${new Date(c.date_debut).toLocaleDateString('fr-FR')}${c.date_fin ? ` → ${new Date(c.date_fin).toLocaleDateString('fr-FR')}` : ''}` : ''
                  return <option key={c.id} value={c.id}>{c.reference} — {c.client_nom}{c.variete ? ` (${c.variete})` : ''}{dates}</option>
                })}
              </select>
            </div>
            <div className="form-group"><label>Tonnage (T)</label>
              <input type="number" step="0.001" min={0} value={rdv.tonnage ?? ''} onChange={e=>setRdv({...rdv,tonnage:e.target.value})} placeholder="ex. 25" />
            </div>
            <div className="form-group"><label>Réf. chargement</label>
              <input type="text" value={rdv.ref_chargement||''} onChange={e=>setRdv({...rdv,ref_chargement:e.target.value})} placeholder="ex. CHG-2026-001" />
            </div>
            <div className="form-group"><label>Immatriculation (si connue)</label>
              <input type="text" value={rdv.immatriculation||''} onChange={e=>setRdv({...rdv,immatriculation:e.target.value})} placeholder="AB-123-CD" />
            </div>
            {rdv.contrat_id && (
              <div style={{ gridColumn:'1/-1', fontSize:'.74rem', color:'var(--stone)', marginTop:'-.4rem' }}>
                Une fois ce RDV validé (✅ dans le planning), ce tonnage sera décompté du contrat sélectionné.
              </div>
            )}
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>📍 Lieu de chargement (si extérieur)</label>
              <div style={{ display:'flex', gap:'.5rem' }}>
                <select style={{ flex:1 }} value={rdv.lieu_chargement_id || ''}
                  onChange={e=>setRdv({...rdv, lieu_chargement_id: e.target.value || null, lieu_chargement_manuel: '' })}>
                  <option value="">— Interne (aucun code couleur) —</option>
                  {lieux.map(l => <option key={l.id} value={l.id}>{l.nom}</option>)}
                </select>
                {onNewLieu && <button type="button" className="btn-sm" onClick={onNewLieu}>+ Lieu</button>}
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:'.5rem', margin:'.5rem 0 .2rem' }}>
                <div style={{ flex:1, height:1, background:'var(--straw,#e8e4d6)' }} />
                <span style={{ fontSize:'.68rem', color:'var(--stone)' }}>ou</span>
                <div style={{ flex:1, height:1, background:'var(--straw,#e8e4d6)' }} />
              </div>
              <input type="text" placeholder="✏️ Saisir un lieu manuellement (ex. chez le transporteur, site temporaire…)"
                value={rdv.lieu_chargement_manuel || ''}
                onChange={e => setRdv({ ...rdv, lieu_chargement_manuel: e.target.value, lieu_chargement_id: e.target.value ? null : rdv.lieu_chargement_id })} />
              {(rdv.lieu_chargement_id || rdv.lieu_chargement_manuel) && (() => {
                const manuel = rdv.lieu_chargement_manuel?.trim()
                const couleur = rdv.lieu_chargement_id
                  ? (lieux.find(l=>l.id===rdv.lieu_chargement_id)?.couleur || 'var(--stone)')
                  : manualLieuColor(manuel || '')
                return (
                <div style={{ marginTop:'.4rem', fontSize:'.74rem', display:'flex', alignItems:'center', gap:'.4rem', color:'var(--stone)' }}>
                  <span style={{ width:10, height:10, borderRadius:3, display:'inline-block',
                    background: rdv.lieu_chargement_id ? couleur : 'transparent',
                    border: !rdv.lieu_chargement_id ? `1.5px dashed ${couleur}` : 'none' }} />
                  {rdv.lieu_chargement_id
                    ? 'Ce RDV apparaîtra avec ce code couleur dans le planning.'
                    : 'Saisie libre — une couleur dédiée sera générée automatiquement pour ce lieu (bordure pointillée).'}
                </div>
                )
              })()}
              {(rdv.lieu_chargement_id || rdv.lieu_chargement_manuel) && (
                <div className="form-grid-2" style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem', marginTop:'.7rem', padding:'.7rem', background:'var(--cream)', borderRadius:8 }}>
                  <div className="form-group"><label>Négociant (🔒 interne uniquement)</label>
                    <input value={rdv.negociant||''} onChange={e=>setRdv({...rdv,negociant:e.target.value})} placeholder="Nom du négociant" /></div>
                  <div className="form-group"><label>Prix HT €/T (🔒 interne uniquement)</label>
                    <input type="number" value={rdv.prix_ht ?? ''} onChange={e=>setRdv({...rdv,prix_ht:e.target.value})} /></div>
                  <div style={{ gridColumn:'1/-1', fontSize:'.72rem', color:'var(--stone)' }}>
                    Ce RDV apparaîtra dans l'onglet 🧾 Confirmations d'achat (tonnage, immatriculation et nb de camions repris automatiquement).
                  </div>
                </div>
              )}
            </div>
            <div style={{ gridColumn:'1/-1', display:'flex', flexWrap:'wrap', gap:'.6rem 1.2rem', padding:'.3rem 0' }}>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer', fontSize:'.86rem', fontWeight:500 }}>
                <input type="checkbox" checked={rdv.lave||false} onChange={e=>setRdv({...rdv,lave:e.target.checked})} /> 💧 Lavé
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer', fontSize:'.86rem', fontWeight:500 }}>
                <input type="checkbox" checked={rdv.a_confirmer||false} onChange={e=>setRdv({...rdv,a_confirmer:e.target.checked})} /> ⏳ À confirmer
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer', fontSize:'.86rem', fontWeight:500 }}>
                <input type="checkbox" checked={rdv.prepare||false} onChange={e=>setRdv({...rdv,prepare:e.target.checked})} /> 📦 Préparé
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:'.5rem', cursor:'pointer', fontSize:'.86rem', fontWeight:500 }}>
                <input type="checkbox" checked={rdv.valide||false} onChange={e=>setRdv({...rdv,valide:e.target.checked})} /> ✅ Chargement validé
              </label>
            </div>
            {/* Prévision palox : quelles cases sortiront des frigos pour ce camion */}
            {rdv.varietes?.some(v => v.variete?.trim()) && (
              <div className="form-group" style={{ gridColumn:'1/-1', background:'var(--cream)', borderRadius:8, padding:'.6rem .8rem' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:'.5rem', flexWrap:'wrap' }}>
                  <label style={{ margin:0 }}>🎲 Prévision palox (objectif {TONNAGE_OBJECTIF_CAMION} T, max {TONNAGE_MAX_CAMION} T / camion × {rdv.nb_camions || 1})</label>
                  {prevLoading && <span style={{ fontSize:'.76rem', color:'var(--stone,#5c6b54)' }}>⏳ Calcul en cours…</span>}
                </div>
                {rdv.palox_prevision?.cells?.length > 0 && (() => {
                  const prev = rdv.palox_prevision
                  const parFrigo = Object.entries(prev.cells.reduce((m, c) => {
                    if (!m[c.frigo]) m[c.frigo] = []
                    m[c.frigo].push(c)
                    return m
                  }, {}))
                  return (
                    <div style={{ marginTop:'.5rem' }}>
                      {parFrigo.map(([frigo, list]) => (
                        <div key={frigo} style={{ marginBottom:'.4rem' }}>
                          <div style={{ fontSize:'.74rem', fontWeight:700, color:'var(--green-deep)', marginBottom:'.25rem' }}>❄️ {frigo}</div>
                          <div style={{ display:'flex', flexWrap:'wrap', gap:'.3rem' }}>
                            {list.map((c, i) => (
                              <span key={i} title={`${c.variety}${c.lot ? ' — ' + c.lot : ''} — ${c.poids_palox != null ? String(c.poids_palox).replace('.', ',') : '2'}T/palox`} style={{
                                display:'inline-flex', alignItems:'center', gap:'.3rem',
                                background: c.color + '22', border:`1.5px solid ${c.color}`, borderRadius:20,
                                padding:'.15rem .55rem', fontSize:'.74rem', fontWeight:600,
                              }}>
                                <span style={{ width:8, height:8, borderRadius:'50%', background:c.color, flexShrink:0 }} />
                                {c.label} <strong style={{ color:'var(--green-mid)' }}>×{c.palox}</strong>
                                {c.poids_palox != null && c.poids_palox !== 2 && (
                                  <span style={{ color:'var(--amber,#c47c1a)' }}>({String(c.poids_palox).replace('.', ',')}T)</span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                      <div style={{ fontSize:'.78rem', fontWeight:700, marginTop:'.3rem',
                        color: prev.total >= prev.target ? 'var(--green-mid)' : 'var(--amber,#c47c1a)' }}>
                        {prev.total.toFixed(1)} T prévues ({prev.totalPalox ?? prev.cells.reduce((s,c)=>s+(c.palox||0),0)} palox) / objectif {prev.target} T{prev.cap ? ` (plafond ${prev.cap} T)` : ''}
                        {prev.total < prev.target && ' — ⚠️ stock insuffisant pour couvrir le camion'}
                      </div>
                    </div>
                  )
                })()}
                {!rdv.palox_prevision && !prevLoading && (
                  <div style={{ fontSize:'.72rem', color:'var(--stone,#5c6b54)', marginTop:4 }}>
                    Se calcule automatiquement à partir des cases des frigos correspondant {(rdv.varietes?.filter(v=>v.variete?.trim()).length || 0) > 1 ? 'aux variétés/lots' : 'à la variété (et au lot)'} saisis.
                  </div>
                )}
              </div>
            )}
            {/* Camion lavé → choix de la bobine (film des sacs) */}
            {rdv.lave && (
              <div className="form-group" style={{ gridColumn:'1/-1', background:'var(--cream)', borderRadius:8, padding:'.6rem .8rem' }}>
                <label>🎞️ Bobine pour le chargement</label>
                <select value={rdv.bobine||''} onChange={e=>setRdv({...rdv,bobine:e.target.value||null})}>
                  <option value="">— Aucune / à définir —</option>
                  {bobines.map(b => {
                    const label = `${b.reference}${b.format ? ` (${b.format})` : ''}${b.client ? ` · ${b.client}` : ''}`
                    return <option key={label} value={label}>{label}</option>
                  })}
                  {rdv.bobine && !bobines.some(b => `${b.reference}${b.format ? ` (${b.format})` : ''}${b.client ? ` · ${b.client}` : ''}` === rdv.bobine) && (
                    <option value={rdv.bobine}>{rdv.bobine}</option>
                  )}
                </select>
                {bobines.length === 0 && (
                  <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:4 }}>
                    Aucune bobine — ajoute-les dans Base de données → 🎞️ Bobines (saisie ou import CSV).
                  </div>
                )}

                {/* Sacs : plusieurs types possibles (ex. 5 palettes en 25kg + 15 en 20kg) */}
                <label style={{ marginTop:'.7rem' }}>🛍️ Sacs pour le chargement</label>
                <div style={{ display:'flex', flexDirection:'column', gap:'.4rem' }}>
                  {sacs.map((s, i) => (
                    <div key={i} style={{ display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap' }}>
                      <input type="number" min={0} step="1" value={s.palettes ?? ''} style={{ width:90 }}
                        onChange={e => setSac(i, { palettes: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                        placeholder="Nb" />
                      <span style={{ fontSize:'.78rem', color:'var(--stone,#5c6b54)' }}>palette{(s.palettes||0) > 1 ? 's' : ''} de sacs</span>
                      <select value={s.format || '25kg'} style={{ width:90 }}
                        onChange={e => setSac(i, { format: e.target.value })}>
                        {SAC_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <span style={{ fontSize:'.78rem', color:'var(--stone,#5c6b54)' }}>·</span>
                      <input type="number" min={0} step="1" value={s.par_palette ?? ''} style={{ width:80 }}
                        onChange={e => setSac(i, { par_palette: e.target.value === '' ? '' : parseInt(e.target.value) || 0 })}
                        placeholder="Nb" />
                      <span style={{ fontSize:'.78rem', color:'var(--stone,#5c6b54)' }}>sacs/palette</span>
                      <button type="button" onClick={() => setRdv({ ...rdv, sacs: sacs.filter((_, idx) => idx !== i) })}
                        style={{ background:'none', border:'none', cursor:'pointer', color:'var(--red,#c0392b)', fontSize:'.95rem' }}>✕</button>
                      {s.palettes > 0 && s.par_palette > 0 && (
                        <span style={{ fontSize:'.74rem', color:'var(--green-mid,#3d7a42)', fontWeight:700, width:'100%' }}>
                          = {(s.palettes * s.par_palette).toLocaleString('fr-FR')} sacs au total
                        </span>
                      )}
                    </div>
                  ))}
                  <button type="button" className="btn-sm" style={{ alignSelf:'flex-start' }}
                    onClick={() => setRdv({ ...rdv, sacs: [...sacs, { format: '25kg', palettes: '', par_palette: '' }] })}>
                    + Type de sac
                  </button>
                </div>
              </div>
            )}
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Observation</label>
              <textarea rows={2} value={rdv.observation||''} onChange={e=>setRdv({...rdv,observation:e.target.value})} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          {onDelete && <button className="btn-danger" onClick={onDelete}>Supprimer</button>}
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={onSave}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}

// Éditeur de points GPS réutilisable (un ou plusieurs) — utilisé à la fois pour un lieu de
// chargement (LieuModal) et pour un chargement (ChargementModal). Chaque point : repère libre +
// soit latitude/longitude, soit une URL collée directement (ex. lien Google Maps partagé).
// `fromLieux`, si fourni, ajoute un raccourci pour reprendre le(s) point(s) d'un lieu enregistré.
function GpsPointsEditor({ points, onChange, fromLieux }) {
  const list = points || []
  const update = (idx, patch) => { const gp = [...list]; gp[idx] = { ...gp[idx], ...patch }; onChange(gp) }
  const remove = idx => onChange(list.filter((_, i) => i !== idx))
  const add = (point = { lat: '', lng: '', label: '', url: '' }) => onChange([...list, point])
  const lieuxWithGps = (fromLieux || []).filter(l => lieuGpsPoints(l).length)
  return (
    <div className="form-group">
      <label>📍 Points GPS</label>
      <div style={{ display: 'grid', gap: '.5rem' }}>
        {list.map((p, idx) => {
          const link = pointLink(p)
          return (
            <div key={idx} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem .6rem', display: 'grid', gap: '.35rem' }}>
              <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                <input type="text" placeholder="Repère (ex. Entrée principale, Quai 2…)" value={p.label ?? ''}
                  onChange={e => update(idx, { label: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
                {link && <a href={link} target="_blank" rel="noreferrer" title="Ouvrir ce point">🗺️</a>}
                <button type="button" onClick={() => remove(idx)}
                  title="Supprimer ce point" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: '1rem', padding: '0 .2rem' }}>✕</button>
              </div>
              <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
                <input type="text" inputMode="decimal" placeholder="Latitude" value={p.lat ?? ''}
                  onChange={e => update(idx, { lat: e.target.value })} style={{ width: 90 }} />
                <input type="text" inputMode="decimal" placeholder="Longitude" value={p.lng ?? ''}
                  onChange={e => update(idx, { lng: e.target.value })} style={{ width: 90 }} />
                <span style={{ fontSize: '.68rem', color: 'var(--text-muted)' }}>ou</span>
                <input type="text" placeholder="🔗 Coller une URL (Google Maps…)" value={p.url ?? ''}
                  onChange={e => update(idx, { url: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
              </div>
            </div>
          )
        })}
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="btn-sm" onClick={() => add()}>+ Ajouter un point GPS</button>
          {lieuxWithGps.length > 0 && (
            <select defaultValue="" onChange={e => {
              const l = lieuxWithGps.find(x => x.id === e.target.value)
              if (!l) return
              const pts = lieuGpsPoints(l).map(p => ({ lat: p.lat ?? '', lng: p.lng ?? '', url: p.url || '', label: p.label || l.nom }))
              onChange([...list, ...pts])
              e.target.value = ''
            }} style={{ fontSize: '.78rem', padding: '.3rem .5rem' }}>
              <option value="">+ Depuis un lieu enregistré…</option>
              {lieuxWithGps.map(l => <option key={l.id} value={l.id}>{l.nom}</option>)}
            </select>
          )}
          {list.length > 1 && gpsPointsMapUrl(list) && (
            <a href={gpsPointsMapUrl(list)} target="_blank" rel="noreferrer" style={{ fontSize: '.78rem' }}>🗺️ Voir l'itinéraire complet</a>
          )}
        </div>
      </div>
    </div>
  )
}

function LieuModal({ newLieu, setNewLieu, onSave, onClose }) {
  const isEdit = !!newLieu.id
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 380 }}>
        <div className="modal-hdr"><h3>{isEdit ? 'Modifier le lieu' : 'Nouveau lieu de chargement'}</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body" style={{ display: 'grid', gap: '.9rem' }}>
          <div className="form-group"><label>Nom du lieu *</label><input autoFocus value={newLieu.nom} onChange={e => setNewLieu({ ...newLieu, nom: e.target.value })} placeholder="ex. Site Nord, Ferme Dupont…" /></div>
          <div className="form-group">
            <label>Couleur d'identification</label>
            <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginTop: '.3rem' }}>
              {LIEU_COLORS.map(c => (
                <div key={c} onClick={() => setNewLieu({ ...newLieu, couleur: c })}
                  style={{ width: 30, height: 30, borderRadius: 7, background: c, cursor: 'pointer', border: newLieu.couleur === c ? '3px solid var(--green-deep)' : '3px solid transparent', transition: 'border .1s' }} />
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', marginTop: '.6rem' }}>
              <input type="color" value={newLieu.couleur} onChange={e => setNewLieu({ ...newLieu, couleur: e.target.value })}
                style={{ width: 40, height: 30, padding: 0, border: '1.5px solid var(--straw,#e8e4d6)', borderRadius: 7, cursor: 'pointer' }} />
              <input type="text" value={newLieu.couleur} onChange={e => setNewLieu({ ...newLieu, couleur: e.target.value })}
                placeholder="#rrggbb" style={{ flex: 1 }} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', margin: '.1rem 0' }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border,#e8e4d6)' }} />
            <span style={{ fontSize: '.68rem', color: 'var(--text-muted,#8a9a82)' }}>Coordonnées du contact sur place</span>
            <div style={{ flex: 1, height: 1, background: 'var(--border,#e8e4d6)' }} />
          </div>
          <div className="form-group"><label>👤 Nom de la personne</label>
            <input value={newLieu.contact_nom || ''} onChange={e => setNewLieu({ ...newLieu, contact_nom: e.target.value })} placeholder="ex. Jean Dupont" /></div>
          <div className="form-group"><label>📞 Téléphone</label>
            <input type="tel" value={newLieu.contact_telephone || ''} onChange={e => setNewLieu({ ...newLieu, contact_telephone: e.target.value })} placeholder="ex. 06 12 34 56 78" /></div>
          <div className="form-group"><label>✉️ Email(s)</label>
            <input type="text" value={newLieu.contact_email || ''} onChange={e => setNewLieu({ ...newLieu, contact_email: e.target.value })} placeholder="ex. contact@site.fr, autre@site.fr" /></div>
          <GpsPointsEditor points={newLieu.gps_points || []} onChange={gp => setNewLieu({ ...newLieu, gps_points: gp })} />
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={onSave}>{isEdit ? 'Enregistrer' : 'Ajouter'}</button>
        </div>
      </div>
    </div>
  )
}

/* ════════════════ PLANNING EXTERNE (restricted, with lieu colors) ════════════════ */
/* Modal partagé (édition d'un chargement extérieur / confirmation d'achat) — utilisé à la
   fois par l'onglet Chargements MC CAIN (vue semaine) et par l'onglet Confirmations d'achat
   (liste de tous les chargements, toutes semaines confondues). */
function ChargementModal({ editing, setEditing, clients, lieux, onNewLieu, onSave, onDelete, onClose }) {
  const [clientQ, setClientQ] = useState(editing.client_nom || '')
  const [showClientDd, setShowClientDd] = useState(false)
  const clientMatches = clientQ.length > 0
    ? clients.filter(c => c.nom.toLowerCase().includes(clientQ.toLowerCase())).slice(0, 8)
    : []
  // Créneaux 15 min sur toute la journée : 00h15 → 00h00 (minuit) — chargements MC CAIN
  const slotOptions = []
  for (let total = 15; total <= 24 * 60; total += 15) {
    slotOptions.push(toSlot(Math.floor(total / 60) % 24, total % 60))
  }

  // Variété/lot : d'abord ce qui est réellement en stock dans les frigos, puis en repli
  // la BDD Variétés (lot pas obligatoire) — jamais restrictif, la saisie libre reste
  // toujours possible (chargement chez un tiers dont on ne voit pas les frigos).
  const [caveStock, setCaveStock] = useState([])
  const [dbVarietes, setDbVarietes] = useState([])
  useEffect(() => {
    supabase.from('cave_cells').select('variety,lot').gt('palox', 0).then(({ data }) => setCaveStock(data || []))
    supabase.from('db_varietes').select('variete,lot').then(({ data }) => setDbVarietes(data || []))
  }, [])
  const varieteSuggestions = [...new Set([
    ...caveStock.map(c => (c.variety || '').trim()).filter(Boolean),
    ...dbVarietes.map(v => (v.variete || '').trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, 'fr'))
  const sameVariety = nom => !editing.variete || (nom || '').trim().toLowerCase() === editing.variete.trim().toLowerCase()
  const lotSuggestions = [...new Set([
    ...caveStock.filter(c => sameVariety(c.variety)).map(c => (c.lot || '').trim()).filter(Boolean),
    ...dbVarietes.filter(v => sameVariety(v.variete)).map(v => (v.lot || '').trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, 'fr'))

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-hdr"><h3>{editing.id ? 'Modifier' : 'Nouveau chargement externe'}</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body" style={{ display: 'grid', gap: '.8rem' }}>
          {/* Client autocomplete */}
          <div className="form-group" style={{ position: 'relative' }}>
            <label>Client *</label>
            <input value={clientQ} placeholder="🔍 Rechercher…"
              onChange={e => { setClientQ(e.target.value); setEditing({ ...editing, client_nom: e.target.value, client_id: null, client_adresse: '', client_cp: '', client_ville: '' }); setShowClientDd(true) }}
              onFocus={() => setShowClientDd(true)} onBlur={() => setTimeout(() => setShowClientDd(false), 200)} />
            {showClientDd && clientMatches.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-md)', zIndex: 300, maxHeight: 160, overflowY: 'auto' }}>
                {clientMatches.map(c => (
                  <div key={c.id} onMouseDown={() => {
                    setClientQ(c.nom)
                    setEditing({ ...editing, client_nom: c.nom, client_id: c.id, client_adresse: c.adresse || '', client_cp: c.code_postal || '', client_ville: c.ville || '' })
                    setShowClientDd(false)
                  }} style={{ padding: '.55rem 1rem', cursor: 'pointer', fontSize: '.84rem', borderBottom: '1px solid var(--border)' }}>
                    <strong>{c.nom}</strong>{c.ville ? ` — ${c.ville}` : ''}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group"><label>📅 Date</label><input type="date" value={editing.date || ''} onChange={e => setEditing({ ...editing, date: e.target.value })} /></div>
            <div className="form-group"><label>🕐 Heure</label>
              <select value={editing.time_slot || ''} onChange={e => setEditing({ ...editing, time_slot: e.target.value || null })}>
                <option value="">— Sans horaire —</option>
                {slotOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Variété</label>
            <input list="chargement-variete-suggestions" value={editing.variete} onChange={e => setEditing({ ...editing, variete: e.target.value })} placeholder="Frigos puis BDD, ou saisie libre" />
            <datalist id="chargement-variete-suggestions">{varieteSuggestions.map(v => <option key={v} value={v} />)}</datalist>
          </div>
          <div className="form-group">
            <label>Lot</label>
            <input list="chargement-lot-suggestions" value={editing.lot || ''} onChange={e => setEditing({ ...editing, lot: e.target.value })} placeholder="ex. TALLOT" />
            <datalist id="chargement-lot-suggestions">{lotSuggestions.map(l => <option key={l} value={l} />)}</datalist>
          </div>
          <div className="form-group"><label>Type de chargement</label>
            <select value={editing.type_chargement} onChange={e => setEditing({ ...editing, type_chargement: e.target.value })}>
              <option value="">— Choisir —</option>
              {['Vrac','Big-bag','Big-bag lavé','Palox','Palox lavé','Sac 10kg','Sac 25kg'].map(o => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Lieu de chargement</label>
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <select style={{ flex: 1, minWidth: 0 }} value={editing.lieu_chargement_id || ''}
                onChange={e => setEditing({ ...editing, lieu_chargement_id: e.target.value || null, lieu_chargement_manuel: '' })}>
                <option value="">— Choisir —</option>
                {lieux.map(l => <option key={l.id} value={l.id}>{l.nom}</option>)}
              </select>
              {onNewLieu && <button type="button" className="btn-sm" onClick={onNewLieu}>+ Lieu</button>}
            </div>
            {(() => {
              const selLieu = lieux.find(l => l.id === editing.lieu_chargement_id)
              const hasContact = selLieu && (selLieu.contact_nom || selLieu.contact_telephone || selLieu.contact_email)
              return hasContact ? (
                <div style={{ marginTop: '.4rem', padding: '.5rem .7rem', background: 'var(--green-pale,#eaf5ea)', borderRadius: 8, fontSize: '.78rem', display: 'grid', gap: '.15rem' }}>
                  {selLieu.contact_nom && <span>👤 {selLieu.contact_nom}</span>}
                  {selLieu.contact_telephone && <span>📞 {selLieu.contact_telephone}</span>}
                  {selLieu.contact_email && <span>✉️ {selLieu.contact_email}</span>}
                </div>
              ) : null
            })()}
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', margin: '.5rem 0 .2rem' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: '.68rem', color: 'var(--text-muted)' }}>ou</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
            <input type="text" placeholder="✏️ Saisir un lieu manuellement…"
              value={editing.lieu_chargement_manuel || ''}
              onChange={e => setEditing({ ...editing, lieu_chargement_manuel: e.target.value, lieu_chargement_id: e.target.value ? null : editing.lieu_chargement_id })} />
          </div>
          <GpsPointsEditor points={editing.gps_points || []} onChange={gp => setEditing({ ...editing, gps_points: gp })} fromLieux={lieux} />
          <div className="form-group"><label>Réf. chargement</label><input value={editing.ref_chargement} onChange={e => setEditing({ ...editing, ref_chargement: e.target.value })} /></div>
          <div className="form-group"><label>Tonnage (T)</label><input type="number" step="0.001" min={0} value={editing.tonnage ?? ''} onChange={e => setEditing({ ...editing, tonnage: e.target.value })} placeholder="ex. 25" /></div>
          <div className="form-group"><label>Négociant (🔒 interne uniquement)</label><input value={editing.negociant||''} onChange={e => setEditing({ ...editing, negociant: e.target.value })} placeholder="Nom du négociant" /></div>
          <div className="form-group"><label>Prix HT €/T (🔒 interne uniquement)</label><input type="number" value={editing.prix_ht} onChange={e => setEditing({ ...editing, prix_ht: e.target.value })} /></div>
          <div className="form-group"><label>Observation</label><textarea rows={2} value={editing.observation} onChange={e => setEditing({ ...editing, observation: e.target.value })}
            style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} /></div>
        </div>
        <div className="modal-foot">
          {editing.id && onDelete && <button className="btn-danger" onClick={onDelete}>Supprimer</button>}
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={onSave}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}

function PlanningExterne({ showToast }) {
  const { perms } = useAuth()
  const readOnly = !!perms.planningReadOnly
  // Rôle restreint à un seul lieu (ex. Xavier — FP Légumes) : même restriction
  // ici que sur le planning principal — voir matchesOnlyLieu.
  const onlyLieuNom = (perms.planningOnlyLieuNom || '').trim().toLowerCase()
  const isMobile = useIsMobilePlanning()
  const [refDate, setRefDate] = useState(new Date())
  const [dayIndex, setDayIndex] = useState(() => { const d = new Date().getDay(); return d === 0 ? 6 : d - 1 })
  const [items, setItems]     = useState([])   // liste brute de la semaine (PDF, bande "sans horaire")
  const [itemsMap, setItemsMap] = useState({}) // { date: { slot: item } } — même structure que le planning principal
  const [sansHoraire, setSansHoraire] = useState({}) // { date: [items sans créneau] }
  const [lieux, setLieux]     = useState([])
  // Rôle restreint à un seul lieu : n'affiche même pas les autres lieux
  // existants (légende, filtre PDF…), pas juste leurs chargements.
  const visibleLieux = onlyLieuNom ? lieux.filter(l => l.nom.trim().toLowerCase() === onlyLieuNom) : lieux
  const [clients, setClients] = useState([])
  const [modalOpen, setModalOpen]   = useState(false)
  const [editing, setEditing]       = useState(null)
  const [lieuModal, setLieuModal]       = useState(false)
  const [newLieu, setNewLieu]           = useState({ nom:'', couleur: LIEU_COLORS[0] })
  const [pdfLieuFilter, setPdfLieuFilter] = useState('ALL')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])

  // Drag-and-drop — même mécanique que le planning principal
  const [dragging, setDragging] = useState(null) // { item, fromDate, fromSlot }
  const [dragOver, setDragOver] = useState(null) // { dateKey, slot }
  const dragInfoRef = useRef(null)
  const dragOverRef = useRef(null)

  // Copier-coller — pour dupliquer rapidement un chargement identique à d'autres heures
  // (ex. plusieurs camions du même client/variété dans la journée) : on copie un chargement
  // existant, puis on clique sur n'importe quel créneau vide pour y coller une copie ; le
  // presse-papiers reste actif pour coller plusieurs fois de suite.
  const [clipboard, setClipboard] = useState(null)

  function openLieuModal() {
    setNewLieu({ nom: '', couleur: nextLieuColor(lieux), scope: 'mccain', contact_nom: '', contact_telephone: '', contact_email: '', gps_points: [] })
    setLieuModal(true)
  }
  function openEditLieuModal(l) {
    setNewLieu({ ...l, gps_points: lieuGpsPoints(l) })
    setLieuModal(true)
  }

  useEffect(() => { loadLieux(); loadClients() }, [])
  // `lieux` en dépendance : matchesOnlyLieu résout le nom depuis lieu_chargement_id,
  // nécessite que la liste des lieux soit chargée (voir même remarque côté PlanningSemaine).
  useEffect(() => { loadItems() }, [refDate, lieux])
  useEffect(() => () => {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
  }, [])

  async function loadLieux() {
    const { data } = await supabase.from('lieux_chargement').select('*').or('scope.is.null,scope.eq.mccain').order('nom')
    setLieux(data || [])
  }
  async function loadClients() {
    const { data } = await supabase.from('clients').select('*').order('nom')
    setClients(data || [])
  }
  async function loadItems() {
    const monday = getMonday(refDate)
    const start = toDateKey(monday), end = toDateKey(addDays(monday, 6))
    const { data: raw } = await supabase.from('planning_externe').select('*').gte('date', start).lte('date', end).order('date')
    const data = onlyLieuNom ? (raw || []).filter(matchesOnlyLieu) : raw
    const map = {}, sans = {}
    ;(data || []).forEach(r => {
      if (r.time_slot && !map[r.date]?.[r.time_slot]) {
        if (!map[r.date]) map[r.date] = {}
        map[r.date][r.time_slot] = r
      } else {
        // sans créneau (ou créneau déjà occupé) → bande "Sans horaire" du jour
        if (!sans[r.date]) sans[r.date] = []
        sans[r.date].push(r)
      }
    })
    setItems(data || [])
    setItemsMap(map)
    setSansHoraire(sans)
  }

  function openNew(dateKey, slot = null) {
    setEditing({ date: dateKey, time_slot: slot, client_id: null, client_nom: '', client_adresse: '', client_cp: '', client_ville: '',
      variete: '', lot: '', type_chargement: '', lieu_chargement_id: null, lieu_chargement_manuel: '', ref_chargement: '', tonnage: '', negociant: 'MC CAIN', prix_ht: '', observation: '', gps_points: [] })
    setModalOpen(true)
  }
  function openEdit(item) {
    setEditing({ ...item, gps_points: Array.isArray(item.gps_points) ? item.gps_points : [] })
    setModalOpen(true)
  }

  const missingSlotColumn = msg => /time_slot|could not find|column/i.test(msg)
  const MIGRATION_MSG = 'Colonne time_slot manquante — exécute migration_planning_externe_horaire.sql dans Supabase → SQL Editor.'

  async function save() {
    if (!editing.client_nom?.trim()) { alert('Client requis.'); return }
    let payload = { ...editing, prix_ht: editing.prix_ht === '' ? null : editing.prix_ht, tonnage: editing.tonnage === '' ? null : parseFloat(editing.tonnage) }
    delete payload.created_at
    // Points GPS : ne garde que les lignes avec une URL ou des coordonnées lat/lng renseignées
    if (Array.isArray(payload.gps_points)) {
      const hasCoords = p => p.lat !== '' && p.lat != null && p.lng !== '' && p.lng != null
      payload.gps_points = payload.gps_points
        .filter(p => p.url?.trim() || hasCoords(p))
        .map(p => ({ lat: hasCoords(p) ? parseFloat(p.lat) : null, lng: hasCoords(p) ? parseFloat(p.lng) : null, label: p.label || '', url: p.url?.trim() || null }))
      if (!payload.gps_points.length) payload.gps_points = null
    }

    const attempt = async p => payload.id
      ? await supabase.from('planning_externe').update(p).eq('id', payload.id)
      : await supabase.from('planning_externe').insert(p)

    let { error } = await attempt(payload)
    if (error && /tonnage/i.test(error.message)) {
      const { tonnage, ...withoutTonnage } = payload
      payload = withoutTonnage
      ;({ error } = await attempt(payload))
      if (!error) alert("Colonne tonnage manquante — exécute migration_A_EXECUTER_68.sql dans Supabase → SQL Editor pour pouvoir enregistrer le tonnage. Enregistré sans le tonnage.")
    }
    if (error && /gps_points/i.test(error.message)) {
      const { gps_points, ...withoutGps } = payload
      payload = withoutGps
      ;({ error } = await attempt(payload))
      if (!error) alert("Colonne gps_points manquante — exécute migration_A_EXECUTER_65.sql dans Supabase → SQL Editor pour pouvoir enregistrer les points GPS. Le chargement a été enregistré sans les points GPS.")
    }
    if (error && /lot|column/i.test(error.message) && !missingSlotColumn(error.message)) {
      const { lot, ...withoutLot } = payload
      payload = withoutLot
      ;({ error } = await attempt(payload))
    }
    if (error) { alert(missingSlotColumn(error.message) ? MIGRATION_MSG : error.message); return }
    // Si la date a changé, suivre la semaine correspondante
    const savedMonday = getMonday(new Date(payload.date))
    if (toDateKey(savedMonday) !== toDateKey(getMonday(refDate))) setRefDate(new Date(payload.date))
    else loadItems()
    setModalOpen(false)
    showToast('✅ Chargement externe enregistré')
  }

  async function remove() {
    if (!editing.id || !confirm('Supprimer ?')) return
    await supabase.from('planning_externe').delete().eq('id', editing.id)
    loadItems()
    setModalOpen(false)
  }

  function copyItem(it) {
    const { id, date, time_slot, created_at, ...rest } = it
    setClipboard(rest)
    showToast('📋 Copié — clique un créneau vide pour coller (plusieurs fois si besoin)')
  }

  async function pasteAt(dateKey, slot) {
    if (!clipboard) return
    let payload = { ...clipboard, date: dateKey, time_slot: slot }
    const attempt = async p => await supabase.from('planning_externe').insert(p)
    let { error } = await attempt(payload)
    if (error && /gps_points/i.test(error.message)) {
      const { gps_points, ...withoutGps } = payload
      payload = withoutGps
      ;({ error } = await attempt(payload))
    }
    if (error && /lot|column/i.test(error.message) && !missingSlotColumn(error.message)) {
      const { lot, ...withoutLot } = payload
      payload = withoutLot
      ;({ error } = await attempt(payload))
    }
    if (error) { alert(missingSlotColumn(error.message) ? MIGRATION_MSG : error.message); return }
    loadItems()
    showToast(`✅ Collé → ${dateKey} ${slot}`)
  }

  async function runSearch(q) {
    setSearchQuery(q)
    if (!q || q.length < 2) { setSearchResults([]); return }
    const { data } = await supabase.from('planning_externe').select('*')
      .or(`client_nom.ilike.%${q}%,variete.ilike.%${q}%`)
      .order('date', { ascending: false }).limit(20)
    setSearchResults(onlyLieuNom ? (data || []).filter(matchesOnlyLieu) : (data || []))
  }

  function goToWeekOf(dateStr) {
    if (!dateStr) return
    setRefDate(new Date(dateStr))
    const dd = new Date(dateStr).getDay()
    setDayIndex(dd === 0 ? 6 : dd - 1)
    setSearchResults([])
    setSearchQuery('')
  }

  // Combine : lieu enregistré (couleur dédiée) OU saisie manuelle libre
  function getLieuDisplay(item) {
    const l = lieux.find(x => x.id === item?.lieu_chargement_id)
    if (l) return { nom: l.nom, couleur: l.couleur, manual: false }
    const manuel = item?.lieu_chargement_manuel?.trim()
    if (manuel) return { nom: manuel, couleur: manualLieuColor(manuel), manual: true }
    return null
  }
  // Rôle restreint à un seul lieu (ex. Xavier — FP Légumes).
  function matchesOnlyLieu(item) {
    if (!onlyLieuNom) return true
    const nom = (getLieuDisplay(item)?.nom || '').trim().toLowerCase()
    return nom === onlyLieuNom
  }

  /* ── Drag handlers (identiques au planning principal) ── */
  function handleCardPointerDown(e, item, dateKey, slot) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.stopPropagation()
    dragInfoRef.current = { item, fromDate: dateKey, fromSlot: slot, startX: e.clientX, startY: e.clientY, active: false }
    window.addEventListener('pointermove', handleWindowPointerMove)
    window.addEventListener('pointerup', handleWindowPointerUp)
  }
  function handleWindowPointerMove(e) {
    const info = dragInfoRef.current
    if (!info) return
    const dx = e.clientX - info.startX, dy = e.clientY - info.startY
    if (!info.active) {
      if (Math.hypot(dx, dy) < 6) return
      info.active = true
      setDragging({ item: info.item, fromDate: info.fromDate, fromSlot: info.fromSlot })
    }
    e.preventDefault()
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const cell = el && el.closest('[data-slot]')
    if (cell) {
      const d = { dateKey: cell.dataset.date, slot: cell.dataset.slot }
      dragOverRef.current = d
      setDragOver(d)
    } else {
      dragOverRef.current = null
      setDragOver(null)
    }
  }
  async function handleWindowPointerUp() {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    window.removeEventListener('pointerup', handleWindowPointerUp)
    const info = dragInfoRef.current
    dragInfoRef.current = null
    if (!info) return
    if (!info.active) { openEdit(info.item); return }
    const target = dragOverRef.current
    dragOverRef.current = null
    setDragging(null)
    setDragOver(null)
    if (target) await performMove(info.item, info.fromDate, info.fromSlot, target.dateKey, target.slot)
  }
  async function performMove(item, fromDate, fromSlot, targetDate, targetSlot) {
    if (fromDate === targetDate && fromSlot === targetSlot) return
    if (itemsMap[targetDate]?.[targetSlot]) { showToast('⚠️ Ce créneau est déjà occupé'); return }
    const { error } = await supabase.from('planning_externe').update({ date: targetDate, time_slot: targetSlot }).eq('id', item.id)
    if (error) { alert(missingSlotColumn(error.message) ? MIGRATION_MSG : error.message); return }
    loadItems()
    showToast(`✅ Chargement déplacé → ${targetDate} ${targetSlot}`)
  }
  const isDropTarget = (dateKey, slot) => dragOver?.dateKey === dateKey && dragOver?.slot === slot
  // Le filtre lieu (menu à côté du bouton PDF) filtre aussi ce qui est affiché à l'écran, pas
  // seulement le PDF — sinon choisir un lieu semble ne "rien faire" puisque la grille ne bouge pas.
  const displayItemsMap = pdfLieuFilter === 'ALL' ? itemsMap : Object.fromEntries(
    Object.entries(itemsMap).map(([date, slots]) => [date, Object.fromEntries(Object.entries(slots).filter(([, it]) => itemMatchesLieuFilter(it)))])
  )
  const displaySansHoraire = pdfLieuFilter === 'ALL' ? sansHoraire : Object.fromEntries(
    Object.entries(sansHoraire).map(([date, arr]) => [date, arr.filter(itemMatchesLieuFilter)])
  )
  const weekHasSansHoraire = Object.values(displaySansHoraire).some(arr => arr.length > 0)

  async function saveLieu() {
    if (!newLieu.nom?.trim()) { alert('Nom requis.'); return }
    const isEdit = !!newLieu.id
    const hasCoords = p => p.lat !== '' && p.lat != null && p.lng !== '' && p.lng != null
    let gpsPoints = (newLieu.gps_points || [])
      .filter(p => p.url?.trim() || hasCoords(p))
      .map(p => ({ lat: hasCoords(p) ? parseFloat(p.lat) : null, lng: hasCoords(p) ? parseFloat(p.lng) : null, label: p.label || '', url: p.url?.trim() || null }))
    // On ne touche pas aux anciennes colonnes lat/lng/gps_url (lieux créés avant ce changement) :
    // lieuGpsPoints() les ignore de toute façon dès que gps_points est renseigné, inutile de les
    // écraser — et ça évite de perdre la donnée si la migration gps_points n'est pas encore passée.
    const payload = { ...newLieu, gps_points: gpsPoints.length ? gpsPoints : null }
    let data, error
    const attempt = async p => isEdit
      ? await supabase.from('lieux_chargement').update(p).eq('id', newLieu.id).select().single()
      : await supabase.from('lieux_chargement').insert(p).select().single()
    let insertPayload = payload
    if (isEdit) { const { id, ...withoutId } = insertPayload; insertPayload = withoutId }
    ;({ data, error } = await attempt(insertPayload))
    if (error && /gps_points/i.test(error.message)) {
      const { gps_points, ...withoutGps } = insertPayload
      insertPayload = withoutGps
      ;({ data, error } = await attempt(insertPayload))
      if (!error) alert("Colonne gps_points manquante — exécute migration_A_EXECUTER_67.sql dans Supabase → SQL Editor pour pouvoir enregistrer plusieurs points GPS. Enregistré sans les points GPS.")
    }
    if (error && /contact_nom|contact_telephone|contact_email/i.test(error.message)) {
      alert("Colonnes de coordonnées manquantes — exécute migration_A_EXECUTER_64.sql dans Supabase → SQL Editor.")
      return
    }
    if (error) { alert(error.message); return }
    setLieux(prev => isEdit ? prev.map(l => l.id === data.id ? data : l) : [...prev, data])
    setLieuModal(false)
    setNewLieu({ nom:'', couleur:'#4a9050', scope: 'mccain', contact_nom: '', contact_telephone: '', contact_email: '', gps_points: [] })
    showToast(isEdit ? '✅ Lieu mis à jour' : '✅ Lieu ajouté')
  }

  async function removeLieu(l) {
    if (!confirm(`Supprimer le lieu "${l.nom}" ? Les chargements qui l'utilisent perdront ce code couleur.`)) return
    const { error } = await supabase.from('lieux_chargement').delete().eq('id', l.id)
    if (error) { alert(error.message); return }
    setLieux(prev => prev.filter(x => x.id !== l.id))
    loadItems()
    showToast('🗑️ Lieu supprimé')
  }

  const monday = getMonday(refDate)

  // Options du filtre lieu pour le PDF : lieux enregistrés + lieux saisis manuellement présents cette semaine
  const manualLieuxThisWeek = [...new Set(items.filter(it => !it.lieu_chargement_id && it.lieu_chargement_manuel?.trim()).map(it => it.lieu_chargement_manuel.trim()))]
  const pdfLieuOptions = [
    { value: 'ALL', label: '— Planning entier (tous lieux) —' },
    ...visibleLieux.map(l => ({ value: `id:${l.id}`, label: l.nom })),
    ...manualLieuxThisWeek.map(n => ({ value: `manual:${n}`, label: n })),
  ]
  function itemMatchesLieuFilter(it) {
    if (pdfLieuFilter === 'ALL') return true
    if (pdfLieuFilter.startsWith('id:')) return it.lieu_chargement_id === pdfLieuFilter.slice(3)
    if (pdfLieuFilter.startsWith('manual:')) return !it.lieu_chargement_id && (it.lieu_chargement_manuel || '').trim() === pdfLieuFilter.slice(7)
    return true
  }

  // PDF récapitulatif du planning (semaine affichée), filtré ou non par lieu de chargement —
  // pensé pour être transmis par mail (jamais de négociant ni de prix, données externes uniquement).
  // Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
  // plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
  // popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
  // toujours le vrai dialogue d'impression natif — même pattern que la
  // Confirmation d'achat plus bas dans ce fichier.
  const [printingWeek, setPrintingWeek] = useState(false)
  useEffect(() => {
    if (!printingWeek) return
    document.body.classList.add('printing-active')
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrintingWeek(false)
    }
    window.addEventListener('afterprint', onAfterPrint)
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printingWeek])
  function printWeekSummary() { setPrintingWeek(true) }

  const printWeekFiltered = items.filter(itemMatchesLieuFilter)
  const printWeekLieuLabel = pdfLieuOptions.find(o => o.value === pdfLieuFilter)?.label || ''
  const printWeekDays = DAYS.map((d, i) => {
    const dateKey = toDateKey(addDays(monday, i))
    const dayItems = printWeekFiltered.filter(it => it.date === dateKey)
      .sort((a, b) => (a.time_slot || '99:99').localeCompare(b.time_slot || '99:99') || (a.client_nom || '').localeCompare(b.client_nom || ''))
    return { label: d, dayNum: addDays(monday, i).getDate(), items: dayItems }
  }).filter(d => d.items.length > 0)

  // Carte d'un chargement — même gabarit que les cartes RDV du planning principal
  function renderCard(it, dateKey, slot, { compact = false } = {}) {
    const lieu = getLieuDisplay(it)
    return (
      <div onPointerDown={e => !readOnly && handleCardPointerDown(e, it, dateKey, slot)}
        title={lieu ? `📍 ${lieu.nom}${lieu.manual ? ' (saisie libre)' : ''}` : undefined}
        style={{
          ...(compact
            ? { flex: 1, borderRadius: 8, padding: '.5rem .7rem' }
            : { position: 'absolute', inset: '1px 3px', borderRadius: 6, padding: '.05rem .45rem', boxShadow: '0 1px 4px rgba(0,0,0,.09)' }),
          background: lieu && !lieu.manual ? lieu.couleur + '18' : compact ? 'var(--green-pale)' : 'white',
          borderLeft: `3px ${lieu?.manual ? 'dashed' : 'solid'} ${lieu?.couleur || 'var(--leaf,#3d7a42)'}`,
          overflow: 'hidden', fontSize: compact ? '.8rem' : '.64rem', lineHeight: compact ? undefined : 1.15,
          cursor: readOnly ? 'default' : 'grab', touchAction: 'none', userSelect: 'none',
          opacity: dragging?.item?.id === it.id ? .45 : 1,
          transition: 'opacity .15s',
        }}>
        <div style={{ fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '.3rem' }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{it.client_nom}</span>
          {lieu && (
            <span style={{
              fontSize: compact ? '.66rem' : '.6rem', fontWeight: 800, padding: '0 .35rem', borderRadius: 50, flexShrink: 0,
              color: lieu.manual ? lieu.couleur : 'white',
              background: lieu.manual ? 'transparent' : lieu.couleur,
              border: lieu.manual ? `1.2px dashed ${lieu.couleur}` : 'none',
            }}>{lieu.nom}</span>
          )}
          {gpsPointsMapUrl(it.gps_points) && (
            <button title={`Voir ${(it.gps_points||[]).length > 1 ? 'les points GPS' : 'le point GPS'} sur la carte`}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); window.open(gpsPointsMapUrl(it.gps_points), '_blank', 'noreferrer') }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: compact ? '.8rem' : '.68rem', padding: 0, lineHeight: 1, flexShrink: 0 }}>📍</button>
          )}
          {!readOnly && (
          <button title="Copier ce chargement (pour le coller à une autre heure)"
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); copyItem(it) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: compact ? '.8rem' : '.68rem', padding: 0, lineHeight: 1, flexShrink: 0 }}>📋</button>
          )}
        </div>
        <div style={{ color: 'var(--stone,#5c6b54)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {it.variete}{it.type_chargement ? ' · ' + it.type_chargement : ''}{it.ref_chargement ? ' · 📄 ' + it.ref_chargement : ''}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Nav bar — même présentation que le planning principal */}
      <div style={{ padding: isMobile ? '.5rem .7rem' : '.7rem 1.2rem', background: 'var(--soil,#1c2b1a)', display: 'flex', alignItems: 'center', gap: isMobile ? '.4rem' : '.6rem', flexWrap: 'wrap' }}>
        {isMobile ? (
          <>
            <button className="btn-sm" style={navBtnStyle} onClick={() => {
              if (dayIndex === 0) { setRefDate(addDays(refDate, -7)); setDayIndex(6) } else setDayIndex(dayIndex - 1)
            }}>‹</button>
            <span style={{ fontWeight:700, fontSize:'.82rem', color:'white', flex:1, textAlign:'center' }}>
              {DAYS[dayIndex]} {addDays(monday, dayIndex).toLocaleDateString('fr-FR',{day:'numeric',month:'short'})}
            </span>
            <button className="btn-sm" style={navBtnStyle} onClick={() => {
              if (dayIndex === 6) { setRefDate(addDays(refDate, 7)); setDayIndex(0) } else setDayIndex(dayIndex + 1)
            }}>›</button>
            <button className="btn-sm" onClick={() => { setRefDate(new Date()); const d = new Date().getDay(); setDayIndex(d===0?6:d-1) }}
              style={{ background:'var(--leaf,#3d7a42)', color:'white', borderColor:'var(--sprout,#a8d4a0)', fontWeight:700, fontSize:'.72rem', padding:'.35rem .6rem' }}>
              Auj.
            </button>
            <input type="week"
              value={(() => { const d = new Date(monday); d.setDate(d.getDate() + 3); const w1 = new Date(d.getFullYear(),0,1); const wk = Math.ceil((((d - w1) / 86400000) + w1.getDay()+1) / 7); return `${d.getFullYear()}-W${String(wk).padStart(2,'0')}` })()}
              onChange={e => {
                if (!e.target.value) return
                const [y,w] = e.target.value.split('-W').map(Number)
                const jan4 = new Date(y,0,4)
                const mon  = getMonday(jan4)
                setRefDate(addDays(mon,(w-1)*7))
                setDayIndex(0)
              }}
              style={{ ...navInputStyle, width:130, flexBasis:'100%' }}
            />
          </>
        ) : (
          <>
            <button className="btn-sm" style={navBtnStyle} onClick={() => setRefDate(addDays(refDate, -7))}>‹</button>
            <button className="btn-sm" style={navBtnStyle} onClick={() => setRefDate(addDays(refDate, 7))}>›</button>
            <span style={{ fontWeight: 700, fontSize: '.95rem', color: 'white', minWidth: 200 }}>Semaine du {formatWeekLabel(monday)}</span>
            <button className="btn-sm" onClick={() => setRefDate(new Date())}
              style={{ background:'var(--leaf,#3d7a42)', color:'white', borderColor:'var(--sprout,#a8d4a0)', fontWeight:700 }}>
              Aujourd'hui
            </button>
            <input type="week"
              onChange={e => {
                const [y,w] = e.target.value.split('-W').map(Number)
                const jan4 = new Date(y,0,4)
                const mon  = getMonday(jan4)
                setRefDate(addDays(mon,(w-1)*7))
              }}
              style={{ ...navInputStyle, width:130 }}
            />
            {/* Filtre lieu — filtre à la fois l'affichage de la grille et l'export PDF */}
            <select value={pdfLieuFilter} onChange={e => setPdfLieuFilter(e.target.value)}
              style={{ fontSize:'.76rem', padding:'.3rem .5rem', borderRadius:6, border:'1px solid rgba(255,255,255,.3)', background:'rgba(255,255,255,.1)', color:'white' }}>
              {pdfLieuOptions.map(o => <option key={o.value} value={o.value} style={{ color:'#1a2e1c' }}>{o.label}</option>)}
            </select>
            <button className="btn-sm" onClick={printWeekSummary}
              style={{ fontSize:'.76rem', background:'rgba(255,255,255,.1)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>
              🖨️ PDF planning
            </button>
            {/* Légende lieux */}
            <div style={{ display: 'flex', gap: '.7rem', alignItems: 'center', flexWrap: 'wrap' }}>
              {visibleLieux.map(l => (
                <span key={l.id} style={{ fontSize: '.72rem', color: 'white', display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: l.couleur, display: 'inline-block' }} />
                  {readOnly ? l.nom : (<>
                  <span onClick={() => openEditLieuModal(l)} title="Modifier ce lieu (coordonnées, couleur…)" style={{ cursor:'pointer' }}>{l.nom}</span>
                  <button onClick={() => removeLieu(l)} title="Supprimer ce lieu"
                    style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', fontSize:'.78rem', padding:0, lineHeight:1 }}
                    onMouseEnter={e=>e.currentTarget.style.color='#e74c3c'}
                    onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,.4)'}>✕</button>
                  </>)}
                </span>
              ))}
              {!readOnly && (
              <button className="btn-sm" onClick={openLieuModal}
                style={{ fontSize: '.72rem', padding: '.25rem .6rem', background: 'rgba(255,255,255,.1)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>
                + Lieu
              </button>
              )}
            </div>
            <div style={{ marginLeft:'auto', position:'relative' }}>
              <input type="text" placeholder="🔍 Client, variété…" value={searchQuery}
                onChange={e => runSearch(e.target.value)} style={{ ...navInputStyle, width:240 }} />
              {searchResults.length > 0 && (
                <div style={{ position:'absolute', right:0, top:'calc(100% + 4px)', width:340, background:'white', border:'1px solid var(--straw,#e8e4d6)', borderRadius:10, boxShadow:'0 4px 20px rgba(0,0,0,.1)', zIndex:400, maxHeight:320, overflowY:'auto' }}>
                  {searchResults.map(r => (
                    <div key={r.id} onClick={() => goToWeekOf(r.date)}
                      style={{ padding:'.6rem .9rem', cursor:'pointer', borderBottom:'1px solid var(--straw,#e8e4d6)', fontSize:'.82rem' }}>
                      <strong>{r.client_nom}</strong> — {fmtDate(r.date)} {r.time_slot || 'sans horaire'}<br/>
                      <span style={{ color:'var(--stone,#5c6b54)' }}>{r.variete} {r.type_chargement}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Mobile: légende lieux + PDF */}
      {isMobile && (
        <div style={{ padding:'.4rem .7rem', background:'var(--soil,#1c2b1a)', display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap', borderTop:'1px solid rgba(255,255,255,.1)' }}>
          {visibleLieux.map(l => (
            <span key={l.id} style={{ fontSize:'.66rem', color:'white', display:'flex', alignItems:'center', gap:'.25rem' }}>
              <span style={{ width:8, height:8, borderRadius:2, background:l.couleur, display:'inline-block' }} />
              {readOnly ? l.nom : (<>
              <span onClick={() => openEditLieuModal(l)} style={{ cursor:'pointer' }}>{l.nom}</span>
              <button onClick={() => removeLieu(l)} title="Supprimer ce lieu"
                style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', fontSize:'.72rem', padding:0, lineHeight:1 }}>✕</button>
              </>)}
            </span>
          ))}
          {!readOnly && (
          <button className="btn-sm" onClick={openLieuModal}
            style={{ fontSize:'.64rem', padding:'.18rem .5rem', background:'rgba(255,255,255,.1)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>
            + Lieu
          </button>
          )}
          <select value={pdfLieuFilter} onChange={e => setPdfLieuFilter(e.target.value)}
            style={{ fontSize:'.64rem', padding:'.18rem .3rem', borderRadius:6, border:'1px solid rgba(255,255,255,.3)', background:'rgba(255,255,255,.1)', color:'white', maxWidth:150 }}>
            {pdfLieuOptions.map(o => <option key={o.value} value={o.value} style={{ color:'#1a2e1c' }}>{o.label}</option>)}
          </select>
          <button className="btn-sm" onClick={printWeekSummary}
            style={{ fontSize:'.64rem', padding:'.18rem .5rem', background:'rgba(255,255,255,.1)', color:'white', borderColor:'rgba(255,255,255,.3)' }}>
            🖨️ PDF
          </button>
        </div>
      )}

      {/* Mobile search row */}
      {isMobile && (
        <div style={{ padding:'.5rem .7rem', background:'white', borderBottom:'1px solid var(--straw)', position:'relative' }}>
          <input type="text" placeholder="🔍 Rechercher client, variété…" value={searchQuery}
            onChange={e => runSearch(e.target.value)}
            style={{ width:'100%', padding:'.5rem .8rem', border:'1.5px solid var(--straw)', borderRadius:8, fontSize:'.82rem', outline:'none' }} />
          {searchResults.length > 0 && (
            <div style={{ position:'absolute', left:8, right:8, top:'calc(100% + 2px)', background:'white', border:'1px solid var(--straw)', borderRadius:10, boxShadow:'var(--shadow-md)', zIndex:400, maxHeight:280, overflowY:'auto' }}>
              {searchResults.map(r => (
                <div key={r.id} onClick={() => goToWeekOf(r.date)}
                  style={{ padding:'.6rem .9rem', cursor:'pointer', borderBottom:'1px solid var(--straw)', fontSize:'.82rem' }}>
                  <strong>{r.client_nom}</strong> — {fmtDate(r.date)} {r.time_slot || 'sans horaire'}<br/>
                  <span style={{ color:'var(--stone)' }}>{r.variete} {r.type_chargement}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Drag hint */}
      {dragging && (
        <div style={{ background:'var(--leaf,#3d7a42)', color:'white', fontSize:'.78rem', padding:'.35rem 1rem', textAlign:'center', flexShrink:0 }}>
          Déplacez «&nbsp;<strong>{dragging.item.client_nom}</strong>&nbsp;» vers un créneau libre — relâchez pour confirmer
        </div>
      )}

      {/* Presse-papiers actif : copier-coller un chargement identique à d'autres heures/jours */}
      {clipboard && !dragging && (
        <div style={{ background:'var(--leaf,#3d7a42)', color:'white', fontSize:'.78rem', padding:'.35rem 1rem', display:'flex', alignItems:'center', justifyContent:'center', gap:'.7rem', flexShrink:0, flexWrap:'wrap' }}>
          <span>📋 Copié «&nbsp;<strong>{clipboard.client_nom}</strong>&nbsp;» — clique un créneau vide pour coller (plusieurs fois si besoin)</span>
          <button className="btn-sm" onClick={() => setClipboard(null)}
            style={{ fontSize:'.7rem', padding:'.15rem .55rem', background:'rgba(255,255,255,.15)', color:'white', borderColor:'rgba(255,255,255,.4)' }}>
            ✕ Vider
          </button>
        </div>
      )}

      {isMobile ? (
        /* ── MOBILE: single-day list view ── */
        <div style={{ flex:1, overflow:'auto', padding:'.4rem .6rem' }}>
          {(displaySansHoraire[toDateKey(addDays(monday, dayIndex))] || []).length > 0 && (
            <div style={{ padding:'.4rem .3rem', borderBottom:'2px solid var(--straw)' }}>
              <div style={{ fontSize:'.68rem', fontWeight:700, color:'var(--amber,#c47c1a)', marginBottom:'.3rem' }}>⏱️ Sans horaire — glisse vers un créneau</div>
              {(displaySansHoraire[toDateKey(addDays(monday, dayIndex))] || []).map(it => (
                <div key={it.id} style={{ display:'flex', marginBottom:'.3rem' }}>
                  {renderCard(it, it.date, null, { compact: true })}
                </div>
              ))}
            </div>
          )}
          {Array.from({ length:96 }).map((_,idx) => {
            const totalMin = 15 + idx*15
            const h = Math.floor(totalMin/60) % 24, m = totalMin%60
            const slot = toSlot(h,m)
            const isHour = m === 0
            const dateKey = toDateKey(addDays(monday, dayIndex))
            const realIt = itemsMap[dateKey]?.[slot]
            const it = displayItemsMap[dateKey]?.[slot]
            return (
              <div key={slot} data-date={dateKey} data-slot={slot}
                onClick={() => !readOnly && !realIt && !dragging && (clipboard ? pasteAt(dateKey, slot) : openNew(dateKey, slot))}
                style={{
                  display:'flex', alignItems:'center', gap:'.7rem', padding:'.35rem .3rem',
                  borderTop: isHour ? '1px solid var(--straw)' : 'none',
                  borderBottom:'1px solid var(--straw)', cursor:'pointer', minHeight:30,
                  background: isDropTarget(dateKey, slot) ? (it ? 'rgba(192,57,43,.08)' : 'rgba(61,122,66,.12)') : 'transparent',
                }}>
                <span style={{ width:42, flexShrink:0, fontSize:'.7rem', fontWeight: isHour ? 700 : 500, color: isHour ? 'var(--fog)' : 'var(--fog2,#d8d2bc)' }}>{slot}</span>
                {it ? renderCard(it, dateKey, slot, { compact: true }) : realIt ? (
                  <div style={{ flex:1, fontSize:'.72rem', color:'var(--fog,#c8c0a8)', fontStyle:'italic' }}>— masqué par le filtre lieu —</div>
                ) : (
                  <div style={{ flex:1, fontSize:'.76rem', color: clipboard ? 'var(--leaf,#3d7a42)' : 'var(--fog,#c8c0a8)', fontWeight: clipboard ? 700 : 400 }}>
                    {clipboard ? '📋 Coller ici' : '+ Ajouter un chargement'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        /* ── DESKTOP: full week grid (identique au planning principal) ── */
        <div style={{ flex:1, overflow:'auto' }}>
          <div style={{ display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', minWidth:900 }}>
            {/* Sticky header */}
            <div style={{ position:'sticky', top:0, gridColumn:'1/-1', display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', zIndex:50, background:'var(--soil,#1c2b1a)' }}>
              <div style={{ height:40 }} />
              {DAYS.map((d,i) => {
                const day     = addDays(monday,i)
                const isToday = toDateKey(day) === toDateKey(new Date())
                return (
                  <div key={d} style={{ height:40, display:'flex', alignItems:'center', justifyContent:'center',
                    fontSize:'.8rem', fontWeight:700,
                    color: isToday ? 'var(--sprout,#a8d4a0)' : 'rgba(255,255,255,.88)',
                    borderLeft:'1px solid rgba(255,255,255,.12)',
                    background: isToday ? 'rgba(255,255,255,.08)' : 'transparent' }}>
                    {d} {day.getDate()}
                  </div>
                )
              })}
            </div>

            {/* Bande "Sans horaire" : chargements existants sans créneau — à glisser sur la grille */}
            {weekHasSansHoraire && (
              <div style={{ display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', gridColumn:'1/-1', background:'var(--amber-pale,#fdf6e9)' }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', paddingRight:6, fontSize:'.6rem', fontWeight:700, color:'var(--amber,#c47c1a)', textAlign:'right' }}>Sans horaire</div>
                {DAYS.map((_d, dayIdx) => {
                  const dateKey = toDateKey(addDays(monday, dayIdx))
                  const list = displaySansHoraire[dateKey] || []
                  return (
                    <div key={dayIdx} style={{ borderLeft:'1px solid var(--straw,#e8e4d6)', borderBottom:'1px solid var(--straw,#e8e4d6)', padding:'2px 3px', minHeight: list.length ? 0 : 20 }}>
                      {list.map(it => (
                        <div key={it.id} style={{ position:'relative', height:34, marginBottom:2 }}>
                          {renderCard(it, dateKey, null)}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}

            {/* Time slots: 00h15 → 00h00 every 15min (chargements MC CAIN, journée complète) */}
            {Array.from({ length:96 }).map((_,idx) => {
              const totalMin = 15 + idx*15
              const h = Math.floor(totalMin/60) % 24, m = totalMin%60
              const slot    = toSlot(h,m)
              const isHour  = m === 0
              const isHalf  = m === 30
              return (
                <div key={slot} style={{ display:'grid', gridTemplateColumns:'56px repeat(7,1fr)', gridColumn:'1/-1' }}>
                  <div style={{ height:26, display:'flex', alignItems:'flex-start', justifyContent:'flex-end',
                    paddingRight:6, fontSize:'.64rem', fontWeight: isHour ? 700 : 500, color: isHour ? 'var(--fog,#8a9a82)' : '#b9b39c',
                    borderBottom: isHour ? '1px solid var(--straw,#e8e4d6)' : isHalf ? '1px solid #ecead5' : '1px dashed #e0ddd4',
                    background:'var(--field,#f2f0e8)' }}>
                    {isHour || isHalf ? slot : ''}
                  </div>
                  {DAYS.map((_d,dayIdx) => {
                    const dateKey = toDateKey(addDays(monday,dayIdx))
                    const realIt  = itemsMap[dateKey]?.[slot]
                    const it      = displayItemsMap[dateKey]?.[slot]
                    const isOver  = isDropTarget(dateKey,slot)
                    return (
                      <div key={dayIdx} data-date={dateKey} data-slot={slot}
                        onClick={() => !readOnly && !dragging && !realIt && (clipboard ? pasteAt(dateKey, slot) : openNew(dateKey, slot))}
                        title={!it && realIt ? 'Masqué par le filtre lieu' : clipboard && !realIt ? '📋 Coller ici' : undefined}
                        style={{ height:26, position:'relative', cursor: readOnly ? 'default' : dragging ? 'copy' : 'pointer',
                          borderBottom: isHour ? '1px solid var(--straw,#e8e4d6)' : isHalf ? '1px solid #ecead5' : '1px dashed #e0ddd4',
                          borderLeft:'1px solid var(--straw,#e8e4d6)',
                          background: isOver && !it ? 'rgba(61,122,66,.12)' :
                                      isOver && it  ? 'rgba(192,57,43,.08)' :
                                      !it && realIt ? 'repeating-linear-gradient(45deg, rgba(0,0,0,.03), rgba(0,0,0,.03) 4px, transparent 4px, transparent 8px)' :
                                      clipboard && !realIt ? 'rgba(61,122,66,.06)' : 'transparent',
                          outline: isOver ? `2px solid ${it ? '#c0392b' : 'var(--leaf,#3d7a42)'}` : 'none',
                          outlineOffset:-2, transition:'background .1s' }}
                        onMouseEnter={e => { if(!it && !realIt && !dragging) e.currentTarget.style.background='var(--green-pale,#eaf5ea)' }}
                        onMouseLeave={e => { if(!it && !isOver) e.currentTarget.style.background='' }}>
                        {it && renderCard(it, dateKey, slot)}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Modal chargement */}
      {modalOpen && editing && (
        <ChargementModal editing={editing} setEditing={setEditing} clients={clients} lieux={lieux}
          onNewLieu={openLieuModal} onSave={save} onDelete={remove}
          onClose={() => setModalOpen(false)} />
      )}

      {/* Lieu modal */}
      {lieuModal && (
        <LieuModal newLieu={newLieu} setNewLieu={setNewLieu} onSave={saveLieu} onClose={() => setLieuModal(false)} />
      )}

      {/* Zone imprimable — invisible à l'écran, seule visible sur le document
          imprimé/PDF (voir .print-area dans index.css). */}
      <div className="print-area" style={{ fontFamily: 'Arial, sans-serif', padding: 18, color: '#1a2e1c', fontSize: 15 }}>
        <div style={{ marginBottom: 2 }} dangerouslySetInnerHTML={{ __html: printLogoHtml() }} />
        <div style={{ color: '#666', marginBottom: 6, fontSize: 13 }}>
          {printWeekLieuLabel !== pdfLieuOptions[0].label ? 'Chargement : ' + printWeekLieuLabel : 'Planning complet'}
        </div>
        <h1 style={{ fontSize: 19, borderBottom: '2px solid #4a9050', paddingBottom: 5, marginBottom: 12 }}>Semaine du {formatWeekLabel(monday)}</h1>
        {printWeekDays.length === 0 ? (
          <div style={{ color: '#999', fontStyle: 'italic' }}>Aucun chargement cette semaine.</div>
        ) : printWeekDays.map(day => (
          <div key={day.label + day.dayNum} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#4a9050', marginBottom: 4 }}>{day.label} {day.dayNum}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '9%' }} /><col style={{ width: '15%' }} /><col style={{ width: '12%' }} /><col style={{ width: '12%' }} />
                <col style={{ width: '14%' }} /><col style={{ width: '5%' }} /><col style={{ width: '16%' }} /><col style={{ width: '17%' }} />
              </colgroup>
              <thead>
                <tr>
                  {['Heure', 'Client', 'Variété', 'Type', 'Lieu'].map(h => (
                    <th key={h} style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, background: '#e8f5e9', fontWeight: 700, textAlign: 'left' }}>{h}</th>
                  ))}
                  <th style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 9, textAlign: 'center', background: '#e8f5e9', fontWeight: 700 }}>GPS</th>
                  <th style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, background: '#e8f5e9', fontWeight: 700, textAlign: 'left', whiteSpace: 'nowrap' }}>Téléphone</th>
                  <th style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, background: '#e8f5e9', fontWeight: 700, textAlign: 'left' }}>Email</th>
                </tr>
              </thead>
              <tbody>
                {day.items.map((it, ii) => {
                  const lieuReg = lieux.find(l => l.id === it.lieu_chargement_id)
                  const lieuNom = lieuReg?.nom || it.lieu_chargement_manuel || '—'
                  // Colonne GPS volontairement compacte : juste une icône cliquable par point
                  // (peu importe la taille, seul l'accès au lien compte) pour laisser plus de
                  // place — et donc une police plus grande — aux autres colonnes.
                  const gpsPoints = it.gps_points || []
                  return (
                    <tr key={it.id || ii}>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}>{it.time_slot || '—'}</td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}><strong>{it.client_nom || '—'}</strong></td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}>{it.variete || '—'}</td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}>{it.type_chargement || '—'}</td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}>{lieuNom}</td>
                      <td style={{ padding: '4px 2px', border: '1px solid #dde8de', fontSize: 9, textAlign: 'center' }}>
                        {gpsPoints.length ? gpsPoints.map((p, pi) => {
                          const link = pointLink(p)
                          if (!link) return null
                          const title = [p.label, p.lat != null && p.lng != null ? `${p.lat}, ${p.lng}` : null].filter(Boolean).join(' : ')
                          return <a key={pi} href={link} title={title} style={{ color: '#2471a3', textDecoration: 'none' }}>🗺️</a>
                        }) : '—'}
                      </td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 13, wordWrap: 'break-word', lineHeight: 1.3, whiteSpace: 'nowrap' }}>{lieuReg?.contact_telephone || '—'}</td>
                      <td style={{ padding: '4px 6px', border: '1px solid #dde8de', fontSize: 16, wordWrap: 'break-word', lineHeight: 1.3 }}>{lieuReg?.contact_email || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
        <div style={{ marginTop: 14, fontSize: 9, color: '#aaa', borderTop: '1px solid #dde8de', paddingTop: 6, textAlign: 'center' }}>
          Document généré le {new Date().toLocaleDateString('fr-FR')}
        </div>
      </div>
    </div>
  )
}

/* Édition rapide du prix pour une confirmation issue d'un RDV du planning normal —
   volontairement minimal (pas de suppression, pas d'autres champs) : l'édition complète
   du RDV (tonnage, immatriculation, date/heure…) reste dans l'onglet Planning. */
function PriceEditModal({ item, onSave, onClose }) {
  const [negociant, setNegociant] = useState(item.negociant || '')
  const [prixHt, setPrixHt] = useState(item.prix_ht ?? '')
  const [observation, setObservation] = useState(item.observation || '')
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-hdr"><h3>💰 Prix — {item.client_nom}</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body" style={{ display:'grid', gap:'.8rem' }}>
          <div style={{ fontSize:'.8rem', color:'var(--text-muted)' }}>
            RDV du planning — {fmtDate(item.date)}{item.variete ? ` · ${item.variete}` : ''}{item.type_chargement ? ` · ${item.type_chargement}` : ''}
          </div>
          <div className="form-group"><label>Négociant (🔒 interne uniquement)</label>
            <input value={negociant} onChange={e=>setNegociant(e.target.value)} placeholder="Nom du négociant" /></div>
          <div className="form-group"><label>Prix HT €/T (🔒 interne uniquement)</label>
            <input type="number" value={prixHt} onChange={e=>setPrixHt(e.target.value)} /></div>
          <div className="form-group"><label>Observations</label>
            <textarea rows={3} value={observation} onChange={e=>setObservation(e.target.value)}
              placeholder="Commentaire visible sur la confirmation imprimée…"
              style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} /></div>
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={() => onSave(negociant, prixHt, observation)}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}

/* ════════════════ CONFIRMATIONS D'ACHAT (liste, toutes semaines) ════════════════
   Uniquement les RDV du planning normal marqués avec un lieu de chargement extérieur
   (planning_rdv) — tonnage / immatriculation / nb de camions / calibre remontent
   automatiquement. Les chargements MC CAIN (planning_externe) n'en ont pas besoin.
   Ajouter le prix à la tonne après coup, et réimprimer à tout moment avec ou sans prix. */
function ConfirmationsAchatTab({ showToast }) {
  const [items, setItems]     = useState([])
  const [lieux, setLieux]     = useState([])
  const [clients, setClients] = useState([])
  const [q, setQ]             = useState('')
  const [priceFilter, setPriceFilter] = useState('ALL') // ALL | SET | UNSET
  const [priceEditing, setPriceEditing] = useState(null)
  const [confirmItem, setConfirmItem] = useState(null)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    const [{ data: rdvAll }, { data: lieuxData }, { data: clientsData }] = await Promise.all([
      supabase.from('planning_rdv').select('*').order('date', { ascending: false }),
      supabase.from('lieux_chargement').select('*').order('nom'),
      supabase.from('clients').select('*').order('nom'),
    ])
    // Un RDV validé (camion chargé/confirmé) n'a plus besoin d'une confirmation d'achat en attente.
    const rdvExternal = (rdvAll || []).filter(r => (r.lieu_chargement_id || r.lieu_chargement_manuel?.trim()) && !r.valide)
    setItems(rdvExternal.sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    setLieux(lieuxData || [])
    setClients(clientsData || [])
  }

  async function savePriceRdv(negociant, prixHt, observation) {
    const payload = { negociant: negociant?.trim() || null, prix_ht: prixHt === '' ? null : parseFloat(prixHt), observation: observation?.trim() || null }
    const { error } = await supabase.from('planning_rdv').update(payload).eq('id', priceEditing.id)
    if (error) { alert(error.message); return }
    setItems(prev => prev.map(i => i.id === priceEditing.id ? { ...i, ...payload } : i))
    setPriceEditing(null)
    showToast('✅ Prix mis à jour')
  }

  const filtered = items.filter(it => {
    if (q.trim() && !`${it.client_nom||''} ${it.ref_chargement||''} ${it.variete||''}`.toLowerCase().includes(q.trim().toLowerCase())) return false
    if (priceFilter === 'SET' && !it.prix_ht) return false
    if (priceFilter === 'UNSET' && it.prix_ht) return false
    return true
  })

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding:'.7rem 1.2rem', background:'var(--green-deep)', display:'flex', alignItems:'center', gap:'.6rem', flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍 Client, réf., variété…" value={q} onChange={e=>setQ(e.target.value)}
          style={{ ...navInputStyle, width:240 }} />
        <select value={priceFilter} onChange={e=>setPriceFilter(e.target.value)}
          style={{ fontSize:'.76rem', padding:'.38rem .6rem', borderRadius:7, border:'1.5px solid rgba(255,255,255,.3)', background:'rgba(255,255,255,.1)', color:'white' }}>
          <option value="ALL" style={{ color:'#1a2e1c' }}>Toutes</option>
          <option value="SET" style={{ color:'#1a2e1c' }}>✅ Prix renseigné</option>
          <option value="UNSET" style={{ color:'#1a2e1c' }}>⚠️ Prix non renseigné</option>
        </select>
        <span style={{ marginLeft:'auto', color:'rgba(255,255,255,.7)', fontSize:'.78rem' }}>{filtered.length} confirmation{filtered.length>1?'s':''}</span>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'1.2rem' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)' }}>Aucune confirmation d'achat.</div>
        ) : (
          <div style={{ display:'grid', gap:'.6rem' }}>
            {filtered.map(it => {
              const lieu = resolveLieu(it, lieux)
              const hasPrice = !!it.prix_ht
              return (
                <div key={it.id} style={{ background:'white', border:'1px solid var(--border)', borderRadius:10, padding:'.8rem 1rem', display:'flex', alignItems:'center', gap:'1rem', flexWrap:'wrap' }}>
                  <div style={{ minWidth:100, fontSize:'.78rem', color:'var(--text-muted)' }}>{fmtDate(it.date)}</div>
                  <div style={{ flex:1, minWidth:160 }}>
                    <div style={{ fontWeight:700 }}>{it.client_nom}</div>
                    <div style={{ fontSize:'.78rem', color:'var(--text-muted)' }}>
                      {it.variete}{it.type_chargement ? ` — ${it.type_chargement}` : ''}{lieu ? ` · 📍 ${lieu.nom}` : ''}
                      {it.tonnage ? ` · ${it.tonnage} T` : ''}{it.nb_camions ? ` · ${it.nb_camions} camion${it.nb_camions>1?'s':''}` : ''}{it.immatriculation ? ` · ${it.immatriculation}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize:'.76rem', fontWeight:700, padding:'.25rem .7rem', borderRadius:50, background: hasPrice ? '#e8f5e9' : 'var(--amber-pale)', color: hasPrice ? 'var(--green-mid)' : 'var(--amber)' }}>
                    {hasPrice ? `✅ ${it.prix_ht} €/T` : '⚠️ Prix non renseigné'}
                  </div>
                  <button className="btn-sm" onClick={() => setPriceEditing(it)}>✏️ Prix / détails</button>
                  <button className="btn-sm" onClick={() => setConfirmItem({ ...it, ...resolveClientAddress(it, clients), lieu })}>🖨️ Confirmation</button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {priceEditing && (
        <PriceEditModal item={priceEditing} onSave={savePriceRdv} onClose={() => setPriceEditing(null)} />
      )}

      {confirmItem && (
        <ConfirmationAchat item={confirmItem} onClose={() => setConfirmItem(null)} />
      )}
    </div>
  )
}

const MONTH_LABEL = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']

/* ════════════════ RÉCAP MC CAIN ════════════════
   Nombre de camions, tonnage total et prix moyen par variété, groupés par mois — à partir de
   tous les chargements MC CAIN (planning_externe), toutes semaines confondues. */
function RecapMcCainTab() {
  const [rows, setRows] = useState([])
  const [year, setYear] = useState('ALL')

  useEffect(() => { load() }, [])

  async function load() {
    const { data } = await supabase.from('planning_externe').select('date,variete,tonnage,prix_ht').order('date', { ascending: false })
    setRows(data || [])
  }

  const years = [...new Set(rows.map(r => (r.date || '').slice(0, 4)).filter(Boolean))].sort((a, b) => b.localeCompare(a))
  const filtered = year === 'ALL' ? rows : rows.filter(r => (r.date || '').startsWith(year))

  // Regroupe par mois (YYYY-MM), puis par variété à l'intérieur de chaque mois
  const byMonth = {}
  filtered.forEach(r => {
    if (!r.date) return
    const monthKey = r.date.slice(0, 7)
    if (!byMonth[monthKey]) byMonth[monthKey] = {}
    const v = r.variete?.trim() || '(non renseignée)'
    if (!byMonth[monthKey][v]) byMonth[monthKey][v] = { nbCamions: 0, tonnage: 0, prixSum: 0, prixCount: 0 }
    const g = byMonth[monthKey][v]
    g.nbCamions += 1
    if (r.tonnage != null) g.tonnage += r.tonnage
    if (r.prix_ht != null) { g.prixSum += r.prix_ht; g.prixCount += 1 }
  })
  const monthKeys = Object.keys(byMonth).sort((a, b) => b.localeCompare(a))

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number)
    return `${MONTH_LABEL[m - 1]} ${y}`
  }
  function monthTotal(varieties) {
    return Object.values(varieties).reduce((acc, g) => {
      acc.nbCamions += g.nbCamions
      acc.tonnage += g.tonnage
      acc.prixSum += g.prixSum
      acc.prixCount += g.prixCount
      return acc
    }, { nbCamions: 0, tonnage: 0, prixSum: 0, prixCount: 0 })
  }
  const th = { padding: '.6rem .9rem', background: 'var(--cream)', textAlign: 'left', fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }
  const td = { padding: '.55rem .9rem', borderBottom: '1px solid var(--border)', fontSize: '.85rem' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ padding: '.7rem 1.2rem', background: 'var(--green-deep)', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <span style={{ color: 'white', fontSize: '.82rem', fontWeight: 600 }}>📊 Récapitulatif MC CAIN — par mois et par variété</span>
        <select value={year} onChange={e => setYear(e.target.value)}
          style={{ marginLeft: 'auto', fontSize: '.76rem', padding: '.35rem .6rem', borderRadius: 7, border: '1.5px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.1)', color: 'white' }}>
          <option value="ALL" style={{ color: '#1a2e1c' }}>Toutes les années</option>
          {years.map(y => <option key={y} value={y} style={{ color: '#1a2e1c' }}>{y}</option>)}
        </select>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem' }}>
        {monthKeys.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Aucun chargement MC CAIN enregistré.</div>
        ) : (
          <div style={{ display: 'grid', gap: '1.4rem' }}>
            {monthKeys.map(monthKey => {
              const varieties = byMonth[monthKey]
              const varietyKeys = Object.keys(varieties).sort((a, b) => a.localeCompare(b))
              const total = monthTotal(varieties)
              return (
                <div key={monthKey} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ padding: '.7rem 1rem', background: 'var(--soil,#1c2b1a)', color: 'white', fontWeight: 700, fontSize: '.88rem', textTransform: 'capitalize' }}>
                    {monthLabel(monthKey)}
                  </div>
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Variété</th>
                      <th style={th}>Nb camions</th>
                      <th style={th}>Tonnage total</th>
                      <th style={th}>Prix moyen</th>
                    </tr></thead>
                    <tbody>
                      {varietyKeys.map(v => {
                        const g = varieties[v]
                        return (
                          <tr key={v}>
                            <td style={td}>{v}</td>
                            <td style={td}>{g.nbCamions}</td>
                            <td style={td}>{g.tonnage ? `${g.tonnage.toFixed(2)} T` : '—'}</td>
                            <td style={td}>{g.prixCount ? `${(g.prixSum / g.prixCount).toFixed(2)} €/T` : '—'}</td>
                          </tr>
                        )
                      })}
                      <tr style={{ background: 'var(--green-pale,#eaf5ea)', fontWeight: 700 }}>
                        <td style={td}>Total {monthLabel(monthKey).toLowerCase()}</td>
                        <td style={td}>{total.nbCamions}</td>
                        <td style={td}>{total.tonnage ? `${total.tonnage.toFixed(2)} T` : '—'}</td>
                        <td style={td}>{total.prixCount ? `${(total.prixSum / total.prixCount).toFixed(2)} €/T` : '—'}</td>
                      </tr>
                    </tbody>
                  </table>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/* ════ Confirmation d'achat imprimable ════
   Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
   plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
   popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
   toujours le vrai dialogue d'impression natif — celui qui propose
   "Enregistrer en PDF" et le partage par mail/WhatsApp. */
function itemLot(item) {
  if (Array.isArray(item.varietes) && item.varietes.length) {
    return item.varietes.map(v => v.lot).filter(Boolean).join(', ')
  }
  return item.lot || ''
}

// Numéro de confirmation basé sur la réf. de chargement : uniquement les chiffres,
// sauf pour le client Pom'Prim où la référence est reprise telle quelle.
function confirmationNumero(item) {
  const ref = (item.ref_chargement || '').trim()
  if (!ref) return ''
  const isPomPrim = (item.client_nom || '').toLowerCase().replace(/['\s]/g, '').includes('pomprim')
  if (isPomPrim) return ref
  const digits = ref.replace(/\D+/g, '')
  return digits || ref
}

function ConfirmationAchat({ item, onClose }) {
  const { canSeePrix } = useAuth()
  const [printWithPrix, setPrintWithPrix] = useState(null) // null = pas d'impression en cours

  useEffect(() => {
    if (printWithPrix === null) return
    document.body.classList.add('printing-active')
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrintWithPrix(null)
    }
    window.addEventListener('afterprint', onAfterPrint)
    // Laisse le temps au contenu conditionnel (ligne prix) de se peindre avant le dialogue natif.
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printWithPrix])

  function printDoc(withPrix) { setPrintWithPrix(withPrix) }

  const lieu = item.lieu?.nom || ''
  const withPrix = !!printWithPrix

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 520 }}>
        <div className="modal-hdr"><h3>🖨️ Confirmation d'achat</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ background: 'var(--cream)', borderRadius: 10, padding: '1rem 1.2rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '.5rem' }}>{item.client_nom}</div>
            {formatClientAddress(item) && <div style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>{formatClientAddress(item)}</div>}
          </div>
          <table style={{ width: '100%', fontSize: '.85rem', borderCollapse: 'collapse' }}>
            {[
              ['Date', item.date],
              ['Lieu de chargement', item.lieu?.nom || '—'],
              ['Variété', item.variete],
              ['Lot', itemLot(item)],
              ['Type de chargement', item.type_chargement],
              ['Calibre', item.calibre],
              ['Tonnage', item.tonnage ? `${item.tonnage} T` : ''],
              ['Nombre de camions', item.nb_camions],
              ['Immatriculation', item.immatriculation],
              ['Réf. chargement', item.ref_chargement],
              ...(canSeePrix ? [['Négociant (interne)', item.negociant]] : []),
              ['Observation', item.observation],
            ].filter(([,v]) => v).map(([k,v]) => (
              <tr key={k}><td style={{ padding: '.5rem .7rem', fontWeight: 600, background: 'var(--cream)', border: '1px solid var(--border)', width: '40%' }}>{k}</td>
                <td style={{ padding: '.5rem .7rem', border: '1px solid var(--border)' }}>{v}</td></tr>
            ))}
          </table>

          {canSeePrix && (
            <div style={{ marginTop: '1.2rem', padding: '.8rem 1rem', background: 'var(--amber-pale)', borderRadius: 8, fontSize: '.85rem', fontWeight: 500 }}>
              Prix HT : {item.prix_ht ? item.prix_ht + ' €/T' : 'non renseigné'} — <em>inclus uniquement dans la version imprimée « avec prix »</em>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>Fermer</button>
          <button className="btn-sm" onClick={() => printDoc(false)}>🖨️ Imprimer sans prix</button>
          {canSeePrix && (
            <button className="btn-sm primary" onClick={() => printDoc(true)}>🖨️ Imprimer avec prix (interne)</button>
          )}
        </div>
      </div>

      {/* Zone imprimable — invisible à l'écran, seule visible sur le document
          imprimé/PDF (voir .print-area dans index.css). */}
      <div className="print-area" style={{ fontFamily: 'Arial, sans-serif', padding: 22, color: '#1a2e1c' }}>
        <div style={{ color: '#4a9050', fontSize: 22, fontWeight: 'bold', marginBottom: 2 }} dangerouslySetInnerHTML={{ __html: printLogoHtml() }} />
        <div style={{ color: '#666', marginBottom: 14, fontSize: 12 }}>Confirmation d'achat {withPrix ? '— Usage interne' : ''}</div>
        <h1 style={{ fontSize: 18, borderBottom: '2px solid #4a9050', paddingBottom: 5 }}>N° {confirmationNumero(item) || '—'}</h1>
        <table style={{ width: '100%', borderCollapse: 'collapse', margin: '12px 0' }}>
          <tbody>
            {[
              ['Date de chargement', item.date || '—'],
              ['Client', <strong key="c">{item.client_nom || '—'}</strong>],
              ...(formatClientAddress(item) ? [['Adresse', formatClientAddress(item)]] : []),
              ['Lieu de chargement', lieu || '—'],
              ['Variété', item.variete || '—'],
              ...(itemLot(item) ? [['Lot', itemLot(item)]] : []),
              ['Type de chargement', item.type_chargement || '—'],
              ...(item.calibre ? [['Calibre', item.calibre]] : []),
              ...(item.tonnage ? [['Tonnage', `${item.tonnage} T`]] : []),
              ...(item.nb_camions ? [['Nombre de camions', item.nb_camions]] : []),
              ...(item.immatriculation ? [['Immatriculation', item.immatriculation]] : []),
              ['Référence', item.ref_chargement || '—'],
              ...(item.observation ? [['Observations', item.observation]] : []),
            ].map(([k, v]) => (
              <tr key={k}>
                <th style={{ padding: '5px 10px', border: '1px solid #dde8de', fontSize: 12, background: '#e8f5e9', fontWeight: 600, width: '40%', textAlign: 'left' }}>{k}</th>
                <td style={{ padding: '5px 10px', border: '1px solid #dde8de', fontSize: 12 }}>{v}</td>
              </tr>
            ))}
            {withPrix && (
              <tr>
                <th style={{ padding: '5px 10px', border: '1px solid #dde8de', fontSize: 12, background: '#e8f5e9', fontWeight: 600, width: '40%', textAlign: 'left' }}>Prix HT (€/T)</th>
                <td style={{ padding: '5px 10px', border: '1px solid #dde8de', fontSize: 12 }}><strong>{item.prix_ht || '—'} €/T</strong></td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{ marginTop: 14, padding: '9px 12px', border: '1.5px solid #4a9050', borderRadius: 8, fontSize: 11.5, background: '#f3f9f3' }}>
          <div style={{ fontWeight: 700, marginBottom: 5 }}>Expéditeur : SARL Ropamil + tampon</div>
          <div>Faire un document d'accompagnement pour chaque camion</div>
          <div>Merci de mailer chaque CMR à ropamil@ropamil.fr une fois le chargement effectué.</div>
        </div>
        <div style={{ marginTop: 14, fontSize: 10, color: '#888', borderTop: '1px solid #dde8de', paddingTop: 7 }}>
          Document généré le {new Date().toLocaleDateString('fr-FR')}{withPrix ? ' — DOCUMENT INTERNE CONFIDENTIEL' : ''}
        </div>
      </div>
    </div>
  )
}


/* ════════════════ SORTIES CAMION (read-only list for now) ════════════════ */
function SortiesCamion() {
  const [rdvs, setRdvs] = useState([])
  useEffect(() => {
    supabase.from('planning_rdv').select('*').order('date', { ascending: false }).limit(100)
      .then(({ data }) => setRdvs(data || []))
  }, [])

  return (
    <div style={{ padding: '1.5rem', overflow: 'auto', flex: 1 }}>
      <h3 style={{ marginBottom: '1rem' }}>Historique des sorties</h3>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        <table style={{ width: '100%', minWidth: 560, fontSize: '.85rem' }}>
          <thead style={{ background: 'var(--cream)' }}>
            <tr>
              <th style={th}>Date</th><th style={th}>Heure</th><th style={th}>Client</th>
              <th style={th}>Variété</th><th style={th}>Chargement</th><th style={th}>Camions</th>
            </tr>
          </thead>
          <tbody>
            {rdvs.map(r => (
              <tr key={r.id}>
                <td style={td}>{fmtDate(r.date)}</td><td style={td}>{r.time_slot}</td><td style={td}>{r.client_nom}</td>
                <td style={td}>{r.variete}</td><td style={td}>{r.type_chargement}</td><td style={td}>{r.nb_camions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
const th = { padding: '.7rem 1rem', textAlign: 'left', fontSize: '.75rem', fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }
const td = { padding: '.6rem 1rem', borderBottom: '1px solid var(--border)' }
