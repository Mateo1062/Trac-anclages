import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import L from 'leaflet'
import polygonClipping from 'polygon-clipping'
import { varietesPdtOf } from '../lib/varietesPdt'
import { cultureIcon, cultureColor } from '../lib/cultureCodes'
import { fmtDate } from '../lib/formatDate'

const FALLBACK_CENTER = [46.6, 2.4] // centre France

// Aire d'un polygone (lat/lng) en hectares — projection équirectangulaire
// centrée sur le polygone, précise à l'échelle d'une parcelle agricole
// (erreur négligeable sur quelques hectares, pas besoin d'une lib géodésique).
export function polygonAreaHa(latlngs) {
  if (!latlngs || latlngs.length < 3) return 0
  const lat0 = latlngs.reduce((s, p) => s + p.lat, 0) / latlngs.length
  const mPerLat = 110540, mPerLng = 111320 * Math.cos(lat0 * Math.PI / 180)
  const pts = latlngs.map(p => [p.lng * mPerLng, p.lat * mPerLat])
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]
    area += x1 * y2 - x2 * y1
  }
  return Math.abs(area / 2) / 10000
}

// Longueur d'une ligne (lat/lng) en mètres — même projection équirectangulaire
// simplifiée que polygonAreaHa, largement suffisante à l'échelle d'un réseau
// d'irrigation.
export function polylineLengthM(latlngs) {
  if (!latlngs || latlngs.length < 2) return 0
  const lat0 = latlngs.reduce((s, p) => s + p.lat, 0) / latlngs.length
  const mPerLat = 110540, mPerLng = 111320 * Math.cos(lat0 * Math.PI / 180)
  const pts = latlngs.map(p => [p.lng * mPerLng, p.lat * mPerLat])
  let d = 0
  for (let i = 0; i < pts.length - 1; i++) {
    d += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
  }
  return d
}

// ── Géométrie du contour d'une parcelle, pour contraindre le tracé de la zone
// traitée à l'intérieur : extraction des anneaux extérieurs (Polygon/MultiPolygon/
// Feature/FeatureCollection), test point-dans-polygone (ray casting) et projection
// du point le plus proche sur le contour quand on sort de la parcelle. ──
function extractRings(geojson) {
  if (!geojson) return []
  const type = geojson.type
  if (type === 'Polygon') return geojson.coordinates.length ? [geojson.coordinates[0]] : []
  if (type === 'MultiPolygon') return geojson.coordinates.map(poly => poly[0])
  if (type === 'Feature') return extractRings(geojson.geometry)
  if (type === 'FeatureCollection') return geojson.features.flatMap(f => extractRings(f.geometry))
  return []
}
function pointInRing([x, y], ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)
    if (intersect) inside = !inside
  }
  return inside
}
function closestPointOnSegment(p, a, b) {
  const [px, py] = p, [ax, ay] = a, [bx, by] = b
  const abx = bx - ax, aby = by - ay
  const denom = abx * abx + aby * aby
  const t = denom ? Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / denom)) : 0
  return [ax + t * abx, ay + t * aby]
}
function makeProjector(lat0) {
  const mPerLat = 110540, mPerLng = 111320 * Math.cos(lat0 * Math.PI / 180)
  return {
    toXY: ll => [ll.lng * mPerLng, ll.lat * mPerLat],
    toLatLng: ([x, y]) => L.latLng(y / mPerLat, x / mPerLng),
  }
}
// Ramène latlng à l'intérieur du contour (rings, projeté à lat0) : inchangé s'il y
// est déjà, sinon le point du bord le plus proche.
function clampToRings(latlng, rings, lat0) {
  if (!rings || !rings.length) return latlng
  const { toXY, toLatLng } = makeProjector(lat0)
  const p = toXY(latlng)
  if (rings.some(ring => pointInRing(p, ring.map(([lng, lat]) => toXY(L.latLng(lat, lng)))))) return latlng
  let best = null, bestD = Infinity
  for (const ring of rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = toXY(L.latLng(ring[i][1], ring[i][0]))
      const b = toXY(L.latLng(ring[i + 1][1], ring[i + 1][0]))
      const cand = closestPointOnSegment(p, a, b)
      const dx = cand[0] - p[0], dy = cand[1] - p[1], d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = cand }
    }
  }
  return best ? toLatLng(best) : latlng
}
const vertexIcon = L.divIcon({
  className: 'draw-vertex',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#ff9800;border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>',
  iconSize: [16, 16], iconAnchor: [8, 8],
})

