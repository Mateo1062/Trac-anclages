import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/useToast'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import Modal from '../components/Modal'
import DataTable from '../components/DataTable'

/* ─────────────────────────────────────────────────────────
   Calcul quantité engrais — reproduit le fichier Excel
   "Calcul quantité engraisGP" :
   - Produits : catalogue (compo N/P/K/MgO/SO3 en u/qx, coeffs, prix €/T)
   - Apports  : une ligne par produit appliqué sur une parcelle (dose kg/ha)
       Qté totale (kg) = dose × surface
       Unités/ha = dose/100 × coeff × compo (N et P) ou dose/100 × compo (K, MgO, SO3)
   - Récap    : quantités à commander par produit (T) + montant (€)
───────────────────────────────────────────────────────── */

const num = v => (v == null || v === '' || isNaN(v)) ? 0 : +v
const fmt = (v, d = 1) => num(v) ? num(v).toFixed(d).replace(/\.0+$/, '') : '0'

function unitesApport(produit, dose) {
  if (!produit) return { n: 0, p: 0, k: 0, mgo: 0, so3: 0 }
  const d = num(dose) / 100
  return {
    n:   d * num(produit.coeff_n) * num(produit.compo_n),
    p:   d * num(produit.coeff_p) * num(produit.compo_p),
    k:   d * num(produit.compo_k),
    mgo: d * num(produit.compo_mgo),
    so3: d * num(produit.compo_so3),
  }
}

const EMPTY_PRODUIT = { nom: '', type: '', coeff_n: 1, coeff_p: 1, compo_n: 0, compo_p: 0, compo_k: 0, compo_mgo: 0, compo_so3: 0, prix_t: 0, notes: '' }
const TYPES_PRODUIT = ['N Liquide', 'N Solide', 'Phosphore', 'Potasse', 'Magnésie', 'NPK', 'PK', 'Amendement', 'Organique', 'Autre']

