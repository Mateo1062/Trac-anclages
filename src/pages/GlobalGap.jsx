import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import { logCongeHistorique } from '../lib/congesHistorique'
import useIsMobile from '../lib/useIsMobile'
import { fmtDate } from '../lib/formatDate'

/* ─────────────────────────────────────────────────────────
   Global GAP
   Tab 1 : Registre des salariés (nom, prénom, rôle, entité,
           téléphone, formations/habilitations)
   Tab 2 : Organigramme interactif (hiérarchie visuelle)
───────────────────────────────────────────────────────── */

const ENTITES = ['Groupe Millard','EARL Nord','SCEA Est','GAEC Sud','SAS Logistics','Autre']
const TYPES_FORMATION = ['Certiphyto','CACES R489','CACES R490','SST','Habilitation électrique','Permis PL','HACCP','Autre']

// Plusieurs responsables hiérarchiques possibles par salarié — nouvelle colonne
// superieur_ids (tableau), avec repli sur l'ancienne superieur_id (unique) pour
// les fiches jamais ré-enregistrées depuis l'ajout de cette fonctionnalité.
function getSupIds(rec) {
  if (Array.isArray(rec?.superieur_ids) && rec.superieur_ids.length) return rec.superieur_ids
  if (rec?.superieur_id) return [rec.superieur_id]
  return []
}

export default function GlobalGap() {
  const [tab, setTab] = useState('salaries')
  const { showToast, ToastEl } = useToast()
  const [salaries, setSalaries] = useState([])
  const [formations, setFormations] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: s }, { data: f }] = await Promise.all([
      supabase.from('salaries').select('*').order('nom'),
      supabase.from('formations').select('*').order('date_expiration'),
    ])
    setSalaries(s || [])
    setFormations(f || [])
    setLoading(false)
  }

  if (loading) return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {ToastEl}
      {/* Tabs */}
      <div style={{ background:'white', borderBottom:'2px solid var(--border)', padding:'0 1.5rem', display:'flex', gap:'.25rem', flexShrink:0, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
        {[['salaries','👥 Registre salariés'],['organigramme','🏢 Organigramme'],['formations','📜 Formations & Habilitations'],['conges','🏖️ Congés']].map(([k,l]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            padding:'.6rem 1.2rem', background:'none', border:'none', whiteSpace:'nowrap', flexShrink:0,
            borderBottom: tab===k ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor:'pointer', fontSize:'.85rem', fontWeight: tab===k ? 700 : 500,
            color: tab===k ? 'var(--green-mid)' : 'var(--text-muted)', marginBottom:-2
          }}>{l}</button>
        ))}
      </div>

      {tab === 'salaries'      && <SalariesTab salaries={salaries} setSalaries={setSalaries} showToast={showToast} />}
      {tab === 'organigramme'  && <OrgTab salaries={salaries} setSalaries={setSalaries} showToast={showToast} />}
      {tab === 'formations'    && <FormationsTab salaries={salaries} formations={formations} setFormations={setFormations} showToast={showToast} />}
      {tab === 'conges'        && <CongesTab salaries={salaries} showToast={showToast} />}
    </div>
  )
}

