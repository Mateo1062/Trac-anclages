import { useEffect, useState } from 'react'
import { subscribeOfflineStatus, replayQueue, clearQueue } from '../lib/offlineSync'

export default function OfflineBanner() {
  const [status, setStatus] = useState({ online: navigator.onLine, pendingCount: 0, syncing: false, lastError: null, staleDataAt: null })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => subscribeOfflineStatus(setStatus), [])

  async function handleClear() {
    if (!confirm(`Vider la file d'attente (${status.pendingCount} modification${status.pendingCount > 1 ? 's' : ''}) ? Ces modifications ne seront JAMAIS envoyées au serveur — à faire seulement si tu vas les refaire à la main.`)) return
    await clearQueue()
  }

  const hasQueueBanner = !status.online || status.pendingCount > 0
  // Une lecture a silencieusement servi une copie en cache (connexion trop
  // lente au moment du chargement, pas forcément "hors-ligne" au sens de
  // navigator.onLine) — sans ce bandeau, rien ne distinguait ça d'un
  // chargement normal, ce qui pouvait faire croire que des données supprimées
  // étaient "revenues".
  const hasStaleBanner = !hasQueueBanner && status.online && status.staleDataAt

  if (!hasQueueBanner && !hasStaleBanner) return null

  const offline = !status.online
  const bg = hasStaleBanner ? '#8a6d1a' : (offline ? '#7a2e2e' : (status.syncing ? '#8a6d1a' : '#2e6b3e'))
  const label = hasStaleBanner
    ? 'Connexion lente — données peut-être pas à jour'
    : offline
      ? `Hors-ligne${status.pendingCount > 0 ? ` — ${status.pendingCount} modification${status.pendingCount > 1 ? 's' : ''} en attente` : ''}`
      : (status.syncing
        ? `Synchronisation en cours… (${status.pendingCount} restante${status.pendingCount > 1 ? 's' : ''})`
        : `${status.pendingCount} modification${status.pendingCount > 1 ? 's' : ''} en attente de synchro`)

  return (
    <div style={{
      // Même logique de positionnement que InstallPrompt : au-dessus de la barre
      // de nav mobile, sous les modales (z-index 9000) pour ne jamais cacher
      // un bouton Enregistrer/Annuler ni l'en-tête en haut de l'écran.
      position: 'fixed', left: '1rem', right: '1rem',
      bottom: 'calc(1rem + env(safe-area-inset-bottom) + 58px)',
      zIndex: 850,
      maxWidth: 420, margin: '0 auto', borderRadius: 12,
      background: bg, color: 'white', textAlign: 'center',
      fontSize: '.8rem', fontWeight: 600, padding: '.5rem .9rem',
      display: 'flex', flexDirection: 'column', gap: '.4rem',
      boxShadow: 'var(--shadow-lg, 0 4px 16px rgba(0,0,0,.25))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
        <span>{hasStaleBanner ? '📡' : (offline ? '🔴' : (status.syncing ? '🟡' : '🟢'))} {label}</span>
        {hasStaleBanner && (
          <button onClick={() => window.location.reload()} style={{
            background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.35)', color: 'white',
            borderRadius: 6, padding: '.15rem .6rem', fontSize: '.72rem', cursor: 'pointer',
          }}>🔄 Recharger</button>
        )}
        {!hasStaleBanner && !offline && !status.syncing && status.pendingCount > 0 && (
          <button onClick={() => replayQueue()} style={{
            background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.35)', color: 'white',
            borderRadius: 6, padding: '.15rem .6rem', fontSize: '.72rem', cursor: 'pointer',
          }}>Réessayer</button>
        )}
        {status.lastError && (
          <button onClick={() => setExpanded(v => !v)} style={{
            background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.35)', color: 'white',
            borderRadius: 6, padding: '.15rem .6rem', fontSize: '.72rem', cursor: 'pointer',
          }}>{expanded ? 'Masquer' : 'Détail'}</button>
        )}
      </div>
      {expanded && status.lastError && (
        <div style={{ fontSize: '.7rem', fontWeight: 400, textAlign: 'left', background: 'rgba(0,0,0,.2)', borderRadius: 6, padding: '.4rem .6rem', wordBreak: 'break-word' }}>
          {status.lastError}
          <div style={{ marginTop: '.4rem' }}>
            <button onClick={handleClear} style={{
              background: 'rgba(255,255,255,.15)', border: '1px solid rgba(255,255,255,.35)', color: 'white',
              borderRadius: 6, padding: '.15rem .6rem', fontSize: '.72rem', cursor: 'pointer',
            }}>🗑️ Vider la file (abandonner ces modifications)</button>
          </div>
        </div>
      )}
    </div>
  )
}
