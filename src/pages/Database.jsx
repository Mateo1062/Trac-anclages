import { useState } from 'react'
import { useToast } from '../lib/useToast'
import { useAuth } from '../lib/AuthContext'
import ClientsTab from './bdd/ClientsTab'
import VarietesTab from './bdd/VarietesTab'
import ChargementsTab from './bdd/ChargementsTab'
import PhytoTab from './bdd/PhytoTab'
import UtilisateursTab from './bdd/UtilisateursTab'
import BobinesTab from './bdd/BobinesTab'

// Base de données scindée : ce qui concerne la vente/export d'un côté, la base
// de données agricole (phytosanitaires + intrants, fusionnés dans un seul onglet
// avec des filtres par catégorie) de l'autre — cf. répartition Export & Vente / Agricole.
const TABS_EXPORT = [
  { key: 'clients', label: '👥 Clients' },
  { key: 'varietes', label: '🥔 Variétés & Lots' },
  { key: 'chargements', label: '🚛 Chargements & Palettes' },
  { key: 'bobines', label: '🎞️ Bobines' },
]
const TABS_AGRICOLE = [
  { key: 'phyto', label: '🗄️ Base de données' },
]

export default function Database({ scope = 'export' }) {
  const { isAdmin, perms } = useAuth()
  const phytoReadOnly = !!perms.databaseAgricolePhytoReadOnlyOnly
  const baseTabs = scope === 'agricole' ? TABS_AGRICOLE : TABS_EXPORT
  const [tab, setTab] = useState(baseTabs[0].key)
  const { showToast, ToastEl } = useToast()
  const tabs = isAdmin ? [...baseTabs, { key: 'utilisateurs', label: '🔒 Utilisateurs' }] : baseTabs

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}
      <div style={{ padding: '0 1.8rem', borderBottom: '1px solid var(--border)', background: 'white', display: 'flex', gap: '.3rem', flexShrink: 0, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '.5rem 1.1rem', borderRadius: '8px 8px 0 0', cursor: 'pointer',
              fontSize: '.82rem', fontWeight: tab === t.key ? 600 : 500,
              border: '1px solid transparent', borderBottom: 'none',
              background: tab === t.key ? 'var(--green-mid)' : 'white',
              color: tab === t.key ? 'white' : 'var(--text-muted)',
              marginTop: '.4rem', transition: 'all .15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'clients' && <ClientsTab showToast={showToast} />}
      {tab === 'varietes' && <VarietesTab showToast={showToast} />}
      {tab === 'chargements' && <ChargementsTab showToast={showToast} />}
      {tab === 'bobines' && <BobinesTab showToast={showToast} />}
      {tab === 'phyto' && <PhytoTab showToast={showToast} readOnly={phytoReadOnly} />}
      {tab === 'utilisateurs' && isAdmin && <UtilisateursTab showToast={showToast} />}
    </div>
  )
}
