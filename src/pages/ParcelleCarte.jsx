import { useState, useEffect } from 'react'
import Parcelles from './Parcelles'
import Carte from './Carte'
import ParcellesImport from './ParcellesImport'
import { useAuth } from '../lib/AuthContext'
import { onGoToParcelleRequest } from '../lib/mapFocus'

// Fusion des anciens onglets "Parcelles" et "Carte" en un seul, sous-onglets
// internes — chacun garde exactement son propre fonctionnement (Parcelles.jsx
// et Carte.jsx ne sont pas modifiés, juste montés l'un ou l'autre ici).
// L'onglet "Import" (CSV/Shapefile/XML/DAPLOS) est réservé à l'admin — pour
// tous les autres, cette interface n'existe nulle part ailleurs dans l'appli.
export default function ParcelleCarte() {
  const { isAdmin } = useAuth()
  const [tab, setTab] = useState('liste') // 'liste' | 'carte' | 'import'

  // "Aller sur la carte" depuis la liste des parcelles (bouton 🗺️ d'une
  // ligne) doit basculer ce sous-onglet, en plus de la section active gérée
  // par App.jsx — sinon Carte.jsx ne serait pas monté pour consommer la
  // parcelle en attente (consumePendingParcelle).
  useEffect(() => onGoToParcelleRequest(() => setTab('carte')), [])

  const TABS = [
    ['liste', '📋 Liste'],
    ['carte', '🗺️'], // juste l'icône, pas de texte
    ...(isAdmin ? [['import', '📥 Import']] : []),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ background: 'white', borderBottom: '2px solid var(--border)', display: 'flex', gap: '.1rem', padding: '0 1.5rem', flexShrink: 0 }}>
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} title={k === 'carte' ? 'Carte' : undefined} style={{
            padding: '.6rem 1.1rem', background: 'none', border: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === k ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor: 'pointer', fontSize: '.85rem', fontWeight: tab === k ? 700 : 500,
            color: tab === k ? 'var(--green-mid)' : 'var(--text-muted)', marginBottom: -2, transition: 'all .15s',
          }}>{l}</button>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'liste' ? <Parcelles /> : tab === 'carte' ? <Carte /> : <ParcellesImport />}
      </div>
    </div>
  )
}
