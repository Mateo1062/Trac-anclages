import proj4 from 'proj4'

// Format DAPLOS (AgroEDI Europe / UN-CEFACT) — export fixe-largeur utilisé par
// MesParcelles ("Export vers fichier DAPLOS", .dap). Décodé par rétro-ingénierie
// sur un export réel (positions de colonnes ci-dessous validées en comparant la
// surface calculée à partir des sommets SC00 avec la surface déclarée en PS00 :
// écart de 0.02 ha sur 12.83 ha, soit ~0.15%).
//
// Coordonnées des sommets de parcelle (SC00) en Lambert II étendu (EPSG:27572).
// Définition officielle EPSG (LCC 1SP : lat_0=46.8, y_0=2200000). L'ancienne
// définition "calibrée empiriquement" (lat_0=45.8989, y_0=2100000) mélangeait le
// parallèle sud de la forme 2SP avec un y_0 ajusté à la main : les deux erreurs se
// compensaient presque, mais laissaient un décalage systématique d'environ 225 m
// (mesuré contre la géométrie officielle Telepac Lambert-93 des mêmes parcelles ;
// la définition ci-dessous ramène l'écart à ~1.7 m, résiduel normal NTF→WGS84).
proj4.defs('EPSG:27572', '+proj=lcc +lat_1=46.8 +lat_0=46.8 +lon_0=0 +k_0=0.99987742 +x_0=600000 +y_0=2200000 +a=6378249.2 +b=6356515 +towgs84=-168,-60,320,0,0,0,0 +pm=paris +units=m +no_defs')

const UNIT_LABELS = { LTR: 'L', KGM: 'kg', TNE: 't', MTQ: 'm³' }

// Le libellé libre du fichier source est parfois tronqué à la source (ex. "cultur"
// au lieu de "cultures") — on préfère mapper sur le code catégorie (3 lettres, fiable).
const CATEGORIE_LABELS = {
  SEX: 'Traitement et protection des cultures',
  SEM: 'Ferti minérale et foliaire',
  SEW: 'Plantation',
  SEK: 'Fertilisation et amendement organique',
  V95: 'Désherbage mécanique',
}

function lambert2eToWgs84(x, y) {
  const [lng, lat] = proj4('EPSG:27572', 'WGS84', [x, y])
  return [lng, lat]
}