const IRRIGATION_ICON = { bouche: '💧', vanne: '🚰', puits: '⛲' }
const IRRIGATION_LABEL = { bouche: 'Bouche d\'irrigation', vanne: 'Vanne', puits: 'Puits' }
// `moving` : rendu distinct (anneau ambre pulsant) une fois le déplacement
// explicitement activé via "🔀 Déplacer" dans le popup — sans ça, rien ne
// distingue visuellement un point qu'on peut faire glisser d'un point figé.
function irrigationDivIcon(type, moving = false) {
  return L.divIcon({
    className: 'irrigation-marker',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:white;border:2px solid ${moving ? '#d97e0a' : '#2980b9'};display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.35)${moving ? ',0 0 0 4px rgba(217,126,10,.35)' : ''};cursor:${moving ? 'grab' : 'pointer'}">${IRRIGATION_ICON[type] || '💧'}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  })
}

function interventionDivIcon(moving = false) {
  return L.divIcon({
    className: 'intervention-marker',
    html: `<div style="width:26px;height:26px;border-radius:50%;background:white;border:2px solid ${moving ? '#d97e0a' : '#e67e22'};display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 1px 4px rgba(0,0,0,.35)${moving ? ',0 0 0 4px rgba(217,126,10,.35)' : ''};cursor:${moving ? 'grab' : 'pointer'}">🔧</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  })
}

const ParcellesMap = forwardRef(function ParcellesMap({
  parcelles, onSelect, onSelectGroup, selectMode = false, selectedIds = null, onToggleSelect, drawMode = false, onZoneDrawn, drawBoundary = null, hideEntite = false, readOnly = false,
  hideDelimitations = false, groupesById = {}, groupClickSelectsAll = true,
  irrigationPoints = [], irrigationDrawMode = false, onAddIrrigationPoint, onSelectIrrigationPoint, onMoveIrrigationPoint, canEditIrrigation = true,
  irrigationLines = [], lineDrawMode = false, onLineDrawn, onSelectIrrigationLine,
  interventionPoints = [], interventionDrawMode = false, onAddInterventionPoint, onSelectInterventionPoint, onMoveInterventionPoint,
}, ref) {
  const mapRef = useRef(null)
  const containerRef = useRef(null)
  const layersRef = useRef({ geo: null })
  const layersByIdRef = useRef({}) // parcelle.id -> Leaflet layer, for restyling without a rebuild
  const irrigationLayerRef = useRef(null)
  const irrigationDrawModeRef = useRef(irrigationDrawMode)
  useEffect(() => { irrigationDrawModeRef.current = irrigationDrawMode }, [irrigationDrawMode])
  const onAddIrrigationPointRef = useRef(onAddIrrigationPoint)
  const onSelectIrrigationPointRef = useRef(onSelectIrrigationPoint)
  const onMoveIrrigationPointRef = useRef(onMoveIrrigationPoint)
  useEffect(() => { onAddIrrigationPointRef.current = onAddIrrigationPoint; onSelectIrrigationPointRef.current = onSelectIrrigationPoint; onMoveIrrigationPointRef.current = onMoveIrrigationPoint })

  // Points d'intervention libres (marquer un endroit précis, hors parcelle/outil)
  const interventionLayerRef = useRef(null)
  const interventionDrawModeRef = useRef(interventionDrawMode)
  useEffect(() => { interventionDrawModeRef.current = interventionDrawMode }, [interventionDrawMode])
  const onAddInterventionPointRef = useRef(onAddInterventionPoint)
  const onSelectInterventionPointRef = useRef(onSelectInterventionPoint)
  const onMoveInterventionPointRef = useRef(onMoveInterventionPoint)
  useEffect(() => { onAddInterventionPointRef.current = onAddInterventionPoint; onSelectInterventionPointRef.current = onSelectInterventionPoint; onMoveInterventionPointRef.current = onMoveInterventionPoint })

  // ── Réseau d'irrigation (lignes/tuyaux) — même principe que le dessin de zone
  // traitée (clic = point, glisser pour ajuster) mais SANS fermeture en polygone
  // et SANS contrainte au contour d'une parcelle (les tuyaux passent où ils
  // veulent). Les lignes déjà enregistrées sont dans leur propre calque,
  // affichable/masquable comme les points d'irrigation. ──
  const lineLayerRef = useRef(null)          // lignes déjà enregistrées (calque togglable)
  const lineMarkersLayerRef = useRef(null)   // sommets de la ligne EN COURS
  const linePreviewLayerRef = useRef(null)   // tracé de la ligne en cours (redessiné à chaque changement)
  const lineMarkersRef = useRef([])
  const linePointsRef = useRef([])
  const lineDrawModeRef = useRef(lineDrawMode)
  useEffect(() => { lineDrawModeRef.current = lineDrawMode; if (!lineDrawMode) clearLineDraw() }, [lineDrawMode])
  const onLineDrawnRef = useRef(onLineDrawn)
  const onSelectIrrigationLineRef = useRef(onSelectIrrigationLine)
  useEffect(() => { onLineDrawnRef.current = onLineDrawn; onSelectIrrigationLineRef.current = onSelectIrrigationLine })
  const lineDrawApiRef = useRef({ undo: () => {}, cancel: () => {}, finish: () => {} })

  function redrawLinePreview() {
    const layer = linePreviewLayerRef.current
    if (!layer) return
    layer.clearLayers()
    const pts = linePointsRef.current
    if (pts.length >= 2) L.polyline(pts, { color: '#2980b9', weight: 3, dashArray: '6,4' }).addTo(layer)
  }
  function clearLineDraw() {
    lineMarkersRef.current.forEach(m => lineMarkersLayerRef.current?.removeLayer(m))
    lineMarkersRef.current = []
    linePointsRef.current = []
    redrawLinePreview()
  }
  function emitLineProgress(extra) {
    onLineDrawnRef.current?.({ points: linePointsRef.current.length, done: false, ...extra })
  }
  function addLinePoint(latlng) {
    const marker = L.marker(latlng, { icon: vertexIcon, draggable: true })
    marker.on('drag', () => {
      const idx = lineMarkersRef.current.indexOf(marker)
      if (idx !== -1) linePointsRef.current[idx] = marker.getLatLng()
      redrawLinePreview()
    })
    marker.on('click', e => L.DomEvent.stopPropagation(e))
    marker.addTo(lineMarkersLayerRef.current)
    lineMarkersRef.current.push(marker)
    linePointsRef.current.push(latlng)
    redrawLinePreview()
    emitLineProgress()
  }
  lineDrawApiRef.current.undo = () => {
    const marker = lineMarkersRef.current.pop()
    if (marker) lineMarkersLayerRef.current?.removeLayer(marker)
    linePointsRef.current.pop()
    redrawLinePreview()
    emitLineProgress()
  }
  lineDrawApiRef.current.cancel = () => { clearLineDraw(); onLineDrawnRef.current?.(null) }
  lineDrawApiRef.current.finish = () => {
    const pts = linePointsRef.current
    if (pts.length < 2) return
    const lengthM = polylineLengthM(pts)
    const geojson = { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) }
    clearLineDraw()
    onLineDrawnRef.current?.({ done: true, geojson, lengthM })
  }

  // ── Dessin libre d'une ou plusieurs zones (surface traitée) : clic = ajoute
  // un sommet déplaçable (marker draggable) à la forme EN COURS, contraint au
  // contour de la parcelle (drawBoundary) s'il est connu — un point ne peut
  // donc jamais sortir du cadre réel de la parcelle. "Valider cette forme"
  // fige la forme en cours (polygone vert) et en démarre une nouvelle — utile
  // pour saisir plusieurs zones distinctes (bord de route, chemin, éoliennes…)
  // dans la même parcelle. Un panneau flottant (rendu par le composant
  // appelant) pilote Dernier point / Valider / Supprimer une forme / Terminer. ──
  const drawMarkersLayerRef = useRef(null)   // marqueurs des sommets de la forme EN COURS
  const drawShapeLayerRef = useRef(null)     // contour de la forme en cours (redessiné à chaque changement)
  const committedLayerRef = useRef(null)     // polygones déjà validés (figés, verts)
  const drawMarkersRef = useRef([])          // [L.Marker] — même ordre que drawPointsRef
  const drawPointsRef = useRef([])           // [L.LatLng] de la forme en cours
  const committedShapesRef = useRef([])      // [{ points:[L.LatLng], layer: L.Polygon }]
  const boundaryRingsRef = useRef([])
  const boundaryLatRef = useRef(46.6)
  // Glisser un sommet jusqu'à relâcher au-dessus du fond de carte fait remonter
  // un clic "fantôme" au conteneur (mousedown sur le marker, mouseup ailleurs —
  // le navigateur déclenche quand même 'click' sur l'ancêtre commun, ici la carte) ;
  // ce flag fait ignorer ce clic-là pour ne pas ajouter un point en trop.
  const suppressNextMapClickRef = useRef(false)
  const onZoneDrawnRef = useRef(onZoneDrawn)
  useEffect(() => { onZoneDrawnRef.current = onZoneDrawn })
  const drawApiRef = useRef({ undo: () => {}, cancel: () => {}, finish: () => {}, commitShape: () => {}, removeShapeAt: () => {} })

  useEffect(() => {
    const rings = extractRings(drawBoundary)
    boundaryRingsRef.current = rings
    if (rings.length && rings[0].length) boundaryLatRef.current = rings[0][0][1]
  }, [drawBoundary])

  function committedHa() {
    return committedShapesRef.current.reduce((s, sh) => s + polygonAreaHa(sh.points), 0)
  }
  function emitProgress(extra) {
    onZoneDrawnRef.current?.({
      points: drawPointsRef.current.length,
      shapes: committedShapesRef.current.length,
      shapesList: committedShapesRef.current.map(sh => ({ ha: polygonAreaHa(sh.points) })),
      committedHa: committedHa(),
      done: false,
      ...extra,
    })
  }
  function redrawShapeOnly() {
    const layer = drawShapeLayerRef.current
    if (!layer) return
    layer.clearLayers()
    const pts = drawPointsRef.current
    if (pts.length >= 2) L.polyline(pts, { color: '#ff9800', weight: 2, dashArray: '5,5' }).addTo(layer)
    if (pts.length >= 3) L.polygon(pts, { color: '#ff9800', weight: 2, fillColor: '#ff9800', fillOpacity: .2 }).addTo(layer)
  }
  function clearCurrentShape() {
    drawMarkersRef.current.forEach(m => drawMarkersLayerRef.current?.removeLayer(m))
    drawMarkersRef.current = []
    drawPointsRef.current = []
    redrawShapeOnly()
  }
  function clearAllDrawing() {
    clearCurrentShape()
    committedShapesRef.current.forEach(sh => committedLayerRef.current?.removeLayer(sh.layer))
    committedShapesRef.current = []
  }
  function addDrawPoint(latlng) {
    const clamped = clampToRings(latlng, boundaryRingsRef.current, boundaryLatRef.current)
    const marker = L.marker(clamped, { icon: vertexIcon, draggable: true })
    marker.on('drag', () => {
      const c = clampToRings(marker.getLatLng(), boundaryRingsRef.current, boundaryLatRef.current)
      if (!marker.getLatLng().equals(c)) marker.setLatLng(c)
      const idx = drawMarkersRef.current.indexOf(marker)
      if (idx !== -1) drawPointsRef.current[idx] = marker.getLatLng()
      redrawShapeOnly()
    })
    marker.on('dragend', () => {
      suppressNextMapClickRef.current = true
      emitProgress()
    })
    // Un simple clic (sans glisser) sur un sommet existant ne doit pas aussi
    // ajouter un nouveau point via le clic carte sous-jacent (bulle sinon).
    marker.on('click', e => L.DomEvent.stopPropagation(e))
    marker.addTo(drawMarkersLayerRef.current)
    drawMarkersRef.current.push(marker)
    drawPointsRef.current.push(clamped)
    redrawShapeOnly()
    emitProgress()
  }
  // Fige la forme en cours (≥ 3 points) en polygone vert non modifiable, et
  // repart de zéro pour une nouvelle forme — la parcelle peut ainsi recevoir
  // autant de zones distinctes que nécessaire (bord de route, chemin…).
  drawApiRef.current.commitShape = () => {
    const pts = drawPointsRef.current
    if (pts.length < 3) return false
    const layer = L.polygon(pts, { color: '#2ecc71', weight: 2, fillColor: '#2ecc71', fillOpacity: .25 }).addTo(committedLayerRef.current)
    committedShapesRef.current.push({ points: [...pts], layer })
    clearCurrentShape()
    emitProgress()
    return true
  }
  drawApiRef.current.removeShapeAt = (i) => {
    const sh = committedShapesRef.current[i]
    if (!sh) return
    committedLayerRef.current?.removeLayer(sh.layer)
    committedShapesRef.current.splice(i, 1)
    emitProgress()
  }
  drawApiRef.current.undo = () => {
    const marker = drawMarkersRef.current.pop()
    if (marker) drawMarkersLayerRef.current?.removeLayer(marker)
    drawPointsRef.current.pop()
    redrawShapeOnly()
    emitProgress()
  }
  drawApiRef.current.cancel = () => { clearAllDrawing(); onZoneDrawnRef.current?.(null) }
  drawApiRef.current.finish = () => {
    // La forme en cours (si valide) est automatiquement validée avant de terminer.
    if (drawPointsRef.current.length >= 3) drawApiRef.current.commitShape()
    const shapes = committedShapesRef.current
    if (!shapes.length) return
    const ha = committedHa()
    const geojson = { type: 'MultiPolygon', coordinates: shapes.map(sh => [[...sh.points.map(p => [p.lng, p.lat]), [sh.points[0].lng, sh.points[0].lat]]]) }
    onZoneDrawnRef.current?.({ shapes: shapes.length, ha, done: true, geojson })
  }
  useImperativeHandle(ref, () => ({
    undoLastPoint: () => drawApiRef.current.undo(),
    cancelDraw: () => drawApiRef.current.cancel(),
    finishDraw: () => drawApiRef.current.finish(),
    commitShape: () => drawApiRef.current.commitShape(),
    removeShapeAt: (i) => drawApiRef.current.removeShapeAt(i),
    undoLastLinePoint: () => lineDrawApiRef.current.undo(),
    cancelLineDraw: () => lineDrawApiRef.current.cancel(),
    finishLineDraw: () => lineDrawApiRef.current.finish(),
    // Pré-charge une ligne déjà enregistrée dans l'outil de tracé (mode
    // "modifier le tracé") : chaque point existant devient un sommet
    // déplaçable, comme s'il venait d'être posé — on peut ensuite en glisser,
    // en ajouter (clic sur la carte) ou en retirer (dernier point) avant de
    // "Terminer" pour enregistrer le nouveau tracé.
    seedLinePoints: (latlngs) => { latlngs.forEach(ll => addLinePoint(L.latLng(ll.lat, ll.lng))) },
    // Recentre/zoome sur une parcelle précise (venant d'ailleurs dans l'appli,
    // ex. "aller sur la carte" depuis la liste des parcelles) et ouvre son popup
    // — sert aussi à vérifier qu'une parcelle signalée "invisible" a bien une
    // forme quelque part, même hors du cadrage automatique global.
    focusParcelle: (id) => {
      const map = mapRef.current
      const layer = layersByIdRef.current[id]
      if (!map || !layer) return false
      const bounds = layer.getBounds?.()
      if (bounds?.isValid?.()) map.fitBounds(bounds, { padding: [80, 80], maxZoom: 17 })
      layer.openPopup?.(bounds?.getCenter?.())
      return true
    },
  }), [])

  const drawModeRef = useRef(drawMode)
  useEffect(() => {
    drawModeRef.current = drawMode
    if (!drawMode) clearAllDrawing()
    const el = containerRef.current
    if (el) el.style.cursor = (drawMode || irrigationDrawMode || lineDrawMode || interventionDrawMode) ? 'crosshair' : ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode, irrigationDrawMode, lineDrawMode, interventionDrawMode])

  // Callbacks passés en prop ne sont pas forcément stables d'un rendu à l'autre
  // (fonctions recréées à chaque rendu du parent) — on les lit toujours via ref
  // pour que la reconstruction des couches (et le fitBounds qui va avec) ne
  // dépende QUE de `parcelles`/`selectMode`, jamais d'un simple changement de
  // sélection (sinon la carte se dézoome à chaque clic).
  const onSelectRef = useRef(onSelect)
  const onToggleSelectRef = useRef(onToggleSelect)
  const onSelectGroupRef = useRef(onSelectGroup)
  useEffect(() => { onSelectRef.current = onSelect; onToggleSelectRef.current = onToggleSelect; onSelectGroupRef.current = onSelectGroup })
  // Lu au clic sur un groupe fusionné pour savoir si TOUS ses membres sont déjà
  // sélectionnés (voir plus bas) — même raison que les refs ci-dessus : le
  // gestionnaire de clic est attaché une fois à la construction des couches, il
  // ne doit jamais lire une sélection figée au moment de cette construction.
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => { selectedIdsRef.current = selectedIds })

  useEffect(() => {
    if (mapRef.current || !containerRef.current) return

    // preferCanvas : les parcelles (polygones GeoJSON) se dessinent sur un seul
    // <canvas> plutôt qu'un nœud SVG par forme — beaucoup plus fluide au
    // déplacement/zoom dès qu'il y a plusieurs dizaines de parcelles affichées.
    const map = L.map(containerRef.current, { zoomControl: true, preferCanvas: true }).setView(FALLBACK_CENTER, 6)

    // keepBuffer plus élevé que le défaut (2) : garde plus de tuiles déjà
    // chargées autour de la zone visible, pour qu'un déplacement révèle moins
    // souvent des zones vides le temps qu'elles se rechargent. updateWhenZooming
    // à false : attend la fin de l'animation de zoom pour charger les nouvelles
    // tuiles au lieu d'en charger en rafale pendant l'animation — visuellement
    // plus net, surtout sur les couches WMS (cadastre/RPG/BCAE) qui sont
    // beaucoup plus lentes à générer qu'une tuile PNG pré-calculée.
    const TILE_PERF = { keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false }

    const plan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap', maxZoom: 19, ...TILE_PERF,
    }).addTo(map)

    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri', maxZoom: 19, ...TILE_PERF,
    })

    // Orthophotos IGN (BD ORTHO, Géoplateforme) — prises de vue aériennes
    // françaises officielles, généralement plus récentes et en bien meilleure
    // résolution que la mosaïque mondiale Esri sur le territoire français (zoom
    // possible bien au-delà de 19). Même service que Cadastre/RPG/BCAE ci-dessous,
    // gratuit et sans clé — la meilleure alternative légale à "Google Earth"
    // (dont les tuiles ne sont pas librement réutilisables hors API payante).
    const satelliteIGN = L.tileLayer.wms('https://data.geopf.fr/wms-r/wms', {
      layers: 'ORTHOIMAGERY.ORTHOPHOTOS', format: 'image/jpeg', version: '1.3.0',
      attribution: 'IGN — Orthophotos (BD ORTHO)', maxZoom: 21, ...TILE_PERF,
    })

    const cadastre = L.tileLayer.wms('https://data.geopf.fr/wms-r/wms', {
      layers: 'CADASTRALPARCELS.PARCELLAIRE_EXPRESS',
      format: 'image/png', transparent: true, version: '1.3.0',
      attribution: 'IGN — Cadastre', ...TILE_PERF,
    })

    // Couches vectorielles agricoles (mêmes données que MesParcelles — service Géoplateforme IGN)
    const rpg = L.tileLayer.wms('https://data.geopf.fr/wms-r/wms', {
      layers: 'LANDUSE.AGRICULTURE.LATEST',
      format: 'image/png', transparent: true, version: '1.3.0',
      attribution: 'IGN — RPG', ...TILE_PERF,
    })
    const bcae = L.tileLayer.wms('https://data.geopf.fr/wms-r/wms', {
      layers: 'HYDROGRAPHY.BCAE.LATEST',
      format: 'image/png', transparent: true, version: '1.3.0',
      attribution: 'IGN — Bandes tampons BCAE', ...TILE_PERF,
    })

    // Points d'irrigation (bouches, vannes, puits) : calque à part, affiché/masqué
    // via sa propre case dans ce même panneau — comme Cadastre/RPG/BCAE, Leaflet
    // gère l'affichage/masquage tout seul dès qu'on l'enregistre comme "overlay".
    // Irrigation (points + réseau) masquée par défaut à l'ouverture de la carte —
    // à cocher explicitement dans le panneau des calques pour l'afficher.
    irrigationLayerRef.current = L.layerGroup()
    lineLayerRef.current = L.layerGroup()
    interventionLayerRef.current = L.layerGroup().addTo(map)

    L.control.layers(
      { '🗺️ Plan': plan, '🛰️ Satellite IGN (haute résolution)': satelliteIGN, '🛰️ Satellite Esri (monde)': satellite },
      {
        '📐 Cadastre officiel': cadastre,
        '🌾 RPG (registre parcellaire graphique)': rpg,
        '💧 Bandes tampons cours d\'eau (BCAE)': bcae,
        '💧 Points d\'irrigation': irrigationLayerRef.current,
        '🚰 Réseau d\'irrigation': lineLayerRef.current,
        '🔧 Points d\'intervention': interventionLayerRef.current,
      },
      { position: 'topright', collapsed: true }
    ).addTo(map)

    // Bouton "Me localiser" — vrai contrôle Leaflet (topleft, comme le zoom) : se
    // stack proprement sous les boutons +/- zoom, sans jamais chevaucher les
    // autres boutons flottants (Quitter mode Intervention, etc., ajoutés ailleurs
    // en position absolue dans d'autres coins).
    const LocateControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control')
        const btn = L.DomUtil.create('a', '', container)
        btn.href = '#'
        btn.title = 'Me localiser'
        btn.innerHTML = '📍'
        btn.style.cssText = 'width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-size:1.05rem;'
        L.DomEvent.disableClickPropagation(container)
        L.DomEvent.on(btn, 'click', e => {
          L.DomEvent.preventDefault(e)
          map.locate({ setView: true, maxZoom: 17, enableHighAccuracy: true })
        })
        return container
      },
    })
    new LocateControl().addTo(map)

    let userMarker = null, userAccuracy = null
    map.on('locationfound', e => {
      if (userMarker) { userMarker.setLatLng(e.latlng); userAccuracy.setLatLng(e.latlng).setRadius(e.accuracy) }
      else {
        userAccuracy = L.circle(e.latlng, { radius: e.accuracy, color: '#3498db', weight: 1, fillOpacity: .08 }).addTo(map)
        userMarker = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 2, fillColor: '#3498db', fillOpacity: 1 })
          .addTo(map).bindPopup('📍 Vous êtes ici')
      }
    })
    map.on('locationerror', e => alert("Impossible de récupérer votre position : " + e.message))

    mapRef.current = map
    // Sur mobile, le conteneur de la carte n'a pas toujours sa taille finale au
    // moment où Leaflet l'initialise (mise en page flex encore en cours) — les
    // calques ajoutés ensuite (points/lignes d'irrigation…) peuvent alors se
    // positionner sur un référentiel de taille erroné et sembler ne pas
    // s'afficher. On force un recalcul une fois la mise en page stabilisée.
    setTimeout(() => map.invalidateSize(), 250)
    layersRef.current.geo = L.featureGroup().addTo(map)
    committedLayerRef.current = L.featureGroup().addTo(map)
    drawShapeLayerRef.current = L.featureGroup().addTo(map)
    drawMarkersLayerRef.current = L.layerGroup().addTo(map)
    lineMarkersLayerRef.current = L.layerGroup().addTo(map)
    linePreviewLayerRef.current = L.featureGroup().addTo(map)

    map.on('click', e => {
      if (lineDrawModeRef.current) { addLinePoint(e.latlng); return }
      if (irrigationDrawModeRef.current) { onAddIrrigationPointRef.current?.(e.latlng); return }
      if (interventionDrawModeRef.current) { onAddInterventionPointRef.current?.(e.latlng); return }
      if (!drawModeRef.current) return
      if (suppressNextMapClickRef.current) { suppressNextMapClickRef.current = false; return }
      addDrawPoint(e.latlng)
    })

    return () => { map.remove(); mapRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Points d'irrigation (bouches, vannes, puits) — reconstruit le calque à
  // chaque changement de données ; clic sur un point ouvre un popup (comme les
  // parcelles) avec son détail et un lien "✏️ Modifier" (sauf pendant le
  // placement d'un nouveau point, pour ne pas interférer). Déclaré APRÈS
  // l'effet de montage ci-dessus : irrigationLayerRef n'existe qu'une fois
  // celui-ci exécuté — sinon (effet déclaré avant) rien ne s'affiche tant
  // qu'`irrigationPoints` n'a pas changé au moins une fois après le montage.
  useEffect(() => {
    const layer = irrigationLayerRef.current
    if (!layer) return
    layer.clearLayers()
    irrigationPoints.forEach(p => {
      // Non déplaçable par défaut — le glisser-déposer direct provoquait des
      // déplacements accidentels au moindre missclick. Il faut explicitement
      // passer par "🔀 Déplacer" dans le popup pour activer le glissé, qui se
      // redésactive tout seul juste après (un seul déplacement par activation).
      const marker = L.marker([p.lat, p.lng], { icon: irrigationDivIcon(p.type), draggable: false })
      if (canEditIrrigation) {
        marker.on('dragend', () => {
          marker.dragging.disable()
          marker.setIcon(irrigationDivIcon(p.type))
          onMoveIrrigationPointRef.current?.(p, marker.getLatLng())
        })
      }
      marker.bindPopup(`
        <strong>${IRRIGATION_ICON[p.type] || '💧'} ${escapeHtml(IRRIGATION_LABEL[p.type] || p.type)}</strong><br/>
        ${p.nom ? `${escapeHtml(p.nom)}<br/>` : ''}
        ${p.notes ? `<span style="color:#888">${escapeHtml(p.notes)}</span><br/>` : ''}
        📍 ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}<br/>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">
          <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noreferrer">🗺️ Ouvrir dans Google Maps</a>
          ${canEditIrrigation ? `<a href="#" data-id="${p.id}" class="irrigation-point-edit">✏️ Modifier</a>` : ''}
          ${canEditIrrigation ? `<a href="#" data-id="${p.id}" class="irrigation-point-move">🔀 Déplacer</a>` : ''}
        </div>
      `)
      if (canEditIrrigation) {
        marker.on('popupopen', (e) => {
          const el = e.popup.getElement().querySelector('.irrigation-point-edit')
          if (el) el.addEventListener('click', (ev) => { ev.preventDefault(); marker.closePopup(); onSelectIrrigationPointRef.current?.(p) })
          const elMove = e.popup.getElement().querySelector('.irrigation-point-move')
          if (elMove) elMove.addEventListener('click', (ev) => {
            ev.preventDefault()
            marker.closePopup()
            marker.dragging.enable()
            marker.setIcon(irrigationDivIcon(p.type, true))
          })
        })
      }
      marker.on('click', () => { if (irrigationDrawModeRef.current) marker.closePopup() })
      marker.addTo(layer)
    })
  }, [irrigationPoints, canEditIrrigation])

  // Réseau d'irrigation (lignes/tuyaux déjà enregistrés) — même remarque que
  // ci-dessus : déclaré après l'effet de montage.
  useEffect(() => {
    const layer = lineLayerRef.current
    if (!layer) return
    layer.clearLayers()
    irrigationLines.forEach(l => {
      const coords = l.geometrie?.coordinates
      if (!Array.isArray(coords) || coords.length < 2) return
      const latlngs = coords.map(([lng, lat]) => [lat, lng])
      const poly = L.polyline(latlngs, { color: l.couleur || '#2980b9', weight: 3 })
      if (canEditIrrigation) poly.on('click', () => { if (!lineDrawModeRef.current) onSelectIrrigationLineRef.current?.(l) })
      poly.addTo(layer)
    })
  }, [irrigationLines, canEditIrrigation])

  // Points d'intervention libres (marquer un endroit précis, hors parcelle/outil)
  // — même remarque que ci-dessus : déclaré après l'effet de montage.
  useEffect(() => {
    const layer = interventionLayerRef.current
    if (!layer) return
    layer.clearLayers()
    interventionPoints.forEach(p => {
      // Non déplaçable par défaut (voir même remarque sur les points d'irrigation
      // plus haut) — passe par "🔀 Déplacer" dans le popup pour activer le glissé.
      const marker = L.marker([p.lat, p.lng], { icon: interventionDivIcon(), draggable: false })
      marker.on('dragend', () => {
        marker.dragging.disable()
        marker.setIcon(interventionDivIcon())
        onMoveInterventionPointRef.current?.(p, marker.getLatLng())
      })
      marker.bindPopup(`
        <strong>🔧 ${escapeHtml(p.description || 'Intervention')}</strong><br/>
        ${p.date_intervention ? `📅 ${fmtDate(p.date_intervention)}<br/>` : ''}
        ${p.notes ? `<span style="color:#888">${escapeHtml(p.notes)}</span><br/>` : ''}
        📍 ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}<br/>
        <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">
          <a href="https://www.google.com/maps?q=${p.lat},${p.lng}" target="_blank" rel="noreferrer">🗺️ Ouvrir dans Google Maps</a>
          <a href="#" data-id="${p.id}" class="intervention-point-edit">✏️ Modifier</a>
          <a href="#" data-id="${p.id}" class="intervention-point-move">🔀 Déplacer</a>
        </div>
      `)
      marker.on('popupopen', (e) => {
        const el = e.popup.getElement().querySelector('.intervention-point-edit')
        if (el) el.addEventListener('click', (ev) => { ev.preventDefault(); marker.closePopup(); onSelectInterventionPointRef.current?.(p) })
        const elMove = e.popup.getElement().querySelector('.intervention-point-move')
        if (elMove) elMove.addEventListener('click', (ev) => {
          ev.preventDefault()
          marker.closePopup()
          marker.dragging.enable()
          marker.setIcon(interventionDivIcon(true))
        })
      })
      marker.on('click', () => { if (interventionDrawModeRef.current) marker.closePopup() })
      marker.addTo(layer)
    })
  }, [interventionPoints])

  // Construit les formes (une fois par changement de données ou de mode) et cadre
  // la vue sur l'ensemble — volontairement INDÉPENDANT de la sélection en cours,
  // pour ne pas dézoomer la carte à chaque clic sur une parcelle en mode Intervention.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const group = layersRef.current.geo
    group.clearLayers()
    layersByIdRef.current = {}

    const withGeo = parcelles.filter(p => p.geometrie)
    // Regroupe les parcelles selon le groupe manuel choisi par un admin/manager
    // (parcelle.groupe_id) pour masquer les délimitations entre elles — juste
    // l'affichage carte, le reste de l'appli continue de les traiter
    // individuellement (voir buildManualParcelleGroups).
    const parcelleGroups = hideDelimitations ? buildManualParcelleGroups(withGeo, groupesById) : {}
    const doneGroups = new Set()

    withGeo.forEach(p => {
      const color = cultureColor(p.culture_actuelle)
      const grp = parcelleGroups[p.id]

      if (grp) {
        // ── Groupe fusionné : le remplissage visible est dessiné UNE SEULE fois
        // par groupe, comme un vrai polygone fusionné (union géométrique réelle
        // des contours, pas juste des contours empilés sans bordure) — sans ça,
        // une fine ligne reste visible entre les parcelles à certains niveaux de
        // zoom (chaque contour est ré-anti-aliasé séparément). Un clic sélectionne
        // TOUTES les parcelles du groupe d'un coup (une intervention posée sur un
        // groupe s'applique à chacune de ses vraies parcelles, voir Carte.jsx) —
        // ces utilisateurs ne voient jamais le détail individuel, il n'y a donc
        // pas de sens à choisir un seul membre en particulier.
        if (!doneGroups.has(grp)) {
          doneGroups.add(grp)
          const memberIds = grp.members.map(m => m.id)
          const unionGeom = unionGeometries(grp.members)
          const baseLayer = L.geoJSON(unionGeom || grp.members[0].geometrie, {
            style: { color, weight: 0, fillColor: color, fillOpacity: .25 },
          })
          baseLayer.options.__baseColor = color
          baseLayer.options.__isGroupBase = true
          if (selectMode) {
            baseLayer.bindTooltip(escapeHtml(grp.displayName), { permanent: true, direction: 'center', className: 'parcelle-label' })
            baseLayer.on('click', () => {
              if (drawModeRef.current) return
              // Mode Heures d'arrachage : une seule vraie parcelle à la fois (le
              // formulaire ne sait saisir des heures que pour UNE parcelle) — on ne
              // fait pas le comportement "toute la zone d'un coup" dans ce cas,
              // sinon appeler onToggleSelect plusieurs fois à la suite ouvrirait
              // puis remplacerait la saisie d'heures plusieurs fois pour ne garder
              // que la dernière parcelle du groupe, au hasard de l'ordre.
              if (!groupClickSelectsAll) { onToggleSelectRef.current?.(memberIds[0]); return }
              const allSelected = memberIds.every(id => selectedIdsRef.current?.has(id))
              // Ajoute ou retire uniquement les ids qui doivent changer d'état —
              // toggleSelect ne fait que basculer un id à la fois, appeler la
              // fonction pour tous ferait un mélange sélectionné/non-sélectionné.
              memberIds.forEach(id => {
                const isSel = selectedIdsRef.current?.has(id)
                if (allSelected ? isSel : !isSel) onToggleSelectRef.current?.(id)
              })
            })
          } else {
            // Même présentation qu'une parcelle normale — pas de mention qu'il
            // s'agit en réalité de plusieurs parcelles réunies (voir Parcelles.jsx).
            baseLayer.bindPopup(`
              <strong>${escapeHtml(grp.displayName)}</strong><br/>
              ${grp.totalSurface.toFixed(2)} ha<br/>
              <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">
                <a href="#" class="parcelle-group-edit">${readOnly ? '👁️ Voir' : '✏️ Modifier'}</a>
              </div>
            `)
            baseLayer.on('popupopen', (e) => {
              const el = e.popup.getElement().querySelector('.parcelle-group-edit')
              if (el) el.addEventListener('click', (ev) => { ev.preventDefault(); onSelectGroupRef.current?.(grp.members) })
            })
          }
          baseLayer.addTo(group)
          // Même couche référencée sous chaque id membre — utilisée à la fois par
          // le recadrage (🗺️ Carte) et par le réapplique-style ci-dessous, qui doit
          // pouvoir la retrouver en surbrillance quel que soit l'id sélectionné.
          memberIds.forEach(id => { layersByIdRef.current[id] = baseLayer })
        }
        return
      }

      // ── Parcelle hors groupe (ou admin/manager, hideDelimitations=false) :
      // comportement inchangé, un seul vrai contour individuel.
      const layer = L.geoJSON(p.geometrie, {
        style: { color, weight: 2, fillColor: color, fillOpacity: .25 },
      })
      layer.options.__baseColor = color
      if (selectMode) {
        // Nom visible en permanence sur la parcelle (pas seulement au survol) pour
        // se repérer facilement pendant la sélection. Pour l'admin/manager (qui voit
        // toujours le détail individuel, hideDelimitations=false), un suffixe indique
        // qu'une parcelle appartient déjà à un groupe — utile en mode Groupes pour
        // savoir laquelle renommer/compléter plutôt que d'en recréer un par erreur.
        const groupSuffix = !hideDelimitations && p.groupe_id && groupesById[p.groupe_id] ? ` 🔗${groupesById[p.groupe_id].nom}` : ''
        layer.bindTooltip(escapeHtml(p.nom + groupSuffix), { permanent: true, direction: 'center', className: 'parcelle-label' })
        // Pendant le dessin de la zone traitée, un clic sur une parcelle ne doit
        // pas (dé)sélectionner — il ajoute un sommet au tracé (géré par le clic carte).
        layer.on('click', () => { if (!drawModeRef.current) onToggleSelectRef.current?.(p.id) })
      } else {
        // Point GPS : centre de l'emprise de la parcelle (bounding box) — suffisant
        // pour retrouver le champ sur Google Maps, pas besoin d'un vrai centroïde.
        const center = layer.getBounds?.()
        const gps = center?.isValid?.() ? center.getCenter() : null
        const varietes = varietesPdtOf(p)
        const varietesHtml = varietes.length
          ? varietes.map(v => {
              const extra = [v.surface != null ? `${v.surface} ha` : null, v.cote ? `côté ${v.cote}` : null].filter(Boolean).join(' · ')
              return `🥔 ${escapeHtml(v.variete)}${extra ? ` <span style="color:#888">(${escapeHtml(extra)})</span>` : ''}<br/>`
            }).join('')
          : (p.culture_actuelle ? `${cultureIcon(p.culture_actuelle)} ${escapeHtml(p.culture_actuelle)}<br/>` : '')
        layer.bindPopup(`
          <strong>${escapeHtml(p.nom)}</strong><br/>
          ${varietesHtml}
          ${p.surface != null ? `${p.surface} ha<br/>` : ''}
          ${!hideEntite && p.entite ? `${escapeHtml(p.entite)}<br/>` : ''}
          ${gps ? `📍 ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}<br/>` : ''}
          <div style="margin-top:6px;display:flex;flex-direction:column;gap:2px">
            ${gps ? `<a href="https://www.google.com/maps?q=${gps.lat},${gps.lng}" target="_blank" rel="noreferrer">🗺️ Ouvrir dans Google Maps</a>` : ''}
            <a href="#" data-id="${p.id}" class="parcelle-map-edit">${readOnly ? '👁️ Voir' : '✏️ Modifier'}</a>
          </div>
        `)
        layer.on('popupopen', (e) => {
          const el = e.popup.getElement().querySelector('.parcelle-map-edit')
          if (el) el.addEventListener('click', (ev) => { ev.preventDefault(); onSelectRef.current?.(p) })
        })
      }
      layer.addTo(group)
      layersByIdRef.current[p.id] = layer
    })

    if (withGeo.length > 0) {
      const bounds = group.getBounds()
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelles, selectMode, hideEntite, readOnly, hideDelimitations, groupesById])

  // Ré-applique juste le style (couleur/épaisseur) des parcelles sélectionnées,
  // sans reconstruire les couches ni retoucher au cadrage/zoom de la carte.
  useEffect(() => {
    if (!selectMode) return
    const layers = layersByIdRef.current
    const done = new Set() // une base de groupe est référencée sous plusieurs ids — ne la restyler qu'une fois
    for (const [id, layer] of Object.entries(layers)) {
      if (done.has(layer)) continue
      done.add(layer)
      const isSelected = selectedIds?.has(id)
      layer.setStyle(isSelected
        ? { color: '#ff9800', weight: 4, fillColor: '#ff9800', fillOpacity: .5 }
        : { color: layer.options.__baseColor, weight: layer.options.__isGroupBase ? 0 : 2, fillColor: layer.options.__baseColor, fillOpacity: .25 })
      const tooltip = layer.getTooltip()
      if (tooltip) tooltip.setContent(`${isSelected ? '✅ ' : ''}${tooltip.getContent().replace(/^✅ /, '')}`)
    }
  }, [selectedIds, selectMode])

  const withGeoCount = parcelles.filter(p => p.geometrie).length

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      {withGeoCount === 0 && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
          background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem',
          fontSize: '.82rem', color: 'var(--text-muted)', boxShadow: 'var(--shadow-md)', maxWidth: 340, textAlign: 'center',
        }}>
          Aucun contour de parcelle importé — utilisez "📐 Importer Shapefile" pour afficher vos vraies parcelles ici.
        </div>
      )}
    </div>
  )
})

export default ParcellesMap

// Regroupement visuel manuel des parcelles (voir parcelle_groupes / parcelle.
// groupe_id, assigné depuis la Carte par un admin/manager) — masque les
// délimitations entre les membres d'un même groupe et affiche le nom du groupe
// à la place des noms individuels. Uniquement l'affichage carte (voir
// hideDelimitations) : le reste de l'appli continue de traiter chaque parcelle
// individuellement. Un groupe retombé à 1 seul membre (après un retrait) est
// ignoré ici — pas de nettoyage serveur nécessaire.
function buildManualParcelleGroups(parcelles, groupesById) {
  const byGroupeId = new Map()
  for (const p of parcelles) {
    if (!p.groupe_id) continue
    if (!byGroupeId.has(p.groupe_id)) byGroupeId.set(p.groupe_id, [])
    byGroupeId.get(p.groupe_id).push(p)
  }
  const byId = {}
  for (const [groupeId, members] of byGroupeId) {
    if (members.length < 2) continue
    const displayName = groupesById[groupeId]?.nom || members[0].nom
    const totalSurface = members.reduce((s, m) => s + (parseFloat(m.surface) || 0), 0)
    for (const m of members) byId[m.id] = { members, displayName, totalSurface }
  }
  return byId
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]))
}

// polygon-clipping attend chaque géométrie sous forme de "MultiPolygon" —
// un tableau de polygones, chacun un tableau d'anneaux, chaque anneau un
// tableau de [lng, lat] — structurellement identique à GeoJSON MultiPolygon.
// coordinates, donc un Polygon GeoJSON doit juste être enveloppé une fois.
function toClipperCoords(geom) {
  if (geom?.type === 'Polygon') return [geom.coordinates]
  if (geom?.type === 'MultiPolygon') return geom.coordinates
  return []
}
// Union géométrique réelle des contours d'un groupe de parcelles — pour que
// leur zone fusionnée soit UN SEUL polygone sans arête interne, quel que soit
// le niveau de zoom (empiler des contours voisins sans bordure laisse presque
// toujours une fine ligne visible en zoomant, chaque contour étant ré-anti-
// aliasé séparément). Renvoie null si le calcul échoue (topologie invalide sur
// des contours numérisés indépendamment) — le composant retombe alors sur le
// contour du premier membre plutôt que de planter.
function unionGeometries(members) {
  const geoms = members.map(m => toClipperCoords(m.geometrie)).filter(g => g.length)
  if (!geoms.length) return null
  if (geoms.length === 1) return { type: 'MultiPolygon', coordinates: geoms[0] }
  try {
    const coordinates = polygonClipping.union(geoms[0], ...geoms.slice(1))
    return { type: 'MultiPolygon', coordinates }
  } catch (e) {
    console.error('Union des contours de groupe échouée :', e)
    return null
  }
}

// Convertit un anneau XY (mètres, projection équirectangulaire locale) en
// anneau GeoJSON lng/lat fermé (premier point répété en dernier) — ne double
// pas la fermeture si l'anneau d'entrée (sortie de polygon-clipping) l'est déjà.
function ringToGeoJSON(ring, toLatLng) {
  const pts = ring.map(([x, y]) => { const ll = toLatLng([x, y]); return [ll.lng, ll.lat] })
  const first = pts[0], last = pts[pts.length - 1]
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) pts.push(first)
  return pts
}
// Point le plus loin dans la direction from→through, prolongé de `dist` au-delà
// de `through` — sert à étendre la ligne de coupe bien au-delà du contour réel,
// pour que le point exact où l'utilisateur a cliqué (pile sur le bord ou pas)
// n'ait pas d'importance : seule la DIRECTION de la ligne compte.
function extendPoint(from, through, dist) {
  const dx = through[0] - from[0], dy = through[1] - from[1]
  const len = Math.hypot(dx, dy) || 1
  return [through[0] + (dx / len) * dist, through[1] + (dy / len) * dist]
}
// Découpe le contour d'une parcelle (Polygon/MultiPolygon GeoJSON) par une
// ligne tracée librement sur la carte (2 points ou plus) — technique du "plan
// de coupe" : la ligne (prolongée très loin à ses deux extrémités) sert de
// bord commun à deux immenses rectangles couvrant chacun un côté de la carte ;
// l'intersection de chaque rectangle avec le contour d'origine donne les
// morceaux de ce côté-là. Si le contour est concave au point qu'un côté se
// retrouve coupé en plusieurs morceaux disjoints, chacun est renvoyé comme un
// morceau séparé (plus de 2 au total) plutôt que d'être artificiellement
// recollé en un seul MultiPolygon — chaque bout redevient sa propre parcelle.
// Renvoie null si la ligne ne coupe pas réellement le contour en ≥2 morceaux.
export function splitPolygonByLine(geometrie, linePoints) {
  if (!linePoints || linePoints.length < 2) return null
  const subjectPolys = toClipperCoords(geometrie)
  if (!subjectPolys.length) return null

  const allLngLat = subjectPolys.flat(2)
  if (!allLngLat.length) return null
  const lat0 = allLngLat.reduce((s, [, lat]) => s + lat, 0) / allLngLat.length
  const { toXY, toLatLng } = makeProjector(lat0)

  const subjectXY = subjectPolys.map(poly => poly.map(ring => ring.map(([lng, lat]) => toXY(L.latLng(lat, lng)))))
  const lineXY = linePoints.map(pt => toXY(pt))

  const xs = subjectXY.flat(2).map(p => p[0]), ys = subjectXY.flat(2).map(p => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const diag = Math.hypot(maxX - minX, maxY - minY)
  const BIG = Math.max(diag * 5, 1000) // marge très généreuse (≥1 km), quelle que soit la taille de la parcelle

  const p0 = lineXY[0], pN = lineXY[lineXY.length - 1]
  let dx = pN[0] - p0[0], dy = pN[1] - p0[1]
  const dlen = Math.hypot(dx, dy) || 1
  dx /= dlen; dy /= dlen
  const nx = -dy, ny = dx // perpendiculaire à la direction générale de la ligne

  const extStart = lineXY.length > 1 ? extendPoint(lineXY[1], lineXY[0], BIG) : lineXY[0]
  const extEnd = lineXY.length > 1 ? extendPoint(lineXY[lineXY.length - 2], lineXY[lineXY.length - 1], BIG) : lineXY[0]
  const extendedLine = [extStart, ...lineXY, extEnd]

  const sideA = [...extendedLine, [extEnd[0] + nx * BIG, extEnd[1] + ny * BIG], [extStart[0] + nx * BIG, extStart[1] + ny * BIG]]
  const sideB = [...extendedLine, [extEnd[0] - nx * BIG, extEnd[1] - ny * BIG], [extStart[0] - nx * BIG, extStart[1] - ny * BIG]]

  let piecesA, piecesB
  try {
    piecesA = polygonClipping.intersection(subjectXY, [[[...sideA, sideA[0]]]])
    piecesB = polygonClipping.intersection(subjectXY, [[[...sideB, sideB[0]]]])
  } catch (e) {
    console.error('Découpe de parcelle échouée :', e)
    return null
  }
  const totalPieces = (piecesA?.length || 0) + (piecesB?.length || 0)
  if (totalPieces < 2) return null // la ligne ne traverse pas vraiment le contour

  const result = [...(piecesA || []), ...(piecesB || [])].map(poly => {
    const rings = poly.map(ring => ringToGeoJSON(ring, toLatLng))
    const geometry = { type: 'Polygon', coordinates: rings }
    const latlngs = rings[0].map(([lng, lat]) => L.latLng(lat, lng))
    return { geometry, areaHa: polygonAreaHa(latlngs) }
  }).filter(p => p.areaHa > 0.001) // ignore les miettes numériques négligeables

  return result.length >= 2 ? result : null
}
