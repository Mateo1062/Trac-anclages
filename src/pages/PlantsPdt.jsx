import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import { printLogoHtml } from '../lib/printLogo'
import { byNom } from '../lib/byNom'
import useIsMobile from '../lib/useIsMobile'
import { defaultCampagne, campagnesDisponibles, isAtOrBeforeCampagne } from '../lib/campagne'
import { useCampagne } from '../lib/CampagneContext'
import { fmtDate } from '../lib/formatDate'

/* ═══════════════════════════════════════════════════════════
   ENTRÉES / SORTIES PLANTS PDT
   ┌──────────────────────────────────────────────────────┐
   │ Onglet 1 — Mouvements   (historique complet)         │
   │ Onglet 2 — Stock plants  (solde par variété/lot)     │
   │ Onglet 3 — Par agri      (ce que chaque agri a pris) │
   └──────────────────────────────────────────────────────┘
═══════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'dossiers-vc', label: '📁 Par variété/calibre' },
  { key: 'mouvements', label: '📋 Mouvements' },
  { key: 'reception',  label: '📥 Réception par variété' },
  { key: 'stock',      label: '📦 Stock plants' },
  { key: 'agris',      label: '🌾 Suivi par agri' },
]

// Convertit une quantité en tonnes (les pesées sont saisies en kg ou en T)
function toTonnes(quantite, unite) {
  if (quantite == null) return 0
  return unite === 'T' ? quantite : quantite / 1000
}

export default function PlantsPdt() {
  const { user, perms } = useAuth()
  const stockOnly = !!perms.plantsPdtStockOnly
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()

  const [tab,     setTab]     = useState(stockOnly ? 'stock' : 'mouvements')
  const [kpiOuvert, setKpiOuvert] = useState(false) // chiffres clés repliés par défaut sur mobile
  const [records, setRecords] = useState([])
  const [agris,   setAgris]   = useState([])
  const [doses,   setDoses]   = useState([])
  const [dosesMissing, setDosesMissing] = useState(false)
  const [loading, setLoading] = useState(true)

  // modal state
  const [editing,  setEditing]  = useState(null)
  const [bonModal, setBonModal] = useState(null)

  // filter for mouvements tab
  const [filterType,   setFilterType]   = useState('all')
  const [filterVariete, setFilterVariete] = useState('')

  // Dossiers par variété/calibre (onglet dédié) — pour ne jamais mélanger deux
  // variétés, ou deux calibres d'une même variété, dans le même suivi.
  const [dossierVC, setDossierVC] = useState(null) // clé "variete|calibre"
  const [dossierVCSearch, setDossierVCSearch] = useState('')

  // Campagne (année agricole) — les onglets Mouvements/Réception repartent sur une
  // base vierge chaque année ; le Stock plants (solde) et le Suivi par agri restent
  // cumulatifs sur toutes les campagnes (le stock ne se remet pas à zéro).
  const { campagneActive, registerCampagnes } = useCampagne()
  const campagneOf = r => r.campagne || defaultCampagne()
  const recordsCampagne = records.filter(r => campagneOf(r) === campagneActive)
  // Cumulatif "jusqu'à la campagne consultée" — le stock ne se remet pas à zéro
  // d'une campagne à l'autre, mais une campagne passée ne doit jamais inclure un
  // mouvement saisi dans une campagne ultérieure.
  const recordsUpTo = records.filter(r => isAtOrBeforeCampagne(campagneOf(r), campagneActive))
  const campagnesListe = campagnesDisponibles(records)
  useEffect(() => { registerCampagnes(campagnesListe) }, [campagnesListe.join(',')])

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: p }, { data: a }, { data: d, error: de }] = await Promise.all([
      supabase.from('plants_pdt').select('*').order('date', { ascending: false }),
      supabase.from('agri_dossiers').select('id,nom,infos').order('nom'),
      supabase.from('plants_doses_plantation').select('*'),
    ])
    setRecords(p || [])
    setAgris((a || []).sort(byNom))
    setDoses(d || [])
    if (de && /does not exist|relation|could not find the table/i.test(de.message)) setDosesMissing(true)
    setLoading(false)
  }

  // dose de plantation (t/ha) par variété+calibre — upsert à la volée
  async function saveDose(variete, calibre, val) {
    const dose = parseFloat(val) || null
    const { data, error } = await supabase.from('plants_doses_plantation')
      .upsert({ variete, calibre: calibre || '', dose_t_ha: dose }, { onConflict: 'variete,calibre' })
      .select().single()
    if (error) { alert(error.message); return }
    setDoses(prev => {
      const rest = prev.filter(x => !(x.variete === variete && (x.calibre || '') === (calibre || '')))
      return [...rest, data]
    })
    showToast('✅ Dose enregistrée')
  }

  // Crée un dossier agriculteur dans la table partagée avec Stock Agriculteurs
  async function createAgri(nom) {
    const { data, error } = await supabase.from('agri_dossiers').insert({ nom, infos: {} }).select().single()
    if (error) { alert(error.message); return null }
    setAgris(prev => [...prev, data].sort(byNom))
    showToast('✅ Dossier créé — visible aussi dans Stock Agriculteurs')
    return data
  }

  // ── CRUD ──
  function openNew(type) {
    setEditing({
      type, date: new Date().toISOString().split('T')[0], campagne: campagneActive,
      agri_id: null, agri_nom: '', variete: '', calibre: '', lot: '',
      quantite: '', unite: 'kg', fournisseur: '', ref_chargement: '',
      prix_unitaire: '', observation: '',
    })
  }
  function openEdit(r) { setEditing({ ...r }) }

  async function save() {
    if (!editing.date) { alert('La date est obligatoire.'); return }
    const payload = {
      ...editing,
      quantite:              parseFloat(editing.quantite)      || null,
      prix_unitaire:         parseFloat(editing.prix_unitaire) || null,
      poids_100_tubercules:  parseFloat(editing.poids_100_tubercules) || null,
      user_id: user?.id,
    }
    delete payload.created_at
    if (editing.id) {
      let { error } = await supabase.from('plants_pdt').update(payload).eq('id', editing.id)
      if (error && /campagne|poids_100_tubercules|column/i.test(error.message)) {
        const { campagne, poids_100_tubercules, ...fallback } = payload
        ;({ error } = await supabase.from('plants_pdt').update(fallback).eq('id', editing.id))
      }
      if (error) { alert(error.message); return }
      setRecords(prev => prev.map(r => r.id === editing.id ? { ...r, ...payload } : r))
    } else {
      let { data, error } = await supabase.from('plants_pdt').insert(payload).select().single()
      if (error && /campagne|poids_100_tubercules|column/i.test(error.message)) {
        const { campagne, poids_100_tubercules, ...fallback } = payload
        ;({ data, error } = await supabase.from('plants_pdt').insert(fallback).select().single())
      }
      if (error) { alert(error.message); return }
      setRecords(prev => [data, ...prev])
    }
    setEditing(null)
    showToast('✅ Enregistré')
  }

  async function del() {
    if (!confirm('Supprimer ce mouvement ?')) return
    await supabase.from('plants_pdt').delete().eq('id', editing.id)
    setRecords(prev => prev.filter(r => r.id !== editing.id))
    setEditing(null)
    showToast('🗑️ Supprimé')
  }

  // ── Stats ──
  const totIn  = recordsUpTo.filter(r => r.type === 'entree').reduce((s, r) => s + (r.quantite || 0), 0)
  const totOut = recordsUpTo.filter(r => r.type === 'sortie').reduce((s, r) => s + (r.quantite || 0), 0)
  const solde  = totIn - totOut

  // ── Stock by variété/lot ──
  const stockByLot = Object.values(
    recordsUpTo.reduce((map, r) => {
      const key = `${r.variete || '?'}__${r.lot || ''}`
      if (!map[key]) map[key] = { variete: r.variete || '?', lot: r.lot || '', calibre: r.calibre || '', entrees: 0, sorties: 0, unite: r.unite || 'kg' }
      if (r.type === 'entree') map[key].entrees += r.quantite || 0
      else                     map[key].sorties += r.quantite || 0
      return map
    }, {})
  ).sort((a, b) => a.variete.localeCompare(b.variete))

  // ── Per agri tracking ──
  const perAgri = Object.values(
    recordsUpTo.filter(r => r.agri_id).reduce((map, r) => {
      if (!map[r.agri_id]) {
        const agri = agris.find(a => a.id === r.agri_id)
        map[r.agri_id] = { agri_id: r.agri_id, agri_nom: r.agri_nom || agri?.nom || '?', mouvements: [] }
      }
      map[r.agri_id].mouvements.push(r)
      return map
    }, {})
  ).sort((a, b) => a.agri_nom.localeCompare(b.agri_nom))

  // ── Filtered movements (campagne active) ──
  const displayed = recordsCampagne.filter(r => {
    if (filterType !== 'all' && r.type !== filterType) return false
    if (filterVariete && !(r.variete || '').toLowerCase().includes(filterVariete.toLowerCase())) return false
    return true
  })

  // ── Dossiers par variété + calibre (campagne active) — un dossier = une
  // combinaison exacte variété/calibre, pour ne jamais mélanger deux calibres
  // d'une même variété (ex. "Agria 35/55" et "Agria 28/35" restent séparés). ──
  const dossiersVC = Object.values(
    recordsCampagne.reduce((map, r) => {
      const variete = r.variete || 'Sans variété'
      const calibre = r.calibre || 'Sans calibre'
      const key = `${variete}|${calibre}`
      if (!map[key]) map[key] = { key, variete, calibre, mouvements: [], entrees: 0, sorties: 0, unite: r.unite || 'kg', poids100Sum: 0, poids100Nb: 0 }
      map[key].mouvements.push(r)
      if (r.type === 'entree') map[key].entrees += r.quantite || 0
      else map[key].sorties += r.quantite || 0
      // Poids moyen des 100 tubercules — saisi uniquement sur les entrées.
      if (r.poids_100_tubercules != null) { map[key].poids100Sum += r.poids_100_tubercules; map[key].poids100Nb++ }
      return map
    }, {})
  ).map(d => ({ ...d, poids100Moyen: d.poids100Nb > 0 ? d.poids100Sum / d.poids100Nb : null }))
    .sort((a, b) => a.variete.localeCompare(b.variete, 'fr') || a.calibre.localeCompare(b.calibre, 'fr', { numeric: true }))
  const dossiersVCFiltered = dossiersVC.filter(d => `${d.variete} ${d.calibre}`.toLowerCase().includes(dossierVCSearch.toLowerCase()))
  const activeDossierVC = dossiersVC.find(d => d.key === dossierVC) || null

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}

      {/* Header with KPIs — repliés par défaut sur mobile pour laisser voir le contenu */}
      <div style={{ background: 'var(--green-deep)', padding: isMobile ? '.6rem 1rem' : '1rem 1.5rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMobile ? '.5rem' : '.8rem', flexWrap: 'wrap', gap: '.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '.6rem' : '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ color: 'white', fontSize: isMobile ? '.95rem' : '1.1rem', fontWeight: 700 }}>Entrées / Sorties Plants PDT</h2>
            <span style={{ fontSize: '.72rem', color: 'rgba(255,255,255,.5)', fontWeight: 600 }}>🗓️ {campagneActive}</span>
          </div>
          {!stockOnly && (
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <button className="btn-sm" onClick={() => openNew('entree')}
              style={{ background: 'var(--green-accent)', color: 'white', borderColor: 'var(--green-light)', fontWeight: 700 }}>
              ↓ Entrée plants
            </button>
            <button className="btn-sm" onClick={() => openNew('sortie')}
              style={{ background: 'var(--amber)', color: 'white', borderColor: '#b45309', fontWeight: 700 }}>
              ↑ Sortie plants
            </button>
          </div>
          )}
        </div>
        {isMobile ? (
          <button onClick={() => setKpiOuvert(o => !o)} style={{
            display: 'flex', alignItems: 'center', gap: '.4rem', background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,.7)', fontSize: '.74rem', fontWeight: 600, padding: '.2rem 0',
          }}>
            {kpiOuvert ? '▾' : '▸'} Chiffres clés {!kpiOuvert && `— Solde ${solde.toFixed(1)} kg`}
          </button>
        ) : null}
        {(!isMobile || kpiOuvert) && (
        <div style={{ display: 'flex', gap: isMobile ? '.5rem' : '1rem', flexWrap: 'wrap', marginTop: isMobile ? '.5rem' : 0 }}>
          {[
            { label: 'Total entrées', value: totIn.toFixed(1) + ' kg', color: 'var(--green-light)' },
            { label: 'Total sorties', value: totOut.toFixed(1) + ' kg', color: '#fbbf24' },
            { label: 'Solde stock', value: solde.toFixed(1) + ' kg', color: solde >= 0 ? 'white' : '#f87171' },
            { label: 'Lots distincts', value: String(stockByLot.length), color: 'rgba(255,255,255,.7)' },
          ].map(k => (
            <div key={k.label} style={{ background: 'rgba(255,255,255,.1)', borderRadius: 9, padding: isMobile ? '.4rem .7rem' : '.45rem .9rem', minWidth: isMobile ? 100 : 110 }}>
              <div style={{ fontSize: '.65rem', color: 'rgba(255,255,255,.55)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
              <div style={{ fontSize: isMobile ? '.9rem' : '1.05rem', fontWeight: 700, color: k.color }}>{k.value}</div>
            </div>
          ))}
        </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tab-scroll-fade" style={{ background: 'white', borderBottom: '2px solid var(--border)', display: 'flex', gap: '.1rem', padding: '0 1.5rem', flexShrink: 0, overflowX: 'auto' }}>
        {(stockOnly ? TABS.filter(t => t.key === 'stock') : TABS).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '.55rem 1.1rem', background: 'none', border: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === t.key ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor: 'pointer', fontSize: '.84rem', fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? 'var(--green-mid)' : 'var(--text-muted)',
            marginBottom: -2, transition: 'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Tab: Dossiers par variété/calibre ── */}
      {tab === 'dossiers-vc' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {(!isMobile || !activeDossierVC) && (
          <div style={{ width: isMobile ? '100%' : 280, borderRight: isMobile ? 'none' : '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'white', overflow: 'hidden' }}>
            <div style={{ padding: '.8rem', borderBottom: '1px solid var(--border)' }}>
              <input type="text" placeholder="🔍 Variété, calibre…" value={dossierVCSearch} onChange={e => setDossierVCSearch(e.target.value)}
                style={{ width: '100%', padding: '.5rem .8rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.84rem', outline: 'none' }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {dossiersVCFiltered.length === 0 && (
                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.82rem' }}>Aucun dossier.</div>
              )}
              {dossiersVCFiltered.map(d => {
                const soldeD = d.entrees - d.sorties
                const isActive = d.key === dossierVC
                return (
                  <div key={d.key} onClick={() => setDossierVC(d.key)}
                    style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: isActive ? 'var(--green-pale)' : 'white', borderLeft: isActive ? '4px solid var(--green-mid)' : '4px solid transparent' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
                      <div style={{ fontWeight: 700, fontSize: '.88rem' }}>🥔 {d.variete}</div>
                      <span style={{ fontSize: '.68rem', fontWeight: 700, background: 'var(--green-mid)', color: 'white', padding: '.1rem .5rem', borderRadius: 50, flexShrink: 0 }}>{d.mouvements.length}</span>
                    </div>
                    <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', marginTop: 2 }}>{d.calibre} · solde {soldeD.toFixed(1)} {d.unite}</div>
                  </div>
                )
              })}
            </div>
          </div>
          )}

          {(!isMobile || activeDossierVC) && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {!activeDossierVC ? (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>
                <div>
                  <div style={{ fontSize: '2.2rem', marginBottom: '.5rem' }}>📁</div>
                  <p style={{ fontSize: '.88rem' }}>Sélectionnez une variété/calibre dans la liste</p>
                </div>
              </div>
            ) : (
              <>
                <div style={{ background: 'var(--green-deep)', padding: '.9rem 1.3rem', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
                  {isMobile && (
                    <button onClick={() => setDossierVC(null)} className="btn-sm" style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>← Retour</button>
                  )}
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <h2 style={{ color: 'white', fontSize: '1.1rem', fontWeight: 700 }}>🥔 {activeDossierVC.variete}</h2>
                    <div style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.7)' }}>{activeDossierVC.calibre}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '.6rem', padding: '.8rem 1.3rem', background: 'white', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  {[
                    { label: 'Entrées', value: `${activeDossierVC.entrees.toFixed(1)} ${activeDossierVC.unite}` },
                    { label: 'Sorties', value: `${activeDossierVC.sorties.toFixed(1)} ${activeDossierVC.unite}` },
                    { label: 'Solde', value: `${(activeDossierVC.entrees - activeDossierVC.sorties).toFixed(1)} ${activeDossierVC.unite}`, accent: true },
                    { label: 'Poids moy. 100 tub.', value: activeDossierVC.poids100Moyen != null ? `${activeDossierVC.poids100Moyen.toFixed(1)} g` : '—' },
                    { label: 'Mouvements', value: String(activeDossierVC.mouvements.length) },
                  ].map(s => (
                    <div key={s.label} style={{ background: s.accent ? 'var(--green-pale)' : 'var(--cream)', borderRadius: 9, padding: '.4rem .8rem', minWidth: 86 }}>
                      <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{s.label}</div>
                      <div style={{ fontSize: '.95rem', fontWeight: 700, color: s.accent ? 'var(--green-mid)' : 'var(--ink)' }}>{s.value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.3rem' }}>
                  <MvtTable records={activeDossierVC.mouvements} onEdit={openEdit} onBon={r => setBonModal({ ...r, agri: agris.find(a => a.id === r.agri_id) })} />
                </div>
              </>
            )}
          </div>
          )}
        </div>
      )}

      {/* ── Tab 1: Mouvements ── */}
      {tab === 'mouvements' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ padding: '.8rem 1.5rem', background: 'white', borderBottom: '1px solid var(--border)', display: 'flex', gap: '.6rem', alignItems: 'center' }}>
            {[['all','Tous'],['entree','Entrées'],['sortie','Sorties']].map(([k, l]) => (
              <button key={k} className="btn-sm" onClick={() => setFilterType(k)}
                style={filterType === k ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>{l}</button>
            ))}
            <input type="text" placeholder="🔍 Variété…" value={filterVariete} onChange={e => setFilterVariete(e.target.value)}
              style={{ padding: '.4rem .8rem', border: '1.5px solid var(--border)', borderRadius: 7, fontSize: '.82rem', outline: 'none', marginLeft: '.4rem' }} />
            <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: 'var(--text-muted)' }}>{displayed.length} mouvement(s)</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.5rem' }}>
            <MvtTable records={displayed} onEdit={openEdit} onBon={r => setBonModal({ ...r, agri: agris.find(a => a.id === r.agri_id) })} />
          </div>
        </div>
      )}

      {/* ── Tab: Réception par variété / calibre ── */}
      {tab === 'reception' && (
        <ReceptionTab records={recordsCampagne} doses={doses} dosesMissing={dosesMissing} onSaveDose={saveDose} />
      )}

      {/* ── Tab 2: Stock by lot ── */}
      {tab === 'stock' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          {stockByLot.length === 0 ? (
            <EmptyState icon="📦">Aucun mouvement enregistré — commencez par une entrée.</EmptyState>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: '1rem' }}>
              {stockByLot.map(s => {
                const soldeS = s.entrees - s.sorties
                const pct = s.entrees > 0 ? Math.min(100, (s.sorties / s.entrees) * 100) : 0
                return (
                  <div key={s.variete + s.lot} style={{
                    background: 'white', border: '1px solid var(--border)', borderRadius: 14,
                    padding: '1rem 1.2rem',
                    borderTop: `4px solid ${soldeS > 0 ? 'var(--green-accent)' : 'var(--text-muted)'}`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '.6rem' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{s.variete}</div>
                        <div style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>
                          {s.lot ? `Lot : ${s.lot}` : 'Sans lot'}{s.calibre ? ` · ${s.calibre}` : ''}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.5rem', color: soldeS > 0 ? 'var(--green-mid)' : 'var(--text-muted)', lineHeight: 1 }}>
                          {soldeS.toFixed(1)}
                        </div>
                        <div style={{ fontSize: '.65rem', color: 'var(--text-muted)' }}>{s.unite} restants</div>
                      </div>
                    </div>
                    {/* Progress bar: sorties / entrees */}
                    <div style={{ height: 8, background: 'var(--cream-dark)', borderRadius: 50, overflow: 'hidden', margin: '.5rem 0' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct >= 75 ? 'var(--amber)' : 'var(--green-accent)', borderRadius: 50 }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: 'var(--text-muted)' }}>
                      <span>↓ Reçu : <strong>{s.entrees.toFixed(1)}</strong></span>
                      <span>↑ Sorti : <strong>{s.sorties.toFixed(1)}</strong></span>
                      <span>{pct.toFixed(0)}% sorti</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Tab 3: Par agri ── */}
      {tab === 'agris' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          {perAgri.length === 0 ? (
            <EmptyState icon="🌾">Aucun mouvement rattaché à un agriculteur.</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
              {perAgri.map(entry => {
                const prises  = entry.mouvements.filter(m => m.type === 'sortie')
                const rendues = entry.mouvements.filter(m => m.type === 'entree')
                const totPris = prises.reduce((s, m) => s + (m.quantite || 0), 0)
                const totRend = rendues.reduce((s, m) => s + (m.quantite || 0), 0)
                const net     = totPris - totRend
                return (
                  <div key={entry.agri_id} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
                    {/* Agri header */}
                    <div style={{ background: 'var(--cream)', padding: '.8rem 1.2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{entry.agri_nom}</div>
                      <div style={{ display: 'flex', gap: '1rem', fontSize: '.78rem' }}>
                        <span style={{ color: 'var(--amber)' }}>Pris : <strong>{totPris.toFixed(1)}</strong></span>
                        <span style={{ color: 'var(--green-mid)' }}>Rendu : <strong>{totRend.toFixed(1)}</strong></span>
                        <span style={{ color: net > 0 ? 'var(--amber)' : 'var(--green-mid)', fontWeight: 700 }}>
                          {net > 0 ? `Doit encore : ${net.toFixed(1)}` : `✅ Tout rendu`}
                        </span>
                      </div>
                    </div>
                    {/* Movements */}
                    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <table style={{ width: '100%', minWidth: 820, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#fafafa' }}>
                          {['Type','Date','Variété','Calibre','Lot','Quantité','Réf.','Obs.',''].map(h => (
                            <th key={h} style={{ padding: '.5rem .8rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {entry.mouvements.map(m => (
                          <tr key={m.id} onClick={() => openEdit(m)} style={{ cursor: 'pointer' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}>
                            <td style={td}>
                              <span style={{ fontSize: '.7rem', fontWeight: 700, padding: '.12rem .45rem', borderRadius: 50, background: m.type === 'entree' ? 'var(--green-pale)' : 'var(--amber-pale)', color: m.type === 'entree' ? 'var(--green-mid)' : 'var(--amber)' }}>
                                {m.type === 'entree' ? '↓ Rendu' : '↑ Pris'}
                              </span>
                            </td>
                            <td style={td}>{fmtDate(m.date)}</td>
                            <td style={td}><strong>{m.variete || '–'}</strong></td>
                            <td style={td}>{m.calibre || '–'}</td>
                            <td style={td}>{m.lot || '–'}</td>
                            <td style={{ ...td, fontWeight: 700 }}>{m.quantite != null ? `${m.quantite} ${m.unite || 'kg'}` : '–'}</td>
                            <td style={td}>{m.ref_chargement || '–'}</td>
                            <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.observation || '–'}</td>
                            <td style={td}>
                              {m.type === 'sortie' && (
                                <button title="Bon de sortie" onClick={e => { e.stopPropagation(); setBonModal({ ...m, agri: agris.find(a => a.id === m.agri_id) }) }}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem' }}>🖨️</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Edit modal ── */}
      {editing && (
        <EditModal
          editing={editing}
          setEditing={setEditing}
          agris={agris}
          onCreateAgri={createAgri}
          onSave={save}
          onDelete={editing.id ? del : null}
          onClose={() => setEditing(null)}
        />
      )}

      {/* ── Bon de sortie modal ── */}
      {bonModal && <BonSortiePlants bon={bonModal} onClose={() => setBonModal(null)} />}
    </div>
  )
}

/* ── Réception par variété / calibre ──
   Regroupe les entrées de plants par variété puis calibre. La dose de
   plantation (t/ha) saisie pour chaque ligne donne la surface plantable :
   surface = tonnage reçu ÷ dose. */
function ReceptionTab({ records, doses, dosesMissing, onSaveDose }) {
  const entrees = records.filter(r => r.type === 'entree')

  // variete -> calibre -> { tonnes, nb, fournisseurs }
  const grouped = {}
  for (const r of entrees) {
    const v = (r.variete || 'Sans variété').trim()
    const c = (r.calibre || '').trim()
    grouped[v] ??= {}
    grouped[v][c] ??= { tonnes: 0, nb: 0, fournisseurs: new Set() }
    grouped[v][c].tonnes += toTonnes(r.quantite, r.unite)
    grouped[v][c].nb++
    if (r.fournisseur) grouped[v][c].fournisseurs.add(r.fournisseur)
  }
  const varietes = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'fr'))

  const doseFor = (v, c) => doses.find(d => d.variete === v && (d.calibre || '') === (c || ''))?.dose_t_ha ?? ''

  let totalT = 0, totalHa = 0
  for (const v of varietes) for (const c of Object.keys(grouped[v])) {
    totalT += grouped[v][c].tonnes
    const dose = parseFloat(doseFor(v, c))
    if (dose > 0) totalHa += grouped[v][c].tonnes / dose
  }

  if (entrees.length === 0) return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
      <EmptyState icon="📥">Aucune entrée de plants — les réceptions saisies via "↓ Entrée plants" apparaîtront ici, classées par variété et calibre.</EmptyState>
    </div>
  )

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
      {dosesMissing && (
        <div style={{ background: 'var(--amber-pale, #fef3c7)', border: '1px solid var(--amber)', borderRadius: 10, padding: '.7rem 1rem', fontSize: '.82rem', marginBottom: '1rem' }}>
          ⚠️ Pour enregistrer les doses de plantation (t/ha), exécute <strong>migration_plants_reception.sql</strong> dans Supabase → SQL Editor.
        </div>
      )}

      {/* Récap global */}
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
        {[
          { label: 'Total reçu', value: `${totalT.toFixed(2)} t` },
          { label: 'Variétés', value: String(varietes.length) },
          { label: 'Surface plantable', value: totalHa > 0 ? `${totalHa.toFixed(1)} ha` : '— (saisir les doses)' },
        ].map(k => (
          <div key={k.label} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.55rem 1rem' }}>
            <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
            <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--green-mid)' }}>{k.value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
        {varietes.map(v => {
          const calibres = Object.keys(grouped[v]).sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
          const sousTotal = calibres.reduce((s, c) => s + grouped[v][c].tonnes, 0)
          const sousHa = calibres.reduce((s, c) => {
            const dose = parseFloat(doseFor(v, c))
            return s + (dose > 0 ? grouped[v][c].tonnes / dose : 0)
          }, 0)
          return (
            <div key={v} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ background: 'var(--green-deep)', padding: '.7rem 1.2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem' }}>
                <div style={{ fontWeight: 700, color: 'white', fontSize: '.95rem' }}>🥔 {v}</div>
                <div style={{ display: 'flex', gap: '1.2rem', fontSize: '.8rem', color: 'rgba(255,255,255,.85)' }}>
                  <span>Reçu : <strong style={{ color: 'white' }}>{sousTotal.toFixed(2)} t</strong></span>
                  {sousHa > 0 && <span>Plantable : <strong style={{ color: '#fbbf24' }}>{sousHa.toFixed(1)} ha</strong></span>}
                </div>
              </div>
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', minWidth: 560, fontSize: '.83rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--cream)' }}>
                      {['Calibre', 'Reçu (t)', 'Entrées', 'Fournisseur(s)', 'Dose plantation (t/ha)', 'Surface plantable'].map(h => (
                        <th key={h} style={{ padding: '.5rem .8rem', textAlign: 'left', fontSize: '.68rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {calibres.map(c => {
                      const g = grouped[v][c]
                      const dose = parseFloat(doseFor(v, c))
                      const ha = dose > 0 ? g.tonnes / dose : null
                      return (
                        <tr key={c || '(sans)'}>
                          <td style={{ ...td, fontWeight: 700 }}>{c || 'Sans calibre'}</td>
                          <td style={{ ...td, fontWeight: 700, color: 'var(--green-mid)' }}>{g.tonnes.toFixed(2)}</td>
                          <td style={td}>{g.nb}</td>
                          <td style={{ ...td, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{[...g.fournisseurs].join(', ') || '–'}</td>
                          <td style={td}>
                            <input type="number" step="0.1" defaultValue={doseFor(v, c)} disabled={dosesMissing}
                              placeholder="ex. 2.5"
                              onBlur={e => { if (e.target.value !== String(doseFor(v, c))) onSaveDose(v, c, e.target.value) }}
                              onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
                              style={{ width: 90, padding: '.35rem .5rem', border: '1.5px solid var(--border)', borderRadius: 6, fontSize: '.82rem', outline: 'none' }} />
                          </td>
                          <td style={{ ...td, fontWeight: 700, color: ha ? 'var(--amber)' : 'var(--text-muted)' }}>
                            {ha ? `${ha.toFixed(1)} ha` : '–'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Movements Table ── */
function MvtTable({ records, onEdit, onBon }) {
  if (!records.length) return (
    <EmptyState icon="📋">Aucun mouvement — cliquez "↓ Entrée plants" ou "↑ Sortie plants" pour commencer.</EmptyState>
  )
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', minWidth: 700, fontSize: '.82rem', borderCollapse: 'collapse' }}>
        <thead style={{ background: 'var(--cream)' }}>
          <tr>
            {['Type','Date','Agri','Variété','Calibre','Lot','Quantité','Unité','Poids 100 tub.','Fournisseur','Réf.','Prix/unité','Obs.',''].map(h => (
              <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map(r => (
            <tr key={r.id} onClick={() => onEdit(r)} style={{ cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
              onMouseLeave={e => e.currentTarget.style.background = ''}>
              <td style={td}>
                <span style={{ fontSize: '.7rem', fontWeight: 700, padding: '.12rem .45rem', borderRadius: 50, background: r.type === 'entree' ? 'var(--green-pale)' : 'var(--amber-pale)', color: r.type === 'entree' ? 'var(--green-mid)' : 'var(--amber)' }}>
                  {r.type === 'entree' ? '↓ Entrée' : '↑ Sortie'}
                </span>
              </td>
              <td style={td}>{fmtDate(r.date)}</td>
              <td style={td}>{r.agri_nom || '–'}</td>
              <td style={td}><strong>{r.variete || '–'}</strong></td>
              <td style={td}>{r.calibre || '–'}</td>
              <td style={td}>{r.lot || '–'}</td>
              <td style={{ ...td, fontWeight: 700 }}>{r.quantite != null ? r.quantite : '–'}</td>
              <td style={td}>{r.unite || 'kg'}</td>
              <td style={td}>{r.type === 'entree' && r.poids_100_tubercules != null ? `${r.poids_100_tubercules} g` : '–'}</td>
              <td style={td}>{r.fournisseur || '–'}</td>
              <td style={td}>{r.ref_chargement || '–'}</td>
              <td style={td}>{r.prix_unitaire != null ? `${r.prix_unitaire} €` : '–'}</td>
              <td style={{ ...td, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.observation || '–'}</td>
              <td style={td} onClick={e => e.stopPropagation()}>
                {r.type === 'sortie' && (
                  <button title="Bon de sortie" onClick={() => onBon(r)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem' }}>🖨️</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── Edit Modal ── */
function EditModal({ editing, setEditing, agris, onCreateAgri, onSave, onDelete, onClose }) {
  const isEntry = editing.type === 'entree'
  function f(key) { return editing[key] || '' }
  function set(key, val) { setEditing({ ...editing, [key]: val }) }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 560 }}>
        <div className="modal-hdr" style={{ background: isEntry ? 'var(--green-deep)' : 'var(--amber)' }}>
          <h3>{editing.id ? 'Modifier' : isEntry ? '↓ Nouvelle entrée plants' : '↑ Nouvelle sortie plants'}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>

            <FG label="Date *">
              <input type="date" value={f('date')} onChange={e => set('date', e.target.value)} />
            </FG>

            <FG label={isEntry ? 'Fournisseur' : 'Agriculteur'}>
              {isEntry ? (
                <input value={f('fournisseur')} onChange={e => set('fournisseur', e.target.value)} placeholder="Nom du fournisseur" />
              ) : (
                <select value={f('agri_id')} onChange={async e => {
                  if (e.target.value === '__new__') {
                    const nom = prompt('Nom du nouveau dossier agriculteur :')
                    if (nom?.trim()) {
                      const a = await onCreateAgri(nom.trim())
                      if (a) setEditing({ ...editing, agri_id: a.id, agri_nom: a.nom })
                    }
                    return
                  }
                  const a = agris.find(x => x.id === e.target.value)
                  setEditing({ ...editing, agri_id: e.target.value || null, agri_nom: a?.nom || '' })
                }}>
                  <option value="">— Aucun / Interne —</option>
                  {agris.map(a => <option key={a.id} value={a.id}>{a.nom}</option>)}
                  <option value="__new__">➕ Créer un nouveau dossier…</option>
                </select>
              )}
            </FG>

            <FG label="Variété *">
              <input value={f('variete')} onChange={e => set('variete', e.target.value)} placeholder="ex. Agria, Bintje…" autoFocus={!editing.id} />
            </FG>

            <FG label="Calibre">
              <input value={f('calibre')} onChange={e => set('calibre', e.target.value)} placeholder="ex. 35/55" />
            </FG>

            <FG label="N° de lot">
              <input value={f('lot')} onChange={e => set('lot', e.target.value)} placeholder="LOT-2026-001" />
            </FG>

            {isEntry && (
              <FG label="Poids de 100 tubercules (g)">
                <input type="number" step="0.01" value={f('poids_100_tubercules')} onChange={e => set('poids_100_tubercules', e.target.value)} placeholder="ex. 850" />
              </FG>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '.5rem' }}>
              <FG label="Quantité">
                <input type="number" step="0.001" value={f('quantite')} onChange={e => set('quantite', e.target.value)} />
              </FG>
              <FG label="Unité">
                <select value={f('unite') || 'kg'} onChange={e => set('unite', e.target.value)}>
                  <option>kg</option><option>T</option><option>sac</option><option>palette</option>
                </select>
              </FG>
            </div>

            <FG label="Réf. chargement">
              <input value={f('ref_chargement')} onChange={e => set('ref_chargement', e.target.value)} placeholder="ex. CHG-2026-001" />
            </FG>

            <FG label="Prix unitaire (€)">
              <input type="number" step="0.01" value={f('prix_unitaire')} onChange={e => set('prix_unitaire', e.target.value)} placeholder="€/kg ou €/T" />
            </FG>

            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Observation</label>
              <textarea rows={2} value={f('observation')} onChange={e => set('observation', e.target.value)}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          {onDelete && <button className="btn-danger" onClick={onDelete}>Supprimer</button>}
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={onSave}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}

/* ── Bon de sortie imprimable ── */
function BonSortiePlants({ bon, onClose }) {
  const agriInfos = bon.agri?.infos || {}
  const totalVal = bon.quantite && bon.prix_unitaire
    ? (parseFloat(bon.quantite) * parseFloat(bon.prix_unitaire)).toFixed(2) + ' €'
    : null

  // Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
  // plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
  // popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
  // toujours le vrai dialogue d'impression natif — même pattern que la
  // Confirmation d'achat dans Planning.jsx.
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    if (!printing) return
    document.body.classList.add('printing-active')
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrinting(false)
    }
    window.addEventListener('afterprint', onAfterPrint)
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printing])
  function print() {
    setPrinting(true)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 480 }}>
        <div className="modal-hdr"><h3>🖨️ Bon de sortie plants</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ background: 'var(--cream)', borderRadius: 10, padding: '1rem 1.2rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: 700 }}>Réf. {bon.ref_chargement || '—'}</div>
            <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginTop: '.2rem' }}>
              {fmtDate(bon.date)} — {bon.agri_nom || 'Agri non précisé'}
            </div>
          </div>
          <table style={{ width: '100%', fontSize: '.84rem', borderCollapse: 'collapse' }}>
            {[
              ['Variété', bon.variete],
              ['Calibre', bon.calibre],
              ['Lot', bon.lot],
              ['Quantité', bon.quantite != null ? `${bon.quantite} ${bon.unite || 'kg'}` : null],
              ['Prix unitaire', bon.prix_unitaire ? `${bon.prix_unitaire} €` : null],
              ['Total', bon.quantite && bon.prix_unitaire ? `${(bon.quantite * bon.prix_unitaire).toFixed(2)} €` : null],
              ['Réf. chargement', bon.ref_chargement],
              ['Observation', bon.observation],
            ].filter(([, v]) => v).map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: '.5rem .7rem', fontWeight: 600, background: 'var(--cream)', border: '1px solid var(--border)', width: '40%' }}>{k}</td>
                <td style={{ padding: '.5rem .7rem', border: '1px solid var(--border)', fontWeight: k === 'Quantité' || k === 'Total' ? 700 : 400 }}>{v}</td>
              </tr>
            ))}
          </table>
          {Object.keys(agriInfos).length > 0 && (
            <div style={{ marginTop: '.7rem', fontSize: '.74rem', color: 'var(--text-muted)' }}>
              Les infos du dossier agri ({Object.keys(agriInfos).join(', ')}) seront incluses.
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-sm" onClick={onClose}>Fermer</button>
          <button className="btn-sm primary" onClick={print}>🖨️ Imprimer le bon</button>
        </div>
      </div>

      {/* Zone imprimable — invisible à l'écran, visible seulement sur le document
          imprimé/PDF (voir .print-area dans index.css). */}
      <div className="print-area" style={{ fontFamily: 'Arial, sans-serif', padding: 20, color: '#1a2e1c', fontSize: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 32 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 'bold', color: '#4a9050' }} dangerouslySetInnerHTML={{ __html: printLogoHtml() }} />
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>BON DE SORTIE — PLANTS DE POMME DE TERRE</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <h2 style={{ fontSize: 18 }}>Réf. {bon.ref_chargement || '—'}</h2>
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>Date : {bon.date ? fmtDate(bon.date) : '—'}</div>
          </div>
        </div>

        <div style={printSectionTitleS}>Destinataire</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={printTdFirstS}>Agriculteur</td><td style={printTdS}><strong>{bon.agri_nom || '—'}</strong></td></tr>
            {Object.entries(agriInfos).map(([k, v]) => (
              <tr key={k}><td style={printTdFirstS}>{k}</td><td style={printTdS}>{v}</td></tr>
            ))}
          </tbody>
        </table>

        <div style={printSectionTitleS}>Détail du lot</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={printTdFirstS}>Variété</td><td style={printTdS}><strong>{bon.variete || '—'}</strong></td></tr>
            <tr><td style={printTdFirstS}>Calibre</td><td style={printTdS}>{bon.calibre || '—'}</td></tr>
            <tr><td style={printTdFirstS}>N° de lot</td><td style={printTdS}>{bon.lot || '—'}</td></tr>
            {bon.fournisseur && <tr><td style={printTdFirstS}>Fournisseur</td><td style={printTdS}>{bon.fournisseur}</td></tr>}
            <tr style={{ background: '#e8f5e9' }}>
              <td style={{ ...printTdFirstS, background: '#e8f5e9', fontSize: 16, color: '#2d5a30' }}>Quantité remise</td>
              <td style={{ ...printTdS, fontSize: 16, fontWeight: 'bold', color: '#2d5a30' }}><strong>{bon.quantite != null ? `${bon.quantite} ${bon.unite || 'kg'}` : '—'}</strong></td>
            </tr>
            {bon.prix_unitaire && <tr><td style={printTdFirstS}>Prix unitaire</td><td style={printTdS}>{bon.prix_unitaire} € / {bon.unite || 'kg'}</td></tr>}
            {totalVal && (
              <tr style={{ background: '#e8f5e9' }}>
                <td style={{ ...printTdFirstS, background: '#e8f5e9', fontSize: 16, color: '#2d5a30' }}>Total</td>
                <td style={{ ...printTdS, fontSize: 16, fontWeight: 'bold', color: '#2d5a30' }}>{totalVal}</td>
              </tr>
            )}
            {bon.ref_chargement && <tr><td style={printTdFirstS}>Réf. chargement</td><td style={printTdS}>{bon.ref_chargement}</td></tr>}
            {bon.observation && <tr><td style={printTdFirstS}>Observation</td><td style={printTdS}>{bon.observation}</td></tr>}
          </tbody>
        </table>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginTop: 48 }}>
          <div style={{ border: '1px solid #dde8de', borderRadius: 6, padding: 16, minHeight: 80 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Signature du livreur</div>
          </div>
          <div style={{ border: '1px solid #dde8de', borderRadius: 6, padding: 16, minHeight: 80 }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>Signature du destinataire (bon pour accord)</div>
          </div>
        </div>

        <div style={{ marginTop: 28, fontSize: 10, color: '#aaa', borderTop: '1px solid #dde8de', paddingTop: 10, textAlign: 'center' }}>
          Document généré le {fmtDate(new Date())}
        </div>
      </div>
    </div>
  )
}

const printSectionTitleS = { fontSize: 10, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '.06em', color: '#6b7c6d', borderBottom: '1px solid #dde8de', paddingBottom: 4, margin: '22px 0 8px' }
const printTdFirstS = { padding: '9px 12px', border: '1px solid #dde8de', fontWeight: 600, background: '#f5f2eb', width: '38%' }
const printTdS = { padding: '9px 12px', border: '1px solid #dde8de' }

function EmptyState({ icon, children }) {
  return (
    <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
      <div style={{ fontSize: '2.5rem', marginBottom: '.6rem' }}>{icon}</div>
      <p style={{ fontSize: '.88rem' }}>{children}</p>
    </div>
  )
}

function FG({ label, children }) {
  return (
    <div className="form-group">
      <label>{label}</label>
      {children}
    </div>
  )
}

const td = { padding: '.6rem .75rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
