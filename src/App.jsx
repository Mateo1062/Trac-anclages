import { useState, useEffect, useRef } from 'react'
import { App as CapApp } from '@capacitor/app'
import { useAuth } from './lib/AuthContext'
import Login from './pages/Login'
import Planning from './pages/Planning'
import Frigos from './pages/Frigos'
import Database from './pages/Database'
import OutilsAgricoles from './pages/OutilsAgricoles'
import EntretienGlobal from './pages/EntretienGlobal'
import ParcelleCarte from './pages/ParcelleCarte'
import Cereales from './pages/Cereales'
import GlobalGap from './pages/GlobalGap'
import CommandePhyto from './pages/CommandePhyto'
import Engrais from './pages/Engrais'
import { DashboardAgricole, DashboardFrigo } from './pages/Dashboard'
import CoutRevient from './pages/CoutRevient'
import StockInterventions from './pages/StockInterventions'
import Meteo from './pages/Meteo'
import InstallPrompt from './components/InstallPrompt'
import OfflineBanner from './components/OfflineBanner'
import UpdateBanner from './components/UpdateBanner'
import JournalActivite from './pages/JournalActivite'
import { useCampagne } from './lib/CampagneContext'
import CampagneSelector from './components/CampagneSelector'
import { onGoToParcelleRequest } from './lib/mapFocus'
import { onGoToSectionRequest } from './lib/diagnosticNav'
import Diagnostic from './pages/Diagnostic'
import Corbeille from './pages/Corbeille'
import { supabase } from './lib/supabase'
import { applyCustomOrder } from './lib/navOrder'
import ChangePasswordModal from './components/ChangePasswordModal'
import NavReorderModal from './components/NavReorderModal'

/* ─── Navigation — copie "Agricole uniquement" : un seul espace ─── */
const NAV_AGRICOLE = [
  { group: 'Temps réel', items: [
    { id: 'dashboard-agricole', label: 'Tableau de bord', icon: IconDashboard },
    { id: 'stock-interventions', label: 'Stock & Interventions', icon: IconStock },
    { id: 'meteo-agricole', label: 'Météo',               icon: IconMeteo },
  ]},
  { group: 'Champ', items: [
    { id: 'parcelle-carte', label: 'Parcelle & Carte',   icon: IconMap },
    { id: 'cereales',       label: 'Céréales',           icon: IconCereale },
  ]},
  { group: 'Suivi', items: [
    { id: 'outils',         label: 'Outils agricoles',   icon: IconOutil },
    { id: 'entretien-global', label: 'Entretien global', icon: IconEntretien },
    { id: 'commande-phyto', label: 'Commande Phyto',     icon: IconPhyto },
    { id: 'engrais',        label: 'Calcul Engrais',     icon: IconEngrais },
    { id: 'cout-revient',   label: 'Coût de revient',    icon: IconCout, costOnly: true },
    { id: 'global-gap',     label: 'Global GAP',         icon: IconGap },
    { id: 'database-agricole', label: 'Base de données', icon: IconDb },
    { id: 'frigos',         label: 'Stockage Frigos',    icon: IconFrigo },
    { id: 'journal-activite', label: "Journal d'activité", icon: IconJournal, adminOnly: true },
    { id: 'diagnostic',     label: 'Diagnostic données', icon: IconDiagnostic, adminOnly: true },
    { id: 'corbeille',      label: 'Corbeille',          icon: IconCorbeille, adminOnly: true },
  ]},
]
// Accès restreint (rôle "frigo") : uniquement Planning + Stockage Frigos, jamais l'espace Agricole,
// pas de contrats/prix/historiques.
const NAV_FRIGO = [
  { group: 'Opérations', items: [
    { id: 'dashboard-frigo', label: 'Tableau de bord',   icon: IconDashboard },
    { id: 'planning',       label: 'Planning',           icon: IconCalendar },
    { id: 'frigos',         label: 'Stockage Frigos',    icon: IconFrigo },
  ]},
]
const WORKSPACES = {
  agricole: { key: 'agricole', label: 'Agricole', icon: '🌾', tagline: 'Parcelles, interventions, outils agricoles, plants…', groups: NAV_AGRICOLE, defaultSection: 'dashboard-agricole' },
}
// Filtre les groupes de nav selon les sections masquées pour le rôle courant
// (permissions.js), et retire les onglets réservés aux admins (adminOnly)/managers
// (managerOnly) pour tout le monde d'autre — puis retire les groupes devenus vides.
// `agricoleOnlyDuplicate` : n'affiche cet item dans l'espace Agricole QUE pour les
// rôles n'ayant pas accès à l'espace Export (sinon il y est déjà, pas de doublon).
function filterNavGroups(groups, hiddenSections, isAdmin, isManager, isAgricoleOnlyRole, canViewFacturation, canViewCosts) {
  return groups
    .map(g => ({ ...g, items: g.items.filter(i =>
      !(hiddenSections || []).includes(i.id) && (!i.adminOnly || isAdmin) && (!i.managerOnly || isManager)
      && (!i.agricoleOnlyDuplicate || isAgricoleOnlyRole) && (!i.hideForManagers || !isManager)
      && (!i.financeOnly || canViewFacturation) && (!i.costOnly || canViewCosts)
    ) }))
    .filter(g => g.items.length > 0)
}
// Choisit la section active : celle demandée si elle est autorisée, sinon la
// section par défaut de l'espace si elle l'est, sinon la première disponible.
function resolveActiveSection(ws, section) {
  const allIds = ws.groups.flatMap(g => g.items).map(i => i.id)
  if (section && allIds.includes(section)) return section
  if (ws.defaultSection && allIds.includes(ws.defaultSection)) return ws.defaultSection
  return allIds[0]
}

