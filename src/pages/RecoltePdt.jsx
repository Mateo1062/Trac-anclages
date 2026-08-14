import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import useIsMobile from '../lib/useIsMobile'
import Modal from '../components/Modal'
import DossiersParcelles from '../components/DossiersParcelles'
import { defaultCampagne, campagnesDisponibles } from '../lib/campagne'
import { useCampagne } from '../lib/CampagneContext'
import { varietesPdtOf as varietesOf } from '../lib/varietesPdt'
import { fmtDate } from '../lib/formatDate'

/* ═══════════════════════════════════════════════════════════
   ENTRÉES PDT — RÉCOLTE
   Saisie de chaque pesée de plateau (palox) pour construire un
   stock théorique :
   · poids moyen / palox = poids net total ÷ nb de palox
   · rendement (t/ha)    = poids net total ÷ surface de la parcelle
═══════════════════════════════════════════════════════════ */

const TABS = [
  { key: 'dossiers',  label: '📁 Dossiers parcelles' },
  { key: 'parcelles', label: '🌾 Par parcelle (rendement)' },
]

export default function RecoltePdt() {
  const { user } = useAuth()
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()

  const [tab, setTab]           = useState('dossiers')
  const [kpiOuvert, setKpiOuvert] = useState(false) // chiffres clés repliés par défaut sur mobile
  const [dossierId, setDossierId] = useState(null) // parcelle sélectionnée dans l'onglet Dossiers
  const [dossierSearch, setDossierSearch] = useState('')
  const [pesees, setPesees]     = useState([])
  const [parcelles, setParcelles] = useState([])
  const [tracteurs, setTracteurs] = useState([])
  const [conducteurs, setConducteurs] = useState([])
  const [loading, setLoading]   = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [editing, setEditing]   = useState(null)
  const [editingVarietes, setEditingVarietes] = useState(null) // { parcelleId, varietes: [{ variete, surface }] }

  // Campagne (année agricole) — repartir sur une base vierge chaque année,
  // campagnes passées toujours consultables via le sélecteur.
  const { campagneActive, registerCampagnes } = useCampagne()
  const campagneOf = r => r.campagne || defaultCampagne()
  const peseesCampagne = pesees.filter(p => campagneOf(p) === campagneActive)
  const campagnesListe = campagnesDisponibles(pesees)
  useEffect(() => { registerCampagnes(campagnesListe) }, [campagnesListe.join(',')])

  useEffect(() => { loadAll() }, [campagneActive])

  async function loadAll() {
    setLoading(true)
    const [{ data: p, error: e1 }, { data: pc, error: e2 }, { data: o }, { data: s }] = await Promise.all([
      supabase.from('pdt_recolte_pesees').select('*').order('date', { ascending: false }),
      supabase.from('parcelles').select('id,nom,surface,culture_actuelle,entite,varietes_pdt,campagne').order('nom'),
      supabase.from('outils_agricoles').select('nom,type').order('nom'),
      supabase.from('salaries').select('prenom,nom,statut').eq('statut', 'actif').order('nom'),
    ])
    if (e1 && /does not exist|relation|could not find the table/i.test(e1.message)) setTableMissing(true)
    setPesees(p || [])
    // Colonne varietes_pdt pas encore créée (migration_A_EXECUTER_21.sql non exécutée) :
    // on retente sans, pour ne pas perdre toutes les parcelles en attendant.
    // Le parcellaire change à chaque campagne (import DAPLOS) — on ne montre (et
    // ne propose dans les listes/dossiers) que les parcelles de la campagne active.
    const scoped = list => (list || []).filter(p => (p.campagne || defaultCampagne()) === campagneActive)
    if (e2 && /varietes_pdt|column/i.test(e2.message)) {
      const { data: pcFallback } = await supabase.from('parcelles').select('id,nom,surface,culture_actuelle,entite,campagne').order('nom')
      setParcelles(scoped(pcFallback))
    } else {
      setParcelles(scoped(pc))
    }
    setTracteurs((o || []).filter(x => !x.type || /tracteur/i.test(x.type)).map(x => x.nom))
    setConducteurs((s || []).map(x => `${x.prenom} ${x.nom}`))
    setLoading(false)
  }

  /* ── CRUD pesée ── */
  function openNew() {
    setEditing({
      date: new Date().toISOString().split('T')[0], campagne: campagneActive,
      parcelle_id: '', parcelle_nom: '', variete: '',
      nb_palox: '', poids_brut: '', poids_net: '',
      tracteur: '', conducteur: '', observation: '',
    })
  }
  function openEdit(p) { setEditing({ ...p, parcelle_id: p.parcelle_id || '' }) }

  async function save() {
    if (!editing.date) { alert('La date est obligatoire.'); return }
    if (!editing.poids_net) { alert('Le poids net est obligatoire.'); return }
    const payload = {
      ...editing,
      parcelle_id: editing.parcelle_id || null,
      nb_palox:   parseFloat(editing.nb_palox) || null,
      poids_brut: parseFloat(editing.poids_brut) || null,
      poids_net:  parseFloat(editing.poids_net),
      surface_ha: parseFloat(editing.surface_ha) || null,
      user_id:    user?.id || null,
    }
    delete payload.created_at
    let error
    if (editing.id) {
      ;({ error } = await supabase.from('pdt_recolte_pesees').update(payload).eq('id', editing.id))
      if (!error) setPesees(prev => prev.map(p => p.id === editing.id ? { ...p, ...payload } : p))
    } else {
      let data
      ;({ data, error } = await supabase.from('pdt_recolte_pesees').insert(payload).select().single())
      if (!error) setPesees(prev => [data, ...prev])
    }
    let migrationHint = false
    if (error && /surface_ha|campagne|column/i.test(error.message)) {
      migrationHint = true
      const { surface_ha, campagne, ...rest } = payload
      if (editing.id) {
        ;({ error } = await supabase.from('pdt_recolte_pesees').update(rest).eq('id', editing.id))
        if (!error) setPesees(prev => prev.map(p => p.id === editing.id ? { ...p, ...rest } : p))
      } else {
        let data
        ;({ data, error } = await supabase.from('pdt_recolte_pesees').insert(rest).select().single())
        if (!error) setPesees(prev => [data, ...prev])
      }
    }
    if (error) { alert(error.message); return }
    setEditing(null)
    showToast(migrationHint ? '✅ Pesée enregistrée (⚠️ surface non enregistrée — exécute migration_A_EXECUTER_8.sql)' : '✅ Pesée enregistrée')
  }

  // ── Variété(s) attribuée(s) à une parcelle, pour ne plus avoir à les
  // ressaisir à chaque pesée — une parcelle peut avoir N variétés (bord de
  // route traité à part, plusieurs lots...), chacune avec sa propre surface
  // (la 1ère récupère automatiquement le reste de la surface de la parcelle). ──
  async function saveVarietes() {
    const e = editingVarietes
    const cleaned = e.varietes
      .map(v => ({
        variete: v.variete?.trim() || '',
        surface: v.surface !== '' && v.surface != null ? parseFloat(v.surface) : null,
        cote: v.cote?.trim() || '',
      }))
      .filter(v => v.variete)
    const payload = { varietes_pdt: cleaned.length > 0 ? cleaned : null }
    const { error } = await supabase.from('parcelles').update(payload).eq('id', e.parcelleId)
    if (error) {
      alert(/varietes_pdt|column/i.test(error.message)
        ? 'Colonne varietes_pdt manquante — exécute migration_A_EXECUTER_21.sql dans Supabase → SQL Editor.'
        : error.message)
      return
    }
    setParcelles(prev => prev.map(p => p.id === e.parcelleId ? { ...p, ...payload } : p))
    setEditingVarietes(null)
    showToast('✅ Variété(s) attribuée(s) — pré-remplies à chaque nouvelle pesée')
  }

  // Sous-dossiers d'une parcelle : dès que 2 variétés (ou plus) sont en jeu — assignées
  // via 🏷️ Variété(s), ET/OU simplement retrouvées dans des pesées déjà saisies sous des
  // noms différents — chacune obtient son propre dossier avec sa surface. La 1ère variété
  // assignée récupère automatiquement le reste de la surface de la parcelle. Retourne
  // null si une seule variété (ou aucune) : le dossier reste simple, comme avant.
  function subDossiersForParcelle(parc, entriesForParcelle) {
    const assigned = varietesOf(parc)
    const norm = s => (s || '').trim().toLowerCase()
    const namesAssigned = new Set(assigned.map(v => norm(v.variete)))
    const extraNames = [...new Set(
      entriesForParcelle.filter(p => p.variete && !namesAssigned.has(norm(p.variete))).map(p => p.variete.trim())
    )]
    if (assigned.length + extraNames.length <= 1) return null
    const usedSurface = assigned.slice(1).reduce((s, v) => s + (v.surface || 0), 0)
    const rows = assigned.map((v, i) => ({
      variete: v.variete,
      surface: i === 0 ? (parc.surface != null ? +(parc.surface - usedSurface).toFixed(4) : null) : (v.surface ?? null),
    }))
    extraNames.forEach(v => rows.push({ variete: v, surface: null }))
    return rows
  }

  async function del() {
    if (!confirm('Supprimer cette pesée ?')) return
    await supabase.from('pdt_recolte_pesees').delete().eq('id', editing.id)
    setPesees(prev => prev.filter(p => p.id !== editing.id))
    setEditing(null)
    showToast('🗑️ Pesée supprimée')
  }

  /* ── Agrégats ── */
  const totNet   = peseesCampagne.reduce((s, p) => s + (p.poids_net || 0), 0)          // kg
  const totPalox = peseesCampagne.reduce((s, p) => s + (p.nb_palox || 0), 0)
  const moyPalox = totPalox > 0 ? totNet / totPalox : null                     // kg/palox

  // Par parcelle ET PAR VARIÉTÉ (une parcelle à plusieurs variétés a sa surface répartie
  // entre elles — chacune garde son propre rendement) : total, palox, moyenne, rendement.
  function surfaceForGroup(parc, variete, pesForGroup) {
    const fromPesees = pesForGroup.find(p => p.surface_ha)?.surface_ha
    if (fromPesees) return fromPesees
    if (!parc) return null
    const sub = subDossiersForParcelle(parc, peseesCampagne.filter(p => p.parcelle_id === parc.id))
    if (sub) {
      const norm = s => (s || '').trim().toLowerCase()
      const match = sub.find(s => norm(s.variete) === norm(variete))
      return match ? match.surface : null // variété non reconnue parmi les sous-dossiers : surface ambiguë
    }
    return parc.surface || null
  }
  const parParcelle = Object.values(peseesCampagne.reduce((map, p) => {
    const key = `${p.parcelle_id || `__${p.parcelle_nom || 'Sans parcelle'}`}|${p.variete || ''}`
    if (!map[key]) {
      const parc = parcelles.find(x => x.id === p.parcelle_id)
      map[key] = { key, nom: parc?.nom || p.parcelle_nom || 'Sans parcelle', variete: p.variete || '', parc, net: 0, palox: 0, nb: 0, _rows: [] }
    }
    map[key].net += p.poids_net || 0
    map[key].palox += p.nb_palox || 0
    map[key].nb++
    map[key]._rows.push(p)
    return map
  }, {})).map(r => ({ ...r, surface: surfaceForGroup(r.parc, r.variete, r._rows) })).sort((a, b) => b.net - a.net)

  const surfacesTouchees = parParcelle.reduce((s, r) => s + (r.surface || 0), 0)
  const rendementGlobal  = surfacesTouchees > 0 ? (totNet / 1000) / surfacesTouchees : null

  // Dossiers PDT : une parcelle = un dossier, SAUF si elle a 2 variétés ou plus (assignées
  // via 🏷️ Variété(s), ou simplement retrouvées dans des pesées saisies sous des noms
  // différents) — dans ce cas chaque variété obtient son propre sous-dossier, avec sa
  // propre surface et ses propres pesées, comme dans "Par parcelle" mais navigable en dossier.
  const dossierParcellesPdt = parcelles
    .filter(p => (p.culture_actuelle || '').trim().toUpperCase() === 'PTC')
    .flatMap(p => {
      const sub = subDossiersForParcelle(p, peseesCampagne.filter(e => e.parcelle_id === p.id))
      if (!sub) return [p]
      return sub.map((s, i) => ({
        ...p, id: `${p.id}::${i}`, nom: `${p.nom} — ${s.variete}`, surface: s.surface,
        _parcelleId: p.id, _variete: s.variete,
      }))
    })
  function entryParcelleIdPdt(p) {
    const parc = parcelles.find(x => x.id === p.parcelle_id)
    if (!parc) return p.parcelle_id
    const sub = subDossiersForParcelle(parc, peseesCampagne.filter(e => e.parcelle_id === parc.id))
    if (!sub) return parc.id
    const norm = s => (s || '').trim().toLowerCase()
    const idx = sub.findIndex(s => norm(s.variete) === norm(p.variete))
    return `${parc.id}::${idx === -1 ? 0 : idx}`
  }

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  if (tableMissing) return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, padding: '2rem', maxWidth: 520, textAlign: 'center' }}>
        <div style={{ fontSize: '2.2rem', marginBottom: '.6rem' }}>⚖️</div>
        <h3 style={{ marginBottom: '.6rem' }}>Table récolte non créée</h3>
        <p style={{ fontSize: '.86rem', color: 'var(--text-muted)' }}>
          Exécute le fichier <strong>migration_recolte_pdt.sql</strong> (à la racine du projet)
          dans Supabase → SQL Editor, puis recharge cette page.
        </p>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}

      {/* Header + KPIs — repliés par défaut sur mobile pour laisser voir le contenu */}
      <div style={{ background: 'var(--green-deep)', padding: isMobile ? '.6rem 1rem' : '1rem 1.5rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMobile ? '.5rem' : '.8rem', flexWrap: 'wrap', gap: '.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '.6rem' : '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ color: 'white', fontSize: isMobile ? '.95rem' : '1.1rem', fontWeight: 700 }}>Entrées PDT — Récolte</h2>
            <span style={{ fontSize: '.72rem', color: 'rgba(255,255,255,.5)', fontWeight: 600 }}>🗓️ {campagneActive}</span>
          </div>
          <button className="btn-sm" onClick={openNew}
            style={{ background: 'var(--green-accent)', color: 'white', borderColor: 'var(--green-light)', fontWeight: 700 }}>
            + Nouvelle pesée
          </button>
        </div>
        {isMobile ? (
          <button onClick={() => setKpiOuvert(o => !o)} style={{
            display: 'flex', alignItems: 'center', gap: '.4rem', background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,.7)', fontSize: '.74rem', fontWeight: 600, padding: '.2rem 0',
          }}>
            {kpiOuvert ? '▾' : '▸'} Chiffres clés {!kpiOuvert && `— Stock ${(totNet / 1000).toFixed(2)} t`}
          </button>
        ) : null}
        {(!isMobile || kpiOuvert) && (
          <div style={{ display: 'flex', gap: isMobile ? '.5rem' : '1rem', flexWrap: 'wrap', marginTop: isMobile ? '.5rem' : 0 }}>
            {[
              { label: 'Stock théorique', value: `${(totNet / 1000).toFixed(2)} t`, color: 'var(--green-light)' },
              { label: 'Palox', value: totPalox ? String(totPalox) : '—', color: 'white' },
              { label: 'Poids moyen / palox', value: moyPalox ? `${moyPalox.toFixed(1)} kg` : '—', color: '#fbbf24' },
              { label: 'Rendement moyen', value: rendementGlobal ? `${rendementGlobal.toFixed(1)} t/ha` : '—', color: 'white' },
              { label: 'Pesées', value: String(peseesCampagne.length), color: 'rgba(255,255,255,.7)' },
            ].map(k => (
              <div key={k.label} style={{ background: 'rgba(255,255,255,.1)', borderRadius: 9, padding: isMobile ? '.4rem .7rem' : '.45rem .9rem', minWidth: isMobile ? 100 : 110 }}>
                <div style={{ fontSize: '.65rem', color: 'rgba(255,255,255,.55)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
                <div style={{ fontSize: isMobile ? '.9rem' : '1.02rem', fontWeight: 700, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tab-scroll-fade" style={{ background: 'white', borderBottom: '2px solid var(--border)', display: 'flex', gap: '.1rem', padding: '0 1.5rem', flexShrink: 0, overflowX: 'auto' }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '.55rem 1.1rem', background: 'none', border: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === t.key ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor: 'pointer', fontSize: '.84rem', fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? 'var(--green-mid)' : 'var(--text-muted)',
            marginBottom: -2, transition: 'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ── Onglet Dossiers parcelles (une parcelle PDT = un dossier) ── */}
      {tab === 'dossiers' && (
        <DossiersParcelles
          parcelles={dossierParcellesPdt}
          entries={peseesCampagne}
          entryParcelleId={entryParcelleIdPdt}
          isMobile={isMobile}
          dossierId={dossierId} setDossierId={setDossierId}
          search={dossierSearch} setSearch={setDossierSearch}
          emptyHint="Aucune parcelle pomme de terre trouvée (code culture PTC/PPH dans Parcelles)."
          renderStats={(parc, rows) => {
            const net = rows.reduce((s, r) => s + (r.poids_net || 0), 0)
            const palox = rows.reduce((s, r) => s + (r.nb_palox || 0), 0)
            return [
              { label: 'Pesées', value: String(rows.length) },
              { label: 'Total', value: `${(net / 1000).toFixed(2)} t` },
              { label: 'Palox', value: palox ? String(palox) : '–' },
              { label: 'Moy./palox', value: palox > 0 ? `${(net / palox).toFixed(1)} kg` : '–' },
              { label: 'Rendement', value: parc.surface > 0 && net > 0 ? `${((net / 1000) / parc.surface).toFixed(1)} t/ha` : '–', accent: true },
            ]
          }}
          onAdd={parc => {
            const realParcelleId = parc._parcelleId || parc.id
            const realParc = parcelles.find(x => x.id === realParcelleId)
            const variete = parc._variete ?? (varietesOf(realParc)[0]?.variete || (realParc?.culture_actuelle && !/^[A-Z]{3}$/.test(realParc.culture_actuelle) ? realParc.culture_actuelle : ''))
            setEditing({
              date: new Date().toISOString().split('T')[0], campagne: campagneActive,
              parcelle_id: realParcelleId, parcelle_nom: realParc?.nom || parc.nom, variete, surface_ha: parc.surface ?? '',
              nb_palox: '', poids_brut: '', poids_net: '',
              tracteur: '', conducteur: '', observation: '',
            })
          }}
          addLabel="+ Pesée"
          headerExtra={parc => {
            const realParcelleId = parc._parcelleId || parc.id
            const realParc = parcelles.find(x => x.id === realParcelleId) || parc
            const list = varietesOf(realParc)
            return (
              <button className="btn-sm" onClick={() => setEditingVarietes({
                parcelleId: realParc.id,
                varietes: list.length > 0 ? list.map(v => ({ variete: v.variete, surface: v.surface ?? '', cote: v.cote || '' })) : [{ variete: '', surface: '', cote: '' }],
              })}>
                🏷️ Variété{list.length > 1 ? 's' : ''}{list.length > 0 ? ` : ${list.map(v => v.variete).join(' + ')}` : ''}
              </button>
            )
          }}
          renderRow={p => [fmtDate(p.date), p.nb_palox ?? '–', p.poids_net != null ? p.poids_net.toLocaleString('fr-FR') + ' kg' : '–', p.tracteur || '–', p.conducteur || '–']}
          rowHeaders={['Date', 'Palox', 'Poids net', 'Tracteur', 'Conducteur']}
          onRowClick={p => openEdit(p)}
        />
      )}

      {/* ── Onglet Par parcelle ── */}
      {tab === 'parcelles' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          {parParcelle.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
              Aucune pesée rattachée à une parcelle.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: '1rem' }}>
              {parParcelle.map(r => {
                const rendement = r.surface > 0 ? (r.net / 1000) / r.surface : null
                const moy = r.palox > 0 ? r.net / r.palox : null
                return (
                  <div key={r.key} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, padding: '1.1rem 1.2rem', borderTop: '4px solid var(--green-accent)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '.7rem' }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{r.nom}{r.variete && <span style={{ fontWeight: 500, color: 'var(--green-mid)' }}> — {r.variete}</span>}</div>
                        <div style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>
                          {r.surface ? `${r.surface} ha` : 'surface inconnue'} · {r.nb} pesée(s)
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.5rem', color: 'var(--green-mid)', lineHeight: 1 }}>
                          {(r.net / 1000).toFixed(2)}
                        </div>
                        <div style={{ fontSize: '.65rem', color: 'var(--text-muted)' }}>tonnes</div>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.5rem', fontSize: '.78rem' }}>
                      <div style={{ background: 'var(--cream)', borderRadius: 8, padding: '.45rem .6rem' }}>
                        <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Palox</div>
                        <strong>{r.palox || '–'}</strong>
                      </div>
                      <div style={{ background: 'var(--cream)', borderRadius: 8, padding: '.45rem .6rem' }}>
                        <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Moy./palox</div>
                        <strong>{moy ? `${moy.toFixed(1)} kg` : '–'}</strong>
                      </div>
                      <div style={{ background: 'var(--green-pale)', borderRadius: 8, padding: '.45rem .6rem' }}>
                        <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Rendement</div>
                        <strong style={{ color: 'var(--green-mid)' }}>{rendement ? `${rendement.toFixed(1)} t/ha` : '–'}</strong>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Modal pesée ── */}
      {editing && (
        <Modal title={editing.id ? 'Modifier la pesée' : 'Nouvelle pesée'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={620}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group"><label>Date *</label>
              <input type="date" value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} /></div>
            <div className="form-group"><label>Parcelle</label>
              <select value={editing.parcelle_id} onChange={e => {
                const parc = parcelles.find(x => x.id === e.target.value)
                const list = parc ? varietesOf(parc) : []
                const sub = list.length > 1 ? subDossiersForParcelle(parc, peseesCampagne.filter(p => p.parcelle_id === parc.id)) : null
                const variete = list.length === 1 ? list[0].variete : (list.length > 1 ? '' : (parc?.culture_actuelle || ''))
                const surface_ha = sub ? (sub[0]?.surface ?? '') : (parc?.surface ?? '')
                setEditing({ ...editing, parcelle_id: e.target.value, parcelle_nom: parc?.nom || '', variete, surface_ha })
              }}>
                <option value="">— Aucune —</option>
                {parcelles.map(p => <option key={p.id} value={p.id}>{p.nom}{p.surface ? ` (${p.surface} ha)` : ''}</option>)}
              </select>
            </div>
            {(() => {
              const parc = parcelles.find(x => x.id === editing.parcelle_id)
              const list = parc ? varietesOf(parc) : []
              // Parcelle à plusieurs variétés (bord de route/chemin traité différemment, lots
              // distincts...) : choix parmi elles, la surface se pré-remplit selon le choix.
              if (list.length > 1) {
                const sub = subDossiersForParcelle(parc, peseesCampagne.filter(p => p.parcelle_id === parc.id)) || []
                return (
                  <div className="form-group"><label>Variété *</label>
                    <select value={editing.variete || ''} onChange={e => {
                      const v = e.target.value
                      const match = sub.find(s => s.variete === v)
                      setEditing({ ...editing, variete: v, surface_ha: match?.surface ?? editing.surface_ha })
                    }}>
                      <option value="">— Choisir —</option>
                      {list.map(v => <option key={v.variete} value={v.variete}>{v.variete}</option>)}
                    </select>
                  </div>
                )
              }
              return (
                <div className="form-group"><label>Variété</label>
                  <input value={editing.variete || ''} onChange={e => setEditing({ ...editing, variete: e.target.value })} placeholder="ex. Agata" /></div>
              )
            })()}
            <div className="form-group"><label>Surface (ha) <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— pour le rendement de cette variété</span></label>
              <input type="number" step="0.01" min="0" value={editing.surface_ha ?? ''} onChange={e => setEditing({ ...editing, surface_ha: e.target.value })} /></div>
            <div className="form-group"><label>Nombre de palox</label>
              <input type="number" step="1" value={editing.nb_palox} onChange={e => setEditing({ ...editing, nb_palox: e.target.value })} /></div>
            <div className="form-group"><label>Poids brut (kg)</label>
              <input type="number" step="1" value={editing.poids_brut} onChange={e => setEditing({ ...editing, poids_brut: e.target.value })} /></div>
            <div className="form-group"><label>Poids net (kg) *</label>
              <input type="number" step="1" value={editing.poids_net} onChange={e => setEditing({ ...editing, poids_net: e.target.value })} /></div>
            <div className="form-group"><label>Tracteur</label>
              <input list="tracteurs-list" value={editing.tracteur || ''} onChange={e => setEditing({ ...editing, tracteur: e.target.value })} />
              <datalist id="tracteurs-list">{tracteurs.map(t => <option key={t} value={t} />)}</datalist>
            </div>
            <div className="form-group"><label>Conducteur</label>
              <input list="conducteurs-list" value={editing.conducteur || ''} onChange={e => setEditing({ ...editing, conducteur: e.target.value })} />
              <datalist id="conducteurs-list">{conducteurs.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            {/* Aperçu calculé en direct */}
            {(editing.nb_palox > 0 || editing.poids_net > 0) && (
              <div style={{ gridColumn: '1/-1', background: 'var(--green-pale)', borderRadius: 8, padding: '.55rem .8rem', fontSize: '.8rem', color: 'var(--green-mid)', fontWeight: 600, display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
                {editing.nb_palox > 0 && editing.poids_net > 0 && (
                  <span>Poids moyen : {(editing.poids_net / editing.nb_palox).toFixed(1)} kg / palox</span>
                )}
                {editing.poids_net > 0 && editing.surface_ha > 0 && (
                  <span>🌾 Rendement : {((editing.poids_net / 1000) / editing.surface_ha).toFixed(1)} t/ha</span>
                )}
                {editing.poids_net > 0 && !(editing.surface_ha > 0) && (
                  <span style={{ color: 'var(--amber)', fontWeight: 500 }}>⚠️ Rendement non calculable — surface manquante</span>
                )}
              </div>
            )}
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Observation</label>
              <textarea rows={2} value={editing.observation || ''} onChange={e => setEditing({ ...editing, observation: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* ── Modal attribution variété(s) à la parcelle — autant de variétés que
           nécessaire ; dès la 2e, chacune obtient son propre dossier. ── */}
      {editingVarietes && (
        <Modal title="🏷️ Variété(s) de la parcelle" onClose={() => setEditingVarietes(null)} onSave={saveVarietes} maxWidth={480}>
          <div style={{ display: 'grid', gap: '.8rem' }}>
            <p style={{ fontSize: '.78rem', color: 'var(--text-muted)', margin: 0 }}>
              Se pré-remplit automatiquement à chaque nouvelle pesée. À partir de 2 variétés, chacune obtient son propre
              dossier dans la liste des parcelles — renseigne la surface de chacune sauf la 1ère, qui récupère
              automatiquement le reste de la surface de la parcelle. Le côté (ex. Nord, côté route…) sert à repérer
              la variété sur la carte.
            </p>
            <div className="form-group">
              <label>Variété(s)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
                {editingVarietes.varietes.map((v, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', paddingBottom: i < editingVarietes.varietes.length - 1 ? '.4rem' : 0, borderBottom: i < editingVarietes.varietes.length - 1 ? '1px dashed var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                      <input style={{ flex: 1 }} autoFocus={i === 0} value={v.variete}
                        onChange={e => setEditingVarietes({ ...editingVarietes, varietes: editingVarietes.varietes.map((x, idx) => idx === i ? { ...x, variete: e.target.value } : x) })}
                        placeholder={i === 0 ? 'ex. Agata (principale)' : `ex. Bintje (variété ${i + 1})`} />
                      {editingVarietes.varietes.length > 1 && (
                        <button type="button" onClick={() => setEditingVarietes({ ...editingVarietes, varietes: editingVarietes.varietes.filter((_, idx) => idx !== i) })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red,#c0392b)', fontSize: '.95rem' }}>✕</button>
                      )}
                    </div>
                    {i > 0 && (
                      <div style={{ display: 'flex', gap: '.5rem' }}>
                        <input style={{ flex: 1 }} type="number" step="0.01" min="0" value={v.surface}
                          onChange={e => setEditingVarietes({ ...editingVarietes, varietes: editingVarietes.varietes.map((x, idx) => idx === i ? { ...x, surface: e.target.value } : x) })}
                          placeholder="Surface (ha)" />
                        <input style={{ flex: 1 }} list="cote-list" value={v.cote || ''}
                          onChange={e => setEditingVarietes({ ...editingVarietes, varietes: editingVarietes.varietes.map((x, idx) => idx === i ? { ...x, cote: e.target.value } : x) })}
                          placeholder="Côté (ex. Nord)" />
                      </div>
                    )}
                  </div>
                ))}
                <datalist id="cote-list">
                  {['Nord','Sud','Est','Ouest','Côté route','Côté chemin'].map(c => <option key={c} value={c} />)}
                </datalist>
                <button type="button" className="btn-sm" style={{ alignSelf: 'flex-start' }}
                  onClick={() => setEditingVarietes({ ...editingVarietes, varietes: [...editingVarietes.varietes, { variete: '', surface: '', cote: '' }] })}>
                  + Ajouter une variété
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

const td = { padding: '.6rem .75rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
