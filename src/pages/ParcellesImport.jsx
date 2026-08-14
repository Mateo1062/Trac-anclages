import { useState, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { useSupabaseTable } from '../lib/useSupabaseTable'
import { useToast } from '../lib/useToast'
import { useAuth } from '../lib/AuthContext'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { parseDaplos, buildDaplos } from '../lib/daplos'
import { isTelepacDossierPac, parseTelepacDossierPac } from '../lib/telepacPac'

// Onglet Import — réservé à l'admin (voir ParcelleCarte.jsx), extrait de
// Parcelles.jsx pour que la liste reste simple pour tout le monde d'autre.
// Toute la logique d'import (CSV, Shapefile, XML, DAPLOS) + export DAPLOS vit
// ici, indépendamment de la liste/carte.

// Clés de propriété courantes dans les exports shapefile agricoles (MesParcelles, RPG…)
const SHP_NAME_KEYS = ['nom','NOM','Nom','parcelle','PARCELLE','Parcelle','libelle','LIBELLE','name','NAME','id_parcel','ID_PARCEL','ilot','ILOT']

function guessShpName(props, idx) {
  for (const k of SHP_NAME_KEYS) if (props[k]) return String(props[k])
  const firstStringVal = Object.values(props).find(v => typeof v === 'string' && v.trim())
  return firstStringVal || `Parcelle ${idx + 1}`
}

// Aire approximative (ha) d'un polygone GeoJSON en coordonnées lat/lng (formule du lacet, projection plane simplifiée)
function ringAreaHa(ring) {
  let area = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]
    area += (x2 - x1) * (y2 + y1)
  }
  const meanLat = ring.reduce((s, p) => s + p[1], 0) / ring.length
  const mPerDegLat = 111320
  const mPerDegLng = 111320 * Math.cos(meanLat * Math.PI / 180)
  return Math.abs(area / 2) * mPerDegLat * mPerDegLng / 10000
}
function geometryAreaHa(geom) {
  if (!geom) return null
  if (geom.type === 'Polygon') return ringAreaHa(geom.coordinates[0])
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((s, poly) => s + ringAreaHa(poly[0]), 0)
  return null
}

/* ── Validation / reprojection des géométries importées ── */
// Définitions proj4 des CRS français courants dans les exports agricoles.
const FR_CRS_DEFS = {
  lambert93: '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  lambert2e: '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +towgs84=-168,-60,320,0,0,0,0 +pm=paris +units=m +no_defs',
}
function detectFrCrsDef(prjText, sampleXY) {
  const t = (prjText || '').toLowerCase()
  if (/lambert[ _-]?93|rgf93|2154/.test(t)) return FR_CRS_DEFS.lambert93
  if (/lambert.*(ii|2).*tendu|27572/.test(t)) return FR_CRS_DEFS.lambert2e
  if (sampleXY) { // repli : ordre de grandeur des coordonnées en mètres
    const y = sampleXY[1]
    if (y > 6000000 && y < 7300000) return FR_CRS_DEFS.lambert93
    if (y > 1500000 && y < 2800000) return FR_CRS_DEFS.lambert2e
  }
  return null
}
function firstCoordOf(geom) {
  let a = geom?.coordinates
  while (Array.isArray(a) && Array.isArray(a[0])) a = a[0]
  return Array.isArray(a) && a.length >= 2 ? a : null
}
function validLngLat(pt) {
  return Number.isFinite(pt?.[0]) && Number.isFinite(pt?.[1]) && Math.abs(pt[0]) <= 180 && Math.abs(pt[1]) <= 90
}
function geometryValid(geom) {
  if (!geom?.coordinates) return false
  let ok = true, count = 0
  const walk = a => {
    if (!ok || !Array.isArray(a)) { ok = false; return }
    if (Array.isArray(a[0])) a.forEach(walk)
    else { count++; if (!validLngLat(a)) ok = false }
  }
  walk(geom.coordinates)
  return ok && count >= 3
}
function geometryCentroid(geom) {
  const ring = geom?.type === 'Polygon' ? geom.coordinates[0] : geom?.type === 'MultiPolygon' ? geom.coordinates[0][0] : null
  if (!ring?.length) return null
  let sx = 0, sy = 0
  for (const [lng, lat] of ring) { sx += lng; sy += lat }
  return [sx / ring.length, sy / ring.length]
}
function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Alias pour repérer les champs utiles dans un XML générique (balises ou attributs)
const XML_FIELD_ALIASES = {
  nom:     ['nom','name','parcelle','libelle','designator','designation'],
  surface: ['surface','superficie','area','ha','hectare'],
  culture: ['culture','crop','cropname','culture_actuelle'],
  commune: ['commune','city','ville'],
  entite:  ['entite','entité','proprietaire','exploitation','farm','client'],
}
function matchXmlKey(key, aliases) {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return aliases.some(a => k.includes(a.replace(/[^a-z0-9]/g, '')))
}