/* ─── SVG icons ──────────────────────────────────── */
const SI = (p) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width:18, height:18, flexShrink:0 }} {...p} />
function IconCalendar()  { return <SI><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></SI> }
function IconFrigo()     { return <SI><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="5" y1="10" x2="19" y2="10"/><line x1="9" y1="6" x2="9" y2="8"/></SI> }
function IconGazage()    { return <SI><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></SI> }
function IconSortie()    { return <SI><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/><path d="M3 5v14"/></SI> }
function IconAgri()      { return <SI><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></SI> }
function IconDb()        { return <SI><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></SI> }
function IconStock()     { return <SI><path d="M3 3v18h18"/><path d="M18.7 8 12 14l-3-3-4.5 4.5"/></SI> }
function IconMap()       { return <SI><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></SI> }
function IconCarte()     { return <SI><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></SI> }
function IconOutil()     { return <SI><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></SI> }
function IconPhyto()     { return <SI><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/></SI> }
function IconCout()      { return <SI><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></SI> }
function IconEngrais()   { return <SI><path d="M12 2C8 7 5 10.5 5 14a7 7 0 0 0 14 0c0-3.5-3-7-7-12z"/><path d="M12 18a4 4 0 0 1-4-4"/></SI> }
function IconCorbeille() { return <SI><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></SI> }
function IconDashboard() { return <SI><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></SI> }
function IconGap()       { return <SI><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></SI> }
function IconCereale()   { return <SI><path d="M12 22V8"/><path d="M12 12c-4 0-6-2-6-6 4 0 6 2 6 6z"/><path d="M12 12c4 0 6-2 6-6-4 0-6 2-6 6z"/><path d="M12 18c-4 0-6-2-6-6 4 0 6 2 6 6z"/><path d="M12 18c4 0 6-2 6-6-4 0-6 2-6 6z"/></SI> }
function IconMeteo()     { return <SI><path d="M17.5 19H9a5 5 0 1 1 1.6-9.75A6 6 0 0 1 22 11.5 4.5 4.5 0 0 1 17.5 19z"/></SI> }
function IconEntretien() { return <SI><path d="M5 17h14"/><path d="M5 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M15 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0z"/><path d="M5 17l1.5-6h11L19 17"/><path d="M7 11l1.5-4h7L17 11"/></SI> }
function IconJournal()   { return <SI><path d="M4 4h13a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V4z"/><path d="M8 8h9"/><path d="M8 12h9"/><path d="M8 16h5"/></SI> }
function IconFacture()   { return <SI><path d="M6 2h9l3 3v17H6z"/><path d="M9 8h6"/><path d="M9 12h6"/><path d="M9 16h4"/></SI> }
function IconDiagnostic() { return <SI><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></SI> }
function IconMenu()      { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width:20, height:20 }}><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg> }
function IconClose()     { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width:20, height:20 }}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> }
function IconLogout()    { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" style={{ width:16, height:16 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> }
function IconChevron(p)  { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width:14, height:14 }} {...p}><polyline points={p.left ? '15 18 9 12 15 6' : '9 18 15 12 9 6'}/></svg> }

function Logo({ size=22 }) {
  return (
    <svg viewBox="0 0 100 100" style={{ width:size, height:size, flexShrink:0 }}>
      <defs>
        <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#20384F"/>
          <stop offset="1" stopColor="#17293D"/>
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="24" fill="url(#logoGrad)"/>
      <line x1="50" y1="30" x2="50" y2="76" stroke="#E0A84C" strokeWidth="4" strokeLinecap="round"/>
      <path d="M50,30 L58,20 L50,24 L42,20 Z" fill="#F1C77A"/>
      <path d="M50,40 L64,32 L60,42 L50,46 Z" fill="#E0A84C"/>
      <path d="M50,40 L36,32 L40,42 L50,46 Z" fill="#E0A84C"/>
      <path d="M50,54 L63,47 L59,56 L50,60 Z" fill="#E0A84C"/>
      <path d="M50,54 L37,47 L41,56 L50,60 Z" fill="#E0A84C"/>
      <path d="M50,68 L61,62 L58,70 L50,74 Z" fill="#E0A84C"/>
      <path d="M50,68 L39,62 L42,70 L50,74 Z" fill="#E0A84C"/>
    </svg>
  )
}

