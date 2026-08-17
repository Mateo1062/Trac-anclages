import { useState, useEffect } from 'react'
import useIsMobile from '../lib/useIsMobile'

/* Détecte iOS Safari (qui n'expose pas beforeinstallprompt) */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream
}
function isInStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

const DISMISS_KEY = 'tracagri_install_dismissed_at'
const DISMISS_DAYS = 14

export default function InstallPrompt() {
  const isMobile = useIsMobile()
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [showIosHint, setShowIosHint] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isInStandaloneMode()) return // already installed, never show

    const dismissedAt = localStorage.getItem(DISMISS_KEY)
    if (dismissedAt) {
      const days = (Date.now() - Number(dismissedAt)) / (1000 * 60 * 60 * 24)
      if (days < DISMISS_DAYS) return
    }

    if (isIOS()) {
      // No native event on iOS — show our own instructions after a short delay
      const t = setTimeout(() => { setShowIosHint(true); setVisible(true) }, 2000)
      return () => clearTimeout(t)
    }

    function onBeforeInstall(e) {
      e.preventDefault()
      setDeferredPrompt(e)
      setVisible(true)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall)
  }, [])

  async function handleInstall() {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
    setVisible(false)
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
    setVisible(false)
  }

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed', left: '1rem', right: '1rem',
      bottom: isMobile ? 'calc(1rem + env(safe-area-inset-bottom) + 58px)' : 'calc(1rem + env(safe-area-inset-bottom))',
      // Sous les modales (z-index 9000) : ne doit jamais couvrir leurs boutons Enregistrer/Annuler.
      zIndex: 800,
      maxWidth: 420, margin: '0 auto',
      background: 'var(--soil)', color: 'white', borderRadius: 14,
      padding: '1rem 1.1rem', boxShadow: 'var(--shadow-lg)',
      display: 'flex', alignItems: 'flex-start', gap: '.8rem',
      animation: 'toastIn .25s ease',
    }}>
      <div style={{ width: 38, height: 38, background: 'var(--leaf)', borderRadius: 10, display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <svg viewBox="0 0 40 40" style={{ width: 22, height: 22 }}>
          <path d="M20 8c-2 0-7 4-7 10 0 2 .8 4 2 6l5 8 5-8c1.2-2 2-4 2-6 0-6-5-10-7-10z" fill="white" opacity=".9" />
          <circle cx="20" cy="18" r="3" fill="var(--leaf)" />
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: '.86rem', marginBottom: 2 }}>Installer Traç'Anclages</div>

        {showIosHint ? (
          <div style={{ fontSize: '.76rem', color: 'rgba(255,255,255,.75)', lineHeight: 1.5 }}>
            Appuyez sur <strong>Partager</strong> <ShareIcon /> puis <strong>« Sur l'écran d'accueil »</strong> pour installer l'app.
          </div>
        ) : (
          <div style={{ fontSize: '.76rem', color: 'rgba(255,255,255,.75)', marginBottom: '.6rem' }}>
            Ajoutez l'app à votre écran d'accueil pour un accès rapide, même hors connexion.
          </div>
        )}

        {!showIosHint && (
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.5rem' }}>
            <button onClick={handleInstall} className="btn-sm primary" style={{ fontSize: '.76rem', padding: '.4rem .9rem' }}>
              Installer
            </button>
            <button onClick={dismiss} className="btn-sm" style={{ fontSize: '.76rem', padding: '.4rem .9rem', background: 'rgba(255,255,255,.08)', color: 'white', borderColor: 'rgba(255,255,255,.2)' }}>
              Plus tard
            </button>
          </div>
        )}
      </div>

      <button onClick={dismiss} title="Fermer" style={{
        background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,.4)',
        padding: 4, flexShrink: 0, display: 'flex',
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width: 16, height: 16 }}>
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14, display: 'inline', verticalAlign: -2 }}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" /><line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}
