import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useSupabaseTable } from '../lib/useSupabaseTable'
import { useToast } from '../lib/useToast'
import DataTable from '../components/DataTable'
import Modal from '../components/Modal'
import CultureLegend from '../components/CultureLegend'
import { groupInterventions, sortGroupsByDateDesc } from '../lib/groupInterventions'
import { useAuth } from '../lib/AuthContext'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { requestGoToParcelle } from '../lib/mapFocus'
import { varietesPdtOf } from '../lib/varietesPdt'
import { fmtDate } from '../lib/formatDate'
import { intervTypeLabel } from '../lib/interventionLabels'
import InterventionChampEditModal from '../components/InterventionChampEditModal'
import useIsMobile from '../lib/useIsMobile'

// Fusionne les parcelles appartenant à un même groupe manuel (voir Carte.jsx /
// parcelle_groupes) en une seule ligne d'affichage — surface totale, nom du
// groupe, champs texte réduits à une seule valeur seulement s'ils concordent
// entre tous les membres (sinon vide, plutôt que d'en montrer un au hasard).
// Utilisé UNIQUEMENT pour l'affichage liste des profils non admin/manager —
// jamais pour la sélection multiple/suppression, qui continue de s'appuyer
// sur les vraies parcelles individuelles.
function mergeGroupedParcelles(items, groupesById) {
  const byGroupeId = new Map()
  for (const p of items) {
    if (!p.groupe_id) continue
    if (!byGroupeId.has(p.groupe_id)) byGroupeId.set(p.groupe_id, [])
    byGroupeId.get(p.groupe_id).push(p)
  }
  const groupedIds = new Set()
  const mergedRows = []
  for (const [groupeId, members] of byGroupeId) {
    if (members.length < 2) continue // groupe orphelin (1 membre) — traité comme une parcelle normale
    members.forEach(m => groupedIds.add(m.id))
    const sameOrEmpty = field => {
      const vals = [...new Set(members.map(m => (m[field] || '').toString().trim()).filter(Boolean))]
      return vals.length === 1 ? vals[0] : ''
    }
    mergedRows.push({
      id: groupeId,
      nom: groupesById[groupeId]?.nom || members[0].nom,
      surface: members.reduce((s, m) => s + (parseFloat(m.surface) || 0), 0),
      entite: sameOrEmpty('entite'),
      culture_actuelle: sameOrEmpty('culture_actuelle'),
      culture_precedente: sameOrEmpty('culture_precedente'),
      interculture: sameOrEmpty('interculture'),
      commune: sameOrEmpty('commune'),
      varietes_pdt: members.flatMap(m => Array.isArray(m.varietes_pdt) ? m.varietes_pdt : []),
      _isGroup: true,
      _memberIds: members.map(m => m.id),
      _memberCount: members.length,
    })
  }
  const untouched = items.filter(p => !groupedIds.has(p.id))
  return [...untouched, ...mergedRows]
}

const EMPTY = { nom:'', entite:'', surface:'', culture_precedente:'', culture_actuelle:'', interculture:'', commune:'', section_cadastrale:'', notes:'' }