// Écran "Qui es-tu ?" — le compte "Frigo" est partagé par 4 personnes (Vivien, Samuel,
// Morgan, Thierry) ; on redemande le nom + le code personnel à CHAQUE changement d'onglet
// (jamais mémorisé) pour tracer sans ambiguïté qui a fait quoi.
const FRIGO_NOMS = ['Vivien', 'Samuel', 'Morgan', 'Thierry']
function FrigoWhoAreYou({ onConfirm }) {
  const [nom, setNom] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  async function valider() {
    if (!nom || !code.trim()) return
    setChecking(true)
    setError('')
    const { data, error: err } = await supabase.from('frigo_identites').select('id').eq('nom', nom).eq('code', code.trim()).maybeSingle()
    setChecking(false)
    if (err && /relation|does not exist|could not find the table/i.test(err.message)) {
      setError("Table frigo_identites manquante — exécute migration_A_EXECUTER_71.sql dans Supabase → SQL Editor.")
      return
    }
    if (!data) { setError('Code incorrect.'); setCode(''); return }
    onConfirm(nom)
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:'1.6rem', background:'var(--field)', padding:'2rem' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'.7rem' }}>
        <Logo size={40} />
        <span style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.7rem', color:'var(--ink)' }}>Traç'Anclages</span>
      </div>
      <div style={{ background:'white', borderRadius:16, padding:'1.8rem', maxWidth:380, width:'100%', boxShadow:'var(--shadow-md)', border:'1px solid var(--border)' }}>
        <div style={{ fontWeight:700, fontSize:'1.05rem', marginBottom:'.3rem', textAlign:'center' }}>👋 Qui es-tu ?</div>
        <div style={{ fontSize:'.78rem', color:'var(--text-muted)', textAlign:'center', marginBottom:'1.2rem' }}>
          Confirme ton identité pour accéder aux frigos.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.6rem', marginBottom:'1.2rem' }}>
          {FRIGO_NOMS.map(n => (
            <button key={n} onClick={() => { setNom(n); setCode(''); setError('') }}
              style={{
                padding:'.8rem .5rem', borderRadius:10, cursor:'pointer', fontWeight:700, fontSize:'.9rem',
                border: nom===n ? '2px solid var(--green-mid)' : '1.5px solid var(--border)',
                background: nom===n ? 'var(--green-pale)' : 'white',
                color: nom===n ? 'var(--green-mid)' : 'var(--ink)',
              }}>
              {n}
            </button>
          ))}
        </div>
        {nom && (
          <div className="form-group" style={{ marginBottom:'1rem' }}>
            <label>Code personnel de {nom}</label>
            <input type="password" inputMode="numeric" autoFocus value={code}
              onChange={e => { setCode(e.target.value); setError('') }}
              onKeyDown={e => { if (e.key === 'Enter') valider() }}
              placeholder="••••" />
          </div>
        )}
        {error && <div style={{ color:'var(--red,#c0392b)', fontSize:'.8rem', marginBottom:'.8rem', textAlign:'center' }}>{error}</div>}
        <button className="btn-sm primary" onClick={valider} disabled={!nom || !code.trim() || checking}
          style={{ width:'100%', justifyContent:'center', padding:'.6rem', fontSize:'.88rem' }}>
          {checking ? 'Vérification…' : 'Valider'}
        </button>
      </div>
    </div>
  )
}

/* ─── Custom hook: detect mobile/tablet ─────────── */
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const fn = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
  return isMobile
}

