import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import useIsMobile from '../lib/useIsMobile'

const PALETTE = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a']
let tableMissingAlerted = false // évite de répéter l'alerte migration_23 pour chaque case dans la boucle d'insertion
// Couleur stable par prévision palox (une couleur différente par RDV/client, dérivée de
// son id — reste la même à chaque rechargement, contrairement à un tirage aléatoire).
const PREVISION_PALETTE = ['#e74c3c','#3498db','#e67e22','#9b59b6','#1abc9c','#e91e63','#f1c40f','#16a085','#8e44ad','#2980b9','#d35400','#27ae60']
function previsionColor(id) {
  let hash = 0
  const s = String(id)
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return PREVISION_PALETTE[hash % PREVISION_PALETTE.length]
}
// Groupe des fiches de lot par variété (triée A→Z), lots triés A→Z à l'intérieur de
// chaque groupe — pour s'y retrouver facilement dès qu'il y a beaucoup de fiches.
function groupFichesByVariety(fiches) {
  const byVariety = fiches.reduce((acc, f) => {
    const v = (f.variety || '').trim() || '(Sans variété)'
    ;(acc[v] ??= []).push(f)
    return acc
  }, {})
  return Object.entries(byVariety)
    .sort(([a], [b]) => a.localeCompare(b, 'fr'))
    .map(([variety, group]) => [variety, group.slice().sort((a, b) => (a.lot || '').localeCompare(b.lot || '', 'fr'))])
}
const ROW_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const CELL_W = 110
// Un palox vu de face est plus large que haut — les cases sont donc des
// rectangles "paysage" (hauteur = largeur × CELL_RATIO), pas des carrés.
const CELL_RATIO = 0.5

/* ── Grille "en escalier" : chaque colonne a sa propre hauteur (col_heights),
   au lieu d'un rows/cols uniforme. Cases numérotées de bas en haut (rangée 1
   = au sol) pour coller à la réalité physique d'un frigo. ── */
function getColHeights(frigo) {
  if (Array.isArray(frigo?.col_heights) && frigo.col_heights.length) return frigo.col_heights
  return Array.from({ length: frigo?.cols || 1 }, () => frigo?.rows || 1)
}
function cellSlotHasData(frigo, cellId) {
  return !!frigo.cells[cellId] || !!frigo.cells[`${cellId}_L`] || !!frigo.cells[`${cellId}_R`]
}

/* ── Plan libre : chaque case a une position (x, y) en unités abstraites, une
   rotation (0 ou 90°) et un drapeau demi-case. Persisté dans cells_layout
   (jsonb) sous forme d'objets { k, x, y, r, h } — k est l'identifiant stable
   de la case (il ne change pas quand on la déplace, les palox rangés suivent
   donc leur case). Les anciens formats — grille "col:row[:h]" ou col_heights —
   sont convertis à la volée en conservant la même forme et les mêmes
   identifiants (k = lettre de rangée + n° de colonne). ── */
const UNIT_W = 100                    // largeur d'une case standard, en unités
const UNIT_H = UNIT_W * CELL_RATIO    // hauteur d'une case standard
const UGAP = 6                        // espace entre deux cases posées bord à bord
const SNAP = 5                        // aimantation du déplacement libre

function toFreeLayout(frigo) {
  const raw = Array.isArray(frigo?.cells_layout) ? frigo.cells_layout : null
  if (raw && raw.length && typeof raw[0] === 'object') {
    return raw.map(c => ({ r: 0, h: false, ...c }))
  }
  let slots
  if (raw && raw.length) {
    slots = raw.map(key => { const [c, r, h] = String(key).split(':'); return { col: +c, row: +r, h: h === 'h' } })
  } else {
    slots = []
    getColHeights(frigo).forEach((hh, i) => { for (let r = 1; r <= hh; r++) slots.push({ col: i + 1, row: r, h: false }) })
  }
  const maxRow = Math.max(...slots.map(s => s.row))
  return slots.map(({ col, row, h }) => ({
    k: `${ROW_LETTERS[(row - 1) % 26]}${col}`,
    x: (col - 1) * (UNIT_W + UGAP),
    y: (maxRow - row) * (UNIT_H + UGAP),
    r: 0,
    h,
  }))
}
// Encombrement d'une case : toutes les cases dérivent de la même taille standard
// (UNIT_W × UNIT_H) — plus de cw/ch personnalisés au cas par cas. Le bouton ↻
// (changer le sens) reste utile : il permute largeur/hauteur (portrait ↔ paysage)
// au lieu de doubler la hauteur comme avant, pour rester dans une taille standard.
// Une demi-case (scission d'un emplacement en deux lots) reste deux fois plus étroite.
function cellDims(cell) {
  let w = UNIT_W, h = UNIT_H
  if (cell.r === 90) { w = UNIT_H; h = UNIT_W }
  if (cell.h) w = (w - UGAP) / 2
  return { w, h }
}
function layoutBbox(cells) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const c of cells) {
    const d = cellDims(c)
    minX = Math.min(minX, c.x); minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + d.w); maxY = Math.max(maxY, c.y + d.h)
  }
  if (!cells.length) { minX = 0; minY = 0; maxX = UNIT_W; maxY = UNIT_H }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}
const rectsOverlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
// Emplacements "+" : une place de case standard collée à chaque côté libre
function ghostSpots(cells) {
  const spots = []
  for (const c of cells) {
    const d = cellDims(c)
    for (const s of [
      { x: c.x + d.w + UGAP, y: c.y },
      { x: c.x - UNIT_W - UGAP, y: c.y },
      { x: c.x, y: c.y - UNIT_H - UGAP },
      { x: c.x, y: c.y + d.h + UGAP },
    ]) {
      const rect = { ...s, w: UNIT_W, h: UNIT_H }
      if (cells.some(o => rectsOverlap(rect, { x: o.x, y: o.y, ...cellDims(o) }))) continue
      if (spots.some(o => rectsOverlap(rect, { x: o.x, y: o.y, w: UNIT_W, h: UNIT_H }))) continue
      spots.push(s)
    }
  }
  return spots
}
// Premier identifiant de case libre (même style que les anciens : lettre + numéro)
function nextKey(cells) {
  const used = new Set(cells.map(c => c.k))
  for (let n = 1; n < 1000; n++) {
    for (const L of ROW_LETTERS) {
      const k = `${L}${n}`
      if (!used.has(k)) return k
    }
  }
  return `X${Date.now() % 100000}`
}

