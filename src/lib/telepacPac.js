import proj4 from 'proj4'

// Lambert-93 (RGF93 / EPSG:2154) — système officiel utilisé par le RPG (Registre
// Parcellaire Graphique) dans les exports "Dossier PAC" Telepac, différent du
// Lambert II étendu (EPSG:27572) utilisé par les exports DAPLOS MesParcelles.
proj4.defs('EPSG:2154', '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs')

function lambert93ToWgs84(x, y) {
  return proj4('EPSG:2154', 'WGS84', [x, y])
}

export function isTelepacDossierPac(xmlText) {
  return xmlText.includes('x-telepac') || xmlText.includes('<rpg>')
}

// Parse un export "Dossier PAC" (Telepac/RPG) : îlots + parcelles avec leurs
// contours précis (GML, Lambert-93) — la source officielle la plus fiable
// pour les emplacements de parcelles.
export function parseTelepacDossierPac(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('XML invalide ou mal formé.')

  const records = []
  const producteurs = Array.from(doc.getElementsByTagName('producteur'))
  for (const prod of producteurs) {
    const exploitation = prod.getElementsByTagName('exploitation')[0]?.textContent?.trim() || ''
    const ilots = Array.from(prod.getElementsByTagName('ilot'))
    for (const ilot of ilots) {
      const numIlot = ilot.getAttribute('numero-ilot') || ''
      const commune = ilot.getElementsByTagName('commune')[0]?.textContent?.trim() || ''
      const parcellesParent = ilot.getElementsByTagName('parcelles')[0]
      const parcelles = parcellesParent ? Array.from(parcellesParent.children).filter(el => el.tagName === 'parcelle') : []
      for (const parc of parcelles) {
        const numParcelle = parc.getElementsByTagName('descriptif-parcelle')[0]?.getAttribute('numero-parcelle') || ''
        const culture = parc.getElementsByTagName('code-culture')[0]?.textContent?.trim() || ''
        const surfaceArStr = parc.getElementsByTagName('surface-admissible')[0]?.textContent
        const surfaceAr = surfaceArStr != null ? parseFloat(surfaceArStr) : null
        const surfaceHa = Number.isFinite(surfaceAr) ? +(surfaceAr / 100).toFixed(4) : null

        let geometry = null
        const coordsEl = parc.getElementsByTagName('gml:coordinates')[0]
        if (coordsEl) {
          const coords = coordsEl.textContent.trim().split(/\s+/)
            .map(pair => {
              const [x, y] = pair.split(',').map(Number)
              if (!Number.isFinite(x) || !Number.isFinite(y)) return null
              return lambert93ToWgs84(x, y)
            })
            .filter(Boolean)
          if (coords.length >= 3) geometry = { type: 'Polygon', coordinates: [coords] }
        }

        records.push({
          name: `Îlot ${numIlot} · Parcelle ${numParcelle}${culture ? ' · ' + culture : ''}`,
          geometry, surfaceHa, culture, commune, entite: exploitation,
          _ilot: numIlot, _numParcelle: numParcelle,
        })
      }
    }
  }
  return records
}