export default function Parcelles() {
  const { showToast, ToastEl } = useToast()
  const { user, perms, isManager } = useAuth()
  const { campagneActive, registerCampagnes } = useCampagne()
  const isMobile = useIsMobile()
  const readOnly = !!perms.parcellesReadOnly
  const { items: allItems, create, update, remove } = useSupabaseTable('parcelles','nom')
  // Le parcellaire change à chaque campagne (import DAPLOS) — la liste ne montre
  // que celles de la campagne active, jamais celles d'une autre année.
  const items = allItems.filter(p => (p.campagne || defaultCampagne()) === campagneActive)
  useEffect(() => { registerCampagnes([...new Set(allItems.map(p => p.campagne).filter(Boolean))]) }, [allItems])
  // Groupes de parcelles (voir Carte.jsx / migration_A_EXECUTER_86.sql) — pour
  // tout le monde sauf admin/manager, la liste doit fusionner les membres d'un
  // groupe en une seule ligne, comme la Carte masque déjà leurs délimitations.
  // Un groupe peut être créé/modifié depuis la Carte pendant que cette page
  // reste affichée (deux onglets, ou un simple aller-retour d'écran sur
  // mobile) — on ne se contente donc pas d'un chargement unique au montage, on
  // revérifie aussi à chaque retour au premier plan de l'appli.
  const [groupes, setGroupes] = useState([])
  function loadGroupes() { supabase.from('parcelle_groupes').select('*').then(({ data, error }) => { if (!error) setGroupes(data || []) }) }
  useEffect(() => {
    loadGroupes()
    function onFocus() { if (!document.hidden) loadGroupes() }
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [])
  const groupesById = useMemo(() => Object.fromEntries(groupes.map(g => [g.id, g])), [groupes])
  const [viewingGroup, setViewingGroup] = useState(null)
  const [viewingGroupInterventions, setViewingGroupInterventions] = useState([])
  const displayItems = useMemo(
    () => isManager ? items : mergeGroupedParcelles(items, groupesById),
    [items, groupesById, isManager]
  )
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [editingInterventions, setEditingInterventions] = useState([])
  const [editingChampGroup, setEditingChampGroup] = useState(null) // groupe d'interventions_phyto en cours de modification
  const [selectedIds, setSelectedIds] = useState(new Set())

  const filtered = displayItems.filter(p => {
    const q = search.toLowerCase()
    return p.nom.toLowerCase().includes(q) ||
      (p.entite||'').toLowerCase().includes(q) ||
      (p.culture_actuelle||'').toLowerCase().includes(q) ||
      varietesPdtOf(p).some(v => (v.variete||'').toLowerCase().includes(q))
  })

  function openNew() { setEditing({ ...EMPTY, campagne: campagneActive }); setEditingInterventions([]) }
  function reloadInterventionsFor(parcelleId) {
    supabase.from('interventions_phyto').select('*').eq('parcelle_id', parcelleId).order('date', { ascending: false })
      .then(({ data }) => setEditingInterventions(data || []))
  }
  // Une ligne fusionnée (groupe) n'est pas une vraie parcelle éditable — ouvre une
  // vue allégée (nom + surface uniquement, pas de champs modifiables) mais avec
  // les mêmes interventions, groupées à travers toutes les vraies parcelles du
  // groupe : pour ces utilisateurs, ça doit se comporter comme UNE parcelle.
  function openRow(row) {
    if (row._isGroup) openViewingGroup(row)
    else openEdit(row)
  }
  function openEdit(p) {
    setEditing({ ...p })
    setEditingInterventions([])
    reloadInterventionsFor(p.id)
  }
  function openViewingGroup(row) {
    setViewingGroup(row)
    setViewingGroupInterventions([])
    reloadViewingGroupInterventions(row._memberIds)
  }
  function reloadViewingGroupInterventions(memberIds) {
    supabase.from('interventions_phyto').select('*').in('parcelle_id', memberIds).order('date', { ascending: false })
      .then(({ data }) => setViewingGroupInterventions(data || []))
  }
  function openChampGroup(g) {
    setEditingChampGroup({
      date: g.date, observation: g.type, sous_type: g.sous_type, defanage: g.defanage,
      parcelle: editing?.nom, parcelle_id: editing?.id, culture: g.items[0]?.culture,
      items: g.items,
    })
  }
  // Même chose mais pour un évènement affiché depuis la vue fusionnée d'un
  // groupe : les nouveaux produits ajoutés doivent atterrir sur TOUTES les
  // vraies parcelles du groupe, pas juste une seule (voir parcelleTargets dans
  // InterventionChampEditModal).
  function openViewingGroupChamp(g) {
    const members = items.filter(p => viewingGroup._memberIds.includes(p.id))
    setEditingChampGroup({
      date: g.date, observation: g.type, sous_type: g.sous_type, defanage: g.defanage,
      parcelle: viewingGroup.nom, items: g.items,
      parcelleTargets: members.map(p => ({ id: p.id, nom: p.nom, culture: p.culture_actuelle, campagne: p.campagne })),
    })
  }

  async function save() {
    if (!editing.nom?.trim()) { alert('Le nom est obligatoire.'); return }
    const payload = { ...editing, surface: editing.surface ? parseFloat(editing.surface) : null }
    try {
      if (editing.id) await update(editing.id, payload)
      else await create(payload)
      setEditing(null)
      showToast('✅ Parcelle enregistrée')
    } catch(e) { alert(e.message) }
  }
  async function del() {
    if (!confirm('Supprimer cette parcelle ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Supprimée')
  }

  /* ── Sélection multiple ── */
  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  function toggleSelectAll() {
    // Une ligne fusionnée (groupe) n'est pas une vraie parcelle — jamais incluse
    // dans la sélection multiple (voir rowSelectable côté DataTable).
    const selectableRows = filtered.filter(p => !p._isGroup)
    setSelectedIds(prev => {
      const allSelected = selectableRows.length > 0 && selectableRows.every(p => prev.has(p.id))
      return allSelected ? new Set() : new Set(selectableRows.map(p => p.id))
    })
  }
  async function deleteSelected() {
    if (selectedIds.size === 0) return
    if (!confirm(`Supprimer ${selectedIds.size} parcelle(s) sélectionnée(s) ? Cette action est irréversible.`)) return
    const ids = [...selectedIds]
    for (const id of ids) {
      try { await remove(id) } catch (e) { console.error(e) }
    }
    setSelectedIds(new Set())
    showToast(`🗑️ ${ids.length} parcelle(s) supprimée(s)`)
  }

  const totalSurface = items.reduce((s, p) => s + (p.surface||0), 0)

  return (
    <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden' }}>
      {ToastEl}

      {/* Toolbar — juste la recherche, le compteur et la création manuelle
          (l'import/export a son propre onglet, réservé à l'admin). */}
      <div style={{ padding: isMobile ? '.7rem .8rem' : '1rem 1.5rem', background:'white', borderBottom:'1px solid var(--border)', display:'flex', gap:'.6rem', alignItems:'center', flexWrap:'wrap' }}>
        <input type="text" placeholder="🔍 Nom, entité, culture, variété…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{ padding: isMobile ? '.45rem .75rem' : '.5rem .9rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize: isMobile ? '.8rem' : '.85rem', flex:'1 1 160px', maxWidth:280, outline:'none' }} />
        <span style={{ fontSize: isMobile ? '.74rem' : '.82rem', color:'var(--text-muted)' }}>
          <strong>{filtered.length}</strong> parcelle(s) · <strong>{totalSurface.toFixed(2)} ha</strong>
        </span>
        {!readOnly && (
          <button className="btn-sm primary" style={{ marginLeft:'auto' }} onClick={openNew}>+ Nouvelle parcelle</button>
        )}
      </div>

      {/* Barre de suppression groupée */}
      {!readOnly && selectedIds.size > 0 && (
        <div style={{ background:'var(--red-pale)', borderBottom:'1px solid #fecaca', padding:'.6rem 1.5rem', display:'flex', alignItems:'center', gap:'.7rem' }}>
          <span style={{ fontSize:'.84rem', color:'var(--red)', fontWeight:600 }}>{selectedIds.size} parcelle(s) sélectionnée(s)</span>
          <button className="btn-sm" onClick={() => setSelectedIds(new Set())}>Désélectionner tout</button>
          <button className="btn-danger" onClick={deleteSelected} style={{ marginLeft:'auto' }}>🗑️ Supprimer la sélection</button>
        </div>
      )}

      <div style={{ flex:1, overflow:'auto', padding: isMobile ? '.6rem' : '1rem 1.5rem', position:'relative' }}>
        {isMobile ? (
          filtered.length === 0 ? (
            <div style={{ textAlign:'center', padding:'2rem 1rem', color:'var(--text-muted)', background:'white', borderRadius:12, border:'1px solid var(--border)', fontSize:'.8rem' }}>
              Aucune parcelle.
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'.4rem' }}>
              {filtered.map(p => {
                const varietes = varietesPdtOf(p)
                const sousLigne = [p.culture_actuelle, (!readOnly && p.entite) || null].filter(Boolean).join(' · ')
                return (
                  <div key={p.id} style={{ background:'white', border:'1px solid var(--border)', borderRadius:10, padding:'.5rem .6rem', display:'flex', alignItems:'flex-start', gap:'.45rem' }}>
                    {!readOnly && !p._isGroup && (
                      <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleSelect(p.id)} onClick={e => e.stopPropagation()} style={{ marginTop:3, flexShrink:0 }} />
                    )}
                    <div onClick={() => openRow(p)} style={{ flex:1, minWidth:0, cursor:'pointer', display:'flex', flexDirection:'column', gap:1 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', gap:'.5rem', alignItems:'flex-start' }}>
                        <strong style={{ fontSize:'.8rem', wordBreak:'break-word' }}>{p.nom}</strong>
                        <span style={{ fontSize:'.74rem', color:'var(--text-muted)', flexShrink:0, whiteSpace:'nowrap' }}>{p.surface!=null?`${p.surface} ha`:'–'}</span>
                      </div>
                      {sousLigne && (
                        <div style={{ fontSize:'.7rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {sousLigne}
                        </div>
                      )}
                      {varietes.length > 0 && (
                        <div style={{ fontSize:'.68rem', color:'var(--green-mid)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {varietes.map(v => `🥔 ${v.variete}`).join(' · ')}
                        </div>
                      )}
                      {p.commune && (
                        <div style={{ fontSize:'.68rem', color:'var(--text-muted)', textAlign:'right' }}>
                          📍 {p.commune}
                        </div>
                      )}
                    </div>
                    <button className="btn-sm" onClick={e => { e.stopPropagation(); requestGoToParcelle(p._isGroup ? p._memberIds[0] : p.id) }} title="Aller sur la carte"
                      style={{ flexShrink:0, padding:'.25rem .45rem', fontSize:'.72rem', whiteSpace:'nowrap' }}>
                      🗺️ Carte
                    </button>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <DataTable
            emptyMessage="Aucune parcelle."
            onRowClick={openRow}
            selectable={!readOnly}
            rowSelectable={p => !p._isGroup}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            columns={[
              { key:'nom', label:'Nom', render:p=><strong>{p.nom}</strong> },
              ...(readOnly ? [] : [{ key:'entite', label:'Entité' }]),
              { key:'surface', label:'Surface (ha)', render:p=>p.surface!=null?p.surface+' ha':'–' },
              { key:'culture_actuelle', label:'Culture actuelle' },
              { key:'varietes_pdt', label:'Variété(s) PDT', render: p => {
                const list = varietesPdtOf(p)
                if (!list.length) return '–'
                return (
                  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                    {list.map((v,i) => (
                      <span key={i} style={{ fontSize:'.78rem' }}>
                        🥔 {v.variete}
                        {(v.surface != null || v.cote) && (
                          <span style={{ color:'var(--text-muted)' }}>
                            {' '}({[v.surface != null ? `${v.surface} ha` : null, v.cote || null].filter(Boolean).join(' · ')})
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )
              } },
              { key:'culture_precedente', label:'Culture précédente', hideOnNarrow: true },
              { key:'interculture', label:'Interculture', hideOnNarrow: true },
              { key:'commune', label:'Commune', hideOnNarrow: true },
              { key:'carte', label:'', render: p => (
                <button className="btn-sm" onClick={e => { e.stopPropagation(); requestGoToParcelle(p._isGroup ? p._memberIds[0] : p.id) }} title="Aller sur la carte">
                  🗺️ Carte
                </button>
              )},
            ]}
            rows={filtered}
          />
        )}
        <CultureLegend codes={filtered.flatMap(p => [p.culture_actuelle, p.culture_precedente])} />
      </div>

      {/* Vue d'une parcelle groupée (voir mergeGroupedParcelles) — se comporte comme
          n'importe quelle autre parcelle pour ces utilisateurs : juste le nom et la
          surface (rien n'indique qu'il s'agit en réalité de plusieurs parcelles
          réunies), avec ses interventions consultables et modifiables comme
          d'habitude — elles s'appliquent simplement à toutes les vraies parcelles
          du groupe en même temps (voir openViewingGroupChamp). */}
      {viewingGroup && (
        <Modal title={viewingGroup.nom} onClose={() => setViewingGroup(null)} maxWidth={560}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem', marginBottom:'1.2rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Nom de la parcelle</label>
              <input disabled value={viewingGroup.nom} />
            </div>
            <div className="form-group">
              <label>Surface (ha)</label>
              <input disabled value={viewingGroup.surface.toFixed(2)} />
            </div>
          </div>

          <div style={{ paddingTop:'1rem', borderTop:'1px solid var(--border)' }}>
            <div style={{ fontSize:'.8rem', fontWeight:700, color:'var(--text-muted)', marginBottom:'.5rem' }}>
              🔄 Interventions sur cette parcelle ({viewingGroupInterventions.length})
            </div>
            {viewingGroupInterventions.length === 0 ? (
              <div style={{ fontSize:'.8rem', color:'var(--text-muted)', fontStyle:'italic' }}>Aucune intervention enregistrée.</div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:'.4rem', maxHeight:280, overflowY:'auto' }}>
                {sortGroupsByDateDesc(groupInterventions(viewingGroupInterventions)).map((g, gi) => {
                  const produitNoms = g.items.map(it => it.produit_nom).filter(Boolean)
                  return (
                  <div key={gi} onClick={() => openViewingGroupChamp(g)}
                    style={{ display:'flex', flexDirection:'column', gap:'.2rem', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem', cursor:'pointer' }}
                    onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}>
                    <div style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
                      <span style={{ fontSize:'.68rem', color:'var(--text-muted)', whiteSpace:'nowrap', flexShrink:0 }}>{fmtDate(g.date)}</span>
                      <span style={{ fontWeight:600, fontSize:'.8rem', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {intervTypeLabel({ observation: g.type, sous_type: g.sous_type, defanage: g.defanage })}
                      </span>
                      <span style={{ fontSize:'.7rem', color:'var(--text-muted)', flexShrink:0 }}>{g.items.length} produit{g.items.length>1?'s':''}</span>
                      <span style={{ fontSize:'.72rem', color:'var(--green-mid)', flexShrink:0 }}>✏️</span>
                    </div>
                    {produitNoms.length > 0 && (
                      <div style={{ fontSize:'.74rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {produitNoms.join(', ')}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Parcelle modal */}
      {editing && (
        <Modal title={editing.id?'Modifier la parcelle':'Nouvelle parcelle'} onClose={()=>setEditing(null)} onSave={readOnly?null:save} onDelete={readOnly||!editing.id?null:del} maxWidth={560}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Nom de la parcelle *</label>
              <input autoFocus disabled={readOnly} value={editing.nom} onChange={e=>setEditing({...editing,nom:e.target.value})} placeholder="ex. Grand Champ Nord" />
            </div>
            {!readOnly && (
            <div className="form-group">
              <label>Entité / Propriétaire</label>
              <input value={editing.entite} onChange={e=>setEditing({...editing,entite:e.target.value})} placeholder="ex. EARL Dupont" />
            </div>
            )}
            <div className="form-group">
              <label>Surface (ha)</label>
              <input type="number" step="0.01" disabled={readOnly} value={editing.surface} onChange={e=>setEditing({...editing,surface:e.target.value})} placeholder="12.50" />
            </div>
            <div className="form-group">
              <label>Culture précédente</label>
              <input disabled={readOnly} value={editing.culture_precedente} onChange={e=>setEditing({...editing,culture_precedente:e.target.value})} placeholder="ex. Blé" />
            </div>
            <div className="form-group">
              <label>Culture actuelle</label>
              <input disabled={readOnly} value={editing.culture_actuelle} onChange={e=>setEditing({...editing,culture_actuelle:e.target.value})} placeholder="ex. Pomme de terre" />
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Interculture</label>
              <input disabled={readOnly} value={editing.interculture} onChange={e=>setEditing({...editing,interculture:e.target.value})} placeholder="ex. Moutarde, Radis fourrager…" />
            </div>
            <div className="form-group">
              <label>Commune</label>
              <input disabled={readOnly} value={editing.commune} onChange={e=>setEditing({...editing,commune:e.target.value})} />
            </div>
            <div className="form-group">
              <label>Section cadastrale</label>
              <input disabled={readOnly} value={editing.section_cadastrale} onChange={e=>setEditing({...editing,section_cadastrale:e.target.value})} placeholder="ex. B 124" />
            </div>
            <div className="form-group" style={{ gridColumn:'1/-1' }}>
              <label>Notes</label>
              <textarea rows={2} disabled={readOnly} value={editing.notes} onChange={e=>setEditing({...editing,notes:e.target.value})}
                style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
            </div>
          </div>

          {editing.id && (
            <div style={{ marginTop:'1.2rem', paddingTop:'1rem', borderTop:'1px solid var(--border)' }}>
              <div style={{ fontSize:'.8rem', fontWeight:700, color:'var(--text-muted)', marginBottom:'.5rem' }}>
                🔄 Interventions sur cette parcelle ({editingInterventions.length})
              </div>
              {editingInterventions.length === 0 ? (
                <div style={{ fontSize:'.8rem', color:'var(--text-muted)', fontStyle:'italic' }}>Aucune intervention enregistrée.</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'.4rem', maxHeight:280, overflowY:'auto' }}>
                  {sortGroupsByDateDesc(groupInterventions(editingInterventions)).map((g, gi) => {
                    const produitNoms = g.items.map(it => it.produit_nom).filter(Boolean)
                    return (
                    <div key={gi} onClick={() => openChampGroup(g)}
                      style={{ display:'flex', flexDirection:'column', gap:'.2rem', border:'1px solid var(--border)', borderRadius:8, padding:'.5rem .7rem', cursor:'pointer' }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--green-pale)'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <div style={{ display:'flex', alignItems:'center', gap:'.6rem' }}>
                        <span style={{ fontSize:'.68rem', color:'var(--text-muted)', whiteSpace:'nowrap', flexShrink:0 }}>{fmtDate(g.date)}</span>
                        <span style={{ fontWeight:600, fontSize:'.8rem', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {intervTypeLabel({ observation: g.type, sous_type: g.sous_type, defanage: g.defanage })}
                        </span>
                        <span style={{ fontSize:'.7rem', color:'var(--text-muted)', flexShrink:0 }}>{g.items.length} produit{g.items.length>1?'s':''}</span>
                        <span style={{ fontSize:'.72rem', color:'var(--green-mid)', flexShrink:0 }}>✏️</span>
                      </div>
                      {produitNoms.length > 0 && (
                        <div style={{ fontSize:'.74rem', color:'var(--text-muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {produitNoms.join(', ')}
                        </div>
                      )}
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {editingChampGroup && (
        <InterventionChampEditModal
          event={editingChampGroup}
          title={viewingGroup ? `Modifier — ${viewingGroup.nom}` : undefined}
          parcelleTargets={editingChampGroup.parcelleTargets}
          onClose={() => setEditingChampGroup(null)}
          onSaved={() => { if (editing) reloadInterventionsFor(editing.id); if (viewingGroup) reloadViewingGroupInterventions(viewingGroup._memberIds) }}
          onDeleted={() => { if (editing) reloadInterventionsFor(editing.id); if (viewingGroup) reloadViewingGroupInterventions(viewingGroup._memberIds) }}
        />
      )}
    </div>
  )
}