// Tente d'abord le format ISOXML (norme ISO 11783 — utilisé par MesParcelles et beaucoup
// d'outils agricoles pour échanger parcelles + contours précis), sinon repli sur un XML
// générique (balises libres, alias sur les noms de champs comme pour le CSV).
function parseParcellesXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('XML invalide ou mal formé.')

  const pfdList = Array.from(doc.getElementsByTagName('PFD'))
  if (pfdList.length > 0) {
    return pfdList.map((pfd, i) => {
      const name = pfd.getAttribute('A') || pfd.getAttribute('C') || `Parcelle ${i + 1}`
      const areaM2 = parseFloat(pfd.getAttribute('C')) // aire en m² (best-effort selon export)
      let geometry = null
      try {
        const pnts = Array.from(pfd.querySelectorAll('PLN > LSG > PNT'))
        const coords = pnts
          .map(p => [parseFloat(p.getAttribute('D')), parseFloat(p.getAttribute('C'))]) // [lon, lat]
          .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
        if (coords.length >= 3) {
          if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) coords.push(coords[0])
          geometry = { type: 'Polygon', coordinates: [coords] }
        }
      } catch { /* pas de contour exploitable pour cette parcelle */ }
      const surfaceHa = geometry ? geometryAreaHa(geometry) : (Number.isFinite(areaM2) ? areaM2 / 10000 : null)
      return { name, geometry, surfaceHa, culture: null, commune: null, entite: null }
    })
  }

  // ── Repli générique : détecte l'élément qui se répète le plus (= 1 enregistrement par parcelle) ──
  const counts = {}
  doc.querySelectorAll('*').forEach(el => {
    if (el.children.length >= 1) counts[el.tagName] = (counts[el.tagName] || 0) + 1
  })
  const bestTag = Object.entries(counts).filter(([,c]) => c >= 2).sort((a,b) => b[1]-a[1])[0]?.[0]
  if (!bestTag) throw new Error("Aucune structure de parcelles reconnue dans ce fichier XML.")

  const records = Array.from(doc.getElementsByTagName(bestTag))
  return records.map((rec, i) => {
    const fields = { nom: null, surface: null, culture: null, commune: null, entite: null }
    const scan = (key, val) => {
      for (const [field, aliases] of Object.entries(XML_FIELD_ALIASES)) {
        if (fields[field] == null && matchXmlKey(key, aliases) && val) fields[field] = val.trim()
      }
    }
    Array.from(rec.attributes || []).forEach(attr => scan(attr.name, attr.value))
    Array.from(rec.children).forEach(child => scan(child.tagName, child.textContent))
    return {
      name: fields.nom || `Parcelle ${i + 1}`,
      geometry: null,
      surfaceHa: fields.surface ? parseFloat(fields.surface.replace(',', '.')) : null,
      culture: fields.culture, commune: fields.commune, entite: fields.entite,
    }
  })
}

