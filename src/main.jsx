import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { CampagneProvider } from './lib/CampagneContext.jsx'
import 'leaflet/dist/leaflet.css'
import './index.css'
import { setPendingReload } from './lib/swUpdate'

// L'appli Android (Capacitor) charge le site en direct (server.url dans
// capacitor.config.json) — donc son JS vient de Vercel à chaque lancement,
// exactement comme la PWA installée depuis le navigateur. On enregistre
// désormais le service worker dans les deux cas : c'est lui qui permet à
// l'appli de s'ouvrir même sans réseau (coupure sur le terrain), en servant
// la coquille + les données déjà en cache. `registerType: 'autoUpdate'`
// vérifie une nouvelle version à chaque lancement en ligne et l'applique
// automatiquement (voir UpdateBanner) — pas de risque de rester bloqué sur
// une version périmée tant que le téléphone repasse en ligne de temps en temps.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  import('virtual:pwa-register').then(({ registerSW }) => {
    // Sans onNeedRefresh, un onglet resté ouvert continue de tourner sur le JS déjà
    // chargé même après un nouveau déploiement — d'où des correctifs qui semblent
    // "ne rien changer" alors qu'ils sont bien en ligne, juste pas encore rechargés.
    let registration = null
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() { setPendingReload(() => updateSW(true)) },
      onRegisteredSW(_url, reg) { registration = reg },
    })
    // Un téléphone gardé en tâche de fond pendant des jours (cas typique d'une app
    // installée) ne revérifie sinon jamais après le check initial — on revérifie
    // donc périodiquement et à chaque retour au premier plan, pour ne jamais rester
    // bloqué longtemps sur une version périmée.
    setInterval(() => registration?.update(), 30 * 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration?.update()
    })
  }).catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <CampagneProvider>
        <App />
      </CampagneProvider>
    </AuthProvider>
  </React.StrictMode>
)