/* ─── App root ───────────────────────────────────── */
export default function App() {
  const { user, profile, loading, logout, isFrigo, isAdmin, isManager, role, perms, canViewFacturation, canViewCosts } = useAuth()
  // Au démarrage, on affiche TOUJOURS le choix d'espace (Export & Vente /
  // Agricole) — l'espace n'est plus mémorisé entre deux ouvertures.
  const [workspace, setWorkspace] = useState(null)
  const [section, setSection]     = useState(null)
  // Rôle "frigo" (compte partagé Vivien/Samuel/Morgan/Thierry) : identité à reconfirmer
  // à CHAQUE changement d'onglet (pas mémorisée), pour savoir qui fait quoi.
  const [frigoIdentityConfirmed, setFrigoIdentityConfirmed] = useState(false)
  const [frigoPendingSection, setFrigoPendingSection] = useState('dashboard-frigo')
  // "Aller sur la carte" depuis la liste des parcelles (Base de données) —
  // bascule la section active, Carte.jsx lit ensuite l'id en attente lui-même.
  useEffect(() => onGoToParcelleRequest(() => setSection('parcelle-carte')), [])
  // "🔍 Localiser" depuis le Diagnostic — bascule juste la section, le hint a déjà
  // été copié dans le presse-papier par requestGoToSection elle-même.
  useEffect(() => onGoToSectionRequest(sectionId => setSection(sectionId)), [])
  // Sur tablette (largeur intermédiaire entre mobile et desktop), la sidebar
  // repliée automatiquement laisse assez de place pour éviter le défilement
  // horizontal des tableaux (ex. liste des parcelles). L'utilisateur garde la
  // main : un clic manuel sur le bouton replier/déplier désactive l'auto-ajustement.
  const [collapsed, setCollapsedRaw] = useState(() => window.innerWidth >= 768 && window.innerWidth < 1100)
  const collapsedOverrideRef = useRef(false)
  function setCollapsed(updaterOrValue) {
    collapsedOverrideRef.current = true
    setCollapsedRaw(updaterOrValue)
  }
  useEffect(() => {
    function onResize() {
      if (collapsedOverrideRef.current) return
      setCollapsedRaw(window.innerWidth >= 768 && window.innerWidth < 1100)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const [mobileOpen, setMobileOpen] = useState(false)
  const isMobile = useIsMobile()
  const [reorderOpen, setReorderOpen] = useState(false)

  // Bouton retour matériel (Android/tablette) : ferme d'abord une éventuelle
  // fenêtre modale ouverte, sinon le tiroir de menu mobile, sinon ramène à
  // l'écran principal de l'espace courant ; si on y est déjà, demande
  // confirmation avant de quitter l'appli (au lieu de fermer directement).
  const backStateRef = useRef({})
  useEffect(() => {
    backStateRef.current = { workspace, section, mobileOpen, isFrigo }
  })
  useEffect(() => {
    let handle
    CapApp.addListener('backButton', () => {
      const { workspace, section, mobileOpen, isFrigo } = backStateRef.current

      const overlay = document.querySelector('.modal-overlay')
      if (overlay) { overlay.click(); return }

      if (mobileOpen) { setMobileOpen(false); return }

      const homeSection = isFrigo ? 'dashboard-frigo' : 'dashboard-agricole'

      if (homeSection && section && section !== homeSection) {
        setSection(homeSection)
        return
      }

      if (window.confirm("Quitter Traç'Anclages ?")) {
        CapApp.exitApp()
      }
    }).then(h => { handle = h })
    return () => { handle?.remove() }
  }, [])

  if (loading) return (
    <div style={{ height:'100vh', display:'grid', placeItems:'center', background:'var(--field)' }}>
      <div style={{ textAlign:'center', display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
        <Logo size={48} />
        <div className="spinner" style={{ borderTopColor:'var(--leaf)', borderColor:'var(--straw)', width:24, height:24 }} />
      </div>
    </div>
  )
  if (!user) return <Login />

  function changeWorkspace() {
    if (isFrigo) return // accès restreint : pas de changement d'espace possible
    setWorkspace(null)
    setSection(null)
    setMobileOpen(false)
  }

  // Rôle frigo : jamais de choix d'espace, toujours "export" avec un menu réduit —
  // et une identité personnelle (parmi les 4 partageant ce compte) à reconfirmer à
  // chaque changement d'onglet, avant que le contenu ne s'affiche.
  if (isFrigo) {
    const ws = { key: 'frigo', label: 'Frigo', icon: '📦', tagline: '', groups: NAV_FRIGO }
    const dn = profile?.display_name || user.email.split('@')[0]
    const initials = dn.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
    const activeSection = section || 'dashboard-frigo'
    const activeItem = NAV_FRIGO.flatMap(g=>g.items).find(i => i.id === activeSection)
    function navigateFrigo(id) {
      setFrigoPendingSection(id)
      setFrigoIdentityConfirmed(false)
      setMobileOpen(false)
    }
    if (!frigoIdentityConfirmed) {
      return (
        <FrigoWhoAreYou onConfirm={nom => { setFrigoIdentityConfirmed(nom); setSection(frigoPendingSection) }} />
      )
    }
    const frigoPageProps = { identifiantFrigo: frigoIdentityConfirmed }
    return (
      <>
        {isMobile
          ? <MobileLayout workspace={ws} section={activeSection} navigate={navigateFrigo} logout={logout} changeWorkspace={changeWorkspace} dn={dn} initials={initials} role="frigo" mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} activeItem={activeItem} hideWorkspaceSwitcher pageProps={frigoPageProps} />
          : <DesktopLayout workspace={ws} section={activeSection} navigate={navigateFrigo} logout={logout} changeWorkspace={changeWorkspace} dn={dn} initials={initials} role="frigo" collapsed={collapsed} setCollapsed={setCollapsed} activeItem={activeItem} hideWorkspaceSwitcher pageProps={frigoPageProps} />}
        <InstallPrompt />
        <OfflineBanner />
        <UpdateBanner />
      </>
    )
  }

  // ─── Copie "Agricole uniquement" ────────────────────────────────
  // Plus de choix d'espace : tout le monde (sauf le rôle frigo dédié, géré
  // ci-dessus) atterrit directement sur l'espace Agricole. Les restrictions
  // par rôle existantes (hiddenSections, lecture seule, etc. — permissions.js)
  // restent actives à l'identique.
  const baseWs = WORKSPACES['agricole']
  const filteredGroups = filterNavGroups(baseWs.groups, perms.hiddenSections, isAdmin, isManager, true, canViewFacturation, canViewCosts)
  const ws = { ...baseWs, groups: applyCustomOrder(filteredGroups, 'agricole') }
  const dn = profile?.display_name || user.email.split('@')[0]
  const initials = dn.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()
  const activeSection = resolveActiveSection(ws, section)
  const activeItem = ws.groups.flatMap(g => g.items).find(i => i.id === activeSection)

  function navigate(id) {
    setSection(id)
    setMobileOpen(false)
  }

  return (
    <>
      {isMobile
        ? <MobileLayout workspace={ws} section={activeSection} navigate={navigate} logout={logout} changeWorkspace={changeWorkspace} dn={dn} initials={initials} role={role} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} activeItem={activeItem} hideWorkspaceSwitcher onReorder={() => setReorderOpen(true)} />
        : <DesktopLayout workspace={ws} section={activeSection} navigate={navigate} logout={logout} changeWorkspace={changeWorkspace} dn={dn} initials={initials} role={role} collapsed={collapsed} setCollapsed={setCollapsed} activeItem={activeItem} hideWorkspaceSwitcher onReorder={() => setReorderOpen(true)} />}
      <InstallPrompt />
      <OfflineBanner />
      <UpdateBanner />
      {reorderOpen && (
        <NavReorderModal workspaceKey="agricole" groups={filteredGroups} onClose={() => setReorderOpen(false)} onSaved={() => setReorderOpen(false)} />
      )}
    </>
  )
}

/* ─── DESKTOP layout ─────────────────────────────── */
function DesktopLayout({ workspace, section, navigate, logout, changeWorkspace, dn, initials, role, collapsed, setCollapsed, activeItem, hideWorkspaceSwitcher, onReorder, pageProps }) {
  const sideW = collapsed ? 64 : 248
  const { campagneActive, setCampagneActive, campagnesListe } = useCampagne()
  const { isManager } = useAuth()
  const [pwModalOpen, setPwModalOpen] = useState(false)
  return (
    <div style={{ height:'100vh', display:'flex', overflow:'hidden' }}>
      {/* Sidebar */}
      <aside style={{
        width: sideW, flexShrink:0, background:'linear-gradient(180deg, var(--soil), var(--soil-mid))',
        display:'flex', flexDirection:'column', overflow:'hidden',
        borderRight:'1px solid rgba(255,255,255,.05)',
        transition:'width .2s cubic-bezier(.4,0,.2,1)',
      }}>
        {/* Logo */}
        <div style={{ height:'calc(56px + env(safe-area-inset-top))', display:'flex', alignItems:'center', padding:'env(safe-area-inset-top) 14px 0', gap:10, borderBottom:'1px solid rgba(255,255,255,.07)', flexShrink:0, boxSizing:'border-box' }}>
          <Logo />
          {!collapsed && <span style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.18rem', color:'white', whiteSpace:'nowrap' }}>Traç<span style={{ color:'var(--sprout)' }}>'</span>Agri</span>}
          <button onClick={() => setCollapsed(c=>!c)} title={collapsed?'Déplier':'Réduire'}
            style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.35)', borderRadius:6, padding:4, display:'flex', transition:'color .15s' }}
            onMouseEnter={e=>e.currentTarget.style.color='rgba(255,255,255,.85)'}
            onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,.35)'}>
            <IconMenu />
          </button>
        </div>

        {/* Espace de travail */}
        {!hideWorkspaceSwitcher && (
        <div style={{ padding:'8px 6px 0' }}>
          <button onClick={changeWorkspace} title="Changer d'espace" style={{
            width:'100%', display:'flex', alignItems:'center', gap:8, padding: collapsed ? '8px 0' : '7px 10px',
            justifyContent: collapsed ? 'center' : 'flex-start', borderRadius:10, cursor:'pointer',
            border:'1px solid rgba(255,255,255,.1)', background:'rgba(255,255,255,.05)', color:'rgba(255,255,255,.75)', fontSize:'.76rem', fontWeight:600,
          }}>
            <span style={{ fontSize:'1rem' }}>{workspace.icon}</span>
            {!collapsed && <span style={{ flex:1, textAlign:'left', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{workspace.label}</span>}
            {!collapsed && <span style={{ fontSize:'.7rem', color:'rgba(255,255,255,.4)' }}>⇄</span>}
          </button>
        </div>
        )}

        {/* Campagne active — globale à toute l'appli */}
        {!collapsed && (
          <div style={{ padding:'10px 10px 2px' }}>
            <CampagneSelector campagnes={campagnesListe} value={campagneActive} onChange={setCampagneActive} canCreate={isManager} />
          </div>
        )}

        {!collapsed && (
          <div style={{ padding:'2px 10px 0', display:'flex', gap:6 }}>
            <button onClick={onReorder} title="Réorganiser le menu" style={{
              flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'5px 0',
              borderRadius:8, cursor:'pointer', border:'1px dashed rgba(255,255,255,.15)', background:'none',
              color:'rgba(255,255,255,.4)', fontSize:'.68rem', fontWeight:600,
            }}>↕️ Réorganiser</button>
            <button onClick={() => window.location.reload()} title="Actualiser toute l'application" style={{
              flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'5px 0',
              borderRadius:8, cursor:'pointer', border:'1px dashed rgba(255,255,255,.15)', background:'none',
              color:'rgba(255,255,255,.4)', fontSize:'.68rem', fontWeight:600,
            }}>🔄 Actualiser</button>
          </div>
        )}

        {/* Nav */}
        <nav style={{ flex:1, overflowY:'auto', overflowX:'hidden', padding:'8px 6px' }}>
          {workspace.groups.map(g => (
            <div key={g.group} style={{ marginBottom:4 }}>
              {!collapsed && (
                <div style={{ fontSize:'.6rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.12em', color:'rgba(255,255,255,.22)', padding:'8px 10px 3px' }}>
                  {g.group}
                </div>
              )}
              {g.items.map(item => <NavItem key={item.id} item={item} active={section===item.id} collapsed={collapsed} onClick={() => navigate(item.id)} />)}
            </div>
          ))}
        </nav>

        {/* User */}
        <div style={{ padding:'8px 6px', borderTop:'1px solid rgba(255,255,255,.07)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:9, padding:'8px 8px', borderRadius:8, background:'rgba(255,255,255,.05)' }}>
            <div style={{ width:28, height:28, background:'var(--leaf)', borderRadius:'50%', display:'grid', placeItems:'center', fontSize:'.7rem', fontWeight:700, color:'white', flexShrink:0 }}>{initials}</div>
            {!collapsed && <>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color:'rgba(255,255,255,.88)', fontSize:'.77rem', fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{dn}</div>
                <div style={{ color:'rgba(255,255,255,.3)', fontSize:'.64rem', textTransform:'capitalize' }}>{role}</div>
              </div>
              <button onClick={() => setPwModalOpen(true)} title="Changer mon mot de passe"
                style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.3)', borderRadius:6, padding:4, display:'flex', transition:'color .15s' }}
                onMouseEnter={e=>e.currentTarget.style.color='white'}
                onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,.3)'}>
                🔑
              </button>
              <button onClick={logout} title="Déconnexion"
                style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.3)', borderRadius:6, padding:4, display:'flex', transition:'color .15s' }}
                onMouseEnter={e=>e.currentTarget.style.color='white'}
                onMouseLeave={e=>e.currentTarget.style.color='rgba(255,255,255,.3)'}>
                <IconLogout />
              </button>
            </>}
          </div>
        </div>
      </aside>
      {pwModalOpen && <ChangePasswordModal onClose={() => setPwModalOpen(false)} />}

      {/* Right side */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Top bar */}
        <header style={{ height:52, background:'var(--white)', borderBottom:'1px solid var(--straw)', display:'flex', alignItems:'center', padding:'0 1.4rem', gap:'1rem', flexShrink:0, boxShadow:'var(--shadow-xs)', borderRadius:'0 0 0 var(--r-lg)' }}>
          <div>
            <div style={{ fontSize:'.95rem', fontWeight:700, color:'var(--ink)', lineHeight:1.2 }}>{activeItem?.label}</div>
            <div style={{ fontSize:'.68rem', color:'var(--fog)', marginTop:1 }}>
              {new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}
            </div>
          </div>
        </header>
        {/* Content */}
        <main style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column', background:'var(--field)' }}>
          <PageRouter section={section} pageProps={pageProps} />
        </main>
      </div>
    </div>
  )
}

/* ─── MOBILE layout ──────────────────────────────── */
const MOBILE_QUICK_TABS = {
  agricole: [{ id:'dashboard-agricole', label:'Tableau de bord', Icon:IconDashboard }, { id:'parcelle-carte', label:'Parcelles', Icon:IconMap }, { id:'outils', label:'Outils', Icon:IconOutil }, { id:'commande-phyto', label:'Phyto', Icon:IconPhyto }, { id:'database-agricole', label:'Base de données', Icon:IconDb }],
  frigo:    [{ id:'planning', label:'Planning', Icon:IconCalendar }, { id:'frigos', label:'Frigos', Icon:IconFrigo }],
}
function MobileLayout({ workspace, section, navigate, logout, changeWorkspace, dn, initials, role, mobileOpen, setMobileOpen, activeItem, hideWorkspaceSwitcher, onReorder, pageProps }) {
  const { campagneActive, setCampagneActive, campagnesListe } = useCampagne()
  const { isManager } = useAuth()
  const [pwModalOpen, setPwModalOpen] = useState(false)
  // Les raccourcis du bas ne doivent proposer que des pages auxquelles cet
  // utilisateur a vraiment accès — workspace.groups est déjà filtré selon ses
  // restrictions (filterNavGroups), on s'en sert comme liste de référence.
  const allowedSectionIds = new Set(workspace.groups.flatMap(g => g.items).map(i => i.id))
  const quickTabs = (MOBILE_QUICK_TABS[workspace.key] || []).filter(t => allowedSectionIds.has(t.id))
  return (
    <div style={{ height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--field)' }}>
      {/* Mobile top bar — paddingTop reserves space for the system status bar (clock/battery) */}
      <header style={{ paddingTop:'env(safe-area-inset-top)', background:'var(--soil)', flexShrink:0 }}>
        <div style={{ height:52, display:'flex', alignItems:'center', padding:'0 1rem', gap:10 }}>
          <button onClick={() => setMobileOpen(true)}
            style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.7)', padding:4, display:'flex', borderRadius:6 }}>
            <IconMenu />
          </button>
          <Logo size={28} />
          <span style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.1rem', color:'white' }}>Traç<span style={{ color:'var(--sprout)' }}>'</span>Agri</span>
          <div style={{ marginLeft:'auto', width:28, height:28, background:'var(--leaf)', borderRadius:'50%', display:'grid', placeItems:'center', fontSize:'.7rem', fontWeight:700, color:'white' }}>
            {initials}
          </div>
        </div>
      </header>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div style={{ position:'fixed', inset:0, zIndex:9000, display:'flex' }}>
          {/* Backdrop */}
          <div onClick={() => setMobileOpen(false)} style={{ position:'absolute', inset:0, background:'rgba(0,0,0,.5)', backdropFilter:'blur(2px)' }} />
          {/* Drawer */}
          <div style={{ position:'relative', width:280, background:'var(--soil)', height:'100%', display:'flex', flexDirection:'column', animation:'slideIn .22s ease' }}>
            {/* Header */}
            <div style={{ paddingTop:'env(safe-area-inset-top)', borderBottom:'1px solid rgba(255,255,255,.07)', flexShrink:0 }}>
              <div style={{ height:56, display:'flex', alignItems:'center', padding:'0 14px', gap:10 }}>
                <Logo />
                <span style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.1rem', color:'white' }}>Traç<span style={{ color:'var(--sprout)' }}>'</span>Agri</span>
                <button onClick={() => setMobileOpen(false)}
                  style={{ marginLeft:'auto', background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.5)', borderRadius:6, padding:4, display:'flex' }}>
                  <IconClose />
                </button>
              </div>
            </div>

            {/* Espace de travail */}
            {!hideWorkspaceSwitcher && (
            <div style={{ padding:'8px 6px 0' }}>
              <button onClick={changeWorkspace} title="Changer d'espace" style={{
                width:'100%', display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
                borderRadius:10, cursor:'pointer', border:'1px solid rgba(255,255,255,.1)',
                background:'rgba(255,255,255,.05)', color:'rgba(255,255,255,.75)', fontSize:'.78rem', fontWeight:600,
              }}>
                <span style={{ fontSize:'1.05rem' }}>{workspace.icon}</span>
                <span style={{ flex:1, textAlign:'left' }}>{workspace.label}</span>
                <span style={{ fontSize:'.72rem', color:'rgba(255,255,255,.4)' }}>⇄ changer</span>
              </button>
            </div>
            )}

            {/* Campagne active — globale à toute l'appli */}
            <div style={{ padding:'10px 10px 2px' }}>
              <CampagneSelector campagnes={campagnesListe} value={campagneActive} onChange={setCampagneActive} canCreate={isManager} />
            </div>

            <div style={{ padding:'6px 10px 0', display:'flex', gap:6 }}>
              {onReorder && (
                <button onClick={() => { setMobileOpen(false); onReorder() }} style={{
                  flex:1, minHeight:40, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'10px 0',
                  borderRadius:8, cursor:'pointer', border:'1px dashed rgba(255,255,255,.15)', background:'none',
                  color:'rgba(255,255,255,.45)', fontSize:'.72rem', fontWeight:600,
                }}>↕️ Réorganiser</button>
              )}
              <button onClick={() => window.location.reload()} style={{
                flex:1, minHeight:40, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'10px 0',
                borderRadius:8, cursor:'pointer', border:'1px dashed rgba(255,255,255,.15)', background:'none',
                color:'rgba(255,255,255,.45)', fontSize:'.72rem', fontWeight:600,
              }}>🔄 Actualiser</button>
            </div>

            {/* Nav groups in drawer */}
            <nav style={{ flex:1, overflowY:'auto', padding:'8px 6px' }}>
              {workspace.groups.map(g => (
                <div key={g.group} style={{ marginBottom:4 }}>
                  <div style={{ fontSize:'.6rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.12em', color:'rgba(255,255,255,.22)', padding:'8px 10px 3px' }}>
                    {g.group}
                  </div>
                  {g.items.map(item => <NavItem key={item.id} item={item} active={section===item.id} collapsed={false} onClick={() => navigate(item.id)} />)}
                </div>
              ))}
            </nav>

            {/* User row */}
            <div style={{ padding:'8px 6px calc(8px + env(safe-area-inset-bottom))', borderTop:'1px solid rgba(255,255,255,.07)', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:9, padding:'10px 10px', borderRadius:8, background:'rgba(255,255,255,.05)' }}>
                <div style={{ width:32, height:32, background:'var(--leaf)', borderRadius:'50%', display:'grid', placeItems:'center', fontSize:'.72rem', fontWeight:700, color:'white' }}>{initials}</div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:'rgba(255,255,255,.88)', fontSize:'.8rem', fontWeight:500, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{dn}</div>
                  <div style={{ color:'rgba(255,255,255,.35)', fontSize:'.66rem', textTransform:'capitalize' }}>{role}</div>
                </div>
                <button onClick={() => { setMobileOpen(false); setPwModalOpen(true) }} title="Changer mon mot de passe"
                  style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', borderRadius:6, padding:6, display:'flex' }}>
                  🔑
                </button>
                <button onClick={logout} title="Déconnexion"
                  style={{ background:'none', border:'none', cursor:'pointer', color:'rgba(255,255,255,.4)', borderRadius:6, padding:6, display:'flex' }}>
                  <IconLogout />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {pwModalOpen && <ChangePasswordModal onClose={() => setPwModalOpen(false)} />}

      {/* Page title bar (mobile) */}
      <div style={{ background:'white', borderBottom:'1px solid var(--straw)', padding:'.6rem 1rem', display:'flex', alignItems:'center', gap:'.5rem' }}>
        <span style={{ fontSize:'.9rem', fontWeight:700, color:'var(--ink)' }}>{activeItem?.label}</span>
      </div>

      {/* Mobile bottom tabs — top 4 items for quick access */}
      <main style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        <PageRouter section={section} pageProps={pageProps} />
      </main>

      {/* Bottom nav bar (mobile) — paddingBottom reserves space for the system nav bar/gesture area */}
      <nav style={{ paddingBottom:'env(safe-area-inset-bottom)', background:'white', borderTop:'1px solid var(--straw)', display:'flex', flexShrink:0, zIndex:100, height:'calc(58px + env(safe-area-inset-bottom))' }}>
        {quickTabs.map(({ id, label, Icon }) => {
          const active = section === id
          return (
            <button key={id} onClick={() => navigate(id)} style={{
              flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3,
              background:'none', border:'none', cursor:'pointer',
              color: active ? 'var(--leaf)' : 'var(--fog)',
              borderTop: active ? '2px solid var(--leaf)' : '2px solid transparent',
              transition:'all .15s', paddingTop:2,
            }}>
              <Icon />
              <span style={{ fontSize:'.58rem', fontWeight: active ? 600 : 400, lineHeight:1 }}>{label}</span>
            </button>
          )
        })}
        {/* More button → opens drawer */}
        <button onClick={() => setMobileOpen(true)} style={{
          flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3,
          background:'none', border:'none', cursor:'pointer', color:'var(--fog)',
          borderTop:'2px solid transparent', paddingTop:2,
        }}>
          <IconMenu />
          <span style={{ fontSize:'.58rem', fontWeight:400, lineHeight:1 }}>Plus</span>
        </button>
      </nav>
    </div>
  )
}

/* ─── Shared NavItem ─────────────────────────────── */
function NavItem({ item, active, collapsed, onClick }) {
  return (
    <button onClick={onClick} title={collapsed ? item.label : ''} style={{
      width:'100%', display:'flex', alignItems:'center', gap:10,
      padding: collapsed ? '9px 0' : '8px 12px',
      justifyContent: collapsed ? 'center' : 'flex-start',
      borderRadius: 999, cursor:'pointer', border:'none', marginBottom:3,
      background: active ? 'linear-gradient(135deg, var(--leaf), var(--leaf-light))' : 'transparent',
      color: active ? 'white' : 'rgba(255,255,255,.55)',
      fontSize:'.82rem', fontWeight: active ? 700 : 500,
      transition:'all .13s',
      boxShadow: active ? '0 3px 10px rgba(47,158,70,.35)' : 'none',
    }}
    onMouseEnter={e => { if(!active){ e.currentTarget.style.background='rgba(255,255,255,.08)'; e.currentTarget.style.color='rgba(255,255,255,.9)' }}}
    onMouseLeave={e => { if(!active){ e.currentTarget.style.background='transparent'; e.currentTarget.style.color='rgba(255,255,255,.55)' }}}>
      <item.icon />
      {!collapsed && <span style={{ whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.label}</span>}
    </button>
  )
}

/* ─── Page router ────────────────────────────────── */
function PageRouter({ section, pageProps = {} }) {
  const { isAdmin } = useAuth()
  return (
    <>
      {section==='planning'       && <Planning />}
      {section==='frigos'         && <Frigos {...pageProps} />}
      {section==='journal-activite'  && isAdmin && <JournalActivite />}
      {section==='diagnostic'        && isAdmin && <Diagnostic />}
      {section==='corbeille'         && isAdmin && <Corbeille />}
      {section==='database-agricole' && <Database scope="agricole" />}
      {section==='outils'         && <OutilsAgricoles />}
      {section==='entretien-global' && <EntretienGlobal />}
      {section==='parcelle-carte' && <ParcelleCarte />}
      {section==='global-gap'     && <GlobalGap />}
      {section==='commande-phyto' && <CommandePhyto />}
      {section==='engrais' && <Engrais />}
      {section==='dashboard-agricole' && <DashboardAgricole />}
      {section==='dashboard-frigo'    && <DashboardFrigo />}
      {section==='cout-revient'   && <CoutRevient />}
      {section==='cereales'       && <Cereales />}
      {section==='stock-interventions' && <StockInterventions />}
      {section==='meteo-agricole' && <Meteo />}
    </>
  )
}
