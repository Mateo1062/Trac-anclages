import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import { Fg, Sec } from '../components/UI'
import { printLogoHtml } from '../lib/printLogo'
import { isDosableCulture } from '../lib/cultureCodes'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { phytoDisplayName, phytoMatches } from '../lib/phytoNames'

/* ═══════════════════════════════════════════════════════════
   COMMANDE PHYTO
   Flux en 5 étapes :
   1. Cultures & Surfaces  — définir les cultures et les surfaces
                             de chaque entité
   2. Produits & Doses     — attacher des produits phyto à chaque
                             culture avec la dose/ha
   3. Besoins calculés     — tableau auto (surface × dose) par entité
   4. Offres fournisseurs  — saisir les prix de chaque fournisseur
                             → comparaison automatique du moins cher
   5. Répartition & Impression — allocation par entité + documents
═══════════════════════════════════════════════════════════ */

// Cultures dont les produits/doses seraient partagés avec une autre culture (ex.
// ORH avec ORP) — désactivé : ORH a désormais son propre onglet dans Produits &
// Doses et sa surface n'est plus comptée dans celle d'ORP pour les Besoins calculés.
const CULTURE_MERGE = {}

const TABS = [
  { key: 'cultures',     icon: '🌱', label: 'Cultures & Surfaces' },
  { key: 'produits',     icon: '🧪', label: 'Produits & Doses' },
  { key: 'besoins',      icon: '📊', label: 'Besoins calculés' },
  { key: 'fournisseurs', icon: '💶', label: 'Offres fournisseurs' },
  { key: 'repartition',  icon: '🖨️', label: 'Répartition & Impression' },
]