// CSV column name aliases (handles variations)
const ALIASES = {
  nom:                ['nom','name','parcelle','libelle','libellé'],
  entite:             ['entite','entité','proprietaire','propriétaire','exploitation','owner'],
  surface:            ['surface','ha','hectare','superficie'],
  culture_precedente: ['culture_precedente','culture_précédente','cult_prec','precedent','précédent'],
  culture_actuelle:   ['culture_actuelle','culture','cult_act','actuelle'],
  interculture:       ['interculture','couvert','couverts','cover_crop'],
  commune:            ['commune','ville','city'],
  section_cadastrale: ['section','section_cadastrale','cadastre','parcelle_cadastrale'],
  notes:              ['notes','remarque','observation','comment'],
}

function matchColumn(header) {
  const h = header.toLowerCase().trim().replace(/[^a-z_éèàêîôùûç]/g,'')
  for (const [field, aliases] of Object.entries(ALIASES)) {
    if (aliases.some(a => h.includes(a.replace(/[^a-z_éèàêîôùûç]/g,'')))) return field
  }
  return null
}

export default function ParcellesImport() {
  const { showToast, ToastEl } = useToast()
  const { user } = useAuth()
  const { campagneActive } = useCampagne()
  const { items } = useSupabaseTable('parcelles','nom')

  const [csvPreview, setCsvPreview] = useState(null) // { rows, mapping }
  const [importing, setImporting] = useState(false)
  const fileRef = useRef()
  const [shpPreview, setShpPreview] = useState(null) // [{ name, geometry, surfaceHa, matchId }]
  const [shpImporting, setShpImporting] = useState(false)
  const shpFileRef = useRef()
  const xmlFileRef = useRef()
  const dapFileRef = useRef()
  const [dapInterventions, setDapInterventions] = useState(null) // [{ parcelleId(dap), date, categorie, produit, quantite, unite }]
  const [dapImportInterventions, setDapImportInterventions] = useState(true)
  const [dapExporting, setDapExporting] = useState(false)

  /* ── CSV Import ── */
  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        parseCSV(ev.target.result)
      } catch(err) {
        alert('Erreur lecture CSV : ' + err.message)
      }
    }
    reader.readAsText(file, 'UTF-8')
    e.target.value = ''
  }

  function parseCSV(text) {
    // Detect separator
    const firstLine = text.split('\n')[0]
    const sep = firstLine.includes(';') ? ';' : firstLine.includes('\t') ? '\t' : ','

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length < 2) { alert('Le fichier CSV semble vide ou invalide.'); return }

    const headers = lines[0].split(sep).map(h => h.replace(/^["']|["']$/g,'').trim())
    const mapping = {} // fieldName -> colIndex
    headers.forEach((h, i) => {
      const field = matchColumn(h)
      if (field) mapping[field] = i
    })

    const rows = lines.slice(1).map(line => {
      const cols = line.split(sep).map(c => c.replace(/^["']|["']$/g,'').trim())
      const row = {}
      for (const [field, idx] of Object.entries(mapping)) {
        row[field] = cols[idx] || ''
      }
      // Keep raw for preview
      row._raw = cols
      return row
    }).filter(r => Object.values(r).some(v => v && v !== ''))

    setCsvPreview({ rows, mapping, headers })
  }

  async function confirmImport() {
    if (!csvPreview?.rows?.length) return
    setImporting(true)
    let ok = 0, fail = 0
    for (const row of csvPreview.rows) {
      const payload = {
        nom:               row.nom || 'Parcelle importée',
        entite:            row.entite || '',
        surface:           row.surface ? parseFloat(row.surface.replace(',','.')) : null,
        culture_precedente:row.culture_precedente || '',
        culture_actuelle:  row.culture_actuelle || '',
        interculture:      row.interculture || '',
        commune:           row.commune || '',
        section_cadastrale:row.section_cadastrale || '',
        notes:             row.notes || '',
        campagne:          campagneActive,
      }
      const { error } = await supabase.from('parcelles').insert(payload)
      error ? fail++ : ok++
    }
    setImporting(false)
    setCsvPreview(null)
    showToast(`✅ ${ok} parcelle(s) importée(s)${fail>0?` · ${fail} erreur(s)`:''}`)
    window.location.reload()
  }

  /* ── Import Shapefile (contours réels MesParcelles / Telepac EDI) ── */
  async function handleShpFile(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    try {
      const shpjsMod = await import('shpjs')
      const buf = await file.arrayBuffer()
      let features = []
      try {
        const geojson = await shpjsMod.default(buf)
        const collections = Array.isArray(geojson) ? geojson : [geojson]
        features = collections.flatMap(c => c.features || [])
      } catch { features = [] }

      // Certains .prj (ex. export EDI Telepac) ne sont pas compris par proj4 :
      // shpjs renvoie alors des coordonnées NaN sans erreur. On re-parse le zip
      // nous-mêmes en détectant le CRS français (Lambert-93, Lambert II étendu).
      if (!features.length || !features.every(f => geometryValid(f.geometry))) {
        features = await reparseShpWithFrCrs(buf, shpjsMod)
      }
      if (!features.length) { alert('Aucune géométrie trouvée dans ce fichier.'); return }
      const bad = features.filter(f => !geometryValid(f.geometry)).length
      if (bad) {
        alert(`Coordonnées illisibles pour ${bad} parcelle(s) (système de projection non reconnu). Import annulé pour ne pas créer de parcelles mal placées.`)
        return
      }

      const preview = features.map((f, i) => {
        const name = guessShpName(f.properties || {}, i)
        const surfaceHa = geometryAreaHa(f.geometry)
        // correspondance par nom d'abord, sinon par position géographique du contour
        const byName = autoMatchId(name)
        let matchId = byName !== '__new__' ? byName : autoMatchByGeometry(f.geometry, surfaceHa)
        // un nom purement numérique (ex. clefedi Telepac) sans correspondance n'est
        // pas un vrai nom de parcelle : par défaut on ignore plutôt que de créer
        // des doublons "51", "52"… — l'utilisateur peut toujours choisir "Créer".
        if (matchId === '__new__' && /^\d+$/.test(name.trim())) matchId = '__skip__'
        return { name, geometry: f.geometry, surfaceHa, culture: null, commune: null, entite: null, matchId }
      })
      setShpPreview(preview)
    } catch (err) {
      alert('Erreur lecture shapefile : ' + err.message)
    }
  }

  // Re-parse un zip shapefile avec un CRS détecté explicitement (contournement des
  // .prj que proj4 ne sait pas lire — il produit alors des NaN silencieusement).
  async function reparseShpWithFrCrs(buf, shpjsMod) {
    const u8 = new Uint8Array(buf)
    if (u8[0] !== 0x50 || u8[1] !== 0x4b) return [] // pas un zip
    const { iter } = await import('but-unzip')
    const byExt = {}
    await Promise.all(Array.from(iter(u8)).map(async entry => {
      const ext = entry.filename.split('.').pop().toLowerCase()
      if (['shp', 'dbf', 'prj', 'cpg'].includes(ext) && !byExt[ext]) byExt[ext] = await entry.read()
    }))
    if (!byExt.shp) return []
    const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength)
    const prjText = byExt.prj ? new TextDecoder('iso-8859-1').decode(byExt.prj) : ''
    const rawGeoms = shpjsMod.parseShp(dv(byExt.shp))
    const def = detectFrCrsDef(prjText, firstCoordOf(rawGeoms[0]))
    if (!def) return []
    const geoms = shpjsMod.parseShp(dv(byExt.shp), def)
    let props = []
    try { props = byExt.dbf ? shpjsMod.parseDbf(dv(byExt.dbf), byExt.cpg) : [] } catch { props = [] }
    return geoms.map((g, i) => ({ type: 'Feature', geometry: g, properties: props[i] || {} }))
  }

  /* ── Import XML (ISOXML, Dossier PAC/Telepac RPG, ou XML générique) ── */
  async function handleXmlFile(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    try {
      const text = await file.text()
      const isPac = isTelepacDossierPac(text)
      const rows = isPac ? parseTelepacDossierPac(text) : parseParcellesXml(text)
      if (!rows.length) { alert('Aucune parcelle trouvée dans ce fichier XML.'); return }
      // Le format Dossier PAC (Telepac) n'a pas de nom de parcelle exploitable
      // (juste des numéros d'îlot/parcelle) — on associe automatiquement par
      // entité + surface la plus proche, sinon l'utilisateur corrige à la main.
      setShpPreview(rows.map(r => ({
        ...r,
        matchId: isPac ? autoMatchByEntiteSurface(r.entite, r.surfaceHa) : autoMatchId(r.name),
      })))
    } catch (err) {
      alert('Erreur lecture XML : ' + err.message)
    }
  }

  /* ── Import DAPLOS (.dap — export MesParcelles : parcelles + interventions) ── */
  async function handleDapFile(e) {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    try {
      const raw = new TextDecoder('iso-8859-1').decode(await file.arrayBuffer())
      const { parcelles: dapParcelles, interventions } = parseDaplos(raw)
      if (!dapParcelles.length) { alert('Aucune parcelle DAPLOS reconnue dans ce fichier.'); return }
      setShpPreview(dapParcelles.map(p => {
        // correspondance par nom d'abord, sinon par position géographique du contour
        const byName = autoMatchId(p.nom)
        return {
          name: p.nom, geometry: p.geometry, surfaceHa: p.surfaceHa,
          culture: null, commune: null, entite: null,
          matchId: byName !== '__new__' ? byName : autoMatchByGeometry(p.geometry, p.surfaceHa),
          _dapId: p.id,
        }
      }))
      setDapInterventions(interventions)
    } catch (err) {
      alert('Erreur lecture fichier DAPLOS : ' + err.message)
    }
  }

  function autoMatchId(name) {
    // Correspondance stricte (nom identique, à la casse/espaces près) uniquement —
    // une correspondance approchée par sous-chaîne risquerait de faire matcher un nom
    // court (ex. "LE PARC") avec un nom sans rapport ("...PARCelle..."), et donc
    // d'écraser le contour de la mauvaise parcelle. En cas de doute, l'utilisateur
    // corrige manuellement dans la liste déroulante.
    const norm = s => (s || '').toLowerCase().trim()
    const n = norm(name)
    const exact = items.find(p => norm(p.nom) === n)
    return exact?.id || '__new__'
  }

  // Pour les formats sans nom de parcelle exploitable (ex. Dossier PAC/Telepac) :
  // associe par entité identique + surface la plus proche (tolérance 3%), en
  // exigeant une correspondance non-ambiguë. Sinon laisse à corriger manuellement.
  function autoMatchByEntiteSurface(entite, surfaceHa) {
    if (!entite || surfaceHa == null) return '__new__'
    const norm = s => (s || '').toLowerCase().trim()
    const candidates = items.filter(p => norm(p.entite) === norm(entite) && p.surface != null)
    if (!candidates.length) return '__new__'
    const withDelta = candidates
      .map(p => ({ p, delta: Math.abs(p.surface - surfaceHa) / Math.max(surfaceHa, 0.01) }))
      .filter(x => x.delta <= 0.03)
      .sort((a, b) => a.delta - b.delta)
    if (withDelta.length === 0) return '__new__'
    if (withDelta.length > 1 && withDelta[1].delta - withDelta[0].delta < 0.005) return '__new__' // ambigu, à corriger manuellement
    return withDelta[0].p.id
  }

  // Correspondance par position : si le contour importé est quasiment au même
  // endroit qu'une parcelle existante (centres < 150 m, surfaces comparables),
  // on met à jour cette parcelle plutôt que d'en créer une en double.
  function autoMatchByGeometry(geometry, surfaceHa) {
    const c = geometryCentroid(geometry)
    if (!c) return '__new__'
    let best = null
    for (const p of items) {
      if (!p.geometrie) continue
      const pc = geometryCentroid(p.geometrie)
      if (!pc || !validLngLat(pc)) continue
      const d = distanceM(c[1], c[0], pc[1], pc[0])
      if (d < 150 && (!best || d < best.d)) best = { id: p.id, d, surface: p.surface }
    }
    if (!best) return '__new__'
    if (surfaceHa && best.surface && Math.abs(best.surface - surfaceHa) / Math.max(surfaceHa, 0.01) > 0.35) return '__new__'
    return best.id
  }

  function updateShpMatch(idx, matchId) {
    setShpPreview(prev => prev.map((r, i) => i === idx ? { ...r, matchId } : r))
  }

  async function confirmShpImport() {
    if (!shpPreview?.length) return
    setShpImporting(true)
    let updated = 0, created = 0, skipped = 0
    const dapIdToRealId = {} // identifiant parcelle DAPLOS -> { id, nom } réel en base (pour les interventions)
    for (const row of shpPreview) {
      if (row.matchId === '__skip__') { skipped++; continue }
      const extra = {}
      if (row.geometry && geometryValid(row.geometry)) extra.geometrie = row.geometry
      if (row.culture)   extra.culture_actuelle = row.culture
      if (row.commune)   extra.commune = row.commune
      if (row.entite)    extra.entite = row.entite
      if (row.surfaceHa) extra.surface = +row.surfaceHa.toFixed(2)
      if (row.matchId === '__new__') {
        const { data, error } = await supabase.from('parcelles').insert({
          nom: row.name, surface: row.surfaceHa ? +row.surfaceHa.toFixed(2) : null, campagne: campagneActive, ...extra,
        }).select().single()
        if (error) skipped++
        else { created++; if (row._dapId) dapIdToRealId[row._dapId] = { id: data.id, nom: row.name } }
      } else {
        const { error } = await supabase.from('parcelles').update(extra).eq('id', row.matchId)
        if (error) skipped++
        else { updated++; if (row._dapId) dapIdToRealId[row._dapId] = { id: row.matchId, nom: row.name } }
      }
    }

    let interventionsCreated = 0
    if (dapImportInterventions && dapInterventions?.length) {
      const rows = dapInterventions
        .filter(it => dapIdToRealId[it.parcelleId])
        .map(it => ({
          date: it.date,
          produit_id: null,
          produit_nom: it.produit,
          quantite: it.quantite,
          unite: it.unite,
          parcelle_id: dapIdToRealId[it.parcelleId].id,
          parcelle: dapIdToRealId[it.parcelleId].nom,
          observation: it.categorie,
          user_id: user?.id || null,
        }))
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase.from('interventions_phyto').insert(rows.slice(i, i + 500))
        if (!error) interventionsCreated += rows.slice(i, i + 500).length
      }
    }

    setShpImporting(false)
    setShpPreview(null)
    setDapInterventions(null)
    showToast(`✅ ${updated} parcelle(s) mise(s) à jour · ${created} créée(s)${skipped ? ` · ${skipped} ignorée(s)` : ''}${interventionsCreated ? ` · ${interventionsCreated} intervention(s) importée(s)` : ''}`)
    window.location.reload()
  }

  /* ── Export DAPLOS (.dap) — parcelles (avec géométrie) + leurs interventions ── */
  async function exportDap() {
    const withGeo = items.filter(p => p.geometrie)
    if (!withGeo.length) { alert("Aucune parcelle avec contour à exporter. Importez d'abord des contours (Shapefile, XML ou .dap) pour pouvoir les ré-exporter."); return }
    setDapExporting(true)
    try {
      const ids = withGeo.map(p => p.id)
      // Pagine : PostgREST plafonne à 1000 lignes par requête par défaut.
      const interventions = []
      for (let page = 0; ; page++) {
        const { data, error } = await supabase
          .from('interventions_phyto').select('*').in('parcelle_id', ids)
          .range(page * 1000, page * 1000 + 999)
        if (error) throw error
        interventions.push(...data)
        if (data.length < 1000) break
      }
      const byParcelle = {}
      for (const it of interventions) {
        (byParcelle[it.parcelle_id] ||= []).push(it)
      }
      const text = buildDaplos(withGeo, byParcelle)
      const blob = new Blob([text], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Export_${Date.now()}.dap`
      a.click()
      URL.revokeObjectURL(url)
      showToast(`✅ ${withGeo.length} parcelle(s) exportée(s) en .dap`)
    } catch (err) {
      alert('Erreur export DAPLOS : ' + err.message)
    } finally {
      setDapExporting(false)
    }
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
      {ToastEl}
      <div style={{ fontSize:'.8rem', color:'var(--text-muted)', marginBottom:'1rem' }}>
        Import/export du parcellaire — visible uniquement par toi.
      </div>

      <div style={{ display:'flex', gap:'.6rem', flexWrap:'wrap', marginBottom:'1rem' }}>
        <label className="btn-sm" style={{ cursor:'pointer' }}>
          📂 Importer CSV
          <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display:'none' }} onChange={handleFile} />
        </label>
        <label className="btn-sm" style={{ cursor:'pointer' }} title="Fichier .zip du shapefile exporté depuis MesParcelles">
          📐 Importer Shapefile
          <input ref={shpFileRef} type="file" accept=".zip" style={{ display:'none' }} onChange={handleShpFile} />
        </label>
        <label className="btn-sm" style={{ cursor:'pointer' }} title="Fichier .xml (ISOXML ou export MesParcelles) — contours et données précises">
          📄 Importer XML
          <input ref={xmlFileRef} type="file" accept=".xml" style={{ display:'none' }} onChange={handleXmlFile} />
        </label>
        <label className="btn-sm" style={{ cursor:'pointer' }} title="Fichier .dap (Export vers fichier DAPLOS depuis MesParcelles) — parcelles + interventions">
          📥 Importer DAPLOS (.dap)
          <input ref={dapFileRef} type="file" accept=".dap" style={{ display:'none' }} onChange={handleDapFile} />
        </label>
        <button className="btn-sm" onClick={exportDap} disabled={dapExporting} title="Génère un fichier .dap (parcelles + interventions) pour ré-import dans MesParcelles">
          {dapExporting ? '⏳ Export…' : '📤 Exporter DAPLOS (.dap)'}
        </button>
      </div>

      {!csvPreview && !shpPreview && (
        <div style={{ textAlign:'center', padding:'2.5rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.85rem' }}>
          Choisis un fichier ci-dessus pour lancer un import.
        </div>
      )}

      {/* CSV preview */}
      {csvPreview && (
        <div style={{ background:'var(--amber-pale)', border:'1px solid var(--amber)', borderRadius:12, padding:'1rem 1.2rem' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.7rem', flexWrap:'wrap', gap:'.5rem' }}>
            <div>
              <strong>{csvPreview.rows.length} parcelle(s)</strong> détectée(s) dans le CSV
              <span style={{ fontSize:'.78rem', color:'var(--text-muted)', marginLeft:'.5rem' }}>
                Colonnes reconnues : {Object.keys(csvPreview.mapping).join(', ')}
              </span>
            </div>
            <div style={{ display:'flex', gap:'.5rem' }}>
              <button className="btn-sm" onClick={()=>setCsvPreview(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={confirmImport} disabled={importing}>
                {importing ? '⏳ Import…' : `✅ Importer ${csvPreview.rows.length} parcelle(s)`}
              </button>
            </div>
          </div>
          {/* Preview first 3 rows */}
          <div style={{ background:'white', borderRadius:8, overflowX:'auto', WebkitOverflowScrolling:'touch', border:'1px solid var(--border)' }}>
            <table style={{ width:'100%', minWidth:600, fontSize:'.78rem', borderCollapse:'collapse' }}>
              <thead><tr>
                {Object.keys(csvPreview.mapping).map(k => (
                  <th key={k} style={{ padding:'.4rem .7rem', background:'var(--cream)', textAlign:'left', fontSize:'.7rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{k}</th>
                ))}
              </tr></thead>
              <tbody>
                {csvPreview.rows.slice(0,3).map((r,i) => (
                  <tr key={i}>
                    {Object.keys(csvPreview.mapping).map(k => (
                      <td key={k} style={{ padding:'.4rem .7rem', borderBottom:'1px solid var(--border)' }}>{r[k]||'–'}</td>
                    ))}
                  </tr>
                ))}
                {csvPreview.rows.length > 3 && (
                  <tr><td colSpan={Object.keys(csvPreview.mapping).length} style={{ padding:'.4rem .7rem', color:'var(--text-muted)', fontStyle:'italic', fontSize:'.75rem' }}>… et {csvPreview.rows.length-3} autre(s)</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Shapefile preview */}
      {shpPreview && (
        <div style={{ background:'var(--sky-pale, #dceafd)', border:'1px solid var(--sky, #2f7de0)', borderRadius:12, padding:'1rem 1.2rem' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.7rem', flexWrap:'wrap', gap:'.5rem' }}>
            <div>
              <strong>{shpPreview.length} contour(s)</strong> détecté(s) — vérifiez/corrigez l'association avant d'importer
            </div>
            <div style={{ display:'flex', gap:'.5rem' }}>
              <button className="btn-sm" onClick={()=>{ setShpPreview(null); setDapInterventions(null) }}>Annuler</button>
              <button className="btn-sm primary" onClick={confirmShpImport} disabled={shpImporting}>
                {shpImporting ? '⏳ Import…' : `✅ Importer ${shpPreview.length} contour(s)`}
              </button>
            </div>
          </div>
          {dapInterventions && (
            <label style={{ display:'flex', alignItems:'center', gap:'.5rem', marginBottom:'.7rem', fontSize:'.82rem', cursor:'pointer' }}>
              <input type="checkbox" checked={dapImportInterventions} onChange={e=>setDapImportInterventions(e.target.checked)} />
              Importer aussi les <strong>{dapInterventions.length} intervention(s)</strong> détectées (traitements, fertilisation, plantation…) dans Commande Phyto → Stock & Interventions
            </label>
          )}
          <div style={{ background:'white', borderRadius:8, overflowX:'auto', WebkitOverflowScrolling:'touch', border:'1px solid var(--border)', maxHeight:400, overflowY:'auto' }}>
            <table style={{ width:'100%', minWidth:600, fontSize:'.78rem', borderCollapse:'collapse' }}>
              <thead><tr>
                {['Nom (détecté)','Surface est.','Associer à'].map(h => (
                  <th key={h} style={{ padding:'.4rem .7rem', background:'var(--cream)', textAlign:'left', fontSize:'.7rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)', position:'sticky', top:0 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {shpPreview.map((r,i) => (
                  <tr key={i}>
                    <td style={{ padding:'.4rem .7rem', borderBottom:'1px solid var(--border)' }}>{r.name}</td>
                    <td style={{ padding:'.4rem .7rem', borderBottom:'1px solid var(--border)' }}>{r.surfaceHa ? r.surfaceHa.toFixed(2)+' ha' : '–'}</td>
                    <td style={{ padding:'.4rem .7rem', borderBottom:'1px solid var(--border)' }}>
                      <select value={r.matchId} onChange={e=>updateShpMatch(i, e.target.value)} style={{ fontSize:'.76rem', padding:'.25rem .4rem' }}>
                        <option value="__new__">➕ Créer une nouvelle parcelle</option>
                        <option value="__skip__">⏭️ Ignorer</option>
                        {items.map(p => <option key={p.id} value={p.id}>{p.nom}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
