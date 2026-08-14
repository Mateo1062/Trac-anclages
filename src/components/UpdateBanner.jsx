import { useEffect, useState } from 'react'
import { getPendingReload, onPendingReloadChange } from '../lib/swUpdate'

// Sans ceci, un onglet resté ouvert continue de tourner sur le JS déjà chargé
// même après un nouveau déploiement — le service worker ne prend le relais
// qu'au prochain rechargement complet. Vu la fréquence des déploiements sur
// cette appli, ça peut sembler des correctifs "n'ont rien changé" alors qu'ils
// sont bien en ligne, juste pas encore chargés dans cet onglet.
export default function UpdateBanner() {
  const [reload, setReload] = useState(getPendingReload())
  useEffect(() => onPendingReloadChange(() => setReload(() => getPendingReload())), [])
  if (!reload) return null
  return (
    <div style={{
      position: 'fixed', left: '1rem', right: '1rem',
      bottom: 'calc(1rem + env(safe-area-inset-bottom) + 58px)',
      zIndex: 900, maxWidth: 420, margin: '0 auto', borderRadius: 12,
      background: 'var(--green-mid, #2e6b3e)', color: 'white', textAlign: 'center',
      fontSize: '.8rem', fontWeight: 600, padding: '.5rem .9rem',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.6rem',
      boxShadow: 'var(--shadow-lg, 0 4px 16px rgba(0,0,0,.25))',
    }}>
      <span>🔄 Nouvelle version disponible</span>
      <button onClick={reload} style={{
        background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.35)', color: 'white',
        borderRadius: 6, padding: '.15rem .6rem', fontSize: '.72rem', cursor: 'pointer', fontWeight: 700,
      }}>Actualiser</button>
    </div>
  )
}