export function parseDaplos(text) {
  const lines = text.split(/\r\n|\n/).filter(l => l.trim())

  const parcelles = new Map() // id -> { id, nom, surfaceHa, insee, geometry: [[lng,lat],...] }
  const interventions = [] // { parcelleId, date, produit, quantite, unite, categorie }
  const pvById = new Map() // guid -> { parcelleId, date, categorie }

  for (const l of lines) {
    const code = l.slice(0, 4)
    const parcelleId = l.slice(4, 8).trim()

    if (code === 'DP00') {
      const nom = l.slice(105, 140).trim()
      const insee = l.slice(160, 165).trim()
      if (parcelleId && nom) {
        parcelles.set(parcelleId, { id: parcelleId, nom, insee, surfaceHa: null, geometry: [] })
      }
    } else if (code === 'PS00') {
      const surfaceHa = parseFloat(l.slice(17, 26))
      const p = parcelles.get(parcelleId)
      if (p && Number.isFinite(surfaceHa)) p.surfaceHa = surfaceHa
    } else if (code === 'SC00') {
      const x = parseFloat(l.slice(17, 28))
      const y = parseFloat(l.slice(28, 38))
      const p = parcelles.get(parcelleId)
      if (p && Number.isFinite(x) && Number.isFinite(y)) {
        p.geometry.push(lambert2eToWgs84(x, y))
      }
    } else if (code === 'PV00') {
      const guid = l.slice(14, 46).trim()
      const dateStr = l.slice(88, 96) // YYYYMMDD
      const categorieCode = l.slice(164, 167).trim()
      const categorie = CATEGORIE_LABELS[categorieCode] || l.slice(167, 205).trim()
      const date = /^\d{8}$/.test(dateStr) ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}` : null
      pvById.set(guid, { parcelleId, date, categorie })
    } else if (code === 'VI00') {
      const guid = l.slice(14, 46).trim()
      const produit = l.slice(49, 131).trim()
      const quantiteRaw = l.slice(210, 219).trim()
      const uniteCode = l.slice(219, 222).trim()
      const quantite = parseFloat(quantiteRaw)
      const pv = pvById.get(guid)
      if (pv && produit && Number.isFinite(quantite)) {
        interventions.push({
          parcelleId: pv.parcelleId,
          date: pv.date,
          categorie: pv.categorie,
          produit,
          quantite,
          unite: UNIT_LABELS[uniteCode] || uniteCode || '',
        })
      }
    }
  }

  const parcellesOut = Array.from(parcelles.values()).map(p => ({
    ...p,
    geometry: p.geometry.length >= 3 ? { type: 'Polygon', coordinates: [closeRing(p.geometry)] } : null,
  }))

  return { parcelles: parcellesOut, interventions }
}

function closeRing(coords) {
  const first = coords[0], last = coords[coords.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) return [...coords, first]
  return coords
}

/* ── Export (parcelles/interventions de l'appli → fichier .dap) ──
   Reconstruit les enregistrements dans le même format que les exports MesParcelles
   observés (positions de colonnes validées à l'import). Non garanti bit-à-bit
   identique à un export MesParcelles officiel (aucune spécification publique
   disponible pour valider les champs annexes) — à tester avant usage en confiance. */

const pad = (s, w) => (s ?? '').toString().slice(0, w).padEnd(w, ' ')
const padNum = (n, w, dec = 2) => (n == null || !Number.isFinite(n) ? ''.padEnd(w, ' ') : n.toFixed(dec).padStart(w, '0'))

const CATEGORIE_CODES = Object.fromEntries(Object.entries(CATEGORIE_LABELS).map(([k, v]) => [v, k]))

function wgs84ToLambert2e(lng, lat) {
  const [x, y] = proj4('WGS84', 'EPSG:27572', [lng, lat])
  return [x, y]
}

export function buildDaplos(parcelles, interventionsByParcelleId, meta = {}) {
  const siret = meta.siret || '43403917800018'
  const codeExpl = meta.codeExpl || '107'
  const raison = meta.raison || 'EXPLOITATION'
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')

  const lines = []
  lines.push(`EI43${siret}0054${siret}80050001`)
  lines.push(`DE${' '.repeat(38)}${dateStr}00480.94`)
  lines.push(`DATF ${siret}   ${codeExpl}${pad(raison, 238)}`)
  lines.push(`DAFR ${siret}   ${codeExpl}${' '.repeat(238)}`)
  lines.push(`DAMR ${siret}   ${codeExpl}${' '.repeat(238)}`)

  parcelles.forEach((p, idx) => {
    const dapId = String(idx + 1).padStart(4, '0')
    const year = new Date().getFullYear().toString()

    lines.push(`DP00${dapId}  ${year}${dateStr}${' '.repeat(24)}ZDS${'0'.repeat(7)}${' '.repeat(28)}ZLR   ZLQ            ${pad(p.nom, 35)}0000${' '.repeat(16)}00000${' '.repeat(85)}`)
    lines.push(`PS00${dapId}  ${year}A17${padNum(p.surface, 9, 2)}`)

    if (p.geometrie?.type === 'Polygon') {
      for (const [lng, lat] of p.geometrie.coordinates[0]) {
        const [x, y] = wgs84ToLambert2e(lng, lat)
        lines.push(`SC00${dapId}  ${year}3  ${x.toFixed(4).padStart(11, '0')}${y.toFixed(2).padStart(10, '0')}${' '.repeat(18)}`)
      }
    }

    for (const it of interventionsByParcelleId[p.id] || []) {
      const guid = cryptoRandomHex32()
      const d = (it.date || '').replace(/-/g, '')
      // 'AUT' n'existe pas dans CATEGORIE_LABELS : au ré-import, le parseur bascule
      // alors sur le libellé libre (qu'on écrit ci-dessous), au lieu de mal étiqueter
      // silencieusement une catégorie personnalisée (ex. "Récolte") avec un des 5
      // codes connus.
      const catCode = CATEGORIE_CODES[it.categorie] || 'AUT'
      lines.push(`PV00${dapId}  ${year}${guid} ZG7ZK2${pad('Intervention avec intrant', 35)}${d}0000${d}0000${' '.repeat(52)}${catCode}${pad(it.categorie || '', 38)}${' '.repeat(100)}${padNum(p.surface, 9, 2)}${' '.repeat(140)}`)
      lines.push(`VI00${dapId}  ${year}${guid}ZIV${pad(it.produit_nom, 82)}${' '.repeat(79)}${padNum(it.quantite, 9, 2)}${pad(Object.entries(UNIT_LABELS).find(([,v])=>v===it.unite)?.[0] || 'LTR', 3)}${' '.repeat(180)}`)
    }
  })

  return lines.join('\r\n') + '\r\n'
}

function cryptoRandomHex32() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}