export default function Engrais() {
  const { showToast, ToastEl } = useToast()
  const { campagneActive, registerCampagnes } = useCampagne()
  const [tab, setTab] = useState('apports')
  const [produits, setProduits] = useState([])
  const [apports, setApports] = useState([])
  const [parcelles, setParcelles] = useState([])
  const [missingTables, setMissingTables] = useState(false)

  const [editingProduit, setEditingProduit] = useState(null)
  const [editingApport, setEditingApport] = useState(null)
  const [expandedRecap, setExpandedRecap] = useState(() => new Set())
  const toggleRecap = id => setExpandedRecap(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  useEffect(() => { loadAll() }, [campagneActive])

  async function loadAll() {
    const [{ data: pr, error }, { data: pa }] = await Promise.all([
      supabase.from('engrais_produits').select('*').order('nom'),
      supabase.from('parcelles').select('id,nom,entite,surface,culture_actuelle,campagne').order('nom'),
    ])
    if (error && /does not exist|relation|could not find the table/i.test(error.message)) { setMissingTables(true); return }
    setProduits(pr || [])
    // Même convention que Carte/MesParcelles : le parcellaire change à chaque
    // campagne, on ne montre (et ne propose dans les listes) que les parcelles
    // de la campagne active, jamais celles d'une autre année.
    setParcelles((pa || []).filter(p => (p.campagne || defaultCampagne()) === campagneActive))
    loadApports()
  }
  async function loadApports() {
    // Repli sur la campagne courante pour les lignes saisies avant l'existence
    // de ce champ — même convention que partout ailleurs (Céréales, MesParcelles…).
    const { data, error } = await supabase.from('engrais_apports').select('*').order('created_at')
    if (error && /does not exist|relation|could not find the table/i.test(error.message)) { setMissingTables(true); return }
    const all = data || []
    registerCampagnes([...new Set(all.map(r => r.campagne).filter(Boolean))])
    setApports(all.filter(r => (r.campagne || defaultCampagne()) === campagneActive))
  }

  const produitById = id => produits.find(p => p.id === id)

  /* ── CRUD produit ── */
  async function saveProduit() {
    const e = editingProduit
    if (!e.nom?.trim()) { alert('Nom requis.'); return }
    const payload = { ...e }
    for (const k of ['coeff_n','coeff_p','compo_n','compo_p','compo_k','compo_mgo','compo_so3','prix_t']) payload[k] = num(payload[k])
    delete payload.created_at
    let error
    if (payload.id) ({ error } = await supabase.from('engrais_produits').update(payload).eq('id', payload.id))
    else ({ error } = await supabase.from('engrais_produits').insert(payload))
    if (error) { alert(error.message); return }
    setEditingProduit(null)
    loadAll()
    showToast('✅ Produit enregistré')
  }
  async function deleteProduit() {
    if (!confirm('Supprimer ce produit ? Ses apports seront aussi supprimés.')) return
    await supabase.from('engrais_apports').delete().eq('produit_id', editingProduit.id)
    await supabase.from('engrais_produits').delete().eq('id', editingProduit.id)
    setEditingProduit(null)
    loadAll()
    showToast('🗑️ Produit supprimé')
  }

  // Crée une fiche intrant (Base de données, catégorie "engrais") pour chaque
  // produit du catalogue qui n'y figure pas encore — les apports ajustent
  // ensuite le stock automatiquement à chaque saisie.
  async function syncProduitsToDb() {
    let created = 0
    for (const p of produits) {
      const { data: existing } = await supabase.from('db_intrants').select('id').eq('categorie', 'engrais').ilike('nom', p.nom).maybeSingle()
      if (!existing) {
        await supabase.from('db_intrants').insert({ nom: p.nom, categorie: 'engrais', unite: 'kg', stock: 0 })
        created++
      }
    }
    showToast(created ? `✅ ${created} produit(s) ajouté(s) à la Base de données` : '✅ Tous les produits sont déjà dans la Base de données')
  }

  /* ── CRUD apport ── */
  function openNewApport(prefill = {}) {
    setEditingApport({ campagne: campagneActive, parcelle_id: null, entite: '', parcelle_nom: '', culture: '', surface_ha: '', produit_id: produits[0]?.id || null, date_apport: '', dose_kg_ha: '', notes: '', ...prefill })
  }

  // ── Lien avec la Base de données (db_intrants, catégorie "engrais") ──
  // Chaque apport CONSOMME du stock (dose × surface, en kg) — la fiche intrant
  // est créée si absente. `sens` = +1 pour appliquer l'apport, −1 pour l'annuler
  // (édition/suppression), même principe que les plants PDT.
  async function adjustEngraisStock(apport, sens) {
    if (!apport?.produit_id) return
    const prod = produitById(apport.produit_id)
    if (!prod?.nom) return
    const qte = num(apport.dose_kg_ha) * num(apport.surface_ha)
    if (!qte) return
    const delta = -qte * sens
    const { data: existing } = await supabase.from('db_intrants')
      .select('id,stock').eq('categorie', 'engrais').ilike('nom', prod.nom).maybeSingle()
    if (existing) {
      await supabase.from('db_intrants').update({ stock: (existing.stock || 0) + delta }).eq('id', existing.id)
    } else {
      await supabase.from('db_intrants').insert({ nom: prod.nom, categorie: 'engrais', unite: 'kg', stock: delta })
    }
  }

  async function saveApport() {
    const e = editingApport
    if (!e.parcelle_nom?.trim()) { alert('Nom de parcelle requis.'); return }
    if (!e.produit_id) { alert('Produit requis.'); return }
    const payload = { ...e, surface_ha: num(e.surface_ha), dose_kg_ha: num(e.dose_kg_ha) }
    delete payload.created_at
    let error
    if (payload.id) {
      const before = apports.find(a => a.id === payload.id)
      ;({ error } = await supabase.from('engrais_apports').update(payload).eq('id', payload.id))
      if (!error) { await adjustEngraisStock(before, -1); await adjustEngraisStock(payload, +1) }
    } else {
      ;({ error } = await supabase.from('engrais_apports').insert(payload))
      if (!error) await adjustEngraisStock(payload, +1)
    }
    if (error) { alert(error.message); return }
    setEditingApport(null)
    loadApports()
    showToast('✅ Apport enregistré — stock intrant mis à jour dans la Base de données')
  }
  async function deleteApport() {
    if (!confirm('Supprimer cet apport ?')) return
    await supabase.from('engrais_apports').delete().eq('id', editingApport.id)
    await adjustEngraisStock(editingApport, -1)
    setEditingApport(null)
    loadApports()
    showToast('🗑️ Apport supprimé — stock intrant réajusté')
  }

  /* ── Regroupement par entité → parcelle ── */
  const parEntite = {}
  for (const a of apports) {
    const ent = a.entite?.trim() || 'Sans entité'
    const pk = `${a.parcelle_nom || '?'}|${a.culture || ''}`
    if (!parEntite[ent]) parEntite[ent] = {}
    if (!parEntite[ent][pk]) parEntite[ent][pk] = { nom: a.parcelle_nom, culture: a.culture, surface: a.surface_ha, rows: [] }
    parEntite[ent][pk].rows.push(a)
  }

  /* ── Récap commande : total kg par produit ── */
  const recap = produits.map(p => {
    const rows = apports.filter(a => a.produit_id === p.id)
      .slice().sort((a, b) => (a.parcelle_nom || '').localeCompare(b.parcelle_nom || '', 'fr'))
    const kg = rows.reduce((s, a) => s + num(a.dose_kg_ha) * num(a.surface_ha), 0)
    return { produit: p, kg, rows, tonnes: kg / 1000, montant: (kg / 1000) * num(p.prix_t), nbParcelles: rows.length }
  }).filter(r => r.kg > 0)
  const totalMontant = recap.reduce((s, r) => s + r.montant, 0)
  const totalKg = recap.reduce((s, r) => s + r.kg, 0)

  if (missingTables) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
        <div style={{ background: 'var(--amber-pale, #fdf6e9)', border: '1.5px solid var(--amber)', borderRadius: 12, padding: '1.5rem 2rem', maxWidth: 520, textAlign: 'center' }}>
          <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>🌱</div>
          <strong>Tables engrais manquantes</strong>
          <p style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginTop: '.5rem' }}>
            Exécute <code>migration_A_EXECUTER_3.sql</code> dans Supabase → SQL Editor, puis recharge la page.
          </p>
        </div>
      </div>
    )
  }

  const thS = { padding: '.45rem .6rem', fontSize: '.68rem', fontWeight: 700, textAlign: 'left', background: 'var(--green-pale)', color: 'var(--green-deep)', whiteSpace: 'nowrap' }
  const tdS = { padding: '.4rem .6rem', fontSize: '.78rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}
      {/* Bandeau : sous-onglets + campagne */}
      <div className="tab-scroll-fade" style={{ background: 'white', borderBottom: '2px solid var(--border)', padding: '0 1rem', display: 'flex', gap: '.25rem', alignItems: 'center', flexShrink: 0, overflowX: 'auto' }}>
        {[['apports', '🌱 Apports par parcelle'], ['produits', '🧪 Produits'], ['recap', '🌍 Vue globale']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding: '.6rem 1rem', background: 'none', border: 'none', whiteSpace: 'nowrap',
            borderBottom: tab === k ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor: 'pointer', fontSize: '.85rem', fontWeight: tab === k ? 700 : 500,
            color: tab === k ? 'var(--green-mid)' : 'var(--text-muted)', marginBottom: -2,
          }}>{l}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.35rem 0' }}>
          <span style={{ fontSize: '.76rem', color: 'var(--text-muted)', fontWeight: 600 }}>🗓️ {campagneActive}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.2rem' }}>
        {/* ═══ APPORTS ═══ */}
        {tab === 'apports' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.8rem', flexWrap: 'wrap', gap: '.5rem' }}>
              <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>
                {apports.length} apport{apports.length > 1 ? 's' : ''} · dose en kg/ha · unités apportées en u/ha
              </span>
              <button className="btn-sm primary" onClick={() => openNewApport()}>+ Nouvel apport</button>
            </div>
            {apports.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2.5rem 1rem', fontStyle: 'italic' }}>
                Aucun apport pour la campagne {campagneActive} — clique "+ Nouvel apport".
              </div>
            )}
            {Object.entries(parEntite).sort(([a], [b]) => a.localeCompare(b)).map(([ent, parcMap]) => {
              const parcs = Object.values(parcMap).sort((a, b) => (a.nom || '').localeCompare(b.nom || ''))
              return (
                <div key={ent} style={{ marginBottom: '1.4rem' }}>
                  <div style={{ fontWeight: 800, fontSize: '.85rem', color: 'var(--green-deep)', textTransform: 'uppercase', letterSpacing: '.03em', margin: '0 0 .5rem' }}>🏢 {ent}</div>
                  {parcs.map(pc => {
                    const tot = pc.rows.reduce((s, a) => {
                      const u = unitesApport(produitById(a.produit_id), a.dose_kg_ha)
                      return { n: s.n + u.n, p: s.p + u.p, k: s.k + u.k, mgo: s.mgo + u.mgo, so3: s.so3 + u.so3, kg: s.kg + num(a.dose_kg_ha) * num(a.surface_ha) }
                    }, { n: 0, p: 0, k: 0, mgo: 0, so3: 0, kg: 0 })
                    return (
                      <div key={pc.nom + pc.culture} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, marginBottom: '.7rem', overflow: 'hidden' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.5rem .8rem', background: 'var(--cream)', flexWrap: 'wrap' }}>
                          <strong style={{ fontSize: '.85rem' }}>🌾 {pc.nom}</strong>
                          {pc.culture && <span style={{ fontSize: '.7rem', fontWeight: 700, background: 'var(--green-pale)', color: 'var(--green-mid)', padding: '.1rem .5rem', borderRadius: 50 }}>{pc.culture}</span>}
                          <span style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{fmt(pc.surface, 2)} ha</span>
                          <button className="btn-sm" style={{ marginLeft: 'auto', fontSize: '.7rem', padding: '.2rem .55rem' }}
                            onClick={() => openNewApport({ parcelle_id: pc.rows[0]?.parcelle_id || null, entite: ent === 'Sans entité' ? '' : ent, parcelle_nom: pc.nom, culture: pc.culture || '', surface_ha: pc.surface })}>
                            + Apport
                          </button>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                            <thead><tr>
                              <th style={thS}>Produit</th><th style={thS}>Date apport</th><th style={{ ...thS, textAlign: 'right' }}>Dose kg/ha</th>
                              <th style={{ ...thS, textAlign: 'right' }}>Qté totale kg</th>
                              <th style={{ ...thS, textAlign: 'right' }}>N</th><th style={{ ...thS, textAlign: 'right' }}>P</th><th style={{ ...thS, textAlign: 'right' }}>K</th>
                              <th style={{ ...thS, textAlign: 'right' }}>MgO</th><th style={{ ...thS, textAlign: 'right' }}>SO3</th>
                            </tr></thead>
                            <tbody>
                              {pc.rows.map(a => {
                                const prod = produitById(a.produit_id)
                                const u = unitesApport(prod, a.dose_kg_ha)
                                return (
                                  <tr key={a.id} onClick={() => setEditingApport({ ...a })} style={{ cursor: 'pointer' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                                    onMouseLeave={e => e.currentTarget.style.background = ''}>
                                    <td style={{ ...tdS, fontWeight: 600 }}>{prod?.nom || '—'}</td>
                                    <td style={{ ...tdS, color: 'var(--text-muted)' }}>{a.date_apport || '—'}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(a.dose_kg_ha)}</td>
                                    <td style={{ ...tdS, textAlign: 'right', fontWeight: 600 }}>{fmt(num(a.dose_kg_ha) * num(a.surface_ha), 0)}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(u.n)}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(u.p)}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(u.k)}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(u.mgo)}</td>
                                    <td style={{ ...tdS, textAlign: 'right' }}>{fmt(u.so3)}</td>
                                  </tr>
                                )
                              })}
                              <tr style={{ background: 'var(--cream)' }}>
                                <td style={{ ...tdS, fontWeight: 700 }} colSpan={3}>Total parcelle</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.kg, 0)} kg</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.n)}</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.p)}</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.k)}</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.mgo)}</td>
                                <td style={{ ...tdS, textAlign: 'right', fontWeight: 700 }}>{fmt(tot.so3)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </>
        )}

        {/* ═══ PRODUITS ═══ */}
        {tab === 'produits' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.8rem', flexWrap: 'wrap', gap: '.5rem' }}>
              <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>Compositions en unités par quintal (u/qx)</span>
              <div style={{ display: 'flex', gap: '.5rem' }}>
                <button className="btn-sm" onClick={syncProduitsToDb} title="Crée une fiche intrant pour chaque produit manquant dans la Base de données">
                  🔗 Synchroniser vers Base de données
                </button>
                <button className="btn-sm primary" onClick={() => setEditingProduit({ ...EMPTY_PRODUIT })}>+ Nouveau produit</button>
              </div>
            </div>
            <DataTable
              emptyMessage="Aucun produit — clique '+ Nouveau produit'."
              onRowClick={p => setEditingProduit({ ...p })}
              columns={[
                { key: 'nom', label: 'Produit', render: p => <strong>{p.nom}</strong> },
                { key: 'type', label: 'Type' },
                { key: 'compo_n', label: 'N', render: p => fmt(p.compo_n) },
                { key: 'compo_p', label: 'P', render: p => fmt(p.compo_p) },
                { key: 'compo_k', label: 'K', render: p => fmt(p.compo_k) },
                { key: 'compo_mgo', label: 'MgO', render: p => fmt(p.compo_mgo) },
                { key: 'compo_so3', label: 'SO3', render: p => fmt(p.compo_so3) },
                { key: 'coeff_n', label: 'Coeff N', render: p => fmt(p.coeff_n, 2) },
                { key: 'coeff_p', label: 'Coeff P', render: p => fmt(p.coeff_p, 2) },
                { key: 'prix_t', label: 'Prix €/T', render: p => `${fmt(p.prix_t, 2)} €` },
              ]}
              rows={produits}
            />
          </>
        )}

        {/* ═══ RÉCAP GLOBAL — total de tout ce qui a été utilisé, cliquable pour le détail par parcelle ═══ */}
        {tab === 'recap' && (
          <>
            <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
              Vue globale campagne {campagneActive} — total de chaque produit utilisé sur toutes les parcelles (Σ dose × surface). Clique un produit pour voir le détail parcelle par parcelle.
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginBottom: '.9rem', flexWrap: 'wrap' }}>
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Produits utilisés</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>{recap.length}</div>
              </div>
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Quantité totale</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>{fmt(totalKg / 1000, 2)} T</div>
              </div>
              <div style={{ background: 'var(--green-pale)', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--green-mid)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Montant total</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--green-mid)' }}>{totalMontant.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} €</div>
              </div>
            </div>

            {recap.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2.5rem', background: 'white', borderRadius: 12, border: '2px dashed var(--border)', color: 'var(--text-muted)' }}>
                Aucun apport saisi pour cette campagne.
              </div>
            ) : (
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                {recap.map(r => {
                  const isOpen = expandedRecap.has(r.produit.id)
                  return (
                    <div key={r.produit.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <div onClick={() => toggleRecap(r.produit.id)}
                        style={{ padding: '.65rem .9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem', cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}>
                        <span style={{ minWidth: 0 }}>
                          <span style={{ marginRight: '.4rem', color: 'var(--green-accent)' }}>{isOpen ? '▾' : '▸'}</span>
                          <strong style={{ fontSize: '.86rem' }}>{r.produit.nom}</strong>
                          <span style={{ color: 'var(--text-muted)', fontSize: '.74rem' }}> — {r.produit.type || '—'} · {r.nbParcelles} parcelle{r.nbParcelles > 1 ? 's' : ''}</span>
                        </span>
                        <span style={{ display: 'flex', gap: '1rem', fontSize: '.82rem', flexWrap: 'wrap' }}>
                          <span><strong>{fmt(r.tonnes, 2)}</strong> T</span>
                          <span style={{ fontWeight: 700, color: 'var(--green-mid)' }}>{r.montant.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} €</span>
                        </span>
                      </div>
                      {isOpen && (
                        <div style={{ background: 'var(--cream)', overflowX: 'auto' }}>
                          <table style={{ width: '100%', minWidth: 480, borderCollapse: 'collapse', fontSize: '.78rem' }}>
                            <thead><tr>
                              <th style={thS}>Parcelle</th><th style={thS}>Entité</th>
                              <th style={{ ...thS, textAlign: 'right' }}>Surface</th>
                              <th style={{ ...thS, textAlign: 'right' }}>Dose (kg/ha)</th>
                              <th style={thS}>Date</th>
                              <th style={{ ...thS, textAlign: 'right' }}>Qté (kg)</th>
                            </tr></thead>
                            <tbody>
                              {r.rows.map(a => (
                                <tr key={a.id} onClick={() => setEditingApport({ ...a })} style={{ cursor: 'pointer' }}
                                  onMouseEnter={e => e.currentTarget.style.background = 'white'}
                                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                                  <td style={tdS}>{a.parcelle_nom || '—'}</td>
                                  <td style={{ ...tdS, color: 'var(--text-muted)' }}>{a.entite || '—'}</td>
                                  <td style={{ ...tdS, textAlign: 'right' }}>{fmt(a.surface_ha, 2)} ha</td>
                                  <td style={{ ...tdS, textAlign: 'right' }}>{fmt(a.dose_kg_ha, 1)}</td>
                                  <td style={tdS}>{a.date_apport || '—'}</td>
                                  <td style={{ ...tdS, textAlign: 'right', fontWeight: 600 }}>{fmt(num(a.dose_kg_ha) * num(a.surface_ha), 0)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )
                })}
                <div style={{ padding: '.65rem .9rem', display: 'flex', justifyContent: 'space-between', background: 'var(--green-pale)', borderTop: '1px solid var(--border)', fontWeight: 800 }}>
                  <span>TOTAL</span>
                  <span style={{ color: 'var(--green-mid)' }}>{totalMontant.toLocaleString('fr-FR', { maximumFractionDigits: 0 })} €</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ═══ Modal produit ═══ */}
      {editingProduit && (
        <Modal title={editingProduit.id ? 'Modifier le produit' : 'Nouveau produit engrais'} onClose={() => setEditingProduit(null)} onSave={saveProduit} onDelete={editingProduit.id ? deleteProduit : null} maxWidth={520}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Nom *</label><input autoFocus value={editingProduit.nom} onChange={e => setEditingProduit({ ...editingProduit, nom: e.target.value })} placeholder="ex. Ammonitrate 33.5" /></div>
            <div className="form-group"><label>Type</label>
              <select value={editingProduit.type || ''} onChange={e => setEditingProduit({ ...editingProduit, type: e.target.value })}>
                <option value="">— Choisir —</option>
                {TYPES_PRODUIT.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Prix (€/T)</label><input type="number" step="0.01" value={editingProduit.prix_t} onChange={e => setEditingProduit({ ...editingProduit, prix_t: e.target.value })} /></div>
            <div className="form-group"><label>Compo N (u/qx)</label><input type="number" step="0.01" value={editingProduit.compo_n} onChange={e => setEditingProduit({ ...editingProduit, compo_n: e.target.value })} /></div>
            <div className="form-group"><label>Compo P (u/qx)</label><input type="number" step="0.01" value={editingProduit.compo_p} onChange={e => setEditingProduit({ ...editingProduit, compo_p: e.target.value })} /></div>
            <div className="form-group"><label>Compo K (u/qx)</label><input type="number" step="0.01" value={editingProduit.compo_k} onChange={e => setEditingProduit({ ...editingProduit, compo_k: e.target.value })} /></div>
            <div className="form-group"><label>Compo MgO (u/qx)</label><input type="number" step="0.01" value={editingProduit.compo_mgo} onChange={e => setEditingProduit({ ...editingProduit, compo_mgo: e.target.value })} /></div>
            <div className="form-group"><label>Compo SO3 (u/qx)</label><input type="number" step="0.01" value={editingProduit.compo_so3} onChange={e => setEditingProduit({ ...editingProduit, compo_so3: e.target.value })} /></div>
            <div className="form-group"><label>Coeff N</label><input type="number" step="0.01" value={editingProduit.coeff_n} onChange={e => setEditingProduit({ ...editingProduit, coeff_n: e.target.value })} /></div>
            <div className="form-group"><label>Coeff P</label><input type="number" step="0.01" value={editingProduit.coeff_p} onChange={e => setEditingProduit({ ...editingProduit, coeff_p: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Notes</label><input value={editingProduit.notes || ''} onChange={e => setEditingProduit({ ...editingProduit, notes: e.target.value })} /></div>
          </div>
        </Modal>
      )}

      {/* ═══ Modal apport ═══ */}
      {editingApport && (() => {
        const prod = produitById(editingApport.produit_id)
        const u = unitesApport(prod, editingApport.dose_kg_ha)
        const qte = num(editingApport.dose_kg_ha) * num(editingApport.surface_ha)
        return (
          <Modal title={editingApport.id ? 'Modifier l\'apport' : 'Nouvel apport'} onClose={() => setEditingApport(null)} onSave={saveApport} onDelete={editingApport.id ? deleteApport : null} maxWidth={540}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
              <div className="form-group" style={{ gridColumn: '1/-1' }}>
                <label>Parcelle (depuis Parcelles)</label>
                <select value={editingApport.parcelle_id || ''} onChange={e => {
                  const p = parcelles.find(x => x.id === e.target.value)
                  if (p) setEditingApport({ ...editingApport, parcelle_id: p.id, parcelle_nom: p.nom, entite: p.entite || '', culture: p.culture_actuelle || '', surface_ha: p.surface ?? '' })
                  else setEditingApport({ ...editingApport, parcelle_id: null })
                }}>
                  <option value="">✏️ Saisie libre…</option>
                  {parcelles.map(p => <option key={p.id} value={p.id}>{p.nom}{p.entite ? ` — ${p.entite}` : ''}{p.surface ? ` (${p.surface} ha)` : ''}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Nom parcelle *</label><input value={editingApport.parcelle_nom} onChange={e => setEditingApport({ ...editingApport, parcelle_nom: e.target.value })} /></div>
              <div className="form-group"><label>Entité / Société</label><input value={editingApport.entite || ''} onChange={e => setEditingApport({ ...editingApport, entite: e.target.value })} placeholder="ex. SARL ROPAMIL" /></div>
              <div className="form-group"><label>Culture</label><input value={editingApport.culture || ''} onChange={e => setEditingApport({ ...editingApport, culture: e.target.value })} placeholder="ex. BETTERAVES" /></div>
              <div className="form-group"><label>Surface (ha)</label><input type="number" step="0.01" value={editingApport.surface_ha} onChange={e => setEditingApport({ ...editingApport, surface_ha: e.target.value })} /></div>
              <div className="form-group" style={{ gridColumn: '1/-1' }}>
                <label>Produit *</label>
                <select value={editingApport.produit_id || ''} onChange={e => setEditingApport({ ...editingApport, produit_id: e.target.value || null })}>
                  <option value="">— Choisir —</option>
                  {produits.map(p => <option key={p.id} value={p.id}>{p.nom}</option>)}
                </select>
              </div>
              <div className="form-group"><label>Date d'apport</label><input value={editingApport.date_apport || ''} onChange={e => setEditingApport({ ...editingApport, date_apport: e.target.value })} placeholder="ex. 03/03/2026 (135 l)" /></div>
              <div className="form-group"><label>Dose (kg/ha) *</label><input type="number" step="0.01" value={editingApport.dose_kg_ha} onChange={e => setEditingApport({ ...editingApport, dose_kg_ha: e.target.value })} /></div>
              <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Notes</label><input value={editingApport.notes || ''} onChange={e => setEditingApport({ ...editingApport, notes: e.target.value })} /></div>
            </div>
            {/* Aperçu calculé en direct */}
            <div style={{ marginTop: '.9rem', background: 'var(--green-pale)', borderRadius: 8, padding: '.6rem .9rem', fontSize: '.78rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <span><strong>{fmt(qte, 0)}</strong> kg au total</span>
              <span>N <strong>{fmt(u.n)}</strong></span>
              <span>P <strong>{fmt(u.p)}</strong></span>
              <span>K <strong>{fmt(u.k)}</strong></span>
              <span>MgO <strong>{fmt(u.mgo)}</strong></span>
              <span>SO3 <strong>{fmt(u.so3)}</strong> u/ha</span>
            </div>
          </Modal>
        )
      })()}
    </div>
  )
}