export default function CommandePhyto() {
  const { showToast, ToastEl } = useToast()
  const [tab, setTab] = useState('cultures')

  // Shared state across all tabs
  const { campagneActive: campagne, registerCampagnes } = useCampagne()
  const [cultures, setCultures]     = useState([])   // { id, nom }
  const [entites, setEntites]       = useState([])   // { id, nom }
  const [surfaces, setSurfaces]     = useState([])   // { id, culture_id, entite_id, surface_ha }
  const [lignes, setLignes]         = useState([])   // { id, culture_id, produit_id, produit_nom, dose_ha, unite }
  const [produits, setProduits]     = useState([])   // from db_phyto
  const [offres, setOffres]         = useState([])   // { id, produit_id, fournisseur, prix_unitaire, unite, selectionne }
  const [loaded, setLoaded]         = useState(false)

  useEffect(() => { loadAll() }, [campagne])

  // cp_surfaces / cp_lignes / cp_offres sont propres à la campagne active (les
  // besoins et prix d'une campagne ne concernent pas la suivante) ; cp_cultures
  // et cp_entites restent des catalogues permanents, communs à toutes les campagnes.
  async function loadScoped(table, order) {
    // Fetch TOUT puis filtre côté client : un .eq('campagne', X) côté serveur
    // exclurait les lignes historiques dont campagne est encore NULL (colonne
    // ajoutée après coup) — même convention que Céréales/CoutRevient/MesParcelles.
    let q = supabase.from(table).select('*')
    if (order) q = q.order(order)
    const { data } = await q
    return (data || []).filter(r => (r.campagne || defaultCampagne()) === campagne)
  }

  async function loadAll() {
    const [
      { data: cu }, { data: en }, su,
      li, { data: ph }, of
    ] = await Promise.all([
      supabase.from('cp_cultures').select('*').order('nom'),
      supabase.from('cp_entites').select('*').order('nom'),
      loadScoped('cp_surfaces'),
      loadScoped('cp_lignes', 'created_at'),
      supabase.from('db_phyto').select('*').order('nom'),
      loadScoped('cp_offres', 'fournisseur'),
    ])
    setCultures(cu || [])
    setEntites(en || [])
    setSurfaces(su)
    setLignes(li)
    setProduits(ph || [])
    setOffres(of)
    setLoaded(true)
  }

  // cp_surfaces est déjà filtré côté campagne active — requête séparée non filtrée
  // pour que le sélecteur propose aussi les campagnes qui n'ont de données QUE
  // dans Commande Phyto.
  useEffect(() => {
    supabase.from('cp_surfaces').select('campagne').then(({ data }) => {
      registerCampagnes([...new Set((data || []).map(r => r.campagne).filter(Boolean))])
    })
  }, [])

  const shared = { cultures, setCultures, entites, setEntites, surfaces, setSurfaces, lignes, setLignes, produits, setProduits, offres, setOffres, campagne, showToast, reload: loadAll }

  if (!loaded) return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {ToastEl}

      {/* Tab bar */}
      <div className="tab-scroll-fade" style={{ background:'white', borderBottom:'1px solid var(--border)', padding:'0 1.5rem', display:'flex', gap:0, flexShrink:0, alignItems:'stretch', overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
        <div style={{ display:'flex', alignItems:'center', padding:'0 1.2rem 0 0', borderRight:'1px solid var(--border)', marginRight:'1rem', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:'.72rem', color:'var(--text-muted)', textTransform:'uppercase', letterSpacing:'.05em' }}>Campagne</div>
            <div style={{ fontWeight:700, fontSize:'.92rem', color:'var(--green-mid)' }}>{campagne}</div>
          </div>
        </div>
        {TABS.map((t, i) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding:'.7rem 1.1rem', background:'none', border:'none', cursor:'pointer',
            borderBottom: tab === t.key ? '3px solid var(--green-mid)' : '3px solid transparent',
            fontSize:'.83rem', fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? 'var(--green-mid)' : 'var(--text-muted)',
            display:'flex', alignItems:'center', gap:'.35rem', marginBottom:-1,
            whiteSpace:'nowrap', transition:'color .15s',
          }}>
            <span style={{ fontSize:'.9rem' }}>{t.icon}</span> {t.label}
            {i < TABS.length - 1 && <span style={{ marginLeft:'.6rem', color:'var(--border)' }}>›</span>}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        {tab === 'cultures'     && <TabCultures     {...shared} />}
        {tab === 'produits'     && <TabProduits      {...shared} />}
        {tab === 'besoins'      && <TabBesoins       {...shared} />}
        {tab === 'fournisseurs' && <TabFournisseurs  {...shared} />}
        {tab === 'repartition'  && <TabRepartition   {...shared} campagne={campagne} />}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════
   TAB 1 — CULTURES & SURFACES
══════════════════════════════════════════════════ */
function TabCultures({ cultures, setCultures, entites, setEntites, surfaces, setSurfaces, showToast, campagne }) {
  const [editCulture, setEditCulture] = useState(null)
  const [editEntite, setEditEntite]   = useState(null)
  const [editSurface, setEditSurface] = useState(null) // { culture_id, entite_id, surface_ha }
  const [importingParcelles, setImportingParcelles] = useState(false)

  // Reprend automatiquement cultures, entités et surfaces à partir des parcelles
  // déjà enregistrées (culture_actuelle, entite, surface), pour éviter de tout
  // ressaisir manuellement ici.
  async function importFromParcelles() {
    setImportingParcelles(true)
    try {
      const { data: allParcelles, error } = await supabase.from('parcelles').select('nom,entite,surface,culture_actuelle,campagne')
      if (error) throw error
      // Le parcellaire change à chaque campagne (import DAPLOS) — on ne reprend
      // que celles de la campagne active, jamais celles d'une autre année.
      const parcelles = (allParcelles || []).filter(p => (p.campagne || defaultCampagne()) === campagne)
      const withData = (parcelles || []).filter(p => p.culture_actuelle?.trim() && p.entite?.trim() && p.surface)
      // Toute parcelle incomplète (surface, culture ou entité manquante) est exclue du
      // total — signalée clairement ici, sinon une entité peut sembler "sans surface"
      // pour une culture alors que c'est juste une fiche parcelle incomplète.
      const skipped = (parcelles || []).filter(p => !p.culture_actuelle?.trim() || !p.entite?.trim() || !p.surface)
      if (!withData.length) { alert("Aucune parcelle avec culture actuelle + entité + surface renseignées à reprendre."); return }
      const skipMsg = skipped.length
        ? `\n\n⚠️ ${skipped.length} parcelle(s) ignorée(s) (donnée manquante) :\n` +
          skipped.slice(0, 20).map(p => `· ${p.nom} (${p.entite || 'entité ?'}) — ${!p.culture_actuelle?.trim() ? 'culture manquante' : !p.entite?.trim() ? 'entité manquante' : 'surface manquante'}`).join('\n') +
          (skipped.length > 20 ? `\n… et ${skipped.length - 20} autre(s)` : '')
        : ''
      if (!confirm(`Reprendre ${withData.length} parcelle(s) : crée les cultures/entités manquantes et REMPLACE les surfaces existantes par la somme des parcelles correspondantes.${skipMsg}\n\nContinuer ?`)) return

      let nextCultures = [...cultures], nextEntites = [...entites]
      const findOrCreateCulture = async (nom) => {
        let c = nextCultures.find(x => x.nom.toLowerCase() === nom.toLowerCase())
        if (c) return c
        const { data } = await supabase.from('cp_cultures').insert({ nom }).select().single()
        nextCultures = [...nextCultures, data]
        return data
      }
      const findOrCreateEntite = async (nom) => {
        let e = nextEntites.find(x => x.nom.toLowerCase() === nom.toLowerCase())
        if (e) return e
        const { data } = await supabase.from('cp_entites').insert({ nom }).select().single()
        nextEntites = [...nextEntites, data]
        return data
      }

      // Agrège les surfaces par (culture, entité)
      const totals = {} // `${cultureId}|${entiteId}` -> ha
      for (const p of withData) {
        const c = await findOrCreateCulture(p.culture_actuelle.trim())
        const e = await findOrCreateEntite(p.entite.trim())
        const key = `${c.id}|${e.id}`
        totals[key] = (totals[key] || 0) + (parseFloat(p.surface) || 0)
      }

      let nextSurfaces = [...surfaces]
      for (const [key, rawHa] of Object.entries(totals)) {
        const ha = +rawHa.toFixed(2)
        const [cultureId, entiteId] = key.split('|')
        const existing = nextSurfaces.find(s => s.culture_id === cultureId && s.entite_id === entiteId)
        if (existing) {
          await supabase.from('cp_surfaces').update({ surface_ha: ha }).eq('id', existing.id)
          nextSurfaces = nextSurfaces.map(s => s.id === existing.id ? { ...s, surface_ha: ha } : s)
        } else {
          const { data } = await supabase.from('cp_surfaces').insert({ culture_id: cultureId, entite_id: entiteId, surface_ha: ha, campagne }).select().single()
          nextSurfaces = [...nextSurfaces, data]
        }
      }

      setCultures(nextCultures)
      setEntites(nextEntites)
      setSurfaces(nextSurfaces)
      showToast(`✅ Repris depuis ${withData.length} parcelle(s)`)
    } catch (e) {
      alert(e.message)
    } finally {
      setImportingParcelles(false)
    }
  }

  // Save culture
  async function saveCulture() {
    if (!editCulture.nom?.trim()) { alert('Nom obligatoire.'); return }
    if (editCulture.id) {
      await supabase.from('cp_cultures').update({ nom: editCulture.nom }).eq('id', editCulture.id)
      setCultures(prev => prev.map(c => c.id === editCulture.id ? { ...c, nom: editCulture.nom } : c))
    } else {
      const { data, error } = await supabase.from('cp_cultures').insert({ nom: editCulture.nom }).select().single()
      if (error) { alert(error.message); return }
      setCultures(prev => [...prev, data])
    }
    setEditCulture(null)
    showToast('✅ Culture enregistrée')
  }

  async function deleteCulture() {
    if (!confirm('Supprimer cette culture et toutes ses surfaces/produits ?')) return
    await supabase.from('cp_surfaces').delete().eq('culture_id', editCulture.id)
    await supabase.from('cp_lignes').delete().eq('culture_id', editCulture.id)
    await supabase.from('cp_cultures').delete().eq('id', editCulture.id)
    setCultures(prev => prev.filter(c => c.id !== editCulture.id))
    setSurfaces(prev => prev.filter(s => s.culture_id !== editCulture.id))
    setEditCulture(null)
    showToast('🗑️ Culture supprimée')
  }

  // Save entite
  async function saveEntite() {
    if (!editEntite.nom?.trim()) { alert('Nom obligatoire.'); return }
    if (editEntite.id) {
      await supabase.from('cp_entites').update({ nom: editEntite.nom }).eq('id', editEntite.id)
      setEntites(prev => prev.map(e => e.id === editEntite.id ? { ...e, nom: editEntite.nom } : e))
    } else {
      const { data, error } = await supabase.from('cp_entites').insert({ nom: editEntite.nom }).select().single()
      if (error) { alert(error.message); return }
      setEntites(prev => [...prev, data])
    }
    setEditEntite(null)
    showToast('✅ Entité enregistrée')
  }

  async function deleteEntite() {
    if (!confirm('Supprimer cette entité et toutes ses surfaces ?')) return
    await supabase.from('cp_surfaces').delete().eq('entite_id', editEntite.id)
    await supabase.from('cp_entites').delete().eq('id', editEntite.id)
    setEntites(prev => prev.filter(e => e.id !== editEntite.id))
    setSurfaces(prev => prev.filter(s => s.entite_id !== editEntite.id))
    setEditEntite(null)
    showToast('🗑️ Entité supprimée')
  }

  // Surface cell
  function getSurface(cultureId, entiteId) {
    return surfaces.find(s => s.culture_id === cultureId && s.entite_id === entiteId)
  }

  function openSurface(cultureId, entiteId) {
    const s = getSurface(cultureId, entiteId)
    setEditSurface({ culture_id: cultureId, entite_id: entiteId, surface_ha: s?.surface_ha ?? '', id: s?.id ?? null })
  }

  async function saveSurface() {
    const ha = +((parseFloat(editSurface.surface_ha) || 0).toFixed(2))
    if (editSurface.id) {
      if (ha === 0) {
        await supabase.from('cp_surfaces').delete().eq('id', editSurface.id)
        setSurfaces(prev => prev.filter(s => s.id !== editSurface.id))
      } else {
        await supabase.from('cp_surfaces').update({ surface_ha: ha }).eq('id', editSurface.id)
        setSurfaces(prev => prev.map(s => s.id === editSurface.id ? { ...s, surface_ha: ha } : s))
      }
    } else if (ha > 0) {
      const { data } = await supabase.from('cp_surfaces').insert({ culture_id: editSurface.culture_id, entite_id: editSurface.entite_id, surface_ha: ha, campagne }).select().single()
      setSurfaces(prev => [...prev, data])
    }
    setEditSurface(null)
    showToast('✅ Surface mise à jour')
  }

  const totalByCulture = (cId) => surfaces.filter(s => s.culture_id === cId).reduce((t, s) => t + (s.surface_ha || 0), 0)
  const totalByEntite  = (eId) => surfaces.filter(s => s.entite_id === eId).reduce((t, s) => t + (s.surface_ha || 0), 0)

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:'.8rem' }}>
        <button className="btn-sm" onClick={importFromParcelles} disabled={importingParcelles}
          title="Crée/actualise cultures, entités et surfaces à partir des parcelles déjà enregistrées">
          {importingParcelles ? '⏳ Reprise…' : '📥 Reprendre depuis les Parcelles'}
        </button>
      </div>
      {/* Manage cultures and entites */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:'1rem', marginBottom:'1.2rem' }}>
        <Panel title="Cultures" onAdd={() => setEditCulture({ nom: '' })}>
          {cultures.map(c => (
            <PanelItem key={c.id} label={c.nom} onEdit={() => setEditCulture({ ...c })} />
          ))}
          {cultures.length === 0 && <Empty>Aucune culture — ex. Blé, PDT, Betteraves…</Empty>}
        </Panel>
        <Panel title="Entités" onAdd={() => setEditEntite({ nom: '' })}>
          {entites.map(e => (
            <PanelItem key={e.id} label={e.nom} onEdit={() => setEditEntite({ ...e })} />
          ))}
          {entites.length === 0 && <Empty>Aucune entité — ex. EARL Nord, GAEC Sud…</Empty>}
        </Panel>
      </div>

      {/* Surface matrix */}
      {cultures.length > 0 && entites.length > 0 && (
        <div>
          <div style={{ fontSize:'.78rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', marginBottom:'.7rem' }}>
            Surfaces (ha) — cliquez sur une cellule pour saisir
          </div>
          <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
            <table style={{ width:'100%', minWidth: 140 + entites.length * 120, fontSize:'.84rem', borderCollapse:'collapse' }}>
              <thead style={{ background:'var(--cream)' }}>
                <tr>
                  <th style={th}>Culture</th>
                  {entites.map(e => <th key={e.id} style={th}>{e.nom}</th>)}
                  <th style={{ ...th, color:'var(--green-mid)' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {cultures.map(c => (
                  <tr key={c.id}>
                    <td style={{ ...td, fontWeight:600 }}>{c.nom}</td>
                    {entites.map(e => {
                      const s = getSurface(c.id, e.id)
                      return (
                        <td key={e.id} style={{ ...td, cursor:'pointer', textAlign:'center' }}
                          onClick={() => openSurface(c.id, e.id)}
                          onMouseEnter={el => el.currentTarget.style.background = 'var(--green-pale)'}
                          onMouseLeave={el => el.currentTarget.style.background = ''}>
                          {s?.surface_ha ? <span style={{ fontWeight:600 }}>{s.surface_ha.toFixed(2)} ha</span> : <span style={{ color:'var(--border)', fontSize:'.75rem' }}>+ ajouter</span>}
                        </td>
                      )
                    })}
                    <td style={{ ...td, textAlign:'center', fontWeight:700, color:'var(--green-mid)' }}>{totalByCulture(c.id).toFixed(2)} ha</td>
                  </tr>
                ))}
                <tr style={{ background:'var(--cream)' }}>
                  <td style={{ ...td, fontWeight:700 }}>Total</td>
                  {entites.map(e => <td key={e.id} style={{ ...td, textAlign:'center', fontWeight:700, color:'var(--green-mid)' }}>{totalByEntite(e.id).toFixed(2)} ha</td>)}
                  <td style={{ ...td, textAlign:'center', fontWeight:700, color:'var(--green-mid)' }}>{surfaces.reduce((t, s) => t + (s.surface_ha || 0), 0).toFixed(2)} ha</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modals */}
      {editCulture && (
        <Modal title={editCulture.id ? 'Modifier la culture' : 'Nouvelle culture'} onClose={() => setEditCulture(null)} onSave={saveCulture} onDelete={editCulture.id ? deleteCulture : null} maxWidth={380}>
          <Fg label="Nom de la culture *"><input autoFocus value={editCulture.nom} onChange={e => setEditCulture({ ...editCulture, nom: e.target.value })} placeholder="ex. Blé, Orge, PDT, Betteraves…" /></Fg>
        </Modal>
      )}
      {editEntite && (
        <Modal title={editEntite.id ? 'Modifier l\'entité' : 'Nouvelle entité'} onClose={() => setEditEntite(null)} onSave={saveEntite} onDelete={editEntite.id ? deleteEntite : null} maxWidth={380}>
          <Fg label="Nom de l'entité *"><input autoFocus value={editEntite.nom} onChange={e => setEditEntite({ ...editEntite, nom: e.target.value })} placeholder="ex. EARL Nord, GAEC Sud…" /></Fg>
        </Modal>
      )}
      {editSurface && (
        <Modal title={`Surface — ${cultures.find(c => c.id === editSurface.culture_id)?.nom} / ${entites.find(e => e.id === editSurface.entite_id)?.nom}`} onClose={() => setEditSurface(null)} onSave={saveSurface} maxWidth={340}>
          <Fg label="Surface (ha)"><input autoFocus type="number" step="0.01" min="0" value={editSurface.surface_ha} onChange={e => setEditSurface({ ...editSurface, surface_ha: e.target.value })} placeholder="0.00" /></Fg>
          <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginTop:'.4rem' }}>Mettre 0 pour supprimer.</div>
        </Modal>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════
   TAB 2 — PRODUITS & DOSES
══════════════════════════════════════════════════ */
function TabProduits({ cultures: culturesAll, entites, lignes, setLignes, produits, setProduits, showToast, campagne }) {
  // Seules les cultures principales sont proposées ici : blé, orge (dont orge
  // d'hiver / escourgeon), maïs, betteraves et pomme de terre.
  const cultures = culturesAll
    .filter(c => isDosableCulture(c.nom) && !CULTURE_MERGE[c.nom.trim().toUpperCase()])
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
  const [editLigne, setEditLigne] = useState(null) // { culture_id, produit_id, produit_nom, unite, notes, dosesByEntite: {entite_id: '1.5'} }
  const [selectedCulture, setSelectedCulture] = useState(cultures[0]?.id || '')
  const [produitQ, setProduitQ] = useState('')
  const [showProduitDd, setShowProduitDd] = useState(false)
  const [ephyByAmm, setEphyByAmm] = useState({})

  const UNITES = ['g/ha','L/ha','kg/ha','mL/ha','T/ha']

  const cultLignes = lignes.filter(l => l.culture_id === selectedCulture)

  // Une "ligne" produit peut désormais couvrir plusieurs cases cp_lignes (une par
  // entité, chacune avec sa propre dose) — on regroupe donc l'affichage par produit.
  // entite_id NULL = dose historique unique appliquée à toutes les entités (avant
  // migration_A_EXECUTER_52.sql, ou tant qu'aucune dose spécifique n'a été saisie).
  const produitGroups = Object.values(
    cultLignes.reduce((map, l) => {
      (map[l.produit_id] ??= { produit_id: l.produit_id, produit_nom: l.produit_nom, unite: l.unite, notes: l.notes, rows: [] }).rows.push(l)
      return map
    }, {})
  ).sort((a, b) => (a.produit_nom || '').localeCompare(b.produit_nom || '', 'fr'))

  // Noms secondaires (autres noms commerciaux du même produit, ex. "UNIX MAX" pour
  // "KAYAK") : stockés côté EPHY, résolus par N° AMM — sert à la fois à afficher le
  // nom commercial alternatif et à faire correspondre une saisie tapée sous ce nom
  // au produit déjà enregistré dans la BDD phyto, plutôt que de rater le match.
  useEffect(() => {
    const amms = [...new Set(produits.map(p => (p.num_amm || '').trim()).filter(Boolean))]
    if (!amms.length) { setEphyByAmm({}); return }
    supabase.from('ephy_produits').select('numero_amm,noms_secondaires').in('numero_amm', amms)
      .then(({ data }) => setEphyByAmm(Object.fromEntries((data || []).map(e => [e.numero_amm, e]))))
  }, [produits])

  function secondaryNamesFor(p) {
    const amm = p?.num_amm?.trim()
    if (!amm) return []
    const ephy = ephyByAmm[amm]
    if (!ephy?.noms_secondaires) return []
    return ephy.noms_secondaires.split('|').map(s => s.trim()).filter(Boolean)
      .filter(n => n.toLowerCase() !== (p.nom || '').trim().toLowerCase())
  }

  const produitMatches = produitQ.length > 0
    ? produits.filter(p => phytoMatches(p, produitQ) || secondaryNamesFor(p).some(n => n.toLowerCase().includes(produitQ.toLowerCase())))
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr')).slice(0, 10)
    : []

  // Une dose par entité : chaque entité avec une dose > 0 saisie obtient sa
  // propre ligne cp_lignes (entite_id renseigné) ; les autres n'en ont pas
  // (produit non utilisé chez elles). L'éventuelle ancienne ligne "toutes
  // entités" (entite_id NULL) de ce produit est supprimée une fois éclatée.
  async function saveLigne() {
    if (!editLigne.culture_id || !editLigne.produit_id) { alert('Culture et produit obligatoires.'); return }
    if (!entites.length) { alert("Créez d'abord au moins une entité (étape 1)."); return }
    const produit = produits.find(p => p.id === editLigne.produit_id)
    const nom = produit ? phytoDisplayName(produit) : (editLigne.produit_nom || '')
    const existingRows = lignes.filter(l => l.culture_id === editLigne.culture_id && l.produit_id === editLigne.produit_id)

    const results = []
    for (const e of entites) {
      const dose = parseFloat(editLigne.dosesByEntite?.[e.id])
      const existing = existingRows.find(l => l.entite_id === e.id)
      if (!dose || dose <= 0) {
        if (existing) await supabase.from('cp_lignes').delete().eq('id', existing.id)
        continue
      }
      const payload = { culture_id: editLigne.culture_id, produit_id: editLigne.produit_id, produit_nom: nom, entite_id: e.id, dose_ha: dose, unite: editLigne.unite, notes: editLigne.notes || null }
      if (existing) {
        const { error } = await supabase.from('cp_lignes').update(payload).eq('id', existing.id)
        if (error && /entite_id|column/i.test(error.message)) { showToast('⚠️ Dose par entité indisponible — exécute migration_A_EXECUTER_52.sql dans Supabase → SQL Editor.'); return }
        if (error) { alert(error.message); return }
        results.push({ ...existing, ...payload })
      } else {
        const { data, error } = await supabase.from('cp_lignes').insert({ ...payload, campagne }).select().single()
        if (error && /entite_id|column/i.test(error.message)) { showToast('⚠️ Dose par entité indisponible — exécute migration_A_EXECUTER_52.sql dans Supabase → SQL Editor.'); return }
        if (error) { alert(error.message); return }
        results.push(data)
      }
    }
    const legacyRow = existingRows.find(l => !l.entite_id)
    if (legacyRow) await supabase.from('cp_lignes').delete().eq('id', legacyRow.id)

    if (!results.length && !legacyRow) { alert('Renseignez au moins une dose pour une entité.'); return }
    setLignes(prev => [...prev.filter(l => !existingRows.some(er => er.id === l.id)), ...results])
    setEditLigne(null)
    showToast('✅ Doses enregistrées')
  }

  async function deleteLigne() {
    if (!confirm('Retirer ce produit (toutes entités) de la culture ?')) return
    const existingRows = lignes.filter(l => l.culture_id === editLigne.culture_id && l.produit_id === editLigne.produit_id)
    await supabase.from('cp_lignes').delete().in('id', existingRows.map(r => r.id))
    setLignes(prev => prev.filter(l => !existingRows.some(er => er.id === l.id)))
    setEditLigne(null)
    showToast('🗑️ Retiré')
  }

  function openNewLigne() {
    setEditLigne({ culture_id: selectedCulture, produit_id: '', produit_nom: '', unite: 'g/ha', notes: '', dosesByEntite: {} })
    setProduitQ('')
  }

  // Sélection d'un produit dans la recherche : deux effets attendus.
  // 1) Si retrouvé via un nom différent du nom principal (ex. on tape "AQUINO"
  //    qui n'est connu que côté EPHY comme équivalent de "QUESTAR"), on fixe ce
  //    nom comme nom_secondaire une bonne fois pour toutes — pour qu'il
  //    s'affiche durablement partout sans avoir à l'éditer à la main ensuite.
  // 2) Si ce produit a déjà des lignes de dose pour cette culture (cas d'un
  //    produit déjà suivi, juste retrouvé sous un autre nom), on reprend ces
  //    doses existantes au lieu de les laisser vides — sinon enregistrer sans
  //    y retoucher les effacerait (case vide = "retirer" dans saveLigne).
  async function pickProduit(p) {
    const q = produitQ.trim()
    let product = p
    if (q && !p.nom.toLowerCase().includes(q.toLowerCase()) && (p.nom_secondaire || '').trim().toLowerCase() !== q.toLowerCase()) {
      const matched = secondaryNamesFor(p).find(n => n.toLowerCase().includes(q.toLowerCase()))
      if (matched) {
        await supabase.from('db_phyto').update({ nom_secondaire: matched }).eq('id', p.id)
        product = { ...p, nom_secondaire: matched }
        setProduits(prev => prev.map(x => x.id === p.id ? product : x))
      }
    }
    const nom = phytoDisplayName(product)
    const existingRows = lignes.filter(l => l.culture_id === editLigne.culture_id && l.produit_id === product.id)
    const legacy = existingRows.find(l => !l.entite_id)
    const dosesByEntite = { ...editLigne.dosesByEntite }
    entites.forEach(e => {
      const specific = existingRows.find(l => l.entite_id === e.id)
      if (specific) dosesByEntite[e.id] = String(specific.dose_ha)
      else if (legacy && dosesByEntite[e.id] == null) dosesByEntite[e.id] = String(legacy.dose_ha)
    })
    setEditLigne(m => ({ ...m, produit_id: product.id, produit_nom: nom, dosesByEntite }))
    setProduitQ(nom)
    setShowProduitDd(false)
  }

  // Édition d'une seule case du tableau (produit × entité) — même logique que la
  // matrice des surfaces dans Cultures & Surfaces : on clique une case, on modifie
  // juste sa valeur. La ligne "toutes entités" historique (entite_id NULL) sert de
  // valeur par défaut tant qu'aucune dose spécifique n'a été saisie pour l'entité ;
  // elle n'est jamais supprimée automatiquement ici, seulement quand toutes les
  // entités ont fini par recevoir leur propre dose (cas géré par la création).
  const [editCell, setEditCell] = useState(null) // { produit_id, produit_nom, unite, entite_id, entite_nom, dose_ha, rowId }
  function openCell(group, entite) {
    const specific = group.rows.find(r => r.entite_id === entite.id)
    const legacy = group.rows.find(r => !r.entite_id)
    // Recalcule le nom depuis la fiche phyto actuelle (pas le texte figé enregistré
    // à l'époque) — ainsi, ressaisir une dose corrige aussi au passage un nom devenu
    // périmé (ex. nom_secondaire ajouté après coup sur la fiche produit).
    const ph = produits.find(p => p.id === group.produit_id)
    setEditCell({
      produit_id: group.produit_id, produit_nom: ph ? phytoDisplayName(ph) : group.produit_nom, unite: group.unite,
      entite_id: entite.id, entite_nom: entite.nom,
      dose_ha: specific ? String(specific.dose_ha) : (legacy ? String(legacy.dose_ha) : ''),
      rowId: specific?.id || null,
    })
  }
  async function saveCell() {
    const dose = parseFloat(editCell.dose_ha)
    const legacyRow = lignes.find(l => l.culture_id === selectedCulture && l.produit_id === editCell.produit_id && !l.entite_id)
    if (!dose || dose <= 0) {
      if (legacyRow) {
        // Une dose partagée "toutes entités" existe encore pour ce produit — sans
        // ligne spécifique à 0, cette entité continuerait à l'hériter et la case
        // semblerait ne pas s'être vidée. On écrit donc un 0 explicite juste pour
        // elle, sans toucher aux autres entités qui héritent encore du partagé.
        const payload = { culture_id: selectedCulture, produit_id: editCell.produit_id, produit_nom: editCell.produit_nom, entite_id: editCell.entite_id, dose_ha: 0, unite: editCell.unite, notes: legacyRow.notes || null }
        if (editCell.rowId) {
          await supabase.from('cp_lignes').update(payload).eq('id', editCell.rowId)
          setLignes(prev => prev.map(l => l.id === editCell.rowId ? { ...l, ...payload } : l))
        } else {
          const { data, error } = await supabase.from('cp_lignes').insert({ ...payload, campagne }).select().single()
          if (error) { alert(error.message); return }
          setLignes(prev => [...prev, data])
        }
      } else if (editCell.rowId) {
        await supabase.from('cp_lignes').delete().eq('id', editCell.rowId)
        setLignes(prev => prev.filter(l => l.id !== editCell.rowId))
      }
      setEditCell(null)
      showToast('✅ Dose retirée')
      return
    }
    const notes = lignes.find(l => l.culture_id === selectedCulture && l.produit_id === editCell.produit_id)?.notes || null
    const payload = { culture_id: selectedCulture, produit_id: editCell.produit_id, produit_nom: editCell.produit_nom, entite_id: editCell.entite_id, dose_ha: dose, unite: editCell.unite, notes }
    if (editCell.rowId) {
      const { error } = await supabase.from('cp_lignes').update(payload).eq('id', editCell.rowId)
      if (error) { alert(error.message); return }
      setLignes(prev => prev.map(l => l.id === editCell.rowId ? { ...l, ...payload } : l))
    } else {
      const { data, error } = await supabase.from('cp_lignes').insert({ ...payload, campagne }).select().single()
      if (error) { alert(error.message); return }
      setLignes(prev => [...prev, data])
    }
    setEditCell(null)
    showToast('✅ Dose mise à jour')
  }

  // Édition des infos partagées du produit (notes, unité) + suppression complète
  // (toutes entités) — séparée de la saisie des doses, qui se fait désormais
  // directement dans le tableau.
  const [editMeta, setEditMeta] = useState(null) // { produit_id, produit_nom, unite, notes }
  function openMeta(group) {
    const ph = produits.find(p => p.id === group.produit_id)
    setEditMeta({ produit_id: group.produit_id, produit_nom: ph ? phytoDisplayName(ph) : group.produit_nom, unite: group.unite || 'g/ha', notes: group.notes || '' })
  }
  async function saveMeta() {
    const rows = lignes.filter(l => l.culture_id === selectedCulture && l.produit_id === editMeta.produit_id)
    await Promise.all(rows.map(r => supabase.from('cp_lignes').update({ unite: editMeta.unite, notes: editMeta.notes || null }).eq('id', r.id)))
    setLignes(prev => prev.map(l => rows.some(r => r.id === l.id) ? { ...l, unite: editMeta.unite, notes: editMeta.notes || null } : l))
    setEditMeta(null)
    showToast('✅ Produit mis à jour')
  }
  async function deleteMeta() {
    if (!confirm('Retirer ce produit (toutes entités) de la culture ?')) return
    const rows = lignes.filter(l => l.culture_id === selectedCulture && l.produit_id === editMeta.produit_id)
    await supabase.from('cp_lignes').delete().in('id', rows.map(r => r.id))
    setLignes(prev => prev.filter(l => !rows.some(r => r.id === l.id)))
    setEditMeta(null)
    showToast('🗑️ Retiré')
  }
  // Suppression directe depuis le tableau (icône 🗑️ de la ligne), sans passer
  // par la modale — un clic + une confirmation suffisent.
  async function deleteProduitGroup(group) {
    const ph = produits.find(p => p.id === group.produit_id)
    const nom = ph ? phytoDisplayName(ph) : group.produit_nom
    if (!confirm(`Retirer "${nom}" (toutes entités) de cette culture ?`)) return
    const rows = lignes.filter(l => l.culture_id === selectedCulture && l.produit_id === group.produit_id)
    await supabase.from('cp_lignes').delete().in('id', rows.map(r => r.id))
    setLignes(prev => prev.filter(l => !rows.some(r => r.id === l.id)))
    showToast('🗑️ Retiré')
  }

  return (
    <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
      {/* Culture selector */}
      <div style={{ padding:'.8rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', gap:'.4rem', flexWrap:'wrap', alignItems:'center' }}>
        <span style={{ fontSize:'.82rem', color:'var(--text-muted)', marginRight:'.3rem' }}>Culture :</span>
        {cultures.map(c => (
          <button key={c.id} onClick={() => setSelectedCulture(c.id)} className="btn-sm"
            style={selectedCulture === c.id ? { background:'var(--green-mid)', color:'white', borderColor:'var(--green-mid)' } : {}}>
            {c.nom}
          </button>
        ))}
        {cultures.length === 0 && <span style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>Créez d'abord des cultures dans l'onglet précédent.</span>}
      </div>

      {/* Products for selected culture */}
      <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
        {selectedCulture && (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.9rem' }}>
              <div style={{ fontSize:'.9rem', fontWeight:600 }}>
                Produits pour {cultures.find(c => c.id === selectedCulture)?.nom}
                <span style={{ marginLeft:'.6rem', fontSize:'.75rem', color:'var(--text-muted)', fontWeight:400 }}>{produitGroups.length} produit(s)</span>
                {(() => {
                  const selNom = cultures.find(c => c.id === selectedCulture)?.nom?.trim().toUpperCase()
                  const merged = Object.entries(CULTURE_MERGE).filter(([, target]) => target === selNom).map(([source]) => source)
                  return merged.length > 0 && (
                    <span style={{ marginLeft:'.6rem', fontSize:'.72rem', color:'var(--amber)', fontWeight:600 }}>
                      ⓘ inclut aussi la surface {merged.join(', ')} dans les besoins
                    </span>
                  )
                })()}
              </div>
              <button className="btn-sm primary" onClick={openNewLigne}>
                + Ajouter un produit
              </button>
            </div>

            {produitGroups.length === 0 ? (
              <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
                Aucun produit phyto pour cette culture — cliquez "+ Ajouter un produit"
              </div>
            ) : (
              <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
                <table style={{ width:'100%', minWidth: 340 + entites.length * 110, fontSize:'.85rem', borderCollapse:'collapse' }}>
                  <thead style={{ background:'var(--cream)' }}>
                    <tr>
                      <th style={th}>Produit phyto</th>
                      <th style={th}>Substance active</th>
                      {entites.map(e => <th key={e.id} style={th}>{e.nom}</th>)}
                      <th style={th}>Notes</th>
                      <th style={th}></th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {produitGroups.map(g => {
                      const ph = produits.find(p => p.id === g.produit_id)
                      const secs = secondaryNamesFor(ph)
                      const legacy = g.rows.find(r => !r.entite_id)
                      return (
                        <tr key={g.produit_id}>
                          <td style={td}>
                            <strong>{ph ? phytoDisplayName(ph) : g.produit_nom}</strong>
                            {secs.length > 0 && <div style={{ fontSize:'.7rem', color:'var(--green-mid)', fontWeight:400 }}>🏷️ aussi : {secs.join(', ')}</div>}
                          </td>
                          <td style={{ ...td, fontSize:'.78rem', color:'var(--text-muted)' }}>{ph?.substance_active || '–'}</td>
                          {entites.map(e => {
                            const specific = g.rows.find(r => r.entite_id === e.id)
                            const dose = specific ? specific.dose_ha : legacy?.dose_ha
                            return (
                              <td key={e.id} style={{ ...td, textAlign:'center', cursor:'pointer' }}
                                onClick={() => openCell(g, e)}
                                onMouseEnter={ev => ev.currentTarget.style.background = 'var(--green-pale)'}
                                onMouseLeave={ev => ev.currentTarget.style.background = ''}>
                                {dose > 0
                                  ? <span style={{ fontWeight:700, color:'var(--green-mid)' }}>{dose} {g.unite}</span>
                                  : <span style={{ color:'var(--border)', fontSize:'.75rem' }}>+ ajouter</span>}
                              </td>
                            )
                          })}
                          <td style={{ ...td, fontSize:'.78rem', color:'var(--text-muted)' }}>{g.notes || '–'}</td>
                          <td style={{ ...td, color:'var(--green-accent)', cursor:'pointer' }} onClick={() => openMeta(g)} title="Modifier unité/notes">✏️</td>
                          <td style={{ ...td, color:'var(--red)', cursor:'pointer' }} onClick={() => deleteProduitGroup(g)} title="Retirer ce produit de la culture">🗑️</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal */}
      {editLigne && (() => {
        const isExisting = lignes.some(l => l.culture_id === editLigne.culture_id && l.produit_id === editLigne.produit_id)
        return (
        <Modal title={isExisting ? 'Modifier le produit' : 'Ajouter un produit phyto'} onClose={() => setEditLigne(null)} onSave={saveLigne} onDelete={isExisting ? deleteLigne : null} maxWidth={480}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            <div className="form-group" style={{ position:'relative' }}>
              <label>Produit phytosanitaire *</label>
              <input placeholder="🔍 Rechercher un produit (nom principal ou commercial)…" value={produitQ}
                onChange={e => { setProduitQ(e.target.value); setEditLigne({ ...editLigne, produit_id: '', produit_nom: '' }); setShowProduitDd(true) }}
                onFocus={() => setShowProduitDd(true)}
                onBlur={() => setTimeout(() => setShowProduitDd(false), 200)} />
              {showProduitDd && produitQ.length > 0 && (
                <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'white', border:'1px solid var(--border)', borderRadius:8, boxShadow:'var(--shadow-md)', zIndex:300, maxHeight:220, overflowY:'auto' }}>
                  {produitMatches.length === 0 && <div style={{ padding:'.6rem 1rem', fontSize:'.82rem', color:'var(--text-muted)' }}>Aucun produit ne correspond.</div>}
                  {produitMatches.map(p => {
                    const secs = secondaryNamesFor(p)
                    return (
                      <div key={p.id} onMouseDown={() => pickProduit(p)}
                        style={{ padding:'.55rem 1rem', cursor:'pointer', fontSize:'.84rem', borderBottom:'1px solid var(--border)' }}>
                        <strong>{phytoDisplayName(p)}</strong>{p.num_amm ? <span style={{ color:'var(--text-muted)' }}> ({p.num_amm})</span> : ''}
                        {secs.length > 0 && <div style={{ fontSize:'.72rem', color:'var(--green-mid)' }}>🏷️ aussi vendu sous : {secs.join(', ')}</div>}
                      </div>
                    )
                  })}
                </div>
              )}
              {editLigne.produit_id && (() => {
                const chosen = produits.find(p => p.id === editLigne.produit_id)
                const secs = secondaryNamesFor(chosen)
                return (
                  <div style={{ fontSize:'.75rem', color:'var(--green-mid)', marginTop:'.3rem' }}>
                    ✅ {phytoDisplayName(chosen)}{secs.length > 0 ? ` (aussi : ${secs.join(', ')})` : ''}
                  </div>
                )
              })()}
              {produits.length === 0 && <div style={{ fontSize:'.73rem', color:'var(--amber)', marginTop:'.2rem' }}>⚠️ Aucun produit dans la BDD phyto — ajoutez-en dans Base de données › Phytosanitaires.</div>}
            </div>
            <Fg label="Unité">
              <select value={editLigne.unite} onChange={e => setEditLigne({ ...editLigne, unite: e.target.value })}>
                {UNITES.map(u => <option key={u}>{u}</option>)}
              </select>
            </Fg>
            <div className="form-group">
              <label>Dose par hectare, par entité *</label>
              {entites.length === 0 ? (
                <div style={{ fontSize:'.78rem', color:'var(--amber)' }}>Aucune entité — créez-en d'abord dans l'étape 1.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'.4rem' }}>
                  {entites.map(e => (
                    <div key={e.id} style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
                      <span style={{ flex:1, fontSize:'.84rem' }}>{e.nom}</span>
                      <input type="number" step="0.001" min="0" style={{ width:110 }}
                        value={editLigne.dosesByEntite?.[e.id] ?? ''}
                        onChange={ev => setEditLigne({ ...editLigne, dosesByEntite: { ...editLigne.dosesByEntite, [e.id]: ev.target.value } })}
                        onKeyDown={ev => { if (ev.key === 'Enter') saveLigne() }}
                        placeholder="0" />
                    </div>
                  ))}
                </div>
              )}
              <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:'.4rem' }}>Laisser vide (ou 0) pour une entité qui n'utilise pas ce produit.</div>
            </div>
            <Fg label="Notes"><input value={editLigne.notes || ''} onChange={e => setEditLigne({ ...editLigne, notes: e.target.value })} placeholder="ex. Traitement herbicide pré-levée" /></Fg>
          </div>
        </Modal>
        )
      })()}

      {/* Case du tableau : dose d'un produit pour une entité précise */}
      {editCell && (
        <Modal title={`${editCell.produit_nom} — ${editCell.entite_nom}`} onClose={() => setEditCell(null)} onSave={saveCell} maxWidth={340}>
          <Fg label={`Dose par hectare (${editCell.unite})`}>
            <input autoFocus type="number" step="0.001" min="0" value={editCell.dose_ha}
              onChange={e => setEditCell({ ...editCell, dose_ha: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') saveCell() }} placeholder="ex. 1.5" />
          </Fg>
          <div style={{ fontSize:'.75rem', color:'var(--text-muted)', marginTop:'.4rem' }}>Mettre 0 pour retirer ce produit de cette entité.</div>
        </Modal>
      )}

      {/* Infos partagées du produit (notes, unité) + suppression complète */}
      {editMeta && (
        <Modal title={`Modifier — ${editMeta.produit_nom}`} onClose={() => setEditMeta(null)} onSave={saveMeta} onDelete={deleteMeta} maxWidth={400}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            <Fg label="Unité">
              <select value={editMeta.unite} onChange={e => setEditMeta({ ...editMeta, unite: e.target.value })}>
                {UNITES.map(u => <option key={u}>{u}</option>)}
              </select>
            </Fg>
            <Fg label="Notes"><input value={editMeta.notes} onChange={e => setEditMeta({ ...editMeta, notes: e.target.value })} placeholder="ex. Traitement herbicide pré-levée" /></Fg>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ══════════════════════════════════════════════════
   TAB 3 — BESOINS CALCULÉS
══════════════════════════════════════════════════ */
function TabBesoins({ cultures, entites, surfaces, lignes, produits }) {
  // For each produit × entité : sum(dose_ha × surface_ha) across all cultures
  const getBesoins = useCallback(() => {
    // Cultures fusionnées (ex. ORH → ORP) : la surface de la culture source s'ajoute
    // à celle de la culture cible, même si les produits ne sont saisis que sur la cible.
    const mergedInto = {} // targetCultureId -> [sourceCultureId, ...]
    cultures.forEach(c => {
      const target = CULTURE_MERGE[c.nom.trim().toUpperCase()]
      if (!target) return
      const targetCulture = cultures.find(x => x.nom.trim().toUpperCase() === target)
      if (targetCulture) (mergedInto[targetCulture.id] ??= []).push(c.id)
    })
    const surfaceFor = (cultureId, entiteId) => {
      const ids = [cultureId, ...(mergedInto[cultureId] || [])]
      return ids.reduce((s, cid) => {
        const surf = surfaces.find(x => x.culture_id === cid && x.entite_id === entiteId)
        return s + (surf?.surface_ha || 0)
      }, 0)
    }
    // Dose d'un produit sur une culture, pour une entité donnée : sa propre ligne
    // (entite_id) si elle existe, sinon la ligne "toutes entités" historique
    // (entite_id NULL) — jamais les deux, et jamais la dose d'une autre entité.
    const doseFor = (cultureId, produitId, entiteId) => {
      const rows = lignes.filter(l => l.culture_id === cultureId && l.produit_id === produitId)
      const specific = rows.find(l => l.entite_id === entiteId)
      if (specific) return specific.dose_ha || 0
      return rows.find(l => !l.entite_id)?.dose_ha || 0
    }
    // Group lignes by produit
    const produitIds = [...new Set(lignes.map(l => l.produit_id))]
    return produitIds.map(pid => {
      const ligne = lignes.find(l => l.produit_id === pid)
      const ph    = produits.find(p => p.id === pid)
      const cultureIds = [...new Set(lignes.filter(l => l.produit_id === pid).map(l => l.culture_id))]
      const byEntite = {}
      entites.forEach(e => {
        let total = 0
        cultureIds.forEach(cid => { total += doseFor(cid, pid, e.id) * surfaceFor(cid, e.id) })
        byEntite[e.id] = total
      })
      const totalGlobal = Object.values(byEntite).reduce((s, v) => s + v, 0)
      return { produit_id: pid, produit_nom: ph ? phytoDisplayName(ph) : (ligne?.produit_nom || '–'), unite: ligne?.unite || '', byEntite, totalGlobal }
    }).filter(r => r.totalGlobal > 0).sort((a, b) => a.produit_nom.localeCompare(b.produit_nom, 'fr'))
  }, [lignes, surfaces, entites, produits, cultures])

  const besoins = getBesoins()

  if (besoins.length === 0) return (
    <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:'2.5rem', marginBottom:'.8rem' }}>📊</div>
        <p>Aucun besoin calculé. Saisissez des surfaces et des produits phyto d'abord.</p>
      </div>
    </div>
  )

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
      <div style={{ marginBottom:'.8rem', fontSize:'.82rem', color:'var(--text-muted)' }}>
        Besoins calculés automatiquement : dose/ha × surface de chaque entité pour chaque produit.
      </div>
      <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
        <table style={{ width:'100%', minWidth: 160 + entites.length * 120, fontSize:'.84rem', borderCollapse:'collapse' }}>
          <thead style={{ background:'var(--cream)' }}>
            <tr>
              <th style={th}>Produit</th>
              {entites.map(e => <th key={e.id} style={th}>{e.nom}</th>)}
              <th style={{ ...th, color:'var(--green-mid)' }}>Total à commander</th>
              <th style={th}>Unité</th>
            </tr>
          </thead>
          <tbody>
            {besoins.map(b => (
              <tr key={b.produit_id}>
                <td style={{ ...td, fontWeight:600 }}>{b.produit_nom}</td>
                {entites.map(e => (
                  <td key={e.id} style={{ ...td, textAlign:'center' }}>
                    {b.byEntite[e.id] > 0 ? <span>{b.byEntite[e.id].toFixed(2)}</span> : <span style={{ color:'var(--border)' }}>–</span>}
                  </td>
                ))}
                <td style={{ ...td, textAlign:'center', fontWeight:700, color:'var(--green-mid)', fontSize:'1rem' }}>
                  {b.totalGlobal.toFixed(2)}
                </td>
                <td style={{ ...td, color:'var(--text-muted)' }}>{b.unite}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════
   TAB 4 — OFFRES FOURNISSEURS
══════════════════════════════════════════════════ */
function TabFournisseurs({ lignes, produits, offres, setOffres, surfaces, entites, showToast, campagne, reload }) {
  const [editOffre, setEditOffre] = useState(null)

  const nomFor = pid => {
    const ph = produits.find(p => p.id === pid)
    return ph ? phytoDisplayName(ph) : (lignes.find(l => l.produit_id === pid)?.produit_nom || '')
  }
  const produitIds = [...new Set(lignes.map(l => l.produit_id))].sort((a, b) => nomFor(a).localeCompare(nomFor(b), 'fr'))

  // Compute best price per produit
  function bestOffre(pid) {
    const list = offres.filter(o => o.produit_id === pid)
    if (!list.length) return null
    return list.reduce((best, o) => (!best || o.prix_unitaire < best.prix_unitaire) ? o : best, null)
  }

  async function saveOffre() {
    if (!editOffre.produit_id || !editOffre.fournisseur?.trim()) { alert('Produit et fournisseur obligatoires.'); return }
    const payload = { ...editOffre, prix_unitaire: parseFloat(editOffre.prix_unitaire) || null }
    delete payload.created_at
    if (editOffre.id) {
      const { error } = await supabase.from('cp_offres').update(payload).eq('id', editOffre.id)
      if (error) { alert(error.message); return }
      setOffres(prev => prev.map(o => o.id === editOffre.id ? { ...o, ...payload } : o))
    } else {
      const { data, error } = await supabase.from('cp_offres').insert({ ...payload, campagne }).select().single()
      if (error) { alert(error.message); return }
      setOffres(prev => [...prev, data])
    }
    setEditOffre(null)
    showToast('✅ Offre enregistrée')
  }

  async function deleteOffre() {
    if (!confirm('Supprimer cette offre ?')) return
    await supabase.from('cp_offres').delete().eq('id', editOffre.id)
    setOffres(prev => prev.filter(o => o.id !== editOffre.id))
    setEditOffre(null)
    showToast('🗑️ Offre supprimée')
  }

  // Toggle selection — valider une offre met aussi à jour le prix de référence
  // du produit dans Base de données, pour ne pas avoir à le ressaisir à la main.
  async function toggleSelect(offre) {
    const newVal = !offre.selectionne
    await supabase.from('cp_offres').update({ selectionne: newVal }).eq('id', offre.id)
    setOffres(prev => prev.map(o => {
      if (o.produit_id === offre.produit_id) return { ...o, selectionne: o.id === offre.id ? newVal : false }
      return o
    }))
    if (newVal && offre.prix_unitaire != null) {
      await supabase.from('db_phyto').update({ prix_unitaire: offre.prix_unitaire }).eq('id', offre.produit_id)
      showToast(`💶 Prix mis à jour dans Base de données (${offre.prix_unitaire} €)`)
      reload?.()
    }
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
      {produitIds.length === 0 ? (
        <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)' }}>
          Ajoutez des produits phyto aux cultures d'abord (étape 2).
        </div>
      ) : (
        <>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem', flexWrap:'wrap', gap:'.7rem' }}>
            <div style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
              Saisissez les prix de chaque fournisseur pour chaque produit. Le moins cher est mis en avant automatiquement. Sélectionnez le fournisseur retenu.
            </div>
            <button className="btn-sm primary" onClick={() => setEditOffre({ produit_id: '', fournisseur: '', prix_unitaire: '', unite: '', reference_fournisseur: '' })} style={{ flexShrink:0 }}>
              + Ajouter une offre
            </button>
          </div>

          {produitIds.map(pid => {
            const ph     = produits.find(p => p.id === pid)
            const ligne  = lignes.find(l => l.produit_id === pid)
            const produitLignes = lignes.filter(l => l.produit_id === pid)
            const doses = [...new Set(produitLignes.map(l => l.dose_ha))]
            const doseLabel = doses.length <= 1 ? `${ligne?.dose_ha ?? ''} ${ligne?.unite || ''}/ha` : `Variable selon entité (${ligne?.unite || ''}/ha)`
            const list   = offres.filter(o => o.produit_id === pid).sort((a, b) => (a.prix_unitaire || 999999) - (b.prix_unitaire || 999999))
            const best   = bestOffre(pid)
            const selected = list.find(o => o.selectionne)

            return (
              <div key={pid} style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem 1.2rem', marginBottom:'1rem' }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.8rem', flexWrap:'wrap', gap:'.5rem' }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:'.92rem' }}>{ph ? phytoDisplayName(ph) : ligne?.produit_nom}</div>
                    <div style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>
                      {ph?.substance_active && `${ph.substance_active} — `}{doseLabel}
                    </div>
                  </div>
                  {selected && (
                    <span style={{ fontSize:'.75rem', background:'var(--green-pale)', color:'var(--green-mid)', fontWeight:700, padding:'.2rem .7rem', borderRadius:50 }}>
                      ✅ {selected.fournisseur} — {selected.prix_unitaire} €/{selected.unite || ligne?.unite}
                    </span>
                  )}
                </div>

                {list.length === 0 ? (
                  <button className="btn-sm" onClick={() => setEditOffre({ produit_id: pid, fournisseur:'', prix_unitaire:'', unite: ligne?.unite || '', reference_fournisseur:'' })} style={{ fontSize:'.78rem' }}>
                    + Ajouter une offre pour ce produit
                  </button>
                ) : (
                  <div style={{ overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
                  <table style={{ width:'100%', minWidth:700, fontSize:'.82rem', borderCollapse:'collapse' }}>
                    <thead>
                      <tr>
                        {['Fournisseur','Réf. fournisseur','Prix unitaire','Unité','Comparaison','Retenir',''].map(h =>
                          <th key={h} style={{ ...th, background:'var(--cream)' }}>{h}</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {list.map(o => {
                        const isBest = best && o.id === best.id
                        const isSelected = o.selectionne
                        return (
                          <tr key={o.id}
                            style={{ background: isSelected ? '#f0fdf0' : isBest ? '#f9fefb' : 'white' }}>
                            <td style={td}><strong>{o.fournisseur}</strong></td>
                            <td style={{ ...td, color:'var(--text-muted)' }}>{o.reference_fournisseur || '–'}</td>
                            <td style={{ ...td, fontWeight:700, color: isBest ? 'var(--green-mid)' : 'inherit', fontSize: isBest ? '1rem' : 'inherit' }}>
                              {o.prix_unitaire != null ? `${o.prix_unitaire} €` : '–'}
                            </td>
                            <td style={td}>{o.unite || ligne?.unite}</td>
                            <td style={td}>
                              {isBest ? <span style={{ color:'var(--green-mid)', fontWeight:700 }}>🏆 Moins cher</span>
                                : best?.prix_unitaire && o.prix_unitaire
                                  ? <span style={{ color:'var(--text-muted)', fontSize:'.75rem' }}>+{((o.prix_unitaire - best.prix_unitaire) / best.prix_unitaire * 100).toFixed(1)}%</span>
                                  : '–'}
                            </td>
                            <td style={{ ...td, textAlign:'center' }}>
                              <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(o)} style={{ width:16, height:16, accentColor:'var(--green-accent)' }} />
                            </td>
                            <td style={td}>
                              <button onClick={() => setEditOffre({ ...o })} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)' }}>✏️</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
                {list.length > 0 && (
                  <button className="btn-sm" onClick={() => setEditOffre({ produit_id: pid, fournisseur:'', prix_unitaire:'', unite: ligne?.unite || '', reference_fournisseur:'' })} style={{ fontSize:'.78rem', marginTop:'.7rem' }}>
                    + Ajouter une autre offre pour ce produit
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* Modal */}
      {editOffre && (
        <Modal title={editOffre.id ? 'Modifier l\'offre' : 'Nouvelle offre fournisseur'} onClose={() => setEditOffre(null)} onSave={saveOffre} onDelete={editOffre.id ? deleteOffre : null} maxWidth={460}>
          <div style={{ display:'grid', gap:'.8rem' }}>
            {!editOffre.id && (
              <div className="form-group">
                <label>Produit *</label>
                <select value={editOffre.produit_id} onChange={e => setEditOffre({ ...editOffre, produit_id: e.target.value })}>
                  <option value="">— Choisir —</option>
                  {produitIds.map(pid => {
                    const l = lignes.find(x => x.produit_id === pid)
                    const ph = produits.find(p => p.id === pid)
                    return <option key={pid} value={pid}>{ph ? phytoDisplayName(ph) : (l?.produit_nom || pid)}</option>
                  })}
                </select>
              </div>
            )}
            <Fg label="Fournisseur *"><input autoFocus value={editOffre.fournisseur} onChange={e => setEditOffre({ ...editOffre, fournisseur: e.target.value })} placeholder="Nom du fournisseur" /></Fg>
            <Fg label="Référence fournisseur"><input value={editOffre.reference_fournisseur || ''} onChange={e => setEditOffre({ ...editOffre, reference_fournisseur: e.target.value })} /></Fg>
            <div style={{ display:'grid', gridTemplateColumns:'2fr 1fr', gap:'.7rem' }}>
              <Fg label="Prix unitaire (€)"><input type="number" step="0.01" value={editOffre.prix_unitaire} onChange={e => setEditOffre({ ...editOffre, prix_unitaire: e.target.value })} /></Fg>
              <Fg label="Unité"><input value={editOffre.unite || ''} onChange={e => setEditOffre({ ...editOffre, unite: e.target.value })} placeholder="L, kg…" /></Fg>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

// Seules ces entités ont un stock propre (achètent/reçoivent les produits) — les autres
// entités n'en ont pas, mais leur surface compte quand même dans le besoin total : leur
// quantité est reportée sur l'entité par défaut ci-dessous plutôt que de leur être
// attribuée à elles-mêmes.
const ENTITES_AVEC_STOCK = new Set(['EARL MILLARD', 'SARL ROPAMIL', 'SCEA FERME DES BOIS', 'SCEA MILLARD-TISSERANT'])
const ENTITE_SANS_STOCK_PAR_DEFAUT = 'SARL ROPAMIL'
const normNomEntite = nom => (nom || '').trim().toUpperCase()

/* ══════════════════════════════════════════════════
   TAB 5 — RÉPARTITION & IMPRESSION
══════════════════════════════════════════════════ */
function TabRepartition({ cultures, entites, surfaces, lignes, produits, offres, campagne }) {
  const [prioritaire, setPrioritaire] = useState([]) // entite ids to prioritize

  // Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
  // plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
  // popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
  // toujours le vrai dialogue d'impression natif — même pattern que
  // ConfirmationAchat (Planning.jsx) et printFiche (CoutRevient.jsx).
  const [printTarget, setPrintTarget] = useState(null) // { type: 'entite'|'fournisseur', data } | null
  useEffect(() => {
    if (!printTarget) return
    document.body.classList.add('printing-active')
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrintTarget(null)
    }
    window.addEventListener('afterprint', onAfterPrint)
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printTarget])

  // Build full repartition table
  const produitIds = [...new Set(lignes.map(l => l.produit_id))]
  const entiteParDefaut = entites.find(e => normNomEntite(e.nom) === ENTITE_SANS_STOCK_PAR_DEFAUT)

  const repartition = produitIds.map(pid => {
    const ligne    = lignes.find(l => l.produit_id === pid)
    const ph       = produits.find(p => p.id === pid)
    const selected = offres.find(o => o.produit_id === pid && o.selectionne)
    const best     = offres.filter(o => o.produit_id === pid).sort((a, b) => (a.prix_unitaire || 999) - (b.prix_unitaire || 999))[0]
    const offre    = selected || best

    const cultureIds = [...new Set(lignes.filter(l => l.produit_id === pid).map(l => l.culture_id))]
    // Besoin brut par entité (dose × sa propre surface), avant report des entités sans stock.
    const qteBrute = {}
    entites.forEach(e => {
      let qte = 0
      cultureIds.forEach(cid => {
        const rows = lignes.filter(l => l.culture_id === cid && l.produit_id === pid)
        const dose = (rows.find(l => l.entite_id === e.id) || rows.find(l => !l.entite_id))?.dose_ha || 0
        const s = surfaces.find(x => x.culture_id === cid && x.entite_id === e.id)
        if (s) qte += dose * (s.surface_ha || 0)
      })
      qteBrute[e.id] = qte
    })
    // Les entités sans stock propre n'apparaissent pas comme destinataires : leur besoin
    // (calculé sur leur surface) est intégralement reporté sur l'entité par défaut.
    if (entiteParDefaut) {
      entites.forEach(e => {
        if (e.id === entiteParDefaut.id || ENTITES_AVEC_STOCK.has(normNomEntite(e.nom))) return
        qteBrute[entiteParDefaut.id] += qteBrute[e.id]
        qteBrute[e.id] = 0
      })
    }
    const byEntite = {}
    entites.forEach(e => {
      const qte = qteBrute[e.id] || 0
      byEntite[e.id] = { qte: +qte.toFixed(3), montant: offre?.prix_unitaire ? +(qte * offre.prix_unitaire).toFixed(2) : null }
    })

    const totalQte  = Object.values(byEntite).reduce((s, v) => s + v.qte, 0)
    const totalMontant = offre?.prix_unitaire ? +(totalQte * offre.prix_unitaire).toFixed(2) : null

    return { pid, nom: ph ? phytoDisplayName(ph) : (ligne?.produit_nom || '–'), unite: ligne?.unite, offre, byEntite, totalQte, totalMontant }
  }).filter(r => r.totalQte > 0).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))

  function togglePrioritaire(eid) {
    setPrioritaire(prev => prev.includes(eid) ? prev.filter(x => x !== eid) : [...prev, eid])
  }

  function printEntite(entite) {
    setPrintTarget({ type: 'entite', data: entite })
  }

  function printFournisseur(fournisseur) {
    setPrintTarget({ type: 'fournisseur', data: fournisseur })
  }

  const fournisseurs = [...new Set(repartition.map(r => r.offre?.fournisseur).filter(Boolean))]
  const totalGlobal  = repartition.reduce((s, r) => s + (r.totalMontant || 0), 0)

  // Données du document imprimable — recalculées à la volée à partir du même
  // state que l'écran, utilisées uniquement par la zone .print-area ci-dessous.
  const printEntiteObj      = printTarget?.type === 'entite' ? printTarget.data : null
  const printFournisseurNom = printTarget?.type === 'fournisseur' ? printTarget.data : null
  const printEntiteLines      = printEntiteObj ? repartition.filter(r => r.byEntite[printEntiteObj.id]?.qte > 0) : []
  const printEntiteTotal      = printEntiteLines.reduce((s, r) => s + (r.byEntite[printEntiteObj?.id]?.montant || 0), 0)
  const printFournisseurLines = printFournisseurNom ? repartition.filter(r => r.offre?.fournisseur === printFournisseurNom) : []
  const printFournisseurTotal = printFournisseurLines.reduce((s, r) => s + (r.totalMontant || 0), 0)
  const printTh = { padding:'8px 10px', border:'1px solid #dde8de', fontSize:12, background:'#e8f5e9', fontWeight:600, textAlign:'left' }
  const printTd = { padding:'8px 10px', border:'1px solid #dde8de', fontSize:12 }

  if (repartition.length === 0) return (
    <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:'2.5rem', marginBottom:'.8rem' }}>🖨️</div>
        <p>Complétez les étapes précédentes pour générer la répartition.</p>
      </div>
    </div>
  )

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
      {/* KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(180px,1fr))', gap:'.8rem', marginBottom:'1.2rem' }}>
        <KpiCard label="Produits à commander" value={repartition.length} color="var(--green-mid)" />
        <KpiCard label="Fournisseurs retenus" value={fournisseurs.length} color="var(--blue)" />
        <KpiCard label="Total HT estimé" value={totalGlobal.toFixed(2) + ' €'} color="var(--amber)" />
        <KpiCard label="Entités concernées" value={entites.length} color="var(--green-accent)" />
      </div>

      {/* Répartition table */}
      <div style={{ marginBottom:'1.2rem' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.7rem' }}>
          <div style={sectionLabel}>Répartition par entité</div>
          <div style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>
            Priorité de répartition :
            {entites.map(e => (
              <label key={e.id} style={{ marginLeft:'.6rem', cursor:'pointer', fontWeight: prioritaire.includes(e.id) ? 700 : 400, color: prioritaire.includes(e.id) ? 'var(--green-mid)' : 'inherit' }}>
                <input type="checkbox" checked={prioritaire.includes(e.id)} onChange={() => togglePrioritaire(e.id)} style={{ marginRight:'.3rem' }} />
                {e.nom}
              </label>
            ))}
          </div>
        </div>
        <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflow:'auto' }}>
          <table style={{ width:'100%', fontSize:'.82rem', borderCollapse:'collapse', minWidth:700 }}>
            <thead style={{ background:'var(--cream)' }}>
              <tr>
                <th style={th}>Produit</th>
                <th style={th}>Fournisseur</th>
                {entites.map(e => (
                  <th key={e.id} style={{ ...th, background: prioritaire.includes(e.id) ? 'var(--green-pale)' : 'var(--cream)', color: prioritaire.includes(e.id) ? 'var(--green-mid)' : 'var(--text-muted)' }}>
                    {e.nom}{prioritaire.includes(e.id) ? ' ★' : ''}
                  </th>
                ))}
                <th style={{ ...th, color:'var(--green-mid)' }}>Total</th>
                <th style={th}>Montant HT</th>
              </tr>
            </thead>
            <tbody>
              {repartition.map(r => (
                <tr key={r.pid}>
                  <td style={{ ...td, fontWeight:600 }}>{r.nom}</td>
                  <td style={{ ...td, fontSize:'.76rem', color:'var(--text-muted)' }}>{r.offre?.fournisseur || <span style={{ color:'var(--red)' }}>⚠️ Non sélectionné</span>}</td>
                  {entites.map(e => {
                    const d = r.byEntite[e.id]
                    return (
                      <td key={e.id} style={{ ...td, textAlign:'center', background: prioritaire.includes(e.id) ? '#fafff8' : 'white' }}>
                        {d.qte > 0 ? <span style={{ fontWeight:600 }}>{d.qte} {r.unite}</span> : <span style={{ color:'var(--border)' }}>–</span>}
                        {d.montant != null && d.qte > 0 && <div style={{ fontSize:'.68rem', color:'var(--text-muted)' }}>{d.montant} €</div>}
                      </td>
                    )
                  })}
                  <td style={{ ...td, textAlign:'center', fontWeight:700, color:'var(--green-mid)' }}>{r.totalQte.toFixed(2)} {r.unite}</td>
                  <td style={{ ...td, textAlign:'right', fontWeight:700 }}>{r.totalMontant != null ? r.totalMontant.toFixed(2) + ' €' : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Impressions */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:'1rem' }}>
        {/* Par entité */}
        <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem 1.2rem' }}>
          <div style={sectionLabel}>Imprimer par entité</div>
          <div style={{ display:'flex', flexDirection:'column', gap:'.5rem', marginTop:'.6rem' }}>
            {entites.map(e => {
              const lines = repartition.filter(r => r.byEntite[e.id]?.qte > 0)
              const total = lines.reduce((s, r) => s + (r.byEntite[e.id]?.montant || 0), 0)
              return (
                <div key={e.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'.5rem .7rem', background:'var(--cream)', borderRadius:8 }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:'.85rem' }}>{e.nom}</div>
                    <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{lines.length} produit(s) — {total.toFixed(2)} € HT</div>
                  </div>
                  <button className="btn-sm" onClick={() => printEntite(e)} style={{ fontSize:'.75rem', padding:'.35rem .7rem' }}>🖨️ Imprimer</button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Par fournisseur */}
        <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem 1.2rem' }}>
          <div style={sectionLabel}>Bons de commande par fournisseur</div>
          {fournisseurs.length === 0 ? (
            <div style={{ fontSize:'.82rem', color:'var(--text-muted)', marginTop:'.6rem' }}>Aucun fournisseur sélectionné — retournez à l'étape 4.</div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'.5rem', marginTop:'.6rem' }}>
              {fournisseurs.map(f => {
                const lines  = repartition.filter(r => r.offre?.fournisseur === f)
                const total  = lines.reduce((s, r) => s + (r.totalMontant || 0), 0)
                return (
                  <div key={f} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'.5rem .7rem', background:'var(--cream)', borderRadius:8 }}>
                    <div>
                      <div style={{ fontWeight:600, fontSize:'.85rem' }}>{f}</div>
                      <div style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{lines.length} produit(s) — {total.toFixed(2)} € HT</div>
                    </div>
                    <button className="btn-sm" onClick={() => printFournisseur(f)} style={{ fontSize:'.75rem', padding:'.35rem .7rem' }}>🖨️ Bon de commande</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Zone imprimable — invisible à l'écran, seule visible sur le document
          imprimé/PDF (voir .print-area dans index.css). */}
      {printTarget && (
        <div className="print-area" style={{ fontFamily:'Arial,sans-serif', padding:44, color:'#1a2e1c', fontSize:13 }}>
          <div style={{ fontSize:24, fontWeight:'bold', color:'#4a9050', marginBottom:2 }} dangerouslySetInnerHTML={{ __html: printLogoHtml() }} />
          {printTarget.type === 'entite' ? (
            <>
              <div style={{ fontSize:10, color:'#888', marginBottom:28 }}>COMMANDE PHYTOSANITAIRE — CAMPAGNE {campagne}</div>
              <h1 style={{ fontSize:18, borderBottom:'2px solid #4a9050', paddingBottom:8, marginBottom:20 }}>{printEntiteObj.nom}</h1>
              <table style={{ width:'100%', borderCollapse:'collapse', marginBottom:24 }}>
                <thead>
                  <tr>
                    {['Produit','Substance active','Fournisseur','Réf. fournisseur','Quantité','Unité','Prix unit. (€)','Montant HT (€)'].map(h => (
                      <th key={h} style={printTh}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {printEntiteLines.map(r => {
                    const d  = r.byEntite[printEntiteObj.id]
                    const ph = produits.find(p => p.produit_id === r.pid || p.id === r.pid)
                    return (
                      <tr key={r.pid}>
                        <td style={printTd}><strong>{r.nom}</strong></td>
                        <td style={{ ...printTd, color:'#6b7c6d', fontSize:11 }}>{ph?.substance_active || '–'}</td>
                        <td style={printTd}>{r.offre?.fournisseur || '–'}</td>
                        <td style={printTd}>{r.offre?.reference_fournisseur || '–'}</td>
                        <td style={{ ...printTd, fontWeight:'bold' }}>{d.qte}</td>
                        <td style={printTd}>{r.unite || ''}</td>
                        <td style={printTd}>{r.offre?.prix_unitaire != null ? r.offre.prix_unitaire : '–'}</td>
                        <td style={{ ...printTd, fontWeight:'bold' }}>{d.montant != null ? d.montant : '–'}</td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td style={{ ...printTd, background:'#f0fdf0', fontWeight:'bold' }} colSpan={7}>Total HT</td>
                    <td style={{ ...printTd, background:'#f0fdf0', fontWeight:'bold' }}>{printEntiteTotal.toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : (
            <>
              <div style={{ fontSize:10, color:'#888', marginBottom:28 }}>BON DE COMMANDE PHYTOSANITAIRE — CAMPAGNE {campagne}</div>
              <h1 style={{ fontSize:18, borderBottom:'2px solid #4a9050', paddingBottom:8, marginBottom:20 }}>Fournisseur : {printFournisseurNom}</h1>
              <table style={{ width:'100%', borderCollapse:'collapse', marginBottom:16 }}>
                <thead>
                  <tr>
                    {['Produit','Réf.','Qté totale','Unité','Prix unit. (€)','Montant HT (€)'].map(h => (
                      <th key={h} style={printTh}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {printFournisseurLines.map(r => (
                    <tr key={r.pid}>
                      <td style={printTd}><strong>{r.nom}</strong></td>
                      <td style={printTd}>{r.offre?.reference_fournisseur || '–'}</td>
                      <td style={{ ...printTd, fontWeight:'bold' }}>{r.totalQte.toFixed(3)}</td>
                      <td style={printTd}>{r.unite || ''}</td>
                      <td style={printTd}>{r.offre?.prix_unitaire != null ? r.offre.prix_unitaire : '–'}</td>
                      <td style={{ ...printTd, fontWeight:'bold' }}>{r.totalMontant != null ? r.totalMontant : '–'}</td>
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...printTd, background:'#f0fdf0', fontWeight:'bold' }} colSpan={5}>Total HT</td>
                    <td style={{ ...printTd, background:'#f0fdf0', fontWeight:'bold' }}>{printFournisseurTotal.toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
          <div style={{ marginTop:32, fontSize:10, color:'#aaa', borderTop:'1px solid #dde8de', paddingTop:8, textAlign:'center' }}>
            Document généré le {new Date().toLocaleDateString('fr-FR')} · Commande phyto {campagne}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Helpers ── */
function Panel({ title, children, onAdd }) {
  return (
    <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflow:'hidden' }}>
      <div style={{ padding:'.8rem 1rem', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center', background:'var(--cream)' }}>
        <div style={{ fontWeight:700, fontSize:'.88rem' }}>{title}</div>
        <button className="btn-sm primary" onClick={onAdd} style={{ padding:'.3rem .7rem', fontSize:'.75rem' }}>+ Ajouter</button>
      </div>
      <div style={{ padding:'.6rem' }}>{children}</div>
    </div>
  )
}

function PanelItem({ label, onEdit }) {
  return (
    <div onClick={onEdit} style={{ padding:'.5rem .7rem', borderRadius:7, cursor:'pointer', fontSize:'.85rem', fontWeight:500, display:'flex', justifyContent:'space-between', alignItems:'center' }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}>
      {label}<span style={{ fontSize:'.75rem', color:'var(--text-muted)' }}>✏️</span>
    </div>
  )
}

function Empty({ children }) {
  return <div style={{ padding:'.8rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.8rem', fontStyle:'italic' }}>{children}</div>
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1rem', textAlign:'center', borderTop:`3px solid ${color}` }}>
      <div style={{ fontSize:'.7rem', textTransform:'uppercase', letterSpacing:'.05em', color:'var(--text-muted)', marginBottom:'.3rem' }}>{label}</div>
      <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.5rem', color }}>{value}</div>
    </div>
  )
}

const th = { padding:'.65rem .9rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em', color:'var(--text-muted)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }
const td = { padding:'.65rem .9rem', borderBottom:'1px solid var(--border)' }
const sectionLabel = { fontSize:'.75rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', marginBottom:'.4rem' }