export default function Frigos({ identifiantFrigo } = {}) {
  const { showToast, ToastEl } = useToast()
  const { user, isAdmin, perms } = useAuth()
  // Rôle "Pont bascule" : consultation uniquement, jamais de modification (lots,
  // cases, forme des frigos…).
  const readOnly = !!perms.frigosReadOnly
  const canCreerFrigo = !perms.frigosNoNouveauFrigo && !readOnly
  const isMobile = useIsMobile()

  const [profiles, setProfiles] = useState([])
  const profileById = Object.fromEntries(profiles.map(p => [p.id, p]))

  const [frigos, setFrigos] = useState({})         // { id: {id,name,cols,rows,cells:{}} }
  const [activeFrigoId, setActiveFrigoId] = useState(null)
  const [previsions, setPrevisions] = useState([]) // RDV planning avec une prévision palox active (non validée)
  const [fiches, setFiches] = useState([])
  const [view, setView] = useState('grille')        // 'grille' | 'recap' | 'historique'
  const [histDate, setHistDate] = useState(new Date().toISOString().split('T')[0])
  const [histCells, setHistCells] = useState(null)  // null = not loaded yet
  const [histLoading, setHistLoading] = useState(false)
  // Historique : 'journal' = chaque saisie une par une (défaut), 'etat' = instantané à une date
  const [histMode, setHistMode] = useState('journal')
  const [journal, setJournal] = useState(null)      // null = pas encore chargé

  // Multi-select state — THE CORE FIX
  const [selectedCells, setSelectedCells] = useState(new Set())
  // La sélection de cases vides ne fait plus apparaître le panneau de lots
  // immédiatement — on peut d'abord sélectionner plusieurs cases tranquillement,
  // puis valider explicitement pour faire apparaître le panneau (plein écran,
  // donc plus possible de continuer à sélectionner une fois affiché).
  const [selectionConfirmed, setSelectionConfirmed] = useState(false)
  const [deleteMode, setDeleteMode] = useState(false)
  // Mode "Modeler" : des "+" apparaissent autour de la forme pour ajouter des
  // cases une par une, et un ✕ sur les cases vides pour les retirer.
  const [modelMode, setModelMode] = useState(false)

  // Zoom de la grille : 'fit' = tout le frigo visible d'un coup (cases réduites),
  // 'zoom' = taille choisie avec 🔍+/− (noms de lots lisibles, défilement).
  const [zoomMode, setZoomMode] = useState('overview')
  const [zoomSize, setZoomSize] = useState(CELL_W)

  // Cases divisées en 2 demi-cases (palox à l'horizontale) — état d'affichage
  // seulement ; une fois qu'une demi-case est remplie, la division redevient
  // évidente à partir des données elles-mêmes au rechargement.
  const [splitCells, setSplitCells] = useState(new Set())
  async function toggleSplit(cellId) {
    const frigo = activeFrigoId ? frigos[activeFrigoId] : null
    const existing = frigo?.cells[cellId]
    if (existing) {
      // La case était pleine (un seul palox à la verticale) : on la scinde en gardant ce
      // palox dans la moitié gauche. La moitié droite reste vide — on peut soit la laisser
      // vide (un seul palox à l'horizontale) soit la remplir ensuite (deux palox).
      const newCellId = `${cellId}_L`
      const { error } = await supabase.from('cave_cells').update({ cell_id: newCellId }).eq('id', existing.id)
      if (error) { alert(error.message); return }
      setFrigos(prev => {
        const nf = { ...prev }
        const f = { ...nf[activeFrigoId], cells: { ...nf[activeFrigoId].cells } }
        delete f.cells[cellId]
        f.cells[newCellId] = { ...existing, cell_id: newCellId }
        nf[activeFrigoId] = f
        return nf
      })
      setSplitCells(prev => new Set(prev).add(cellId))
      showToast('↔️ Case divisée — palox conservé dans la moitié gauche')
      return
    }
    setSplitCells(prev => {
      const next = new Set(prev)
      next.has(cellId) ? next.delete(cellId) : next.add(cellId)
      return next
    })
  }

  // Marque/démarque une case comme "demi-case seule" (persisté dans le plan).
  // On relit le plan frais depuis la base avant de le modifier (même protection
  // que le mode Modeler contre les sessions restées ouvertes).
  async function setHalfFlag(k, half) {
    const cells = await fetchFreshLayout(activeFrigoId)
    return persistLayout(activeFrigoId, cells.map(c => c.k === k ? { ...c, h: half } : c))
  }

  // Sur une case scindée en 2 : supprime une moitié vide — il ne reste qu'une
  // demi-case seule (persistée), l'éventuel palox de l'autre moitié est conservé.
  async function keepOneHalf(cellId, k) {
    const ok = await setHalfFlag(k, true)
    if (!ok) return
    setSplitCells(prev => { const n = new Set(prev); n.delete(cellId); return n })
    setExpandedSplitCells(prev => { const n = new Set(prev); n.delete(cellId); return n })
    showToast('◧ Une seule demi-case conservée')
  }

  // Sur une demi-case seule : redevient une case entière (le palox éventuel
  // repasse sur la case complète).
  async function restoreFullCell(cellId, k) {
    const frigo = frigos[activeFrigoId]
    const half = frigo?.cells[`${cellId}_L`] || frigo?.cells[`${cellId}_R`]
    if (half) {
      const { error } = await supabase.from('cave_cells').update({ cell_id: cellId }).eq('id', half.id)
      if (error) { alert(error.message); return }
      setFrigos(prev => {
        const nf = { ...prev }
        const f = { ...nf[activeFrigoId], cells: { ...nf[activeFrigoId].cells } }
        delete f.cells[half.cell_id]
        f.cells[cellId] = { ...half, cell_id: cellId }
        nf[activeFrigoId] = f
        return nf
      })
    }
    const ok = await setHalfFlag(k, false)
    if (!ok) return
    setSplitCells(prev => { const n = new Set(prev); n.delete(cellId); return n })
    showToast('⬜ Case entière rétablie')
  }

  // Une case scindée mais avec un seul côté rempli s'affiche par défaut comme une case
  // normale (unifiée) — ce Set retient celles que l'utilisateur a choisi d'"ouvrir" pour
  // voir les deux moitiés (et pouvoir remplir la 2e).
  const [expandedSplitCells, setExpandedSplitCells] = useState(new Set())
  function toggleExpanded(cellId) {
    setExpandedSplitCells(prev => {
      const next = new Set(prev)
      next.has(cellId) ? next.delete(cellId) : next.add(cellId)
      return next
    })
  }

  // Modals
  const [frigoModalOpen, setFrigoModalOpen] = useState(false)
  const [editingFrigo, setEditingFrigo] = useState(null)
  const [ficheModalOpen, setFicheModalOpen] = useState(false)
  const [editingFiche, setEditingFiche] = useState(null)
  const [insertModalOpen, setInsertModalOpen] = useState(false)
  const [insertFiche, setInsertFiche] = useState(null)
  const [insertPalox, setInsertPalox] = useState(1)
  const [insertPoidsPalox, setInsertPoidsPalox] = useState(2)
  const [fichesModalOpen, setFichesModalOpen] = useState(false) // accès rapide "Fiches de lot" sur mobile
  const [insertOrientation, setInsertOrientation] = useState(0)

  useEffect(() => { loadAll() }, [])
  useEffect(() => { if (view === 'historique' && histMode === 'etat') loadHistorique(histDate) }, [view, histMode, histDate])
  useEffect(() => { if (view === 'historique' && histMode === 'journal' && activeFrigoId) loadJournal(activeFrigoId) }, [view, histMode, activeFrigoId])

  async function loadJournal(frigoId) {
    setJournal(null)
    const { data, error } = await supabase.from('cave_mouvements').select('*')
      .eq('frigo_id', frigoId).order('created_at', { ascending: false }).limit(500)
    setJournal(error ? { error: error.message } : (data || []))
  }

  // Suppression d'une ou plusieurs lignes du journal — réservée à Matéo (admin),
  // les autres utilisateurs ne doivent pas pouvoir effacer une saisie du fil d'audit.
  async function deleteMouvement(id) {
    if (!isAdmin) return
    if (!confirm('Supprimer cette ligne du journal ?')) return
    const { error } = await supabase.from('cave_mouvements').delete().eq('id', id)
    if (error) { alert(error.message); return }
    setJournal(prev => Array.isArray(prev) ? prev.filter(m => m.id !== id) : prev)
    showToast('🗑️ Ligne supprimée')
  }
  async function deleteMouvements(ids) {
    if (!isAdmin || !ids.length) return
    if (!confirm(`Supprimer ${ids.length} ligne(s) du journal ?`)) return
    const { error } = await supabase.from('cave_mouvements').delete().in('id', ids)
    if (error) { alert(error.message); return }
    setJournal(prev => Array.isArray(prev) ? prev.filter(m => !ids.includes(m.id)) : prev)
    showToast(`🗑️ ${ids.length} ligne(s) supprimée(s)`)
  }

  async function loadAll() {
    // Tri alphabétique naturel (A1, A2… B1, BOURGOIN 1…) — l'ordre d'insertion de
    // la map détermine aussi l'ordre du récap global et le frigo ouvert par défaut.
    const { data: frigosData } = await supabase.from('frigos').select('*')
    ;(frigosData || []).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base', numeric: true }))
    const { data: cellsData } = await supabase.from('cave_cells').select('*')
    const { data: fichesData } = await supabase.from('lot_fiches').select('*').order('created_at')
    const { data: profilesData } = await supabase.from('profiles').select('id,display_name')

    const map = {}
    ;(frigosData || []).forEach(f => { map[f.id] = { ...f, cells: {} } })
    ;(cellsData || []).forEach(c => { if (map[c.frigo_id]) map[c.frigo_id].cells[c.cell_id] = c })

    setFrigos(map)
    // Une variété enregistrée sans numéro de lot (BDD > Variétés) n'a pas sa place dans
    // la liste des fiches de lots des frigos — elle n'y correspond à rien de physique.
    setFiches((fichesData || []).filter(f => (f.lot || '').trim()))
    setProfiles(profilesData || [])

    ensureTodaySnapshot(cellsData || [])
    loadPrevisions()
  }

  // ── Prévisions palox actives (générées depuis le Planning, pas encore validées) —
  // pour les surligner directement sur la grille des frigos avec une couleur par client.
  async function loadPrevisions() {
    const { data, error } = await supabase.from('planning_rdv')
      .select('id,client_nom,date,contrat_id,palox_prevision,valide')
      .not('palox_prevision', 'is', null)
    if (error) { setPrevisions([]); return }
    const withCells = (data || []).filter(r => !r.valide && Array.isArray(r.palox_prevision?.cells) && r.palox_prevision.cells.length > 0)
    setPrevisions(withCells.map(r => ({ ...r, color: previsionColor(r.id) })))
  }

  // ── Instantané quotidien : sauvegarde l'état du jour une seule fois par jour,
  // pour pouvoir consulter plus tard "ce qu'il restait" à une date passée.
  async function ensureTodaySnapshot(cellsData) {
    const today = new Date().toISOString().split('T')[0]
    const { count } = await supabase.from('cave_snapshots').select('id', { count: 'exact', head: true }).eq('snapshot_date', today)
    if (count > 0) return
    if (!cellsData.length) return
    const rows = cellsData.map(c => ({
      snapshot_date: today, frigo_id: c.frigo_id, cell_id: c.cell_id,
      variety: c.variety, lot: c.lot, palox: c.palox, color: c.color,
    }))
    await supabase.from('cave_snapshots').upsert(rows, { onConflict: 'snapshot_date,cell_id' })
  }

  // Réécrit l'instantané du jour à partir de l'état actuel — appelé silencieusement
  // après chaque case remplie/vidée (voir confirmInsert/deleteSelectedCells), pour
  // que l'historique du jour même reste toujours à jour, pas seulement figé sur le
  // premier chargement de la page. Le bouton "Enregistrer l'état du jour" fait pareil,
  // en plus visible (toast), pour un déclenchement manuel à la demande.
  async function syncTodaySnapshot() {
    const { data: cellsData } = await supabase.from('cave_cells').select('*')
    const today = new Date().toISOString().split('T')[0]
    const rows = (cellsData || []).map(c => ({
      snapshot_date: today, frigo_id: c.frigo_id, cell_id: c.cell_id,
      variety: c.variety, lot: c.lot, palox: c.palox, color: c.color,
    }))
    if (rows.length) await supabase.from('cave_snapshots').upsert(rows, { onConflict: 'snapshot_date,cell_id' })
    if (view === 'historique' && histDate === today) loadHistorique(today)
  }

  async function saveSnapshotNow() {
    await syncTodaySnapshot()
    showToast('📸 État du jour enregistré')
  }

  // ── Journal des saisies : chaque case remplie ou vidée est enregistrée
  // individuellement dans cave_mouvements (horodatée) — l'historique montre
  // ces saisies une par une, pas seulement un état quotidien. ──
  async function logMouvements(rows) {
    if (!rows.length) return
    const withUser = rows.map(r => ({ ...r, user_id: user?.id || null, identifiant_frigo: identifiantFrigo || null }))
    let { error } = await supabase.from('cave_mouvements').insert(withUser)
    if (error && /identifiant_frigo/i.test(error.message)) {
      ;({ error } = await supabase.from('cave_mouvements').insert(withUser.map(({ identifiant_frigo, ...r }) => r)))
      if (!error) showToast('⚠️ Identité non enregistrée — exécute migration_A_EXECUTER_71.sql dans Supabase → SQL Editor.')
    }
    if (error && /user_id|column/i.test(error.message)) {
      ;({ error } = await supabase.from('cave_mouvements').insert(rows))
      if (!error) showToast('⚠️ Auteur non enregistré — exécute migration_A_EXECUTER_51.sql dans Supabase → SQL Editor.')
    }
    if (error && /does not exist|relation|could not find the table/i.test(error.message)) {
      showToast('⚠️ Table cave_mouvements manquante — exécute migration_A_EXECUTER_5.sql')
    }
  }

  async function loadHistorique(date) {
    setHistLoading(true)
    const { data } = await supabase.from('cave_snapshots').select('*').eq('snapshot_date', date)
    setHistCells(data || [])
    setHistLoading(false)
  }

  const activeFrigo = activeFrigoId ? frigos[activeFrigoId] : null

  // Prévisions palox actives concernant ce frigo (une couleur par client/RDV) + carte
  // cellId → prévision, pour surligner directement les cases visées sur la grille.
  const activePrevisions = activeFrigo
    ? previsions.filter(p => p.palox_prevision.cells.some(c => c.frigo === activeFrigo.name))
    : []
  const previsionByCellId = {}
  activePrevisions.forEach(p => {
    p.palox_prevision.cells.filter(c => c.frigo === activeFrigo?.name).forEach(c => {
      previsionByCellId[c.cell_id] = p
    })
  })

  // Adapte la taille des cases à l'espace visible, sous deux modes distincts :
  // - "fit" (⤢ Lisible) : ne descend jamais sous MIN_FIT_SIZE (le nom du lot doit
  //   rester lisible) — repasse en défilement si le frigo ne tient pas à cette taille.
  // - "overview" (🗺️ Vue d'ensemble) : aucun plancher, le frigo entier tient toujours
  //   à l'écran sans défiler, quitte à ce que le texte devienne petit/illisible.
  const MIN_FIT_SIZE = 150 // largeur mini — sous ce seuil le nom du lot n'a plus la place de s'afficher
  const MIN_OVERVIEW_SIZE = 38 // assez pour garder le nom du lot visible même très réduit
  const gridWrapRef = useRef(null)
  const [fitSize, setFitSize] = useState(null)
  const [overviewSize, setOverviewSize] = useState(null)
  useEffect(() => {
    if (view !== 'grille' || !activeFrigo) return
    const el = gridWrapRef.current
    if (!el) return
    function recompute() {
      // En mode Modeler, le plan s'agrandit d'une case fantôme de chaque côté
      // (les "+") — on en tient compte pour que tout reste visible.
      const bbox = layoutBbox(toFreeLayout(activeFrigo))
      const pad = modelMode ? (UNIT_W + UGAP) * 2 : 0
      const planW = bbox.w + pad
      const planH = bbox.h + pad
      const rect = el.getBoundingClientRect()
      const availW = rect.width - 56
      const availH = rect.height - 56
      const fitted = Math.min(CELL_W, (availW / planW) * UNIT_W, (availH / planH) * UNIT_W)
      const safeFitted = Number.isFinite(fitted) ? fitted : CELL_W
      setFitSize(Math.max(MIN_FIT_SIZE, safeFitted))
      setOverviewSize(Math.max(MIN_OVERVIEW_SIZE, safeFitted))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [view, activeFrigo, modelMode])

  // Taille de case affichée selon le mode de zoom
  const cellSize = zoomMode === 'fit' ? (fitSize || Math.max(MIN_FIT_SIZE, CELL_W))
    : zoomMode === 'overview' ? (overviewSize || Math.max(MIN_OVERVIEW_SIZE, CELL_W))
    : zoomSize
  function zoomIn() { setZoomSize(Math.min(220, cellSize + 20)); setZoomMode('zoom') }
  function zoomOut() { setZoomSize(Math.max(100, cellSize - 20)); setZoomMode('zoom') }

  // ── Cell click: toggle selection (multi-select works via Set, always re-rendering cleanly) ──
  const toggleCell = useCallback((cellId) => {
    if (deleteMode) {
      setSelectedCells(prev => {
        const next = new Set(prev)
        next.has(cellId) ? next.delete(cellId) : next.add(cellId)
        return next
      })
      return
    }
    setSelectedCells(prev => {
      const next = new Set(prev)
      next.has(cellId) ? next.delete(cellId) : next.add(cellId)
      return next
    })
  }, [deleteMode])

  function clearSelection() {
    setSelectedCells(new Set())
    setSelectionConfirmed(false)
  }

  // ── Click a fiche while cells are selected → open insertion confirmation ──
  function onFicheClick(fiche) {
    if (selectedCells.size === 0) {
      showToast('Sélectionnez d\'abord une ou plusieurs cases 🎯')
      return
    }
    setInsertFiche(fiche)
    setInsertPalox(fiche.palox || 1)
    setInsertPoidsPalox(2)
    setInsertOrientation(0)
    setInsertModalOpen(true)
  }

  // ── Confirm insert: apply the SAME fiche to ALL selected cells, then reset cleanly ──
  async function confirmInsert() {
    if (!insertFiche || selectedCells.size === 0) return
    const cellsArr = [...selectedCells]
    const frigoId = cellsArr[0].split('_')[0]
    const info = {
      variety: insertFiche.variety,
      lot: insertFiche.lot || '',
      palox: insertPalox,
      poids_palox: insertPoidsPalox,
      color: insertFiche.color,
      date: insertFiche.date || new Date().toISOString().split('T')[0],
      orientation: insertOrientation,
    }

    for (const cellId of cellsArr) {
      let { error } = await supabase.from('cave_cells').upsert(
        { cell_id: cellId, frigo_id: frigoId, ...info, updated_at: new Date().toISOString() },
        { onConflict: 'cell_id' }
      )
      if (error && /poids_palox|column/i.test(error.message)) {
        const { poids_palox, ...fallback } = info
        ;({ error } = await supabase.from('cave_cells').upsert(
          { cell_id: cellId, frigo_id: frigoId, ...fallback, updated_at: new Date().toISOString() },
          { onConflict: 'cell_id' }
        ))
        if (error) console.error(error)
        else if (!tableMissingAlerted) { tableMissingAlerted = true; alert('Colonne poids_palox manquante — exécute migration_A_EXECUTER_23.sql dans Supabase → SQL Editor pour activer le suivi 2T/1,2T.') }
        continue
      }
      if (error) { console.error(error); continue }
    }

    // Update local state for all cells at once
    setFrigos(prev => {
      const next = { ...prev }
      const f = { ...next[frigoId], cells: { ...next[frigoId].cells } }
      cellsArr.forEach(cid => { f.cells[cid] = info })
      next[frigoId] = f
      return next
    })

    // Sync to stock variety table (best-effort, ignore if table missing)
    try {
      const exists = await supabase.from('db_varietes').select('id').eq('variete', info.variety).eq('lot', info.lot || '').maybeSingle()
      if (!exists.data) {
        await supabase.from('db_varietes').insert({ variete: info.variety, lot: info.lot || '' })
      }
    } catch (e) { /* table may not exist yet in this module phase */ }

    // CRITICAL: fully reset selection + modal so the user can immediately select more cells
    setSelectedCells(new Set())
    setSelectionConfirmed(false)
    setInsertFiche(null)
    setInsertModalOpen(false)
    showToast(`✅ ${cellsArr.length} case(s) remplie(s)`)
    logMouvements(cellsArr.map(cid => ({ frigo_id: frigoId, cell_id: cid, action: 'entree', variety: info.variety, lot: info.lot || '', palox: info.palox, color: info.color })))
    syncTodaySnapshot()
  }

  // ── Delete selected cells ──
  async function deleteSelectedCells() {
    if (selectedCells.size === 0) return
    if (!confirm(`Vider ${selectedCells.size} case(s) sélectionnée(s) ?`)) return
    const cellsArr = [...selectedCells]
    // On relève ce que contenait chaque case AVANT de la vider, pour le journal
    const sorties = []
    cellsArr.forEach(cid => {
      for (const f of Object.values(frigos)) {
        const c = f.cells[cid]
        if (c) { sorties.push({ frigo_id: f.id, cell_id: cid, action: 'sortie', variety: c.variety, lot: c.lot || '', palox: c.palox, color: c.color }); break }
      }
    })
    for (const cellId of cellsArr) {
      await supabase.from('cave_cells').delete().eq('cell_id', cellId)
    }
    logMouvements(sorties)
    setFrigos(prev => {
      const next = { ...prev }
      Object.keys(next).forEach(fid => {
        const f = { ...next[fid], cells: { ...next[fid].cells } }
        cellsArr.forEach(cid => delete f.cells[cid])
        next[fid] = f
      })
      return next
    })
    setSelectedCells(new Set())
    setDeleteMode(false)
    showToast(`🗑️ ${cellsArr.length} case(s) vidée(s)`)
    syncTodaySnapshot()
  }

  // ── Modélisation libre : le plan du frigo se construit case par case ──
  // Persiste le plan (objets { k, x, y, r, h }) en le recalant en (0,0) — les
  // positions sont pures, les identifiants k ne bougent jamais : aucun
  // renommage de cave_cells n'est nécessaire, les palox suivent leur case.
  async function persistLayout(frigoId, cellsIn) {
    const bbox = layoutBbox(cellsIn)
    const layout = cellsIn.map(c => ({ ...c, x: Math.round(c.x - bbox.minX), y: Math.round(c.y - bbox.minY) }))
    const cols = Math.max(1, Math.round(bbox.w / (UNIT_W + UGAP)))
    const rows = Math.max(1, Math.round(bbox.h / (UNIT_H + UGAP)))
    const { error } = await supabase.from('frigos').update({ cells_layout: layout, cols, rows }).eq('id', frigoId)
    if (error) {
      alert(/could not find|column/i.test(error.message)
        ? 'Colonne cells_layout manquante — exécute migration_frigos_case_par_case.sql dans Supabase → SQL Editor.'
        : error.message)
      return false
    }
    setFrigos(prev => ({ ...prev, [frigoId]: { ...prev[frigoId], cells_layout: layout, cols, rows } }))
    return true
  }

  // Relit le plan depuis la base juste avant de le modifier : une session
  // restée ouverte avec un vieux plan en mémoire ne peut ainsi pas écraser
  // silencieusement une remise à zéro faite ailleurs.
  async function fetchFreshLayout(frigoId) {
    const { data } = await supabase.from('frigos').select('cells_layout,col_heights,cols,rows').eq('id', frigoId).single()
    return toFreeLayout(data ? { ...activeFrigo, ...data } : activeFrigo)
  }

  // Ajoute une case à l'emplacement demandé (les "+" autour du plan).
  async function addCellAtSpot(x, y) {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    cells.push({ k: nextKey(cells), x, y, r: 0, h: false })
    await persistLayout(activeFrigo.id, cells)
  }

  // Retire une case du plan (uniquement si elle est vide, et jamais la dernière).
  async function removeCellByKey(k) {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    if (cells.length <= 1) { alert('Un frigo garde au moins une case.'); return }
    if (cellSlotHasData(activeFrigo, `${activeFrigo.id}_${k}`)) { alert('Videz cette case avant de la retirer.'); return }
    await persistLayout(activeFrigo.id, cells.filter(c => c.k !== k))
  }

  // Pivote une case de 90° (portrait ↔ paysage)
  async function rotateCell(k) {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    await persistLayout(activeFrigo.id, cells.map(c => c.k === k ? { ...c, r: c.r === 90 ? 0 : 90 } : c))
  }

  // Déplace une case à la position lâchée (glisser-déposer du mode Modeler)
  async function moveCell(k, x, y) {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    await persistLayout(activeFrigo.id, cells.map(c => c.k === k ? { ...c, x, y } : c))
  }
  // Capacité par défaut (nb de palox qui tiennent normalement dans cette case) —
  // affichée en petit grisé sur la case vide, pour ne plus avoir à s'en souvenir.
  // Cycle 1→8 puis vide (pas de valeur = rien à afficher).
  async function cycleCellCap(k) {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    await persistLayout(activeFrigo.id, cells.map(c => {
      if (c.k !== k) return c
      const next = (c.cap || 0) >= 8 ? null : (c.cap || 0) + 1
      return next == null ? { ...c, cap: undefined } : { ...c, cap: next }
    }))
  }
  // Réaligne toutes les cases sur la vraie grille (multiples de UNIT_W+UGAP /
  // UNIT_H+UGAP, avec UGAP = l'espacement normal entre deux cases voisines — donc
  // aucun décalage entre elles une fois réaligné) — le glissé libre en mode
  // Modeler aimante à 5 unités (SNAP), pas à la largeur réelle d'une case (106),
  // donc de petits décalages s'accumulent au fil des déplacements manuels. Un
  // clic recolle tout sur la grille propre ; garde l'ancien plan de côté pour
  // pouvoir annuler si le résultat ne convient pas (ex. forme volontairement
  // irrégulière qui ne devait pas être "corrigée").
  const [preRealignLayout, setPreRealignLayout] = useState(null)
  async function realignGrid() {
    if (!activeFrigo) return
    const cells = await fetchFreshLayout(activeFrigo.id)
    const gridW = UNIT_W + UGAP, gridH = UNIT_H + UGAP
    const snapped = cells.map(c => ({ ...c, x: Math.round(c.x / gridW) * gridW, y: Math.round(c.y / gridH) * gridH }))
    const ok = await persistLayout(activeFrigo.id, snapped)
    if (ok) { setPreRealignLayout(cells); showToast('✅ Cases réalignées sur la grille') }
  }
  async function undoRealign() {
    if (!activeFrigo || !preRealignLayout) return
    const ok = await persistLayout(activeFrigo.id, preRealignLayout)
    if (ok) { setPreRealignLayout(null); showToast('↩️ Réalignement annulé') }
  }

  // Reconstruction ponctuelle du frigo A1 — sa forme a été cassée par l'ancien
  // bouton Réaligner (retiré depuis). D'après la capture de référence envoyée
  // par l'utilisateur : 4 colonnes × 10 rangées (capacité 4/4/4/5×7), puis
  // 5 colonnes × 2 rangées (capacité 5) — confirmé vide, donc reconstruction
  // complète sans risque de perdre du contenu stocké.
  async function rebuildA1FromReference() {
    if (!activeFrigo) return
    if (!confirm(`Remplacer TOUTE la disposition actuelle de "${activeFrigo.name}" par la forme de référence (4×10 + 5×2) ? Cette action est irréversible.`)) return
    const gridW = UNIT_W + UGAP, gridH = UNIT_H + UGAP
    const capTop = [4, 4, 4, 5, 5, 5, 5, 5, 5, 5]
    const cells = []
    let n = 1
    for (let row = 0; row < 10; row++) {
      for (let col = 0; col < 4; col++) cells.push({ k: `Z${n++}`, x: col * gridW, y: row * gridH, r: 0, h: false, cap: capTop[row] })
    }
    for (let row = 10; row < 12; row++) {
      for (let col = 0; col < 5; col++) cells.push({ k: `Z${n++}`, x: col * gridW, y: row * gridH, r: 0, h: false, cap: 5 })
    }
    const ok = await persistLayout(activeFrigo.id, cells)
    if (ok) showToast('✅ Forme de A1 reconstruite depuis la référence')
  }
  // Applique une capacité par défaut à toutes les cases (vides) actuellement
  // sélectionnées en une fois — même mécanisme de sélection que pour insérer un
  // lot dans plusieurs cases à la fois, pour aller vite sur une rangée entière.
  const [capPickerOpen, setCapPickerOpen] = useState(false)
  async function applyCapToSelection(value) {
    if (!activeFrigo) return
    const prefix = `${activeFrigo.id}_`
    const keys = new Set([...selectedCells].map(cid => cid.replace(prefix, '').replace(/_[LR]$/, '')))
    const cells = await fetchFreshLayout(activeFrigo.id)
    const ok = await persistLayout(activeFrigo.id, cells.map(c => keys.has(c.k) ? { ...c, cap: value } : c))
    if (ok) showToast(`✅ Capacité par défaut (${value}) appliquée à ${keys.size} case(s)`)
    setCapPickerOpen(false)
    clearSelection()
  }
  async function cycleOrientation(cellId, frigoId) {
    const cell = frigos[frigoId]?.cells[cellId]
    if (!cell) return
    const next = ((cell.orientation || 0) + 90) % 360
    await supabase.from('cave_cells').update({ orientation: next }).eq('cell_id', cellId)
    setFrigos(prev => {
      const nf = { ...prev }
      const f = { ...nf[frigoId], cells: { ...nf[frigoId].cells } }
      f.cells[cellId] = { ...f.cells[cellId], orientation: next }
      nf[frigoId] = f
      return nf
    })
  }

  // ── Frigo CRUD ──
  function openNewFrigo() {
    setEditingFrigo({ name: '' })
    setFrigoModalOpen(true)
  }
  function openEditFrigo() {
    if (!activeFrigo) return
    setEditingFrigo({ ...activeFrigo })
    setFrigoModalOpen(true)
  }
  async function saveFrigo() {
    if (!editingFrigo.name?.trim()) { alert('Nom requis.'); return }
    if (editingFrigo.id) {
      // Renommage seulement — la disposition (col_heights) n'est pas touchée ici,
      // elle se modifie uniquement via les boutons +/- de la grille.
      await supabase.from('frigos').update({ name: editingFrigo.name }).eq('id', editingFrigo.id)
      setFrigos(prev => ({ ...prev, [editingFrigo.id]: { ...prev[editingFrigo.id], name: editingFrigo.name } }))
    } else {
      // Le frigo démarre avec une seule case — sa forme se construit ensuite
      // case par case avec le mode "Modeler".
      let { data, error } = await supabase.from('frigos').insert({ name: editingFrigo.name, cols: 1, rows: 1, col_heights: [1], cells_layout: [{ k: 'A1', x: 0, y: 0, r: 0, h: false }] }).select().single()
      if (error && /cells_layout|could not find/i.test(error.message)) {
        // colonne cells_layout pas encore créée (migration non exécutée) — repli col_heights
        ;({ data, error } = await supabase.from('frigos').insert({ name: editingFrigo.name, cols: 1, rows: 1, col_heights: [1] }).select().single())
      }
      if (error) { alert(error.message); return }
      setFrigos(prev => ({ ...prev, [data.id]: { ...data, cells: {} } }))
      setActiveFrigoId(data.id)
      if (isAdmin) setModelMode(true)
    }
    setFrigoModalOpen(false)
    showToast('✅ Frigo enregistré')
  }
  async function deleteFrigo() {
    if (!activeFrigo) return
    const { count: histCount } = await supabase.from('cave_snapshots').select('id', { count: 'exact', head: true }).eq('frigo_id', activeFrigo.id)
    const warn = histCount > 0 ? ` Son historique (${histCount} entrée${histCount > 1 ? 's' : ''} sur plusieurs jours) sera aussi perdu.` : ''
    if (!confirm(`Supprimer "${activeFrigo.name}" et toutes ses cases ?${warn}`)) return
    const { error: e1 } = await supabase.from('cave_cells').delete().eq('frigo_id', activeFrigo.id)
    const { error: e2 } = await supabase.from('cave_snapshots').delete().eq('frigo_id', activeFrigo.id)
    const { error: e3 } = await supabase.from('frigos').delete().eq('id', activeFrigo.id)
    if (e1 || e2 || e3) { alert((e1 || e2 || e3).message); return }
    setFrigos(prev => {
      const next = { ...prev }
      delete next[activeFrigo.id]
      return next
    })
    setActiveFrigoId(null) // retour à la page de choix des frigos
    showToast('🗑️ Frigo supprimé')
  }

  // ── Fiche CRUD (with delete button, requested fix) ──
  // Couleurs déjà prises par d'autres lots (fiche en cours d'édition exclue, pour
  // qu'elle garde sa propre couleur affichée/sélectionnable) — évite que deux lots
  // se retrouvent avec la même couleur (ou faute de choix, on retombe sur tout
  // le nuancier si toutes les couleurs sont déjà utilisées).
  function usedColors(excludeId) {
    return new Set(fiches.filter(f => f.id !== excludeId).map(f => f.color).filter(Boolean))
  }
  function nextAvailableColor(excludeId) {
    const used = usedColors(excludeId)
    return PALETTE.find(c => !used.has(c)) || PALETTE[0]
  }
  function openNewFiche() {
    setEditingFiche({ variety: '', lot: '', palox: 1, color: nextAvailableColor(null), date: new Date().toISOString().split('T')[0] })
    setFicheModalOpen(true)
  }
  function openEditFiche(f) {
    setEditingFiche({ ...f })
    setFicheModalOpen(true)
  }
  // Synchro inverse de celle de BDD > Variétés (qui crée une fiche de lot quand on
  // enregistre une variété) : ajouter une fiche de lot ici enregistre aussi la
  // variété/lot dans la base de données, si elle n'y est pas déjà.
  async function syncDbVariete(f) {
    if (!f.variety?.trim()) return
    try {
      const { data: existing } = await supabase.from('db_varietes').select('id').eq('variete', f.variety).eq('lot', f.lot || '').maybeSingle()
      if (existing) return
      await supabase.from('db_varietes').insert({ variete: f.variety, lot: f.lot || '' })
    } catch (e) { console.warn('Variété BDD non synchronisée:', e) }
  }
  async function saveFiche() {
    if (!editingFiche.variety?.trim()) { alert('Variété requise.'); return }
    if (editingFiche.id) {
      await supabase.from('lot_fiches').update(editingFiche).eq('id', editingFiche.id)
      setFiches(prev => prev.map(f => f.id === editingFiche.id ? editingFiche : f))
    } else {
      const { data, error } = await supabase.from('lot_fiches').insert(editingFiche).select().single()
      if (error) { alert(error.message); return }
      setFiches(prev => [...prev, data])
    }
    await syncDbVariete(editingFiche)
    setFicheModalOpen(false)
    showToast('✅ Fiche enregistrée')
  }
  async function deleteFiche(ficheId) {
    if (!isAdmin) return
    if (!confirm('Supprimer cette fiche de lot ?')) return
    await supabase.from('lot_fiches').delete().eq('id', ficheId)
    setFiches(prev => prev.filter(f => f.id !== ficheId))
    showToast('🗑️ Fiche supprimée')
  }

  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', flex: 1, overflow: isMobile ? 'auto' : 'hidden' }}>
      {ToastEl}

      {/* Première page : le choix du frigo à consulter (une carte par frigo).
          Le frigo choisi s'ouvre ensuite seul, en pleine page, avec un bouton retour. */}
      {!activeFrigo ? (
        <FrigoChooserPage
          frigos={frigos}
          isMobile={isMobile}
          onNew={canCreerFrigo ? openNewFrigo : null}
          onSnapshot={saveSnapshotNow}
          onOpen={id => { setActiveFrigoId(id); setView('grille'); setZoomMode('overview'); clearSelection() }}
        />
      ) : (
      <>
      {/* Main frigo area — pleine largeur : plus de panneau latéral fixe, les fiches
          de lot s'ouvrent en fenêtre (bouton dans la barre) pour ne jamais rogner
          la vue du frigo. En-tête compact tenu sur une seule ligne dense. */}
      <div style={{ flex: 1, height: isMobile ? '100%' : 'auto', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* En-tête compact : retour + nom + palox + onglets de vue, tout sur une ligne
            (défile horizontalement sur mobile plutôt que de prendre de la hauteur) */}
        <div style={{
          background: 'white', borderBottom: '1px solid var(--border)', padding: '.4rem .8rem',
          display: 'flex', alignItems: 'center', gap: '.5rem', flexShrink: 0,
          flexWrap: isMobile ? 'nowrap' : 'wrap', overflowX: isMobile ? 'auto' : 'visible', WebkitOverflowScrolling: 'touch',
        }}>
          <button className="btn-sm" style={{ flexShrink: 0, padding: '.3rem .6rem', fontSize: '.78rem' }}
            onClick={() => { setActiveFrigoId(null); clearSelection(); setDeleteMode(false); setModelMode(false); setView('grille') }}
          >← Frigos</button>
          <div style={{ fontWeight: 700, fontSize: '.92rem', flexShrink: 0 }}>❄️ {activeFrigo.name}</div>
          <span style={{ fontSize: '.74rem', color: 'var(--text-muted)', flexShrink: 0 }}>
            {Object.values(activeFrigo.cells).reduce((s, c) => s + (c.palox || 0), 0)} palox
          </span>
          <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', flexShrink: 0 }} />
          {[['grille', '▦ Grille'], ['recap', '📋 Récap'], ['historique', '📅 Historique']].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className="btn-sm" style={{ flexShrink: 0, padding: '.3rem .6rem', fontSize: '.78rem',
              ...(view === k ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}>
              {l}
            </button>
          ))}
          <div style={{ marginLeft: isMobile ? 0 : 'auto', display: 'flex', gap: '.4rem', flexShrink: 0 }}>
            <button onClick={() => setFichesModalOpen(true)} className="btn-sm primary" style={{ padding: '.3rem .6rem', fontSize: '.78rem' }}>
              📋 Lots ({fiches.length})
            </button>
            {!readOnly && (
              <button onClick={openNewFiche} className="btn-sm" style={{ padding: '.3rem .6rem', fontSize: '.78rem' }} title="Créer un nouveau lot">
                + Créer un lot
              </button>
            )}
          </div>
        </div>

        {/* Toolbar */}
        {activeFrigo && view === 'grille' && (
          <div style={{ background: 'white', borderBottom: '1px solid var(--border)', padding: '.4rem .8rem', display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>
              {readOnly ? 'Lecture seule — consultation uniquement' : selectedCells.size > 0 ? `${selectedCells.size} case(s) sélectionnée(s)` : 'Cliquez sur des cases pour les sélectionner'}
            </span>
            {!readOnly && !modelMode && (
              <button onClick={() => setSelectedCells(new Set(toFreeLayout(activeFrigo).map(c => `${activeFrigo.id}_${c.k}`)))}
                className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>
                Sélectionner toutes les cases
              </button>
            )}
            {!readOnly && selectedCells.size > 0 && (
              <button onClick={clearSelection} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>Désélectionner tout</button>
            )}
            {!readOnly && selectedCells.size > 0 && !deleteMode && !modelMode && !selectionConfirmed &&
              [...selectedCells].every(cid => !activeFrigo.cells[cid]) && (
              <button onClick={() => setSelectionConfirmed(true)} className="btn-sm primary" style={{ padding: '.25rem .6rem', fontSize: '.74rem' }}>
                ✓ Valider la sélection
              </button>
            )}
            {isAdmin && !readOnly && selectedCells.size > 0 && !deleteMode && !modelMode && !selectionConfirmed &&
              [...selectedCells].every(cid => !activeFrigo.cells[cid]) && (
              <div style={{ position: 'relative' }}>
                <button onClick={() => setCapPickerOpen(o => !o)} className="btn-sm" style={{ padding: '.25rem .6rem', fontSize: '.74rem' }}
                  title="Définir la capacité par défaut (nb de palox) de toutes les cases sélectionnées">
                  🔢 Capacité par défaut
                </button>
                {capPickerOpen && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'white', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-md)', padding: '.4rem', display: 'flex', gap: '.25rem', zIndex: 300 }}>
                    {[1,2,3,4,5,6,7,8].map(n => (
                      <button key={n} onClick={() => applyCapToSelection(n)} className="btn-sm"
                        style={{ padding: '.2rem .45rem', fontSize: '.76rem', minWidth: 26 }}>{n}</button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Sens et division d'une case : plus d'icônes sur la case elle-même
                (ça prenait de la place) — on sélectionne une case puis on agit
                depuis la barre d'outils. */}
            {!readOnly && selectedCells.size === 1 && !deleteMode && (() => {
              const selId = [...selectedCells][0]
              const baseKey = selId.replace(/_[LR]$/, '')
              const hasWholeData = !!activeFrigo.cells[baseKey]
              const isSplitCell = splitCells.has(baseKey) || !!activeFrigo.cells[`${baseKey}_L`] || !!activeFrigo.cells[`${baseKey}_R`]
              return (
                <>
                  {hasWholeData && (
                    <button onClick={() => cycleOrientation(baseKey, activeFrigo.id)} className="btn-sm"
                      style={{ padding: '.25rem .55rem', fontSize: '.74rem' }} title="Tourner le sens du palox">↻ Sens</button>
                  )}
                  <button onClick={() => toggleSplit(baseKey)} className="btn-sm"
                    style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}
                    title={isSplitCell ? 'Refusionner en une case entière' : 'Diviser en 2 demi-cases (palox à l\'horizontale)'}>
                    {isSplitCell ? '⇄ Fusionner' : '⇄ Diviser en 2'}
                  </button>
                </>
              )
            })()}
            {/* Zoom : "Lisible" ajuste le frigo à l'écran sans descendre sous une taille
                lisible (défile si besoin) ; "Vue d'ensemble" fait toujours tenir le frigo
                entier sans défiler, quitte à réduire beaucoup le texte ; 🔍+/− zoom manuel. */}
            <div style={{ display: 'flex', gap: '.3rem', alignItems: 'center' }}>
              <button onClick={zoomOut} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }} title="Réduire les cases">🔍−</button>
              <button onClick={zoomIn} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }} title="Agrandir les cases pour lire les noms de lots">🔍+</button>
              <button onClick={() => setZoomMode('fit')} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem',
                ...(zoomMode === 'fit' ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}
                title="Ajuste à l'écran en gardant le nom des lots lisible (défile si besoin)">⤢ Lisible</button>
              <button onClick={() => setZoomMode('overview')} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem',
                ...(zoomMode === 'overview' ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}
                title="Fait tenir le frigo entier sur l'écran, sans défiler">🗺️ Vue d'ensemble</button>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={saveSnapshotNow} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }} title="Force un instantané du stock à cet instant">
                📸 État du jour
              </button>
              {/* La modélisation de la forme est réservée au profil admin */}
              {isAdmin && !readOnly && (
                <button
                  onClick={() => { setModelMode(!modelMode); setDeleteMode(false); clearSelection(); setPreRealignLayout(null) }}
                  className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem',
                  ...(modelMode ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}
                >
                  {modelMode ? '✓ Terminer la forme' : '🧱 Modeler'}
                </button>
              )}
              {isAdmin && !readOnly && modelMode && (activeFrigo?.name || '').trim().toLowerCase() === 'a1' && (
                <button onClick={rebuildA1FromReference} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem', background: 'var(--amber-pale, #fdf6e9)', borderColor: 'var(--amber)', color: 'var(--amber)' }}
                  title="Reconstruit la forme de A1 depuis la capture de référence (4×10 + 5×2) — usage ponctuel, A1 confirmé vide">
                  🔧 Reconstruire A1 (référence)
                </button>
              )}
              {isAdmin && !readOnly && modelMode && preRealignLayout && (
                <button onClick={undoRealign} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}
                  title="Revenir à la disposition d'avant le dernier réalignement">
                  ↩️ Annuler
                </button>
              )}
              {!readOnly && (
                <button
                  onClick={() => { setDeleteMode(!deleteMode); setModelMode(false); clearSelection() }}
                  className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem',
                  ...(deleteMode ? { background: 'var(--red-pale)', color: 'var(--red)', borderColor: '#fecaca' } : {}) }}
                >
                  {deleteMode ? '✕ Annuler' : '🗑️ Vider'}
                </button>
              )}
              {!readOnly && deleteMode && selectedCells.size > 0 && (
                <button onClick={deleteSelectedCells} className="btn-danger" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>Vider {selectedCells.size}</button>
              )}
              {!readOnly && <button onClick={openEditFrigo} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem' }}>✏️</button>}
              {isAdmin && !readOnly && <button onClick={deleteFrigo} className="btn-sm" style={{ padding: '.25rem .55rem', fontSize: '.74rem', color: 'var(--red)' }}>Supprimer</button>}
            </div>
          </div>
        )}

        {/* Panneau de lots — plein écran, affiché seulement après validation
            explicite de la sélection (bouton "✓ Valider la sélection" dans la
            barre d'outils) : on peut d'abord sélectionner plusieurs cases
            tranquillement, le panneau plein écran n'apparaît qu'une fois prêt.
            Liste déroulante (pas des cartes côte à côte) pour scanner vite un
            frigo avec beaucoup de lots différents. */}
        {!readOnly && activeFrigo && view === 'grille' && !deleteMode && !modelMode && selectionConfirmed && selectedCells.size > 0 &&
          [...selectedCells].every(cid => !activeFrigo.cells[cid]) && (
          <ChoixLotPanel
            nbCases={selectedCells.size}
            fiches={fiches}
            onPick={onFicheClick}
            onNew={openNewFiche}
            onEdit={openEditFiche}
            onDelete={isAdmin ? (id) => deleteFiche(id) : undefined}
            onClose={clearSelection}
          />
        )}

        {/* Content: grille / récap / historique — la grille redimensionne ses cases pour
            tenir dans l'espace visible sans scroller ; si même à taille minimale lisible elle
            ne rentre pas (beaucoup de rangées sur petit écran), on repasse en défilement
            plutôt que d'afficher des cases illisibles. Les autres vues défilent normalement. */}
        <div ref={gridWrapRef} style={{ flex: 1, overflow: 'auto', padding: isMobile ? '.9rem' : '1.4rem', display: view === 'grille' ? 'flex' : 'block' }}>
          {view === 'grille' ? (
            // margin auto : centré quand le plan tient dans l'écran, défilement
            // propre (sans bord coupé) quand il est plus grand (mode zoom)
            <div style={{ margin: 'auto', display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '1rem', alignItems: isMobile ? 'stretch' : 'flex-start' }}>
            <FrigoGrid
              frigo={activeFrigo}
              selectedCells={selectedCells}
              deleteMode={deleteMode}
              modelMode={modelMode && isAdmin}
              onCellClick={toggleCell}
              onCycleOrientation={cellId => cycleOrientation(cellId, activeFrigo.id)}
              onAddCell={addCellAtSpot}
              onRemoveCell={removeCellByKey}
              onRotateCell={rotateCell}
              onMoveCell={moveCell}
              onSetCap={cycleCellCap}
              onToggleSplit={toggleSplit}
              onKeepOneHalf={keepOneHalf}
              onRestoreFull={restoreFullCell}
              splitCells={splitCells}
              expandedSplitCells={expandedSplitCells}
              onToggleExpanded={toggleExpanded}
              size={cellSize}
              previsionByCellId={previsionByCellId}
            />
            {(zoomMode === 'overview' || activePrevisions.length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
                {zoomMode === 'overview' && <VarietyLegend cells={activeFrigo.cells} />}
                {activePrevisions.length > 0 && <PrevisionLegend previsions={activePrevisions} />}
              </div>
            )}
            </div>
          ) : view === 'recap' ? (
            <RecapView frigo={activeFrigo} />
          ) : view === 'recap-global' ? (
            <RecapGlobalView frigos={frigos} />
          ) : (
            <HistoriqueView date={histDate} setDate={setHistDate} cells={histCells} loading={histLoading} frigoId={activeFrigo.id} frigoName={activeFrigo.name}
              histMode={histMode} setHistMode={setHistMode} journal={journal} profileById={profileById}
              isAdmin={isAdmin} onDeleteMouvement={deleteMouvement} onDeleteMouvements={deleteMouvements}
              onDeleted={() => loadHistorique(histDate)} />
          )}
        </div>
      </div>
      </>
      )}

      {/* Fiches de lot : toujours en fenêtre (jamais un panneau fixe) pour laisser
          au frigo toute la largeur — s'ouvre via le bouton "📋 Lots" de l'en-tête. */}
      {fichesModalOpen && (
        <div className="modal-overlay" onClick={e => e.target === e.currentTarget && setFichesModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 420 }}>
            <div className="modal-hdr">
              <h3>📋 Fiches de lot</h3>
              <button className="modal-close" onClick={() => setFichesModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
              {!readOnly && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button onClick={openNewFiche} className="btn-sm primary">+ Créer</button>
                </div>
              )}
              {!readOnly && (
                <p style={{ fontSize: '.78rem', color: 'var(--text-muted)', margin: 0 }}>
                  {selectedCells.size > 0
                    ? `Cliquez une fiche pour remplir les ${selectedCells.size} case(s) sélectionnée(s).`
                    : 'Sélectionnez d\'abord des cases sur la grille, puis cliquez une fiche pour les remplir toutes en même temps.'}
                </p>
              )}
              {fiches.length === 0 && (
                <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucune fiche créée.</div>
              )}
              {groupFichesByVariety(fiches).map(([variety, group]) => (
                <div key={variety}>
                  <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', margin: '.6rem 0 .3rem' }}>
                    {variety} ({group.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                    {group.map(f => (
                      <FicheCard
                        key={f.id}
                        fiche={f}
                        onClick={readOnly ? undefined : () => { onFicheClick(f); setFichesModalOpen(false) }}
                        onEdit={readOnly ? undefined : () => openEditFiche(f)}
                        onDelete={isAdmin && !readOnly ? () => deleteFiche(f.id) : undefined}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Frigo modal */}
      {frigoModalOpen && editingFrigo && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setFrigoModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 380 }}>
            <div className="modal-hdr">
              <h3>{editingFrigo.id ? 'Modifier le frigo' : 'Nouveau frigo'}</h3>
              <button className="modal-close" onClick={() => setFrigoModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label>Nom du frigo</label>
                <input type="text" value={editingFrigo.name} onChange={e => setEditingFrigo({ ...editingFrigo, name: e.target.value })} placeholder="ex. Frigo Nord" autoFocus />
              </div>
              {!editingFrigo.id && (
                <p style={{ fontSize: '.74rem', color: 'var(--text-muted)', marginTop: '.5rem' }}>
                  Le frigo démarre avec une seule case. Utilise ensuite le mode <strong>🧱 Modeler</strong> :
                  des "+" apparaissent sur chaque côté des cases pour donner au frigo exactement la forme voulue.
                </p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn-sm" onClick={() => setFrigoModalOpen(false)}>Annuler</button>
              <button className="btn-sm primary" onClick={saveFrigo}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}

      {/* Fiche modal */}
      {ficheModalOpen && editingFiche && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setFicheModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-hdr">
              <h3>{editingFiche.id ? 'Modifier la fiche' : 'Nouvelle fiche lot'}</h3>
              <button className="modal-close" onClick={() => setFicheModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gap: '.8rem' }}>
                <div className="form-group">
                  <label>Variété</label>
                  <input type="text" value={editingFiche.variety} onChange={e => setEditingFiche({ ...editingFiche, variety: e.target.value })} placeholder="ex. Bintje, Agria…" autoFocus />
                </div>
                <div className="form-group">
                  <label>N° de lot</label>
                  <input type="text" value={editingFiche.lot} onChange={e => setEditingFiche({ ...editingFiche, lot: e.target.value })} placeholder="LOT-2026-001" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
                  <div className="form-group">
                    <label>Palox par case</label>
                    <input type="number" min={1} max={99} value={editingFiche.palox} onChange={e => setEditingFiche({ ...editingFiche, palox: parseInt(e.target.value) || 1 })} />
                  </div>
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={editingFiche.date} onChange={e => setEditingFiche({ ...editingFiche, date: e.target.value })} />
                  </div>
                </div>
                <div className="form-group">
                  <label>Couleur</label>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginBottom: '.4rem' }}>
                    Seules les couleurs pas encore prises par un autre lot sont proposées, pour rester clair sur les cases.
                  </div>
                  <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                    {PALETTE.filter(c => c === editingFiche.color || !usedColors(editingFiche.id).has(c)).map(c => (
                      <div
                        key={c}
                        onClick={() => setEditingFiche({ ...editingFiche, color: c })}
                        style={{
                          width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer',
                          border: editingFiche.color === c ? '3px solid var(--green-deep)' : '3px solid transparent'
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              {editingFiche.id && isAdmin && (
                <button className="btn-danger" onClick={() => { deleteFiche(editingFiche.id); setFicheModalOpen(false) }}>Supprimer</button>
              )}
              <button className="btn-sm" onClick={() => setFicheModalOpen(false)}>Annuler</button>
              <button className="btn-sm primary" onClick={saveFiche}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}

      {/* Insert confirmation modal */}
      {insertModalOpen && insertFiche && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setInsertModalOpen(false)}>
          <div className="modal" style={{ maxWidth: 400 }}>
            <div className="modal-hdr">
              <h3>Insérer dans {selectedCells.size} case(s)</h3>
              <button className="modal-close" onClick={() => setInsertModalOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ borderRadius: 12, border: `3px solid ${insertFiche.color}`, padding: '1rem 1.2rem', marginBottom: '1rem' }}>
                <div style={{ fontWeight: 700, fontSize: '1rem' }}>{insertFiche.variety}</div>
                <div style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{insertFiche.lot || 'Sans n° de lot'}</div>
              </div>
              <div className="form-group">
                <label>Palox par case (s'applique à toutes les cases sélectionnées)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}>
                  <button className="btn-sm" onClick={() => setInsertPalox(Math.max(1, insertPalox - 1))}>−</button>
                  <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.8rem', color: 'var(--green-mid)', minWidth: 40, textAlign: 'center' }}>{insertPalox}</span>
                  <button className="btn-sm" onClick={() => setInsertPalox(Math.min(99, insertPalox + 1))}>+</button>
                </div>
              </div>
              <div className="form-group" style={{ marginTop: '.8rem' }}>
                <label>Taille de palox (s'applique à toutes les cases sélectionnées)</label>
                <div style={{ display: 'flex', gap: '.5rem' }}>
                  {[['2 T', 2], ['1,2 T', 1.2]].map(([label, val]) => (
                    <button key={val} type="button" className="btn-sm" onClick={() => setInsertPoidsPalox(val)}
                      style={insertPoidsPalox === val ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)', fontWeight: 700 } : {}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group" style={{ marginTop: '.8rem' }}>
                <label>Sens des palox (s'applique à toutes les cases sélectionnées)</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}>
                  <button className="btn-sm" onClick={() => setInsertOrientation(o => (o + 270) % 360)} title="Tourner vers la gauche">↺</button>
                  <div style={{ width: 44, height: 44, border: '2px solid var(--border)', borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--cream)' }}>
                    <span style={{ display: 'inline-block', fontSize: '1.3rem', transform: `rotate(${insertOrientation}deg)`, transition: 'transform .15s' }}>⬆️</span>
                  </div>
                  <button className="btn-sm" onClick={() => setInsertOrientation(o => (o + 90) % 360)} title="Tourner vers la droite">↻</button>
                  <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{insertOrientation}°</span>
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-sm" onClick={() => setInsertModalOpen(false)}>Annuler</button>
              <button className="btn-sm primary" onClick={confirmInsert}>✓ Insérer dans {selectedCells.size} case(s)</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* Une case du frigo. Plus d'icônes (sens / diviser) dans la case elle-même —
   ces actions se pilotent depuis la barre d'outils une fois la case
   sélectionnée, pour laisser toute la place au contenu. */
function FrigoCell({ cellId, data, isSelected, deleteMode, onCellClick, width, height, compactLabels, cap, modelMode, onSetCap }) {
  return (
    <div
      onClick={() => onCellClick(cellId)}
      style={{
        width, height, boxSizing: 'border-box', border: isSelected ? '3px solid var(--green-accent)' : '2px solid var(--border)',
        borderRadius: 8, background: data ? 'white' : '#fafafa',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: data ? (width < 110 ? '3px 2px' : compactLabels ? '4px 6px' : '5px 8px') : 4, position: 'relative', overflow: 'hidden',
        transform: isSelected ? 'scale(1.04)' : 'none',
        boxShadow: isSelected ? '0 4px 12px rgba(74,144,80,.25)' : 'none',
        transition: 'transform .12s, box-shadow .12s, border-color .12s',
        outline: deleteMode && isSelected ? '2px solid var(--red)' : 'none',
      }}
    >
      {data && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 5, background: data.color }} />}
      {data ? (
        width < 110 ? (
          // Case trop étroite pour variété + lot + palox côte à côte (mode Vue
          // d'ensemble) : on laisse tomber la variété (verticale) pour garder le
          // lot lisible — l'info qu'on veut voir même en vue d'ensemble — avec le
          // nb de palox à côté.
          <div style={{ width: '100%', display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 3, overflow: 'hidden' }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '.6rem', fontWeight: 700, color: 'var(--ink)' }}>
              {data.lot || (data.variety || '').slice(0, 3)}
            </span>
            <span style={{ flexShrink: 0, fontFamily: "'DM Serif Display', serif", fontSize: '.68rem', color: 'var(--green-mid)' }}>{data.palox}</span>
          </div>
        ) : (
          // Case basse et large (paysage) : variété abrégée à la verticale collée à
          // gauche, lot centré (tronqué avec "…" si trop long), nb de palox (sans le
          // mot "palox" — le chiffre suffit) à droite.
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
            <div style={{ flexShrink: 0, width: compactLabels ? 15 : 17, display: 'flex', justifyContent: 'center', overflow: 'visible' }}>
              <div style={{ transform: 'rotate(-90deg)', whiteSpace: 'nowrap', fontWeight: 700, fontSize: compactLabels ? '.62rem' : '.72rem' }}>
                {(data.variety || '').slice(0, 3)}
              </div>
            </div>
            <span style={{ flex: 1, minWidth: 0, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: compactLabels ? '.58rem' : '.66rem', color: 'var(--text-muted)' }}>
              {data.lot}
            </span>
            <span style={{ flexShrink: 0, whiteSpace: 'nowrap', fontFamily: "'DM Serif Display', serif", fontSize: compactLabels ? '.85rem' : '1.05rem', color: 'var(--green-mid)' }}>
              {data.palox}{data.poids_palox != null && data.poids_palox !== 2 ? ` · ${String(data.poids_palox).replace('.', ',')}T` : ''}
            </span>
          </div>
        )
      ) : (
        <span style={{ fontSize: compactLabels ? '1.1rem' : '1.4rem', color: 'var(--cream-dark)' }}>+</span>
      )}
      {/* Capacité par défaut (nb de palox qui tiennent normalement ici) — visible en
          petit sur la case vide, dans une couleur bien lisible (bleu franc + fond
          clair) pour se voir tout de suite au coup d'œil, sans avoir à s'en souvenir.
          Réglable uniquement en mode Modeler (clique pour incrémenter 1→8 puis vider). */}
      {!data && (cap || (modelMode && onSetCap)) && (
        <span
          onClick={modelMode && onSetCap ? e => { e.stopPropagation(); onSetCap() } : undefined}
          title={modelMode && onSetCap ? 'Capacité par défaut (nb de palox) — clique pour changer' : 'Capacité par défaut (nb de palox)'}
          style={{
            position: 'absolute', bottom: 2, right: 3, fontSize: compactLabels ? '.72rem' : '.82rem',
            color: 'var(--sky, #2f7de0)', fontWeight: 800,
            cursor: modelMode && onSetCap ? 'pointer' : 'default',
            background: 'var(--sky-pale, #dceafd)', borderRadius: 4,
            padding: '0 4px', lineHeight: 1.4,
          }}>
          {cap || (modelMode ? '+' : '')}
        </span>
      )}
    </div>
  )
}

/* Emplacement d'un frigo : soit une case entière (palox "à la verticale", le
   cas normal), soit divisé en 2 demi-cases côte à côte (palox "à l'horizontale"
   — deux tournés sur le côté tiennent dans la place d'un seul à la verticale).
   Le découpage est déduit des données (une demi-case remplie = case divisée) ;
   le bouton ⇄ permet de le faire à l'avance sur une case encore vide. */
function FrigoCellSlot({ frigo, cellId, k, halfOnly, cap, selectedCells, deleteMode, onCellClick, onCycleOrientation, onToggleSplit, onKeepOneHalf, onRestoreFull, size, height, splitCells, expandedSplitCells, onToggleExpanded, modelMode, onSetCap }) {
  const leftId = `${cellId}_L`, rightId = `${cellId}_R`
  const dataWhole = frigo.cells[cellId]
  const dataL = frigo.cells[leftId]
  const dataR = frigo.cells[rightId]
  const isSplit = splitCells.has(cellId) || !!dataL || !!dataR
  const compact = size < 70 // cases rétrécies (adaptation à l'écran) : bascule sur les libellés compacts
  const halfW = (size - 4) / 2

  // Demi-case seule (persistée) : le slot occupe déjà son encombrement réduit
  // dans le plan — la case le remplit. ⇄ pour redevenir une case entière.
  if (halfOnly && !dataWhole) {
    const halfId = dataL ? leftId : dataR ? rightId : leftId
    const halfData = dataL || dataR
    return (
      <div style={{ position: 'relative', width: size, height }}>
        <FrigoCell cellId={halfId} data={halfData} isSelected={selectedCells.has(halfId)} deleteMode={deleteMode}
          onCellClick={onCellClick} onCycleOrientation={onCycleOrientation} width={size} height={height} compactLabels />
        <button onClick={e => { e.stopPropagation(); onRestoreFull(cellId, k) }} title="Repasser en case entière"
          style={{ position: 'absolute', bottom: 2, right: 2, background: 'white', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.62rem', lineHeight: 1, padding: '1px 3px', color: 'var(--text-muted)' }}>⇄</button>
      </div>
    )
  }

  if (!isSplit) {
    return (
      <FrigoCell cellId={cellId} data={dataWhole} isSelected={selectedCells.has(cellId)} deleteMode={deleteMode}
        onCellClick={onCellClick} width={size} height={height} compactLabels={compact}
        cap={cap} modelMode={modelMode} onSetCap={onSetCap ? () => onSetCap(k) : null} />
    )
  }

  // Une seule moitié occupée : affichée par défaut comme une case normale (unifiée), avec
  // un petit bouton pour "ouvrir" la case et voir/remplir la 2e moitié si besoin.
  const onlyOneFilled = (!!dataL) !== (!!dataR)
  const expanded = expandedSplitCells?.has(cellId)
  if (onlyOneFilled && !expanded) {
    const filledId = dataL ? leftId : rightId
    const filledData = dataL || dataR
    return (
      <div style={{ position: 'relative' }}>
        <FrigoCell cellId={filledId} data={filledData} isSelected={selectedCells.has(filledId)} deleteMode={deleteMode}
          onCellClick={onCellClick} onCycleOrientation={onCycleOrientation} width={size} height={height} compactLabels={compact} />
        <button onClick={e => { e.stopPropagation(); onToggleExpanded(cellId) }} title="Case divisée — cliquer pour voir/remplir la 2e moitié"
          style={{ position: 'absolute', bottom: 2, right: 2, background: 'white', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.62rem', lineHeight: 1, padding: '1px 3px', color: 'var(--text-muted)' }}>⇄</button>
      </div>
    )
  }

  // Un ✕ sur chaque moitié vide : la retire pour ne garder que l'autre
  // (demi-case seule — le choix demandé après une scission).
  const halfRemoveBtn = { position: 'absolute', top: 1, right: 1, background: 'white', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.58rem', lineHeight: 1, padding: '1px 3px', color: 'var(--red)', zIndex: 3 }
  return (
    <div style={{ position: 'relative', width: size, display: 'flex', gap: 4 }}>
      <div style={{ position: 'relative' }}>
        <FrigoCell cellId={leftId} data={dataL} isSelected={selectedCells.has(leftId)} deleteMode={deleteMode}
          onCellClick={onCellClick} onCycleOrientation={onCycleOrientation} width={halfW} height={height} compactLabels />
        {!dataL && (
          <button onClick={e => { e.stopPropagation(); onKeepOneHalf(cellId, k) }} title="Supprimer cette moitié — ne garder que l'autre (demi-case seule)"
            style={halfRemoveBtn}>✕</button>
        )}
      </div>
      <div style={{ position: 'relative' }}>
        <FrigoCell cellId={rightId} data={dataR} isSelected={selectedCells.has(rightId)} deleteMode={deleteMode}
          onCellClick={onCellClick} onCycleOrientation={onCycleOrientation} width={halfW} height={height} compactLabels />
        {!dataR && (
          <button onClick={e => { e.stopPropagation(); onKeepOneHalf(cellId, k) }} title="Supprimer cette moitié — ne garder que l'autre (demi-case seule)"
            style={halfRemoveBtn}>✕</button>
        )}
      </div>
      {!dataL && !dataR && (
        <button onClick={e => { e.stopPropagation(); onToggleSplit(cellId) }} title="Refusionner en une seule case"
          style={{ position: 'absolute', top: -8, right: -4, background: 'white', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.62rem', lineHeight: 1, padding: '1px 3px', color: 'var(--text-muted)' }}>⇄</button>
      )}
      {onlyOneFilled && expanded && (
        <button onClick={e => { e.stopPropagation(); onToggleExpanded(cellId) }} title="Revenir à l'affichage unifié (masquer la moitié vide)"
          style={{ position: 'absolute', top: -8, right: -4, background: 'white', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer', fontSize: '.62rem', lineHeight: 1, padding: '1px 3px', color: 'var(--text-muted)' }}>⇄</button>
      )}
    </div>
  )
}

/* Plan libre du frigo : chaque case est positionnée en absolu (x, y en unités,
   converties en pixels via l'échelle). En mode Modeler : glisser-déposer pour
   déplacer une case, ↻ pour la pivoter à 90°, "+" collé à chaque côté libre
   pour en ajouter une, ✕ pour retirer une case vide. */
// Légende couleur → variété (mode Vue d'ensemble) : les cases y sont trop petites
// pour lire le lot dans le détail, la couleur de la case (barre du haut) reste le
// repère visuel rapide — cette légende explique ce que chaque couleur représente.
function VarietyLegend({ cells }) {
  const groups = {}
  Object.values(cells || {}).forEach(c => {
    if (!c.variety) return
    const key = c.variety
    if (!groups[key]) groups[key] = { variety: c.variety, colors: new Set(), palox: 0 }
    groups[key].colors.add(c.color || 'var(--stone,#5c6b54)')
    groups[key].palox += c.palox || 0
  })
  const rows = Object.values(groups).sort((a, b) => a.variety.localeCompare(b.variety, 'fr'))
  if (rows.length === 0) return null
  return (
    <div style={{ width: 200, flexShrink: 0, background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.8rem .9rem', position: 'sticky', top: 0 }}>
      <div style={{ fontSize: '.76rem', fontWeight: 700, marginBottom: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        🎨 Variétés
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        {rows.map(r => (
          <div key={r.variety} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <span style={{ display: 'flex', flexShrink: 0, gap: 2 }}>
              {[...r.colors].map(c => <span key={c} style={{ width: 11, height: 11, borderRadius: 3, background: c, display: 'inline-block' }} />)}
            </span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: '.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.variety}</span>
            <span style={{ fontSize: '.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>{r.palox} palox</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Légende des prévisions palox actives pour le frigo affiché : une ligne par client/RDV
// avec sa couleur de surlignement et si c'est sous contrat ou hors contrat.
function PrevisionLegend({ previsions }) {
  return (
    <div style={{ width: 220, flexShrink: 0, background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.8rem .9rem', position: 'sticky', top: 0 }}>
      <div style={{ fontSize: '.76rem', fontWeight: 700, marginBottom: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
        🎯 Prévisions palox
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
        {previsions.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: p.color, flexShrink: 0, marginTop: 2, boxShadow: `0 0 0 2px ${p.color}33` }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: '.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.client_nom || 'Sans nom'}</div>
              <div style={{ fontSize: '.68rem', color: p.contrat_id ? 'var(--green-mid)' : 'var(--amber)', fontWeight: 600 }}>
                {p.contrat_id ? '📄 Sous contrat' : '🚚 Hors contrat'}
              </div>
              {p.date && <div style={{ fontSize: '.68rem', color: 'var(--text-muted)' }}>{new Date(p.date).toLocaleDateString('fr-FR')}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FrigoGrid({ frigo, selectedCells, deleteMode, modelMode, onCellClick, onCycleOrientation, onAddCell, onRemoveCell, onRotateCell, onMoveCell, onSetCap, onToggleSplit, onKeepOneHalf, onRestoreFull, splitCells, expandedSplitCells, onToggleExpanded, size, previsionByCellId = {} }) {
  const cells = toFreeLayout(frigo)
  const scale = size / UNIT_W
  const bbox = layoutBbox(cells)
  const pad = modelMode ? UNIT_W + UGAP : 0
  const originX = bbox.minX - pad, originY = bbox.minY - pad
  const canvasW = (bbox.w + pad * 2) * scale
  const canvasH = (bbox.h + pad * 2) * scale
  const ghosts = modelMode ? ghostSpots(cells) : []

  // Glisser-déposer (mode Modeler) : la position suit le pointeur (aimantée),
  // et n'est persistée qu'au lâcher. Un simple clic (déplacement < 7 px) reste
  // un clic normal sur la case.
  const [drag, setDrag] = useState(null) // { k, x, y }
  const dragRef = useRef(null)
  const justDraggedRef = useRef(false)
  function startDrag(e, cell) {
    if (!modelMode) return
    if (e.target.closest('button')) return // les boutons ⇄ ↻ ✕ gardent leur clic
    const startX = e.clientX, startY = e.clientY
    dragRef.current = { k: cell.k, x: cell.x, y: cell.y, moved: false }
    const onMove = ev => {
      if (!dragRef.current) return
      if (!dragRef.current.moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 7) return
      const nx = Math.round((cell.x + (ev.clientX - startX) / scale) / SNAP) * SNAP
      const ny = Math.round((cell.y + (ev.clientY - startY) / scale) / SNAP) * SNAP
      dragRef.current = { k: cell.k, x: nx, y: ny, moved: true }
      setDrag({ k: cell.k, x: nx, y: ny })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (d?.moved) {
        justDraggedRef.current = true
        onMoveCell(d.k, d.x, d.y)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const roundBtn = (color) => ({ position: 'absolute', width: 20, height: 20, borderRadius: '50%', border: `1.5px solid ${color}`, background: 'white', color, fontSize: '.7rem', fontWeight: 700, lineHeight: 1, cursor: 'pointer', zIndex: 5, padding: 0 })

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: '.5rem' }}>
      {modelMode && (
        <div style={{ fontSize: '.78rem', color: 'var(--green-mid)', fontWeight: 600, textAlign: 'center' }}>
          🧱 Glisse une case pour la déplacer · ↻ pour la pivoter · "+" pour ajouter · ✕ pour retirer une case vide · chiffre en bas à droite = capacité par défaut (clique pour changer)
        </div>
      )}
      <div style={{ position: 'relative', width: canvasW, height: canvasH }}>
        {cells.map(cell => {
          const d = cellDims(cell)
          const pos = drag?.k === cell.k ? drag : cell
          const w = d.w * scale, h = d.h * scale
          const cellId = `${frigo.id}_${cell.k}`
          const hasData = cellSlotHasData(frigo, cellId)
          const prevision = previsionByCellId[cellId] || previsionByCellId[`${cellId}_L`] || previsionByCellId[`${cellId}_R`]
          return (
            <div key={cell.k}
              onPointerDown={e => startDrag(e, cell)}
              onClickCapture={e => { if (justDraggedRef.current) { justDraggedRef.current = false; e.preventDefault(); e.stopPropagation() } }}
              style={{
                position: 'absolute', left: (pos.x - originX) * scale, top: (pos.y - originY) * scale,
                width: w, height: h,
                touchAction: modelMode ? 'none' : undefined,
                cursor: modelMode ? 'grab' : undefined,
                zIndex: drag?.k === cell.k ? 20 : 1,
                opacity: drag?.k === cell.k ? .85 : 1,
              }}>
              <FrigoCellSlot frigo={frigo} cellId={cellId} k={cell.k} halfOnly={cell.h} cap={cell.cap}
                selectedCells={selectedCells} deleteMode={deleteMode}
                onCellClick={onCellClick} onCycleOrientation={onCycleOrientation}
                onToggleSplit={onToggleSplit} onKeepOneHalf={onKeepOneHalf} onRestoreFull={onRestoreFull}
                splitCells={splitCells}
                expandedSplitCells={expandedSplitCells} onToggleExpanded={onToggleExpanded}
                size={w} height={h}
                modelMode={modelMode} onSetCap={onSetCap} />
              {prevision && (
                <div title={`Prévision — ${prevision.client_nom || 'Sans nom'}${prevision.contrat_id ? ' (sous contrat)' : ' (hors contrat)'}`}
                  style={{
                    position: 'absolute', inset: -3, borderRadius: 10, pointerEvents: 'none', zIndex: 4,
                    border: `3px solid ${prevision.color}`, boxShadow: `0 0 0 2px ${prevision.color}33`,
                  }} />
              )}
              {modelMode && (
                <button onClick={e => { e.stopPropagation(); onRotateCell(cell.k) }}
                  title="Pivoter la case à 90°"
                  style={{ ...roundBtn('var(--green-mid)'), top: -7, left: -7 }}>↻</button>
              )}
              {modelMode && !hasData && cells.length > 1 && (
                <button onClick={e => { e.stopPropagation(); onRemoveCell(cell.k) }}
                  title="Retirer cette case du plan"
                  style={{ ...roundBtn('var(--red)'), top: -7, right: -7 }}>✕</button>
              )}
            </div>
          )
        })}
        {ghosts.map(s => (
          <button key={`ghost-${s.x}:${s.y}`} onClick={() => onAddCell(s.x, s.y)}
            title="Ajouter une case ici"
            style={{
              position: 'absolute', left: (s.x - originX) * scale, top: (s.y - originY) * scale,
              width: UNIT_W * scale, height: UNIT_H * scale,
              border: '2px dashed var(--green-accent)', borderRadius: 10,
              background: 'rgba(74,144,80,.06)', color: 'var(--green-mid)',
              fontSize: Math.max(18, size * .35), fontWeight: 700, cursor: 'pointer',
            }}>+</button>
        ))}
      </div>
    </div>
  )
}

// Frigos exclus du calcul de capacité prévisionnelle (stockage externe / hors
// norme 2T-palox — pas de sens d'y appliquer une capacité théorique 2T/palox).
// Comparaison normalisée (minuscules, sans accents ni ponctuation/espaces) pour
// rester robuste aux variations d'orthographe/casse du nom saisi.
const CAPACITE_PREVISIONNELLE_EXCLUS = ['exterieurvatry', 'exterieurnormee', 'exterieurlanguillat']
function normalizeFrigoName(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '')
}
function frigoExcluDeCapacite(name) {
  const n = normalizeFrigoName(name)
  return CAPACITE_PREVISIONNELLE_EXCLUS.some(k => n.includes(k))
}

/* Regroupe les cases occupées par variété + lot pour un récap lisible */
function groupCells(cellsObj) {
  const groups = {}
  Object.values(cellsObj).forEach(c => {
    const key = `${c.variety}|${c.lot || ''}`
    if (!groups[key]) groups[key] = { variety: c.variety, lot: c.lot, color: c.color, palox: 0, tonnage: 0, cases: 0 }
    groups[key].palox += c.palox || 0
    groups[key].tonnage += (c.palox || 0) * (c.poids_palox || 2)
    groups[key].cases += 1
  })
  return Object.values(groups).sort((a, b) => a.variety.localeCompare(b.variety))
}

function RecapView({ frigo }) {
  const groups = groupCells(frigo.cells)
  const cellsList = toFreeLayout(frigo)
  const totalCases = cellsList.length
  const occupiedCases = Object.keys(frigo.cells).length
  const totalPalox = groups.reduce((s, g) => s + g.palox, 0)
  const totalTonnage = groups.reduce((s, g) => s + g.tonnage, 0)
  // Prévisionnel = capacité totale du frigo en tonnage, à 2T/palox — en tenant
  // compte de la capacité par défaut réglée case par case (le petit chiffre
  // bleu sur une case vide, mode Modeler), pas juste 1 palox par case ; les
  // cases sans capacité réglée comptent pour 1 palox par défaut.
  const capacitePalox = cellsList.reduce((s, c) => s + (c.cap || 1), 0)
  const capaciteTonnage = capacitePalox * 2

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.7rem', marginBottom: '1.2rem' }}>
        <RecapKpi label="Cases occupées" value={`${occupiedCases} / ${totalCases}`} color="var(--green-mid)" />
        <RecapKpi label="Total palox" value={totalPalox} color="var(--blue)" />
        <RecapKpi label="Tonnage estimé" value={`${totalTonnage.toFixed(1)} T`} color="var(--green-deep)" />
        <RecapKpi label="Lots différents" value={groups.length} color="var(--amber)" />
      </div>
      {!frigoExcluDeCapacite(frigo.name) && (
      <div style={{ background: 'var(--amber-pale, #fef3c7)', border: '1px solid var(--amber)', borderRadius: 12, padding: '.8rem 1rem', marginBottom: '1.2rem', display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '1.3rem' }}>📈</div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 700, fontSize: '.85rem' }}>Prévisionnel — capacité totale à 2T/palox par défaut</div>
          <div style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>{totalCases} case{totalCases > 1 ? 's' : ''} · {capacitePalox} palox max · {Math.max(0, capaciteTonnage - totalTonnage).toFixed(1)} T restants</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--amber)' }}>{capaciteTonnage.toFixed(1)} T</div>
          <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>capacité prévisionnelle</div>
        </div>
      </div>
      )}
      {groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
          Ce frigo est vide.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
          {groups.map((g, i) => (
            <div key={i} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.7rem 1rem', display: 'flex', alignItems: 'center', gap: '.7rem' }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: g.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{g.variety}</div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{g.lot || 'Sans n° de lot'} · {g.cases} case{g.cases > 1 ? 's' : ''}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--green-mid)' }}>{g.palox}</div>
                <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>palox</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* Récap agrégé sur tous les frigos : totaux globaux, répartition par frigo, et par
   variété/lot tous frigos confondus (deux lots identiques dans deux frigos différents
   sont additionnés ensemble, comme dans RecapView pour un seul frigo). */
// Déduit un libellé lisible de case à partir de son cell_id brut (ex. "A1", "A1 (gauche)"
// pour une demi-case scindée) — le cell_id est préfixé par l'id du frigo, on retire ce préfixe.
function cellLabel(rawCellId, frigoId) {
  let rest = rawCellId.startsWith(frigoId + '_') ? rawCellId.slice(frigoId.length + 1) : rawCellId
  const isLeft = rest.endsWith('_L'), isRight = rest.endsWith('_R')
  const base = rest.replace(/_[LR]$/, '')
  return `Case ${base}${isLeft ? ' (gauche)' : isRight ? ' (droite)' : ''}`
}

function RecapGlobalView({ frigos }) {
  const list = Object.values(frigos)
  const allCellsFlat = list.flatMap(f => Object.values(f.cells))

  // Regroupe par variété+lot, en gardant la trace de chaque emplacement (frigo + case)
  const groupsMap = {}
  allCellsFlat.forEach(c => {
    const key = `${c.variety}|${c.lot || ''}`
    if (!groupsMap[key]) groupsMap[key] = { variety: c.variety, lot: c.lot, color: c.color, palox: 0, tonnage: 0, cases: 0, locations: [] }
    groupsMap[key].palox += c.palox || 0
    groupsMap[key].tonnage += (c.palox || 0) * (c.poids_palox || 2)
    groupsMap[key].cases += 1
    groupsMap[key].locations.push({ frigoName: frigos[c.frigo_id]?.name || '?', label: cellLabel(c.cell_id, c.frigo_id) })
  })
  const groups = Object.values(groupsMap).sort((a, b) => a.variety.localeCompare(b.variety))

  const totalPalox = groups.reduce((s, g) => s + g.palox, 0)
  const totalTonnage = groups.reduce((s, g) => s + g.tonnage, 0)
  const totalOccupied = allCellsFlat.length
  const totalCapacity = list.reduce((s, f) => s + (f.rows || 0) * (f.cols || 0), 0)

  // Prévisionnel = capacité totale en tonnage à 2T/palox, en tenant compte de
  // la capacité par défaut réglée case par case (le petit chiffre bleu sur une
  // case vide, mode Modeler) ; une case sans capacité réglée compte pour 1 palox.
  // Les frigos hors norme (stockage externe…) sont exclus de ce calcul.
  const perFrigo = list.map(f => {
    const capacity = (f.rows || 0) * (f.cols || 0)
    const exclu = frigoExcluDeCapacite(f.name)
    const capacitePalox = exclu ? 0 : toFreeLayout(f).reduce((s, c) => s + (c.cap || 1), 0)
    return {
      id: f.id, name: f.name,
      occupied: Object.keys(f.cells).length,
      capacity,
      capaciteTonnage: capacitePalox * 2,
      exclu,
      palox: Object.values(f.cells).reduce((s, c) => s + (c.palox || 0), 0),
    }
  }).sort((a, b) => a.name.localeCompare(b.name))
  const totalCapaciteTonnage = perFrigo.reduce((s, f) => s + f.capaciteTonnage, 0)

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.7rem', marginBottom: '1.4rem' }}>
        <RecapKpi label="Frigos" value={list.length} color="var(--stone,#5c6b54)" />
        <RecapKpi label="Cases occupées" value={`${totalOccupied} / ${totalCapacity}`} color="var(--green-mid)" />
        <RecapKpi label="Total palox" value={totalPalox} color="var(--blue)" />
        <RecapKpi label="Tonnage estimé" value={`${totalTonnage.toFixed(1)} T`} color="var(--green-deep)" />
        <RecapKpi label="Lots différents" value={groups.length} color="var(--amber)" />
        <RecapKpi label="📈 Capacité prévisionnelle" value={`${totalCapaciteTonnage.toFixed(1)} T`} color="var(--amber)" />
      </div>

      <div style={{ fontWeight: 700, fontSize: '.9rem', margin: '0 0 .6rem' }}>Par frigo</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '1.6rem' }}>
        {perFrigo.map(f => (
          <div key={f.id} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, fontWeight: 700, fontSize: '.85rem', minWidth: 100 }}>❄️ {f.name}</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{f.occupied} / {f.capacity} cases</div>
            {!f.exclu && (
              <div style={{ fontSize: '.72rem', color: 'var(--amber)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                📈 capacité {f.capaciteTonnage.toFixed(1)} T
              </div>
            )}
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.1rem', color: 'var(--green-mid)', minWidth: 70, textAlign: 'right' }}>
              {f.palox}<span style={{ fontSize: '.55rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginLeft: 4 }}>palox</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontWeight: 700, fontSize: '.9rem', margin: '0 0 .6rem' }}>Par lot (tous frigos confondus)</div>
      {groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
          Tous les frigos sont vides.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {groups.map((g, i) => (
            <div key={i} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.7rem 1rem', display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap' }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: g.color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{g.variety}{g.lot ? ` — ${g.lot}` : ''}</div>
                {!g.lot && <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>Sans n° de lot</div>}
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--green-mid)' }}>{g.palox}</div>
                <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>palox</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 70 }}>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--green-deep)' }}>{g.tonnage.toFixed(1)}</div>
                <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>tonnes</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RecapKpi({ label, value, color }) {
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '.8rem 1rem', borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: '.66rem', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.4rem', color }}>{value}</div>
    </div>
  )
}

/* Historique d'un frigo : par défaut le journal de CHAQUE saisie (case remplie /
   vidée, horodatée) ; l'instantané "état à une date" reste en second sous-onglet. */
function HistoriqueView({ date, setDate, cells, loading, frigoId, frigoName, onDeleted, histMode, setHistMode, journal, profileById, isAdmin, onDeleteMouvement, onDeleteMouvements }) {
  if (histMode === 'journal') {
    return (
      <div>
        <HistModeTabs histMode={histMode} setHistMode={setHistMode} />
        <JournalSaisies journal={journal} frigoId={frigoId} frigoName={frigoName} profileById={profileById} isAdmin={isAdmin} onDeleteMouvement={onDeleteMouvement} onDeleteMouvements={onDeleteMouvements} />
      </div>
    )
  }
  return (
    <div>
      <HistModeTabs histMode={histMode} setHistMode={setHistMode} />
      <HistoriqueEtatView date={date} setDate={setDate} cells={cells} loading={loading} frigoId={frigoId} frigoName={frigoName} onDeleted={onDeleted} />
    </div>
  )
}

function HistModeTabs({ histMode, setHistMode }) {
  return (
    <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
      {[['journal', '📒 Journal des saisies'], ['etat', '📅 État à une date']].map(([k, l]) => (
        <button key={k} onClick={() => setHistMode(k)} className="btn-sm"
          style={histMode === k ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>
          {l}
        </button>
      ))}
    </div>
  )
}

/* Le journal : chaque remplissage (entrée) et vidage (sortie) de case, un par
   un avec l'heure, regroupés par jour — du plus récent au plus ancien. */
function JournalSaisies({ journal, frigoId, frigoName, profileById = {}, isAdmin, onDeleteMouvement, onDeleteMouvements }) {
  const [selected, setSelected] = useState(new Set())
  function toggleSelected(id) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  async function deleteSelected() {
    await onDeleteMouvements?.([...selected])
    setSelected(new Set())
  }
  if (journal == null) {
    return <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>Chargement…</div>
  }
  if (journal.error) {
    return (
      <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 10, padding: '1rem', fontSize: '.85rem', color: '#9a3412' }}>
        {/does not exist|relation|could not find/i.test(journal.error)
          ? <>⚠️ Le journal n'est pas encore activé — exécute <strong>migration_A_EXECUTER_5.sql</strong> dans Supabase → SQL Editor, puis reviens ici.</>
          : journal.error}
      </div>
    )
  }
  if (!journal.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
        Aucune saisie enregistrée pour {frigoName}.
        <div style={{ fontSize: '.78rem', marginTop: '.4rem' }}>Chaque case remplie ou vidée apparaîtra ici automatiquement, avec la date et l'heure.</div>
      </div>
    )
  }
  const byDay = []
  const idx = {}
  journal.forEach(m => {
    const key = new Date(m.created_at).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    if (!(key in idx)) { idx[key] = byDay.length; byDay.push({ day: key, rows: [] }) }
    byDay[idx[key]].rows.push(m)
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
      {isAdmin && selected.size > 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: '.7rem',
          background: 'var(--red-pale, #fee2e2)', border: '1px solid #fecaca', borderRadius: 10, padding: '.5rem .9rem',
        }}>
          <strong style={{ fontSize: '.82rem', color: 'var(--red, #dc2626)' }}>{selected.size} ligne(s) sélectionnée(s)</strong>
          <button onClick={deleteSelected} className="btn-danger" style={{ padding: '.25rem .6rem', fontSize: '.76rem' }}>🗑️ Supprimer la sélection</button>
          <button onClick={() => setSelected(new Set())} className="btn-sm" style={{ padding: '.25rem .6rem', fontSize: '.76rem', marginLeft: 'auto' }}>Annuler</button>
        </div>
      )}
      {byDay.map(g => {
        const allDaySelected = g.rows.every(m => selected.has(m.id))
        return (
        <div key={g.day}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontWeight: 700, fontSize: '.84rem', marginBottom: '.4rem', textTransform: 'capitalize' }}>
            {isAdmin && (
              <input type="checkbox" checked={allDaySelected} title="Sélectionner toute la journée"
                onChange={() => setSelected(prev => {
                  const next = new Set(prev)
                  g.rows.forEach(m => allDaySelected ? next.delete(m.id) : next.add(m.id))
                  return next
                })}
              />
            )}
            {g.day} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {g.rows.length} saisie{g.rows.length > 1 ? 's' : ''}</span>
          </div>
          <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            {g.rows.map((m, i) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.5rem .9rem', fontSize: '.82rem', borderBottom: i < g.rows.length - 1 ? '1px solid var(--border)' : 'none', flexWrap: 'wrap',
                ...(selected.has(m.id) ? { background: 'var(--red-pale, #fee2e2)' } : {}) }}>
                {isAdmin && (
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggleSelected(m.id)} />
                )}
                <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', minWidth: 42 }}>
                  {new Date(m.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{
                  fontSize: '.68rem', fontWeight: 700, padding: '.15rem .5rem', borderRadius: 20,
                  background: m.action === 'sortie' ? 'var(--red-pale, #fee2e2)' : '#dcfce7',
                  color: m.action === 'sortie' ? 'var(--red, #dc2626)' : 'var(--green-mid)',
                }}>
                  {m.action === 'sortie' ? '− Sortie' : '+ Entrée'}
                </span>
                <span style={{ color: 'var(--text-muted)', minWidth: 84 }}>{cellLabel(m.cell_id, m.frigo_id)}</span>
                {m.color && <span style={{ width: 10, height: 10, borderRadius: 3, background: m.color, flexShrink: 0 }} />}
                <strong style={{ flex: 1, minWidth: 90 }}>{m.variety}</strong>
                <span style={{ color: 'var(--text-muted)' }}>{m.lot || 'Sans n° de lot'}</span>
                <span style={{ fontWeight: 700, color: m.action === 'sortie' ? 'var(--red, #dc2626)' : 'var(--green-mid)' }}>{m.palox} palox</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '.76rem' }}>
                  {m.identifiant_frigo ? `par ${m.identifiant_frigo}` : m.user_id ? `par ${profileById[m.user_id]?.display_name || '—'}` : ''}
                </span>
                {isAdmin && (
                  <button onClick={() => onDeleteMouvement?.(m.id)} title="Supprimer cette ligne"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.85rem', padding: '.1rem .3rem' }}>
                    🗑️
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        )
      })}
    </div>
  )
}

function HistoriqueEtatView({ date, setDate, cells, loading, frigoId, frigoName, onDeleted }) {
  const today = new Date().toISOString().split('T')[0]
  const forFrigo = (cells || []).filter(c => c.frigo_id === frigoId)
  const cellsObj = {}
  forFrigo.forEach(c => { cellsObj[c.cell_id] = c })
  const groups = groupCells(cellsObj)
  const totalPalox = groups.reduce((s, g) => s + g.palox, 0)

  async function deleteGroup(g) {
    if (!confirm(`Supprimer "${g.variety}${g.lot ? ' — ' + g.lot : ''}" de l'instantané du ${date} ?`)) return
    let q = supabase.from('cave_snapshots').delete().eq('frigo_id', frigoId).eq('snapshot_date', date).eq('variety', g.variety)
    q = g.lot ? q.eq('lot', g.lot) : q.is('lot', null)
    await q
    onDeleted?.()
  }

  async function deleteWholeSnapshot() {
    if (!confirm(`Supprimer tout l'instantané du ${date} pour ${frigoName} ? Cette action est irréversible.`)) return
    await supabase.from('cave_snapshots').delete().eq('frigo_id', frigoId).eq('snapshot_date', date)
    onDeleted?.()
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>Voir l'état du stock au :</label>
        <input type="date" value={date} max={today} onChange={e => setDate(e.target.value)}
          style={{ padding: '.4rem .7rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem' }} />
        {date === today && <span style={{ fontSize: '.72rem', color: 'var(--green-mid)', fontWeight: 600 }}>Aujourd'hui</span>}
        {forFrigo.length > 0 && (
          <button className="btn-sm" onClick={deleteWholeSnapshot} style={{ marginLeft: 'auto', color: 'var(--red)', borderColor: 'var(--red-pale)' }}>
            🗑️ Supprimer cet instantané
          </button>
        )}
      </div>
      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>Chargement…</div>
      ) : forFrigo.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
          Aucun instantané enregistré pour {frigoName} à cette date.
          {date === today && <div style={{ fontSize: '.78rem', marginTop: '.4rem' }}>Clique "📸 Enregistrer l'état du jour" pour en créer un maintenant.</div>}
        </div>
      ) : (
        <>
          <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
            <strong style={{ color: 'var(--green-mid)' }}>{totalPalox} palox</strong> répartis sur {forFrigo.length} case(s), {groups.length} lot(s)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
            {groups.map((g, i) => (
              <div key={i} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.7rem 1rem', display: 'flex', alignItems: 'center', gap: '.7rem' }}>
                <div style={{ width: 12, height: 12, borderRadius: 3, background: g.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{g.variety}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{g.lot || 'Sans n° de lot'} · {g.cases} case{g.cases > 1 ? 's' : ''}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--green-mid)' }}>{g.palox}</div>
                  <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>palox</div>
                </div>
                <button onClick={() => deleteGroup(g)} title="Supprimer ce lot de l'instantané"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.9rem', padding: '.2rem' }}
                  onMouseEnter={e => e.currentTarget.style.color = 'var(--red)'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--text-muted)'}>🗑️</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/* Choix d'un lot pour remplir la sélection de cases — plein écran, liste
   déroulante filtrable (au lieu de cartes côte à côte) pour scanner vite
   même avec beaucoup de lots différents. */
function ChoixLotPanel({ nbCases, fiches, onPick, onNew, onEdit, onDelete, onClose }) {
  const [q, setQ] = useState('')
  const filtered = q.trim()
    ? fiches.filter(f => `${f.variety} ${f.lot || ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : fiches

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 8000, background: 'white', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '.8rem 1rem', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '.6rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.5rem' }}>
          <span style={{ fontSize: '.9rem', fontWeight: 700 }}>📋 Choisis un lot — {nbCases} case(s)</span>
          <button onClick={onClose} className="btn-sm" style={{ padding: '.3rem .7rem', fontSize: '.8rem' }}>✕ Fermer</button>
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <input autoFocus type="text" value={q} onChange={e => setQ(e.target.value)} placeholder="🔍 Rechercher une variété, un n° de lot…"
            style={{ flex: 1, padding: '.6rem .9rem', fontSize: '.88rem', border: '1.5px solid var(--border)', borderRadius: 10 }} />
          <button onClick={onNew} className="btn-sm primary" style={{ padding: '.4rem .9rem', fontSize: '.82rem', flexShrink: 0 }}>+ Créer</button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {fiches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
            Aucune fiche créée — clique "+ Créer" pour en ajouter une.
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem 1.5rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
            Aucun lot ne correspond à "{q}".
          </div>
        ) : (
          groupFichesByVariety(filtered).map(([variety, group]) => (
            <div key={variety}>
              <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', padding: '.6rem 1.1rem .2rem', background: 'var(--cream)' }}>
                {variety} ({group.length})
              </div>
              {group.map(f => (
                <div key={f.id} onClick={() => onPick(f)}
                  style={{ display: 'flex', alignItems: 'center', gap: '.8rem', padding: '.9rem 1.1rem', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <span style={{ width: 14, height: 14, borderRadius: 4, background: f.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: '.92rem' }}>{f.variety}</div>
                    <div style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>{f.lot || 'Sans n° de lot'}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.2rem', color: 'var(--green-mid)' }}>{f.palox}</div>
                    <div style={{ fontSize: '.58rem', color: 'var(--text-muted)' }}>palox/case</div>
                  </div>
                  <div style={{ display: 'flex', gap: '.3rem', flexShrink: 0 }}>
                    <button onClick={e => { e.stopPropagation(); onEdit(f) }} title="Modifier"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.9rem', padding: '.2rem' }}>✏️</button>
                    {onDelete && (
                      <button onClick={e => { e.stopPropagation(); onDelete(f.id) }} title="Supprimer"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.9rem', padding: '.2rem' }}>🗑️</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function FicheCard({ fiche, onClick, onEdit, onDelete }) {
  const [showMenu, setShowMenu] = useState(false)
  return (
    <div
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); onDelete?.() }}
      style={{
        background: 'white', border: '2px solid var(--border)', borderRadius: 12,
        padding: '.9rem 1rem', cursor: 'pointer', position: 'relative', overflow: 'hidden',
        transition: 'border-color .15s, box-shadow .15s'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = fiche.color; setShowMenu(true) }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; setShowMenu(false) }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 5, background: fiche.color }} />
      <div style={{ marginTop: '.3rem', display: 'flex', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '.9rem' }}>{fiche.variety}</div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{fiche.lot || 'Sans n° de lot'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.4rem', color: 'var(--green-mid)' }}>{fiche.palox}</div>
          <div style={{ fontSize: '.58rem', color: 'var(--text-muted)' }}>palox/case</div>
        </div>
      </div>
      {showMenu && (onEdit || onDelete) && (
        <div style={{ display: 'flex', gap: '.4rem', marginTop: '.5rem' }}>
          {onEdit && <button onClick={(e) => { e.stopPropagation(); onEdit() }} style={{ fontSize: '.7rem', background: 'var(--cream)', border: 'none', borderRadius: 5, padding: '.2rem .5rem', cursor: 'pointer' }}>✏️ Modifier</button>}
          {onDelete && <button onClick={(e) => { e.stopPropagation(); onDelete() }} style={{ fontSize: '.7rem', background: 'var(--red-pale)', color: 'var(--red)', border: 'none', borderRadius: 5, padding: '.2rem .5rem', cursor: 'pointer' }}>🗑️ Supprimer</button>}
        </div>
      )}
      {onDelete && <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', marginTop: '.3rem', fontStyle: 'italic' }}>Clic droit pour supprimer rapidement</div>}
    </div>
  )
}

/* ── Première page du stockage : une carte par frigo (nom, remplissage, palox,
   lots) — cliquer une carte ouvre le frigo seul en pleine page. Le récap global
   (tous frigos confondus) reste accessible d'ici. ── */
function FrigoChooserPage({ frigos, isMobile, onOpen, onNew, onSnapshot }) {
  const [showGlobal, setShowGlobal] = useState(false)
  const list = Object.values(frigos)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base', numeric: true }))
  const totalPalox = list.reduce((s, f) => s + Object.values(f.cells).reduce((t, c) => t + (c.palox || 0), 0), 0)

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '1rem' : '1.4rem 1.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap', marginBottom: '1.1rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0 }}>❄️ Stockage frigos</h2>
        <span style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>
          {list.length} frigo{list.length > 1 ? 's' : ''} · {totalPalox} palox
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <button className="btn-sm" onClick={() => setShowGlobal(v => !v)}
            style={showGlobal ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>
            🌐 Récap global
          </button>
          <button className="btn-sm" onClick={onSnapshot} title="Force un instantané du stock à cet instant">📸 État du jour</button>
          {onNew && <button className="btn-sm primary" onClick={onNew}>+ Nouveau frigo</button>}
        </div>
      </div>

      {showGlobal ? (
        <RecapGlobalView frigos={frigos} />
      ) : list.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '3rem 1rem', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
          Aucun frigo créé — clique « + Nouveau frigo » pour commencer.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${isMobile ? 158 : 225}px, 1fr))`, gap: '.9rem' }}>
          {list.map(f => <FrigoCard key={f.id} frigo={f} onOpen={() => onOpen(f.id)} />)}
        </div>
      )}
    </div>
  )
}

function FrigoCard({ frigo, onOpen }) {
  const layout = toFreeLayout(frigo)
  const total = layout.length
  const occupied = layout.filter(c => cellSlotHasData(frigo, `${frigo.id}_${c.k}`)).length
  const palox = Object.values(frigo.cells).reduce((s, c) => s + (c.palox || 0), 0)
  const lots = groupCells(frigo.cells)
  const pct = total ? Math.round((occupied / total) * 100) : 0
  // Tonnage réel = ce qui est effectivement stocké aujourd'hui (poids réel saisi
  // par case, 2T/palox par défaut si non précisé) — évolue au fur et à mesure
  // que les frigos se remplissent.
  const tonnageReel = Object.values(frigo.cells).reduce((s, c) => s + (c.palox || 0) * (c.poids_palox || 2), 0)
  // Prévisionnel = capacité totale en tonnage à 2T/palox, en tenant compte de
  // la capacité par défaut réglée case par case (le petit chiffre bleu). Les
  // frigos hors norme (stockage externe…) sont exclus de ce calcul.
  const exclu = frigoExcluDeCapacite(frigo.name)
  const capacitePalox = layout.reduce((s, c) => s + (c.cap || 1), 0)
  const capaciteTonnage = capacitePalox * 2
  return (
    <div
      onClick={onOpen}
      style={{ background: 'white', border: '2px solid var(--border)', borderRadius: 14, padding: '1rem 1.1rem', cursor: 'pointer', transition: 'border-color .15s, box-shadow .15s, transform .12s' }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--green-mid)'; e.currentTarget.style.boxShadow = '0 6px 16px rgba(74,144,80,.15)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.transform = 'none' }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '.5rem' }}>
        <div style={{ fontWeight: 700, fontSize: '.98rem', wordBreak: 'break-word' }}>❄️ {frigo.name}</div>
        <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.3rem', color: 'var(--green-mid)', whiteSpace: 'nowrap', flexShrink: 0 }}>
          {palox}<span style={{ fontSize: '.55rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginLeft: 4 }}>palox</span>
        </div>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--cream)', border: '1px solid var(--border)', margin: '.65rem 0 .45rem', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, var(--green-accent), var(--green-mid))' }} />
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--text-muted)' }}>
        {occupied} / {total} cases occupées · {lots.length} lot{lots.length > 1 ? 's' : ''}
      </div>
      <div style={{ fontSize: '.74rem', color: 'var(--green-deep)', fontWeight: 600, marginTop: '.2rem' }}>
        🧊 Réel : {tonnageReel.toFixed(1)} T
      </div>
      {!exclu && (
        <div style={{ fontSize: '.74rem', color: 'var(--amber)', fontWeight: 600 }}>
          📈 Prévisionnel : {capaciteTonnage.toFixed(1)} T
        </div>
      )}
      {lots.length > 0 && (
        <div style={{ display: 'flex', gap: 4, marginTop: '.5rem', flexWrap: 'wrap' }}>
          {lots.slice(0, 12).map((g, i) => (
            <div key={i} title={`${g.variety}${g.lot ? ' — ' + g.lot : ''} · ${g.palox} palox`}
              style={{ width: 12, height: 12, borderRadius: 3, background: g.color }} />
          ))}
          {lots.length > 12 && <span style={{ fontSize: '.66rem', color: 'var(--text-muted)' }}>+{lots.length - 12}</span>}
        </div>
      )}
      <div style={{ marginTop: '.55rem', fontSize: '.72rem', color: 'var(--green-mid)', fontWeight: 600 }}>Ouvrir →</div>
    </div>
  )
}
