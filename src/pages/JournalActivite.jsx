import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import useIsMobile from '../lib/useIsMobile'

const TABLE_LABELS = {
  parcelles: 'Parcelles',
  interventions_phyto: 'Interventions phyto',
  interventions_outils: 'Interventions outils',
  interventions_vehicules: 'Interventions véhicules',
  outils_agricoles: 'Outils agricoles',
  vehicules_entretien: 'Entretien global',
  cereales_moisson: 'Céréales — moisson',
  cereales_contrats: 'Céréales — contrats',
  cereales_livraisons: 'Céréales — livraisons',
  pdt_recolte_pesees: 'Récolte PDT',
  plants_pdt: 'Plants PDT',
  planning_rdv: 'Planning',
  cave_cells: 'Frigos — cases',
  frigos: 'Frigos',
  lot_fiches: 'Frigos — fiches lot',
  contrats: 'Contrats',
  clients: 'Clients',
  db_phyto: 'Base de données — Phyto',
  db_intrants: 'Base de données — Intrants',
  db_varietes: 'Base de données — Variétés',
  profiles: 'Utilisateurs',
  conges: 'Congés',
  salaries: 'Salariés',
  agri_dossiers: 'Stock Agriculteurs',
  bons_sortie: 'Bons de sortie',
}
const METHOD_LABEL = { POST: '➕ Créé', PATCH: '✏️ Modifié', PUT: '✏️ Modifié', DELETE: '🗑️ Supprimé' }
const METHOD_COLOR = { POST: 'var(--green-mid)', PATCH: 'var(--amber)', PUT: 'var(--amber)', DELETE: 'var(--red)' }

const PAGE_SIZE = 60

export default function JournalActivite() {
  const isMobile = useIsMobile()
  const [rows, setRows] = useState([])
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [tableMissing, setTableMissing] = useState(false)

  const [filterUser, setFilterUser] = useState('')
  const [filterTable, setFilterTable] = useState('')
  const [filterMethod, setFilterMethod] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(null) // id de la ligne dont le détail est ouvert

  useEffect(() => { supabase.from('profiles').select('id,display_name').then(({ data }) => setProfiles(data || [])) }, [])
  useEffect(() => { load(0) }, [filterUser, filterTable, filterMethod])

  function buildQuery(from, to) {
    let q = supabase.from('activity_log').select('*').order('created_at', { ascending: false }).range(from, to)
    if (filterUser) q = q.eq('user_id', filterUser)
    if (filterTable) q = q.eq('table_name', filterTable)
    if (filterMethod) q = q.eq('method', filterMethod)
    return q
  }

  async function load(from) {
    if (from === 0) setLoading(true); else setLoadingMore(true)
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1)
    if (error) {
      if (/does not exist|relation|could not find/i.test(error.message)) setTableMissing(true)
      setLoading(false); setLoadingMore(false)
      return
    }
    setRows(prev => from === 0 ? (data || []) : [...prev, ...(data || [])])
    setHasMore((data || []).length === PAGE_SIZE)
    setLoading(false)
    setLoadingMore(false)
  }

  const profileName = id => profiles.find(p => p.id === id)?.display_name
  const usedTables = [...new Set(rows.map(r => r.table_name))].sort()

  const filtered = rows.filter(r => {
    if (!search.trim()) return true
    const s = search.toLowerCase()
    const nom = (profileName(r.user_id) || r.user_email || '').toLowerCase()
    return nom.includes(s) || (r.record_id || '').toLowerCase().includes(s) || (r.summary || '').toLowerCase().includes(s) || r.table_name.toLowerCase().includes(s)
  })

  if (tableMissing) return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1.5rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>🕵️</div>
        <p style={{ fontSize: '.88rem', color: 'var(--text-muted)' }}>
          Table manquante — exécute <strong>migration_A_EXECUTER_24.sql</strong> dans Supabase → SQL Editor, puis recharge la page.
        </p>
      </div>
    </div>
  )

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ background: 'white', borderBottom: '1px solid var(--border)', padding: isMobile ? '.8rem 1rem' : '.9rem 1.5rem' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 .7rem', color: 'var(--ink)' }}>🕵️ Journal d'activité</h2>
        <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
          <input type="text" placeholder="🔍 Utilisateur, id, résumé…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ padding: '.45rem .8rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.82rem', outline: 'none', flex: '1 1 200px', maxWidth: 260 }} />
          <select value={filterUser} onChange={e => setFilterUser(e.target.value)} style={{ fontSize: '.82rem' }}>
            <option value="">Tous les utilisateurs</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.display_name || p.id}</option>)}
          </select>
          <select value={filterTable} onChange={e => setFilterTable(e.target.value)} style={{ fontSize: '.82rem' }}>
            <option value="">Tous les onglets</option>
            {usedTables.map(t => <option key={t} value={t}>{TABLE_LABELS[t] || t}</option>)}
          </select>
          <select value={filterMethod} onChange={e => setFilterMethod(e.target.value)} style={{ fontSize: '.82rem' }}>
            <option value="">Toutes les actions</option>
            <option value="POST">➕ Créations</option>
            <option value="PATCH">✏️ Modifications</option>
            <option value="DELETE">🗑️ Suppressions</option>
          </select>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '.8rem' : '1rem 1.5rem' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
            Aucune action journalisée pour ces filtres.
          </div>
        ) : (
          <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {filtered.map((r, i) => (
              <div key={r.id}>
                <div onClick={() => setExpanded(expanded === r.id ? null : r.id)} style={{
                  display: 'flex', alignItems: 'center', gap: '.8rem', padding: '.65rem 1rem', cursor: 'pointer',
                  borderTop: i === 0 ? 'none' : '1px solid var(--border)', flexWrap: 'wrap',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--cream)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <span style={{ fontSize: '.74rem', color: 'var(--text-muted)', minWidth: isMobile ? 'auto' : 130 }}>
                    {new Date(r.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span style={{ fontSize: '.82rem', fontWeight: 700, minWidth: isMobile ? 'auto' : 110 }}>
                    {profileName(r.user_id) || r.user_email || 'Inconnu'}
                  </span>
                  <span style={{ fontSize: '.76rem', fontWeight: 700, color: METHOD_COLOR[r.method] || 'var(--text-muted)' }}>
                    {METHOD_LABEL[r.method] || r.method}
                  </span>
                  <span style={{ fontSize: '.8rem', color: 'var(--text-main)' }}>{TABLE_LABELS[r.table_name] || r.table_name}</span>
                  {r.summary && <span style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>· {r.summary}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: '.72rem', color: 'var(--text-muted)' }}>{expanded === r.id ? '▾' : '▸'} détail</span>
                </div>
                {expanded === r.id && (
                  <div style={{ padding: '.7rem 1rem', background: 'var(--cream)', borderTop: '1px solid var(--border)', fontSize: '.76rem' }}>
                    {r.record_id && <div style={{ marginBottom: '.4rem' }}><strong>Identifiant :</strong> {r.record_id}</div>}
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '.72rem', color: 'var(--text-muted)' }}>
                      {r.payload ? JSON.stringify(r.payload, null, 2) : '(pas de détail — suppression ou requête sans corps)'}
                    </pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {hasMore && !search && (
          <div style={{ textAlign: 'center', marginTop: '1rem' }}>
            <button className="btn-sm" disabled={loadingMore} onClick={() => load(rows.length)}>
              {loadingMore ? '⏳ Chargement…' : 'Charger plus'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