/* ════ Onglet Salariés ════ */
function SalariesTab({ salaries, setSalaries, showToast }) {
  const [search, setSearch] = useState('')
  const [filterEntite, setFilterEntite] = useState('all')
  const [editing, setEditing] = useState(null)

  const EMPTY = { nom:'', prenom:'', role:'', entite:'', superieur_ids:[], telephone:'', email:'', date_entree:'', statut:'actif', notes:'' }

  const actifs = salaries.filter(s => s.statut === 'actif')
  const displayed = salaries.filter(s =>
    (filterEntite==='all' || s.entite===filterEntite) &&
    (!search || `${s.nom} ${s.prenom} ${s.role}`.toLowerCase().includes(search.toLowerCase()))
  )

  async function save() {
    if (!editing.nom?.trim() || !editing.prenom?.trim()) { alert('Nom et prénom obligatoires.'); return }
    // date_entree est optionnelle — une chaîne vide envoyée à une colonne "date"
    // est rejetée par Postgres (syntaxe de date invalide), il faut null.
    const payload = { ...editing, date_entree: editing.date_entree || null }; delete payload.created_at
    if (editing.id) {
      const { error } = await supabase.from('salaries').update(payload).eq('id', editing.id)
      if (error) { alert(error.message); return }
      setSalaries(prev => prev.map(s => s.id===editing.id ? {...s,...payload} : s))
    } else {
      const { data, error } = await supabase.from('salaries').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setSalaries(prev => [...prev, data])
    }
    setEditing(null)
    showToast('✅ Salarié enregistré')
  }

  async function del() {
    if (!confirm(`Supprimer ${editing.prenom} ${editing.nom} ?`)) return
    await supabase.from('formations').delete().eq('salarie_id', editing.id)
    await supabase.from('salaries').delete().eq('id', editing.id)
    setSalaries(prev => prev.filter(s => s.id!==editing.id))
    setEditing(null)
    showToast('🗑️ Supprimé')
  }

  const entites = [...new Set(salaries.map(s => s.entite).filter(Boolean))]

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {/* Toolbar */}
      <div style={{ padding:'1rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', gap:'.6rem', alignItems:'center', flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍 Nom, prénom, rôle…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ padding:'.5rem .9rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', width:260, outline:'none' }} />
        <select value={filterEntite} onChange={e=>setFilterEntite(e.target.value)}
          style={{ padding:'.5rem .8rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none' }}>
          <option value="all">Toutes les entités</option>
          {entites.map(e=><option key={e}>{e}</option>)}
        </select>
        <div style={{ marginLeft:'auto', fontSize:'.82rem', color:'var(--text-muted)' }}><strong>{actifs.length}</strong> salarié(s) actif(s)</div>
        <button className="btn-sm primary" onClick={() => setEditing({...EMPTY})}>+ Nouveau salarié</button>
      </div>

      {/* Cards */}
      <div style={{ flex:1, overflow:'auto', padding:'1.2rem 1.5rem' }}>
        {displayed.length === 0 ? (
          <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
            Aucun salarié — cliquez "+ Nouveau salarié".
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:'1rem' }}>
            {displayed.map(s => {
              const initials = `${s.prenom?.[0]||''}${s.nom?.[0]||''}`.toUpperCase()
              return (
                <div key={s.id} onClick={() => setEditing({...s})}
                  style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, padding:'1.1rem', cursor:'pointer', transition:'box-shadow .15s', opacity: s.statut==='inactif' ? .6 : 1 }}
                  onMouseEnter={e=>e.currentTarget.style.boxShadow='var(--shadow-md)'}
                  onMouseLeave={e=>e.currentTarget.style.boxShadow='none'}>
                  <div style={{ display:'flex', gap:'.8rem', alignItems:'flex-start' }}>
                    <div style={{ width:44, height:44, background:'var(--green-accent)', borderRadius:'50%', display:'grid', placeItems:'center', fontSize:'.9rem', fontWeight:700, color:'white', flexShrink:0 }}>{initials}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:700, fontSize:'.95rem' }}>{s.prenom} {s.nom}</div>
                      <div style={{ fontSize:'.78rem', color:'var(--text-muted)', marginTop:1 }}>{s.role || '—'}</div>
                      {s.entite && <div style={{ fontSize:'.72rem', background:'var(--green-pale)', color:'var(--green-mid)', fontWeight:600, display:'inline-block', padding:'.1rem .5rem', borderRadius:50, marginTop:'.3rem' }}>{s.entite}</div>}
                    </div>
                    {s.statut==='inactif' && <span style={{ fontSize:'.65rem', color:'var(--text-muted)', background:'var(--cream)', padding:'.15rem .5rem', borderRadius:50 }}>Inactif</span>}
                  </div>
                  {(s.telephone||s.email) && (
                    <div style={{ marginTop:'.7rem', paddingTop:'.6rem', borderTop:'1px solid var(--border)', fontSize:'.75rem', color:'var(--text-muted)' }}>
                      {s.telephone && <div>📞 {s.telephone}</div>}
                      {s.email && <div>✉️ {s.email}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Modal */}
      {editing && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setEditing(null)}>
          <div className="modal" style={{ maxWidth:540 }}>
            <div className="modal-hdr"><h3>{editing.id?'Modifier le salarié':'Nouveau salarié'}</h3><button className="modal-close" onClick={()=>setEditing(null)}>✕</button></div>
            <div className="modal-body">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
                <Fg label="Prénom *"><input autoFocus value={editing.prenom} onChange={e=>setEditing({...editing,prenom:e.target.value})} /></Fg>
                <Fg label="Nom *"><input value={editing.nom} onChange={e=>setEditing({...editing,nom:e.target.value})} /></Fg>
                <Fg label="Rôle / Poste"><input value={editing.role} onChange={e=>setEditing({...editing,role:e.target.value})} placeholder="ex. Chef d'équipe" /></Fg>
                <Fg label="Entité">
                  <input list="entites-list" value={editing.entite} onChange={e=>setEditing({...editing,entite:e.target.value})} />
                  <datalist id="entites-list">{ENTITES.map(e=><option key={e} value={e}/>)}</datalist>
                </Fg>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Responsables hiérarchiques (plusieurs possibles)</label>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:'.4rem', marginBottom:'.5rem' }}>
                    {getSupIds(editing).map(id => {
                      const sup = salaries.find(s=>s.id===id)
                      if (!sup) return null
                      return (
                        <span key={id} style={{ display:'inline-flex', alignItems:'center', gap:'.35rem', background:'var(--green-pale)', color:'var(--green-mid)', fontSize:'.78rem', fontWeight:600, padding:'.25rem .6rem', borderRadius:50 }}>
                          {sup.prenom} {sup.nom}
                          <button type="button" onClick={()=>setEditing({...editing, superieur_ids: getSupIds(editing).filter(x=>x!==id)})}
                            style={{ background:'none', border:'none', cursor:'pointer', color:'inherit', fontSize:'.85rem', lineHeight:1, padding:0 }}>✕</button>
                        </span>
                      )
                    })}
                    {getSupIds(editing).length===0 && <span style={{ fontSize:'.78rem', color:'var(--text-muted)', fontStyle:'italic' }}>Aucun (direction)</span>}
                  </div>
                  <select value="" onChange={e=>{ if(!e.target.value) return; setEditing({...editing, superieur_ids:[...getSupIds(editing), e.target.value]}) }}>
                    <option value="">+ Ajouter un responsable…</option>
                    {salaries.filter(s=>s.id!==editing.id && !getSupIds(editing).includes(s.id)).map(s=><option key={s.id} value={s.id}>{s.prenom} {s.nom}</option>)}
                  </select>
                </div>
                <Fg label="Statut">
                  <select value={editing.statut} onChange={e=>setEditing({...editing,statut:e.target.value})}>
                    <option value="actif">Actif</option>
                    <option value="inactif">Inactif</option>
                  </select>
                </Fg>
                <Fg label="Téléphone"><input value={editing.telephone} onChange={e=>setEditing({...editing,telephone:e.target.value})} /></Fg>
                <Fg label="Email"><input value={editing.email} onChange={e=>setEditing({...editing,email:e.target.value})} /></Fg>
                <Fg label="Date d'entrée"><input type="date" value={editing.date_entree||''} onChange={e=>setEditing({...editing,date_entree:e.target.value})} /></Fg>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Notes</label>
                  <textarea rows={2} value={editing.notes||''} onChange={e=>setEditing({...editing,notes:e.target.value})}
                    style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              {editing.id && <button className="btn-danger" onClick={del}>Supprimer</button>}
              <button className="btn-sm" onClick={()=>setEditing(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={save}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ════ Onglet Organigramme ════ */
// Disposition libre : chaque carte salarié a une position (org_x/org_y en
// base). Sans position enregistrée, une disposition automatique en arbre est
// calculée. En glissant une carte (admin), sa position est persistée et
// toutes les lignes (hiérarchie principale + responsables supplémentaires)
// suivent, car elles sont tracées en SVG d'après la position réelle des cartes.
const ORG_CARD_W = 180
const ORG_ROW_H = 195
const ORG_MAIN_COLOR = '#4a9050'

// Calcule les tracés SVG (lignes hiérarchie + liens secondaires colorés) reliant les
// cartes salarié d'après leur position réelle dans le DOM — partagé entre le canevas
// à l'écran et la zone imprimable, chacun ayant son propre conteneur/refs.
function computeOrgPaths(container, nodeRefsMap, mainLinks, extraLinks, supColor) {
  if (!container) return []
  const cRect = container.getBoundingClientRect()
  const out = []
  // Lignes principales : bas du responsable → haut du salarié
  for (const { supId, empId } of mainLinks) {
    const supEl = nodeRefsMap.get(supId)
    const empEl = nodeRefsMap.get(empId)
    if (!supEl || !empEl) continue
    const sR = supEl.getBoundingClientRect(), eR = empEl.getBoundingClientRect()
    const x1 = sR.left + sR.width / 2 - cRect.left
    const y1 = sR.bottom - cRect.top
    const x2 = eR.left + eR.width / 2 - cRect.left
    const y2 = eR.top - cRect.top
    out.push({ key: `main-${supId}-${empId}`, d: `M${x1},${y1} V${y2 - 14} H${x2} V${y2}`, color: ORG_MAIN_COLOR, marker: false })
  }
  // Liens secondaires : légèrement décalés pour longer la ligne principale
  const perEmp = {}
  for (const { empId, supId } of extraLinks) {
    const empEl = nodeRefsMap.get(empId)
    const supEl = nodeRefsMap.get(supId)
    if (!empEl || !supEl) continue
    const eR = empEl.getBoundingClientRect(), sR = supEl.getBoundingClientRect()
    perEmp[empId] = (perEmp[empId] || 0) + 1
    const off = 8 * perEmp[empId]
    const x1 = sR.left + sR.width / 2 - cRect.left + off
    const y1 = sR.bottom - cRect.top
    const x2 = eR.left + eR.width / 2 - cRect.left + off
    const y2 = eR.top - cRect.top
    out.push({ key: `${empId}-${supId}`, d: `M${x1},${y1} V${y2 - 12} H${x2} V${y2}`, color: supColor[supId], marker: true })
  }
  return out
}

function OrgTab({ salaries, setSalaries, showToast }) {
  const { isAdmin } = useAuth()
  const isMobile = useIsMobile()
  const actifs = salaries.filter(s => s.statut === 'actif')
  const containerRef = useRef(null)
  const nodeRefs = useRef(new Map())
  const [paths, setPaths] = useState([])
  const [drag, setDrag] = useState(null) // { id, x, y }
  const dragRef = useRef(null)

  // Arbre principal : chaque salarié n'apparaît qu'UNE fois, rattaché à son
  // PREMIER responsable hiérarchique. Les responsables supplémentaires sont
  // matérialisés par des traits colorés tracés par-dessus.
  // `ancestors` évite une boucle infinie en cas de cycle accidentel.
  function buildTree(parentId = null, ancestors = []) {
    return actifs
      .filter(s => {
        const ids = getSupIds(s)
        return parentId === null ? ids.length === 0 : ids[0] === parentId
      })
      .filter(s => !ancestors.includes(s.id))
      .map(s => ({ ...s, children: buildTree(s.id, [...ancestors, s.id]) }))
  }
  const roots = buildTree(null)

  // Liste aplatie (avec niveau, pour la couleur des cartes) + liens principaux
  const treeList = []
  const mainLinks = []
  ;(function walk(nodes, level) {
    nodes.forEach(n => {
      treeList.push({ node: n, level })
      n.children.forEach(c => mainLinks.push({ supId: n.id, empId: c.id }))
      walk(n.children, level + 1)
    })
  })(roots, 0)

  // Un lien "secondaire" par responsable au-delà du premier.
  const extraLinks = actifs.flatMap(s => getSupIds(s).slice(1).map(supId => ({ empId: s.id, supId })))
    .filter(l => actifs.some(a => a.id === l.supId))

  // Une couleur par responsable supplémentaire distinct — la ligne a le même
  // style plein que les lignes principales de l'arbre, seule la couleur change.
  const LINK_COLORS = ['#c98a2e', '#2563eb', '#9333ea', '#0d9488', '#dc2626', '#db2777']
  const extraSups = [...new Set(extraLinks.map(l => l.supId))]
  const supColor = Object.fromEntries(extraSups.map((id, i) => [id, LINK_COLORS[i % LINK_COLORS.length]]))

  // Regroupement par salarié, pour l'affichage en accordéon mobile (pas de
  // lignes SVG possibles hors du canevas positionné en absolu).
  const extraByEmp = {}
  for (const { empId, supId } of extraLinks) {
    const sup = actifs.find(a => a.id === supId)
    if (!sup) continue
    ;(extraByEmp[empId] ||= []).push({ supId, supName: `${sup.prenom} ${sup.nom}`, color: supColor[supId] })
  }

  // Disposition automatique en arbre : feuilles côte à côte, parent centré
  // au-dessus de ses enfants, un niveau = une rangée.
  const autoPos = {}
  {
    let cursor = 0
    const layout = (node, depth) => {
      let x
      if (!node.children.length) { x = cursor; cursor += ORG_CARD_W + 30 }
      else {
        const xs = node.children.map(c => layout(c, depth + 1))
        x = (Math.min(...xs) + Math.max(...xs)) / 2
      }
      autoPos[node.id] = { x, y: depth * ORG_ROW_H }
      return x
    }
    roots.forEach(r => { layout(r, 0); cursor += 30 })
  }

  // Position affichée : glisser en cours > position enregistrée > automatique
  const positions = {}
  for (const { node } of treeList) {
    positions[node.id] = drag?.id === node.id ? { x: drag.x, y: drag.y }
      : (node.org_x != null && node.org_y != null) ? { x: node.org_x, y: node.org_y }
      : autoPos[node.id] || { x: 0, y: 0 }
  }
  const contW = Math.max(...Object.values(positions).map(p => p.x), 0) + ORG_CARD_W + 20
  const contH = Math.max(...Object.values(positions).map(p => p.y), 0) + ORG_ROW_H

  function recomputePaths() {
    setPaths(computeOrgPaths(containerRef.current, nodeRefs.current, mainLinks, extraLinks, supColor))
  }

  useLayoutEffect(() => {
    recomputePaths()
    window.addEventListener('resize', recomputePaths)
    return () => window.removeEventListener('resize', recomputePaths)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salaries, drag])

  // ── Glisser-déposer (admin) : position persistée au lâcher ──
  function startDrag(e, id) {
    if (!isAdmin) return
    const start = positions[id]
    const startX = e.clientX, startY = e.clientY
    dragRef.current = { id, x: start.x, y: start.y, moved: false }
    const onMove = ev => {
      if (!dragRef.current) return
      if (!dragRef.current.moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return
      const nx = Math.max(0, Math.round((start.x + ev.clientX - startX) / 10) * 10)
      const ny = Math.max(0, Math.round((start.y + ev.clientY - startY) / 10) * 10)
      dragRef.current = { id, x: nx, y: ny, moved: true }
      setDrag({ id, x: nx, y: ny })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (d?.moved) persistPos(d.id, d.x, d.y)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  async function persistPos(id, x, y) {
    setSalaries(prev => prev.map(s => s.id === id ? { ...s, org_x: x, org_y: y } : s))
    const { error } = await supabase.from('salaries').update({ org_x: x, org_y: y }).eq('id', id)
    if (error) {
      alert(/org_|could not find|column/i.test(error.message)
        ? 'Colonnes org_x / org_y manquantes — exécute migration_organigramme_positions.sql dans Supabase → SQL Editor.'
        : error.message)
    }
  }

  async function resetLayout() {
    if (!confirm('Revenir à la disposition automatique pour tout le monde ?')) return
    const { error } = await supabase.from('salaries').update({ org_x: null, org_y: null }).not('id', 'is', null)
    if (error) { alert(error.message); return }
    setSalaries(prev => prev.map(s => ({ ...s, org_x: null, org_y: null })))
    showToast('↺ Disposition automatique rétablie')
  }

  // Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
  // plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
  // popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
  // toujours le vrai dialogue d'impression natif. La zone imprimable reproduit le
  // même canevas positionné en absolu que l'écran (positions personnalisées ou
  // automatiques), avec son propre conteneur/refs pour ne pas perturber l'affichage.
  const printContainerRef = useRef(null)
  const printNodeRefs = useRef(new Map())
  const [printPaths, setPrintPaths] = useState([])
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    if (!printing) return
    document.body.classList.add('printing-active')
    // Le print-area passe de display:none à display:block via cette classe — il
    // faut attendre ce changement de layout avant de mesurer les cartes (getBoundingClientRect).
    const t1 = setTimeout(() => {
      setPrintPaths(computeOrgPaths(printContainerRef.current, printNodeRefs.current, mainLinks, extraLinks, supColor))
    }, 30)
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrinting(false)
    }
    window.addEventListener('afterprint', onAfterPrint)
    const t2 = setTimeout(() => window.print(), 120)
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printing])
  function printOrg() {
    setPrinting(true)
  }

  if (actifs.length === 0) {
    return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Aucun salarié actif à afficher.</div>
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:'1.5rem' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem', flexWrap:'wrap', gap:'.6rem' }}>
        {extraLinks.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', gap:'1rem', fontSize:'.78rem', color:'var(--text-muted)', flexWrap:'wrap' }}>
            {extraSups.map(id => {
              const sup = actifs.find(a => a.id === id)
              return (
                <div key={id} style={{ display:'flex', alignItems:'center', gap:'.4rem' }}>
                  <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke={supColor[id]} strokeWidth="2" /></svg>
                  aussi sous {sup ? `${sup.prenom} ${sup.nom}` : '?'}
                </div>
              )
            })}
          </div>
        )}
        <div style={{ marginLeft:'auto', display:'flex', gap:'.5rem' }}>
          {isAdmin && <button className="btn-sm" onClick={resetLayout} title="Efface les positions personnalisées de toutes les cartes">↺ Disposition auto</button>}
          <button className="btn-sm" onClick={printOrg}>🖨️ Imprimer l'organigramme</button>
        </div>
      </div>
      {isAdmin && !isMobile && (
        <p style={{ fontSize:'.75rem', color:'var(--text-muted)', margin:'0 0 .8rem' }}>
          ✋ Glisse une carte pour placer librement chaque salarié — la disposition est enregistrée pour tout le monde.
        </p>
      )}
      {isMobile ? (
        // Sur mobile, le canevas à positionnement libre (glisser-déposer, lignes
        // SVG tracées d'après des coordonnées pixel absolues) est illisible et
        // inutilisable au doigt — on affiche la même hiérarchie sous forme
        // d'accordéon dépliable, sans repositionnement libre (desktop only).
        <div style={{ display:'flex', flexDirection:'column', gap:'.6rem' }}>
          {roots.map(r => <OrgMobileNode key={r.id} node={r} level={0} extraByEmp={extraByEmp} />)}
        </div>
      ) : (
        <div style={{ overflow:'auto', paddingBottom:'1rem' }}>
          <div ref={containerRef} style={{ position:'relative', width: contW, height: contH }}>
            <svg style={{ position:'absolute', top:0, left:0, width:'100%', height:'100%', pointerEvents:'none', overflow:'visible' }}>
              <defs>
                {[...new Set(paths.filter(p => p.marker).map(p => p.color))].map(c => (
                  <marker key={c} id={`orgArrow-${c.replace('#','')}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill={c} />
                  </marker>
                ))}
              </defs>
              {paths.map(p => (
                <path key={p.key} d={p.d} stroke={p.color} strokeWidth="2" fill="none"
                  markerEnd={p.marker ? `url(#orgArrow-${p.color.replace('#','')})` : undefined} />
              ))}
            </svg>
            {treeList.map(({ node, level }) => (
              <OrgCard key={node.id} node={node} level={level} nodeRefs={nodeRefs}
                pos={positions[node.id]} draggable={isAdmin} dragging={drag?.id === node.id}
                onPointerDown={e => startDrag(e, node.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Zone imprimable — invisible à l'écran, visible seulement sur le document
          imprimé/PDF (voir .print-area dans index.css). Reproduit le canevas
          positionné en absolu (disposition personnalisée ou automatique) avec son
          propre conteneur/refs, calculés une fois la zone rendue visible. */}
      <div className="print-area" style={{ fontFamily: 'Arial, sans-serif', padding: 32, background: 'white', color: '#1a2e1c' }}>
        <h1 style={{ fontSize: 22, borderBottom: '2px solid #4a9050', paddingBottom: 8, marginBottom: 24 }}>Organigramme — Groupe Millard</h1>
        {extraLinks.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', fontSize: 11, color: '#888', marginBottom: 10 }}>
            {extraSups.map(id => {
              const sup = actifs.find(a => a.id === id)
              return (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="24" height="10"><line x1="0" y1="5" x2="24" y2="5" stroke={supColor[id]} strokeWidth="2" /></svg>
                  aussi sous {sup ? `${sup.prenom} ${sup.nom}` : '?'}
                </div>
              )
            })}
          </div>
        )}
        <div style={{ overflowX: 'auto', paddingBottom: 20 }}>
          <div ref={printContainerRef} style={{ position: 'relative', width: contW, height: contH }}>
            <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
              <defs>
                {[...new Set(printPaths.filter(p => p.marker).map(p => p.color))].map(c => (
                  <marker key={c} id={`printOrgArrow-${c.replace('#', '')}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 Z" fill={c} />
                  </marker>
                ))}
              </defs>
              {printPaths.map(p => (
                <path key={p.key} d={p.d} stroke={p.color} strokeWidth="2" fill="none"
                  markerEnd={p.marker ? `url(#printOrgArrow-${p.color.replace('#', '')})` : undefined} />
              ))}
            </svg>
            {treeList.map(({ node }) => {
              const initials = `${node.prenom?.[0] || ''}${node.nom?.[0] || ''}`.toUpperCase()
              const pos = positions[node.id] || { x: 0, y: 0 }
              return (
                <div key={node.id} ref={el => { if (el) printNodeRefs.current.set(node.id, el) }}
                  style={{ position: 'absolute', left: pos.x, top: pos.y, width: ORG_CARD_W, boxSizing: 'border-box', background: '#e8f5e9', border: '2px solid #4a9050', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ width: 36, height: 36, background: '#4a9050', borderRadius: '50%', margin: '0 auto 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold', fontSize: 13 }}>{initials}</div>
                  <div style={{ fontWeight: 'bold', fontSize: 13 }}>{node.prenom} {node.nom}</div>
                  <div style={{ fontSize: 11, color: '#666' }}>{node.role || ''}</div>
                  {node.entite && <div style={{ fontSize: 10, background: '#4a9050', color: 'white', borderRadius: 50, padding: '1px 8px', display: 'inline-block', marginTop: 4 }}>{node.entite}</div>}
                </div>
              )
            })}
          </div>
        </div>
        <div style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #ddd', paddingTop: 10, textAlign: 'center' }}>
          Document généré le {fmtDate(new Date())} · Global GAP
        </div>
      </div>
    </div>
  )
}

function OrgMobileNode({ node, level, extraByEmp }) {
  const [open, setOpen] = useState(level < 2)
  const initials = `${node.prenom?.[0]||''}${node.nom?.[0]||''}`.toUpperCase()
  const colors = ['var(--green-deep)','var(--green-mid)','var(--green-accent)','var(--green-light)']
  const color = colors[Math.min(level, colors.length-1)]
  const hasChildren = node.children.length > 0
  const extras = extraByEmp[node.id] || []

  return (
    <div>
      <div onClick={() => hasChildren && setOpen(o => !o)}
        style={{ display:'flex', alignItems:'center', gap:'.7rem', background:'white', border:`2px solid ${color}`, borderRadius:12, padding:'.7rem .9rem', cursor: hasChildren ? 'pointer' : 'default' }}>
        <div style={{ width:38, height:38, background:color, borderRadius:'50%', display:'grid', placeItems:'center', fontSize:'.8rem', fontWeight:700, color:'white', flexShrink:0 }}>{initials}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontWeight:700, fontSize:'.88rem' }}>{node.prenom} {node.nom}</div>
          <div style={{ fontSize:'.74rem', color:'var(--text-muted)' }}>{node.role || '—'}</div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:'.3rem', marginTop:'.3rem' }}>
            {node.entite && <span style={{ fontSize:'.63rem', background:color+'20', color, fontWeight:700, padding:'.1rem .5rem', borderRadius:50 }}>{node.entite}</span>}
            {extras.map(e => (
              <span key={e.supId} style={{ fontSize:'.63rem', color:e.color, fontWeight:700, padding:'.1rem .5rem', borderRadius:50, background:e.color+'18' }}>
                ↳ aussi sous {e.supName}
              </span>
            ))}
          </div>
        </div>
        {hasChildren && (
          <span style={{ fontSize:'.9rem', color:'var(--text-muted)', flexShrink:0, transform: open ? 'rotate(90deg)' : 'none', transition:'transform .15s' }}>▶</span>
        )}
      </div>
      {hasChildren && open && (
        <div style={{ marginLeft:18, paddingLeft:'.8rem', borderLeft:'2px solid var(--border)', marginTop:'.5rem', display:'flex', flexDirection:'column', gap:'.5rem' }}>
          {node.children.map(c => <OrgMobileNode key={c.id} node={c} level={level+1} extraByEmp={extraByEmp} />)}
        </div>
      )}
    </div>
  )
}

function OrgCard({ node, level, nodeRefs, pos, draggable, dragging, onPointerDown }) {
  const initials = `${node.prenom?.[0]||''}${node.nom?.[0]||''}`.toUpperCase()
  const colors = ['var(--green-deep)','var(--green-mid)','var(--green-accent)','var(--green-light)']
  const color = colors[Math.min(level, colors.length-1)]

  return (
    <div ref={el => { if (el) nodeRefs.current.set(node.id, el) }}
      onPointerDown={draggable ? onPointerDown : undefined}
      style={{
        position:'absolute', left: pos.x, top: pos.y, width: ORG_CARD_W, boxSizing:'border-box',
        background:'white', border:`2px solid ${color}`, borderRadius:12, padding:'.8rem 1rem', textAlign:'center',
        boxShadow: dragging ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        cursor: draggable ? 'grab' : 'default',
        touchAction: draggable ? 'none' : undefined,
        userSelect:'none',
        zIndex: dragging ? 10 : 1,
        opacity: dragging ? .85 : 1,
      }}>
      <div style={{ width:40, height:40, background:color, borderRadius:'50%', margin:'0 auto .5rem', display:'grid', placeItems:'center', fontSize:'.85rem', fontWeight:700, color:'white' }}>{initials}</div>
      <div style={{ fontWeight:700, fontSize:'.88rem' }}>{node.prenom} {node.nom}</div>
      <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginTop:2 }}>{node.role||'—'}</div>
      {node.entite && <div style={{ fontSize:'.65rem', background:color+'20', color, fontWeight:700, padding:'.1rem .5rem', borderRadius:50, display:'inline-block', marginTop:'.3rem' }}>{node.entite}</div>}
    </div>
  )
}

/* ════ Onglet Formations ════ */
function FormationsTab({ salaries, formations, setFormations, showToast }) {
  const [editing, setEditing] = useState(null)
  const today = new Date().toISOString().split('T')[0]

  const EMPTY = { salarie_id:'', type:'Certiphyto', intitule:'', date_obtention:'', date_expiration:'', organisme:'', numero_cert:'' }

  // Flag expiring soon (< 60 days)
  function expiresIn(dateStr) {
    if (!dateStr) return null
    const d = new Date(dateStr), now = new Date()
    return Math.floor((d - now) / 86400000)
  }

  async function save() {
    if (!editing.salarie_id) { alert('Salarié obligatoire.'); return }
    if (!editing.intitule?.trim()) { alert('Intitulé obligatoire.'); return }
    const payload = { ...editing }; delete payload.created_at
    if (editing.id) {
      await supabase.from('formations').update(payload).eq('id', editing.id)
      setFormations(prev => prev.map(f => f.id===editing.id ? {...f,...payload} : f))
    } else {
      const { data, error } = await supabase.from('formations').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setFormations(prev => [...prev, data])
    }
    setEditing(null)
    showToast('✅ Formation enregistrée')
  }

  async function del() {
    if (!confirm('Supprimer ?')) return
    await supabase.from('formations').delete().eq('id', editing.id)
    setFormations(prev => prev.filter(f => f.id!==editing.id))
    setEditing(null)
    showToast('🗑️ Supprimée')
  }

  const expiringSoon = formations.filter(f => { const d = expiresIn(f.date_expiration); return d !== null && d >= 0 && d <= 60 })
  const expired      = formations.filter(f => { const d = expiresIn(f.date_expiration); return d !== null && d < 0 })

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding:'1rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ display:'flex', gap:'.8rem', fontSize:'.82rem' }}>
          {expired.length > 0 && <span style={{ color:'var(--red)', fontWeight:600 }}>⚠️ {expired.length} expirée(s)</span>}
          {expiringSoon.length > 0 && <span style={{ color:'var(--amber)', fontWeight:600 }}>⏳ {expiringSoon.length} expirant bientôt</span>}
        </div>
        <button className="btn-sm primary" onClick={()=>setEditing({...EMPTY})}>+ Nouvelle formation</button>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'1rem 1.5rem' }}>
        {formations.length === 0 ? (
          <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
            Aucune formation enregistrée.
          </div>
        ) : (
          <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
            <table style={{ width:'100%', minWidth:900, fontSize:'.83rem', borderCollapse:'collapse' }}>
              <thead style={{ background:'var(--cream)' }}>
                <tr>
                  {['Salarié','Type','Intitulé','Organisme','N° Cert.','Obtention','Expiration','Statut',''].map(h=>(
                    <th key={h} style={{ padding:'.6rem .8rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {formations.map(f => {
                  const sal = salaries.find(s=>s.id===f.salarie_id)
                  const daysLeft = expiresIn(f.date_expiration)
                  let statusBg = 'var(--green-pale)', statusColor = 'var(--green-mid)', statusLabel = 'Valide'
                  if (daysLeft !== null && daysLeft < 0) { statusBg='var(--red-pale)'; statusColor='var(--red)'; statusLabel='Expirée' }
                  else if (daysLeft !== null && daysLeft <= 60) { statusBg='var(--amber-pale)'; statusColor='var(--amber)'; statusLabel=`J-${daysLeft}` }
                  else if (!f.date_expiration) { statusBg='var(--cream)'; statusColor='var(--text-muted)'; statusLabel='Pas de date' }

                  return (
                    <tr key={f.id} onClick={()=>setEditing({...f})} style={{ cursor:'pointer' }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <td style={tdS}><strong>{sal ? `${sal.prenom} ${sal.nom}` : '—'}</strong></td>
                      <td style={tdS}>{f.type}</td>
                      <td style={tdS}>{f.intitule}</td>
                      <td style={tdS}>{f.organisme||'—'}</td>
                      <td style={tdS}>{f.numero_cert||'—'}</td>
                      <td style={tdS}>{fmtDate(f.date_obtention)}</td>
                      <td style={tdS}>{fmtDate(f.date_expiration)}</td>
                      <td style={tdS}><span style={{ fontSize:'.7rem', fontWeight:700, padding:'.15rem .55rem', borderRadius:50, background:statusBg, color:statusColor }}>{statusLabel}</span></td>
                      <td style={tdS}><span style={{ color:'var(--green-accent)' }}>✏️</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setEditing(null)}>
          <div className="modal" style={{ maxWidth:500 }}>
            <div className="modal-hdr"><h3>{editing.id?'Modifier':'Nouvelle formation / habilitation'}</h3><button className="modal-close" onClick={()=>setEditing(null)}>✕</button></div>
            <div className="modal-body">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Salarié *</label>
                  <select value={editing.salarie_id} onChange={e=>setEditing({...editing,salarie_id:e.target.value})}>
                    <option value="">— Choisir —</option>
                    {salaries.filter(s=>s.statut==='actif').map(s=><option key={s.id} value={s.id}>{s.prenom} {s.nom}</option>)}
                  </select>
                </div>
                <Fg label="Type">
                  <input list="types-list" value={editing.type} onChange={e=>setEditing({...editing,type:e.target.value})} />
                  <datalist id="types-list">{TYPES_FORMATION.map(t=><option key={t} value={t}/>)}</datalist>
                </Fg>
                <Fg label="Intitulé *"><input autoFocus value={editing.intitule} onChange={e=>setEditing({...editing,intitule:e.target.value})} placeholder="ex. Certiphyto Décideur" /></Fg>
                <Fg label="Organisme"><input value={editing.organisme} onChange={e=>setEditing({...editing,organisme:e.target.value})} placeholder="ex. Chambre d'agriculture" /></Fg>
                <Fg label="N° de certificat"><input value={editing.numero_cert} onChange={e=>setEditing({...editing,numero_cert:e.target.value})} /></Fg>
                <Fg label="Date d'obtention"><input type="date" value={editing.date_obtention||''} onChange={e=>setEditing({...editing,date_obtention:e.target.value})} /></Fg>
                <Fg label="Date d'expiration"><input type="date" value={editing.date_expiration||''} onChange={e=>setEditing({...editing,date_expiration:e.target.value})} /></Fg>
              </div>
            </div>
            <div className="modal-foot">
              {editing.id && <button className="btn-danger" onClick={del}>Supprimer</button>}
              <button className="btn-sm" onClick={()=>setEditing(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={save}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Fg({ label, children }) { return <div className="form-group"><label>{label}</label>{children}</div> }
const tdS = { padding:'.6rem .8rem', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }

const TYPES_CONGE = ['Congé payé','RTT','Maladie','Sans solde','Formation','Autre']

/* ════ Onglet Congés — dates de congés par salarié (lié au registre), avec historique ════ */
function CongesTab({ salaries, showToast }) {
  const [conges, setConges] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [filterSalarie, setFilterSalarie] = useState('')
  const [historiqueOpen, setHistoriqueOpen] = useState(false)
  const [historique, setHistorique] = useState(null) // null = pas encore chargé

  useEffect(() => { load() }, [])
  useEffect(() => { if (historiqueOpen && historique === null) loadHistorique() }, [historiqueOpen])

  async function loadHistorique() {
    const { data, error } = await supabase.from('conges_historique').select('*').order('created_at', { ascending: false }).limit(200)
    setHistorique(error ? [] : (data || []))
  }

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('conges').select('*').order('date_debut', { ascending: false })
    setConges(data || [])
    setLoading(false)
  }

  const EMPTY = { salarie_id: '', type: 'Congé payé', date_debut: '', date_fin: '', observation: '' }

  function nbJours(c) {
    if (!c.date_debut || !c.date_fin) return null
    const d1 = new Date(c.date_debut), d2 = new Date(c.date_fin)
    return Math.round((d2 - d1) / 86400000) + 1
  }

  async function save() {
    if (!editing.salarie_id) { alert('Salarié obligatoire.'); return }
    if (!editing.date_debut || !editing.date_fin) { alert('Dates de début et de fin obligatoires.'); return }
    if (editing.date_fin < editing.date_debut) { alert('La date de fin doit être après la date de début.'); return }
    const payload = { ...editing }; delete payload.created_at
    let savedId = editing.id
    if (editing.id) {
      const { error } = await supabase.from('conges').update(payload).eq('id', editing.id)
      if (error) { alert(error.message); return }
      setConges(prev => prev.map(c => c.id === editing.id ? { ...c, ...payload } : c))
    } else {
      const { data, error } = await supabase.from('conges').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setConges(prev => [data, ...prev])
      savedId = data.id
    }
    logCongeHistorique({ conge_id: savedId, salarie_id: payload.salarie_id, action: editing.id ? 'modification' : 'creation', type: payload.type, date_debut: payload.date_debut, date_fin: payload.date_fin, source: 'global_gap' })
    setEditing(null)
    showToast('✅ Congé enregistré')
  }

  async function del() {
    if (!confirm('Supprimer ce congé ?')) return
    await supabase.from('conges').delete().eq('id', editing.id)
    setConges(prev => prev.filter(c => c.id !== editing.id))
    logCongeHistorique({ conge_id: editing.id, salarie_id: editing.salarie_id, action: 'suppression', type: editing.type, date_debut: editing.date_debut, date_fin: editing.date_fin, source: 'global_gap' })
    setEditing(null)
    showToast('🗑️ Supprimé')
  }

  if (loading) return <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>Chargement…</div>

  const filtered = filterSalarie ? conges.filter(c => c.salarie_id === filterSalarie) : conges
  const today = new Date().toISOString().split('T')[0]
  const enCours = filtered.filter(c => c.date_debut <= today && c.date_fin >= today)
  const aVenir = filtered.filter(c => c.date_debut > today)

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      <div style={{ padding:'1rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'.8rem', flexWrap:'wrap' }}>
        <select value={filterSalarie} onChange={e=>setFilterSalarie(e.target.value)} style={{ maxWidth:220 }}>
          <option value="">— Tous les salariés —</option>
          {salaries.map(s => <option key={s.id} value={s.id}>{s.prenom} {s.nom}</option>)}
        </select>
        <div style={{ display:'flex', gap:'.8rem', fontSize:'.82rem' }}>
          {enCours.length > 0 && <span style={{ color:'var(--green-mid)', fontWeight:600 }}>🟢 {enCours.length} en cours</span>}
          {aVenir.length > 0 && <span style={{ color:'var(--amber)', fontWeight:600 }}>📅 {aVenir.length} à venir</span>}
        </div>
        <button className="btn-sm" onClick={()=>setHistoriqueOpen(true)} style={{ marginLeft:'auto' }}>🕘 Historique</button>
        <button className="btn-sm primary" onClick={()=>setEditing({...EMPTY, salarie_id: filterSalarie || ''})}>+ Nouveau congé</button>
      </div>

      <div style={{ flex:1, overflow:'auto', padding:'1rem 1.5rem' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign:'center', padding:'3rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)' }}>
            Aucun congé enregistré.
          </div>
        ) : (
          <div style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
            <table style={{ width:'100%', minWidth:700, fontSize:'.83rem', borderCollapse:'collapse' }}>
              <thead style={{ background:'var(--cream)' }}>
                <tr>
                  {['Salarié','Type','Début','Fin','Jours','Statut','Observation'].map(h=>(
                    <th key={h} style={{ padding:'.6rem .8rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', color:'var(--text-muted)', borderBottom:'1px solid var(--border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const sal = salaries.find(s => s.id === c.salarie_id)
                  const jours = nbJours(c)
                  let statusBg = 'var(--cream)', statusColor = 'var(--text-muted)', statusLabel = 'Passé'
                  if (c.date_debut <= today && c.date_fin >= today) { statusBg='var(--green-pale)'; statusColor='var(--green-mid)'; statusLabel='En cours' }
                  else if (c.date_debut > today) { statusBg='var(--amber-pale)'; statusColor='var(--amber)'; statusLabel='À venir' }
                  return (
                    <tr key={c.id} onClick={()=>setEditing({...c})} style={{ cursor:'pointer' }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <td style={tdS}><strong>{sal ? `${sal.prenom} ${sal.nom}` : '—'}</strong></td>
                      <td style={tdS}>{c.type || '—'}</td>
                      <td style={tdS}>{fmtDate(c.date_debut)}</td>
                      <td style={tdS}>{fmtDate(c.date_fin)}</td>
                      <td style={tdS}>{jours ?? '—'}</td>
                      <td style={tdS}><span style={{ fontSize:'.7rem', fontWeight:700, padding:'.15rem .55rem', borderRadius:50, background:statusBg, color:statusColor }}>{statusLabel}</span></td>
                      <td style={{ ...tdS, whiteSpace:'normal', color:'var(--text-muted)' }}>{c.observation || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setEditing(null)}>
          <div className="modal" style={{ maxWidth:460 }}>
            <div className="modal-hdr"><h3>{editing.id?'Modifier le congé':'Nouveau congé'}</h3><button className="modal-close" onClick={()=>setEditing(null)}>✕</button></div>
            <div className="modal-body">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Salarié *</label>
                  <select value={editing.salarie_id} onChange={e=>setEditing({...editing,salarie_id:e.target.value})}>
                    <option value="">— Choisir —</option>
                    {salaries.map(s=><option key={s.id} value={s.id}>{s.prenom} {s.nom}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Type</label>
                  <input list="types-conge-list" value={editing.type} onChange={e=>setEditing({...editing,type:e.target.value})} />
                  <datalist id="types-conge-list">{TYPES_CONGE.map(t=><option key={t} value={t}/>)}</datalist>
                </div>
                <Fg label="Date de début *"><input type="date" value={editing.date_debut||''} onChange={e=>setEditing({...editing,date_debut:e.target.value})} /></Fg>
                <Fg label="Date de fin *"><input type="date" value={editing.date_fin||''} onChange={e=>setEditing({...editing,date_fin:e.target.value})} /></Fg>
                <div className="form-group" style={{ gridColumn:'1/-1' }}>
                  <label>Observation</label>
                  <textarea rows={2} value={editing.observation||''} onChange={e=>setEditing({...editing,observation:e.target.value})}
                    style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              {editing.id && <button className="btn-danger" onClick={del}>Supprimer</button>}
              <button className="btn-sm" onClick={()=>setEditing(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={save}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}

      {historiqueOpen && (
        <div className="modal-overlay" onClick={e=>e.target===e.currentTarget&&setHistoriqueOpen(false)}>
          <div className="modal" style={{ maxWidth:560 }}>
            <div className="modal-hdr"><h3>🕘 Historique des congés</h3><button className="modal-close" onClick={()=>setHistoriqueOpen(false)}>✕</button></div>
            <div className="modal-body" style={{ overflowY:'auto', maxHeight:'65vh' }}>
              {historique === null ? (
                <p style={{ color:'var(--text-muted)', fontSize:'.82rem' }}>Chargement…</p>
              ) : historique.length === 0 ? (
                <p style={{ color:'var(--text-muted)', fontSize:'.82rem' }}>Aucun mouvement enregistré — exécute migration_A_EXECUTER_14.sql si cette table n'existe pas encore.</p>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'.5rem' }}>
                  {historique.map(h => {
                    const sal = salaries.find(s => s.id === h.salarie_id)
                    const actionMeta = { creation: ['➕', 'var(--green-mid)'], suppression: ['🗑️', 'var(--red)'], modification: ['✏️', 'var(--amber)'] }[h.action] || ['•', 'var(--text-muted)']
                    return (
                      <div key={h.id} style={{ display:'flex', gap:'.6rem', alignItems:'flex-start', padding:'.5rem 0', borderBottom:'1px solid var(--border)', fontSize:'.82rem' }}>
                        <span style={{ color: actionMeta[1] }}>{actionMeta[0]}</span>
                        <div style={{ flex:1 }}>
                          <strong>{sal ? `${sal.prenom} ${sal.nom}` : 'Salarié supprimé'}</strong>
                          {' — '}{h.action}{h.type ? ` (${h.type})` : ''}
                          {h.date_debut && <div style={{ color:'var(--text-muted)', fontSize:'.76rem' }}>{fmtDate(h.date_debut)} → {fmtDate(h.date_fin)}</div>}
                        </div>
                        <div style={{ textAlign:'right', fontSize:'.7rem', color:'var(--text-muted)' }}>
                          <div>{h.source === 'planning' ? '📅 Planning' : '🏢 Global GAP'}</div>
                          <div>{new Date(h.created_at).toLocaleString('fr-FR')}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
