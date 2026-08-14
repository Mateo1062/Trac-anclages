import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import Modal from '../components/Modal'
import useIsMobile from '../lib/useIsMobile'
import { fmtDate } from '../lib/formatDate'

// Suivi d'entretien pour tout ce qui n'est pas un outil agricole au sens propre
// (voitures de la ferme, chariots élévateurs…) — même principe que la page
// "Outils agricoles" (fiches + historique d'interventions), tables séparées.
const TYPE_OPTIONS = ['Voiture', 'Chariot élévateur', 'Télescopique', 'Utilitaire', 'Autre']
const INTERV_OPTIONS = ['Entretien préventif', 'Vidange', 'Réparation', 'Contrôle technique', 'Graissage', 'Remplacement pièce', 'Révision', 'Autre']
const SANS_TYPE = 'Sans type'
const TYPE_ICON = {
  'Voiture': '🚗', 'Chariot élévateur': '🏗️', 'Télescopique': '🏗️', 'Utilitaire': '🚐', 'Autre': '🔧',
  [SANS_TYPE]: '📦',
}
export default function EntretienGlobal() {
  const { user, canViewCosts } = useAuth()
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const [vehicules, setVehicules] = useState([])
  const [activeType, setActiveType] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [interventions, setInterv] = useState([])
  const [profiles, setProfiles] = useState([]) // pour afficher qui a créé/modifié/validé
  const [search, setSearch] = useState('')
  const [vehiculeModal, setVehiculeModal] = useState(null)
  const [intervModal, setIntervModal] = useState(null)
  const [tableMissing, setTableMissing] = useState(false)

  useEffect(() => { loadVehicules(); loadProfiles() }, [])
  useEffect(() => { if (activeId) loadInterv(activeId) }, [activeId])

  async function loadVehicules() {
    const { data, error } = await supabase.from('vehicules_entretien').select('*').order('nom')
    if (error && /does not exist|relation|could not find/i.test(error.message)) { setTableMissing(true); return }
    setVehicules(data || [])
  }
  async function loadInterv(id) {
    const { data } = await supabase.from('interventions_vehicules').select('*').eq('vehicule_id', id).order('date', { ascending: false })
    setInterv(data || [])
  }
  async function loadProfiles() {
    const { data } = await supabase.from('profiles').select('id,display_name')
    setProfiles(data || [])
  }
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'

  function openNewVehicule() { setVehiculeModal({ nom: '', type: (activeType && activeType !== SANS_TYPE) ? activeType : '', marque: '', modele: '', num_serie: '', annee: '', notes: '' }) }
  function openEditVehicule(v) { setVehiculeModal({ ...v }) }
  async function saveVehicule() {
    if (!vehiculeModal.nom?.trim()) { alert('Nom obligatoire.'); return }
    const payload = { ...vehiculeModal, annee: vehiculeModal.annee ? parseInt(vehiculeModal.annee) : null }
    delete payload.created_at
    if (vehiculeModal.id) {
      await supabase.from('vehicules_entretien').update(payload).eq('id', vehiculeModal.id)
      setVehicules(prev => prev.map(v => v.id === vehiculeModal.id ? { ...v, ...payload } : v))
    } else {
      const { data, error } = await supabase.from('vehicules_entretien').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setVehicules(prev => [...prev, data])
      setActiveId(data.id)
    }
    setVehiculeModal(null)
    showToast('✅ Véhicule enregistré')
  }
  async function deleteVehicule() {
    if (!confirm(`Supprimer "${vehiculeModal.nom}" et toutes ses interventions ?`)) return
    await supabase.from('interventions_vehicules').delete().eq('vehicule_id', vehiculeModal.id)
    await supabase.from('vehicules_entretien').delete().eq('id', vehiculeModal.id)
    setVehicules(prev => prev.filter(v => v.id !== vehiculeModal.id))
    if (activeId === vehiculeModal.id) setActiveId(null)
    setVehiculeModal(null)
    showToast('🗑️ Véhicule supprimé')
  }

  function openNewInterv() {
    setIntervModal({ vehicule_id: activeId, date: new Date().toISOString().split('T')[0], type_interv: '', description: '', intervenant: '', cout: '', kilometrage: '', heures: '', prochain_rdv: '', observation: '', en_attente: false, valide: true })
  }
  function openEditInterv(i) { setIntervModal({ ...i, cout: i.cout ?? '', kilometrage: i.kilometrage ?? '', heures: i.heures ?? '', en_attente: !!i.en_attente, valide: i.valide !== false }) }
  // En attente et Effectuée s'excluent mutuellement.
  function toggleEnAttente(v) { setIntervModal(m => ({ ...m, en_attente: v, valide: v ? false : m.valide })) }
  function toggleValide(v) { setIntervModal(m => ({ ...m, valide: v, en_attente: v ? false : m.en_attente })) }
  async function saveInterv() {
    if (!intervModal.description?.trim()) { alert('Description obligatoire.'); return }
    // valide_par/valide_le ne sont (re)posés que lors du passage effectif à
    // "Effectuée" — voir OutilsAgricoles.jsx pour la même logique.
    const existing = intervModal.id ? interventions.find(x => x.id === intervModal.id) : null
    const wasValide = existing ? existing.valide !== false : false
    const nowValide = !!intervModal.valide
    const payload = {
      ...intervModal,
      cout: parseFloat(intervModal.cout) || null,
      kilometrage: parseFloat(intervModal.kilometrage) || null,
      heures: parseFloat(intervModal.heures) || null,
      prochain_rdv: intervModal.prochain_rdv || null,
      en_attente: !!intervModal.en_attente,
      valide: nowValide,
      updated_by: user?.id || null,
      valide_par: nowValide ? (wasValide ? existing.valide_par : (user?.id || null)) : null,
      valide_le:  nowValide ? (wasValide ? existing.valide_le  : new Date().toISOString()) : null,
    }
    if (!intervModal.id) payload.created_by = user?.id || null
    delete payload.created_at
    if (intervModal.id) {
      let { error } = await supabase.from('interventions_vehicules').update(payload).eq('id', intervModal.id)
      if (error && /en_attente|valide|created_by|updated_by|valide_par|valide_le|column/i.test(error.message)) {
        const { en_attente, valide, created_by, updated_by, valide_par, valide_le, ...fallback } = payload
        ;({ error } = await supabase.from('interventions_vehicules').update(fallback).eq('id', intervModal.id))
      }
      if (error) { alert(error.message); return }
      setInterv(prev => prev.map(i => i.id === intervModal.id ? { ...i, ...payload } : i))
    } else {
      let { data, error } = await supabase.from('interventions_vehicules').insert(payload).select().single()
      if (error && /en_attente|valide|created_by|updated_by|valide_par|valide_le|column/i.test(error.message)) {
        const { en_attente, valide, created_by, updated_by, valide_par, valide_le, ...fallback } = payload
        ;({ data, error } = await supabase.from('interventions_vehicules').insert(fallback).select().single())
      }
      if (error) { alert(error.message); return }
      setInterv(prev => [data, ...prev])
    }
    setIntervModal(null)
    showToast('✅ Intervention enregistrée')
  }
  async function deleteInterv() {
    if (!confirm('Supprimer cette intervention ?')) return
    await supabase.from('interventions_vehicules').delete().eq('id', intervModal.id)
    setInterv(prev => prev.filter(i => i.id !== intervModal.id))
    setIntervModal(null)
    showToast('🗑️ Supprimée')
  }

  const activeVehicule = vehicules.find(v => v.id === activeId)
  const typeOf = v => v.type?.trim() || SANS_TYPE
  const filtered = vehicules
    .filter(v => !activeType || typeOf(v) === activeType)
    .filter(v => v.nom.toLowerCase().includes(search.toLowerCase()))
  const usedTypes = [...new Set(vehicules.map(typeOf))]
  const folderTypes = [...new Set([...TYPE_OPTIONS, ...usedTypes])]
    .filter(t => usedTypes.includes(t) || TYPE_OPTIONS.includes(t))
  const folders = folderTypes.map(t => ({ type: t, count: vehicules.filter(v => typeOf(v) === t).length }))
    .filter(f => f.count > 0 || TYPE_OPTIONS.includes(f.type))
    .sort((a, b) => a.type.localeCompare(b.type, 'fr'))

  const today = new Date().toISOString().split('T')[0]
  const upcoming = interventions.filter(i => i.prochain_rdv && i.prochain_rdv >= today).sort((a, b) => a.prochain_rdv.localeCompare(b.prochain_rdv))
  const lastKm = interventions.find(i => i.kilometrage != null)
  const lastHeures = interventions.find(i => i.heures != null)

  if (tableMissing) return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ maxWidth: 480, textAlign: 'center', background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1.5rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>🚗</div>
        <p style={{ fontSize: '.88rem', color: 'var(--text-muted)' }}>
          Tables manquantes — exécute <strong>migration_A_EXECUTER_22.sql</strong> dans Supabase → SQL Editor, puis recharge la page.
        </p>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {ToastEl}

      {(!isMobile || !activeVehicule) && (
      <div style={{ width: isMobile ? '100%' : 270, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', background: 'white', flexShrink: 0 }}>
        {!activeType ? (
          <>
            <div style={{ padding: '.9rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '.95rem', fontWeight: 700 }}>Entretien global</h3>
              <button className="btn-sm primary" onClick={openNewVehicule} style={{ padding: '.35rem .7rem', fontSize: '.78rem' }}>+ Nouveau</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '.5rem' }}>
              {folders.map(f => (
                <div key={f.type} onClick={() => setActiveType(f.type)} style={{
                  padding: '.7rem .85rem', borderRadius: 9, cursor: 'pointer', marginBottom: 3,
                  display: 'flex', alignItems: 'center', gap: '.6rem', border: '1.5px solid transparent',
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#f5f5f5'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <span style={{ fontSize: '1.3rem' }}>{TYPE_ICON[f.type] || '📁'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '.86rem' }}>{f.type}</div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{f.count} véhicule{f.count > 1 ? 's' : ''}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: '.9rem', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button className="btn-sm" onClick={() => { setActiveType(null); setSearch('') }} style={{ padding: '.3rem .6rem', fontSize: '.76rem' }}>← Dossiers</button>
                <button className="btn-sm primary" onClick={openNewVehicule} style={{ padding: '.35rem .7rem', fontSize: '.78rem' }}>+ Nouveau</button>
              </div>
              <div style={{ fontWeight: 700, fontSize: '.9rem', display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                <span>{TYPE_ICON[activeType] || '📁'}</span> {activeType}
              </div>
              <input type="text" placeholder="🔍 Rechercher…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ padding: '.45rem .8rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.82rem', outline: 'none' }} />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '.5rem' }}>
              {filtered.map(v => (
                <div key={v.id} onClick={() => setActiveId(v.id)} style={{
                  padding: '.7rem .85rem', borderRadius: 9, cursor: 'pointer', marginBottom: 3,
                  background: activeId === v.id ? 'var(--green-pale)' : 'transparent',
                  border: activeId === v.id ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
                }}
                onMouseEnter={e => { if (activeId !== v.id) e.currentTarget.style.background = '#f5f5f5' }}
                onMouseLeave={e => { if (activeId !== v.id) e.currentTarget.style.background = 'transparent' }}>
                  <div style={{ fontWeight: 600, fontSize: '.88rem', color: activeId === v.id ? 'var(--green-mid)' : 'var(--text-main)' }}>
                    {v.nom}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {[v.marque, v.modele, v.annee].filter(Boolean).join(' · ')}
                  </div>
                </div>
              ))}
              {filtered.length === 0 && <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.82rem' }}>Aucun véhicule</div>}
            </div>
          </>
        )}
      </div>
      )}

      {(!isMobile || activeVehicule) && (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!activeVehicule ? (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '3rem', marginBottom: '.5rem' }}>🚗</div>
              <p>Sélectionnez ou créez un véhicule</p>
            </div>
          </div>
        ) : (<>
          <div style={{ background: 'var(--green-deep)', padding: '1rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, flexWrap: 'wrap', gap: '.6rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem' }}>
              {isMobile && <button className="btn-sm" onClick={() => setActiveId(null)} style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>← Retour</button>}
              <div>
                <h2 style={{ color: 'white', fontSize: '1.1rem', fontWeight: 700 }}>{activeVehicule.nom}</h2>
                <span style={{ color: 'rgba(255,255,255,.5)', fontSize: '.78rem' }}>
                  {[activeVehicule.type, activeVehicule.marque, activeVehicule.modele, activeVehicule.annee].filter(Boolean).join(' · ')}
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <button className="btn-sm" onClick={() => openEditVehicule(activeVehicule)} style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>✏️ Modifier</button>
              <button className="btn-sm primary" onClick={openNewInterv}>+ Intervention</button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '1.2rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
            <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
              {[['Type', activeVehicule.type], ['Marque', activeVehicule.marque], ['Modèle', activeVehicule.modele], ['N° série', activeVehicule.num_serie], ['Année', activeVehicule.annee]].filter(([, v]) => v).map(([k, v]) => (
                <div key={k} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 8, padding: '.4rem .7rem', fontSize: '.82rem' }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '.7rem', textTransform: 'uppercase' }}>{k}</div>
                  <div style={{ fontWeight: 600 }}>{v}</div>
                </div>
              ))}
              {activeVehicule.notes && <div style={{ background: 'var(--amber-pale)', border: '1px solid var(--amber)', borderRadius: 8, padding: '.4rem .7rem', fontSize: '.82rem', flex: 1 }}>{activeVehicule.notes}</div>}
            </div>

            {upcoming.length > 0 && (
              <div style={{ background: 'var(--amber-pale)', border: '1px solid var(--amber)', borderRadius: 10, padding: '.8rem 1rem' }}>
                <div style={{ fontWeight: 700, fontSize: '.82rem', color: 'var(--amber)', marginBottom: '.4rem' }}>⏰ Prochaines échéances</div>
                {upcoming.slice(0, 3).map(i => (
                  <div key={i.id} style={{ fontSize: '.8rem', marginBottom: '.2rem' }}>
                    <strong>{i.prochain_rdv}</strong> — {i.type_interv || i.description}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.8rem' }}>
              <KpiCard label="Interventions" value={interventions.length} color="var(--green-mid)" />
              {interventions.some(i=>i.en_attente) && <KpiCard label="⏳ En attente" value={interventions.filter(i=>i.en_attente).length} color="var(--amber)" />}
              {canViewCosts && <KpiCard label="Coût total" value={(interventions.reduce((s, i) => s + (i.cout || 0), 0)).toLocaleString('fr-FR', { minimumFractionDigits: 2 }) + ' €'} color="var(--blue)" />}
              <KpiCard label="Dernière intervention" value={interventions[0]?.date ? fmtDate(interventions[0].date) : '–'} color="var(--text-muted)" />
              <KpiCard label="Kilométrage relevé" value={lastKm ? lastKm.kilometrage.toLocaleString('fr-FR') + ' km' : '–'} color="var(--amber)" />
              <KpiCard label="Heures relevées" value={lastHeures ? lastHeures.heures.toLocaleString('fr-FR') + ' h' : '–'} color="var(--amber)" />
            </div>

            {interventions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
                Aucune intervention enregistrée — cliquez "+ Intervention" pour commencer.
              </div>
            ) : (
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', minWidth: 900, fontSize: '.83rem', borderCollapse: 'collapse' }}>
                  <thead style={{ background: 'var(--cream)' }}>
                    <tr>
                      {['Statut', 'Date', 'Type', 'Description', 'Intervenant', ...(canViewCosts ? ['Coût'] : []), 'Km', 'Heures', 'Prochain RDV', 'Obs.'].map(h => (
                        <th key={h} style={{ padding: '.6rem .9rem', textAlign: 'left', fontSize: '.72rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {interventions.map(i => (
                      <tr key={i.id} onClick={() => openEditInterv(i)} style={{ cursor: 'pointer', background: i.en_attente ? 'var(--amber-pale)' : undefined }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                        onMouseLeave={e => e.currentTarget.style.background = i.en_attente ? 'var(--amber-pale)' : ''}>
                        <td style={td}>
                          {i.en_attente
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--amber)', color:'white', whiteSpace:'nowrap' }}>⏳ En attente</span>
                            : i.valide !== false
                            ? <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.15rem .5rem', borderRadius:50, background:'var(--green-mid)', color:'white', whiteSpace:'nowrap' }}>✅ Effectuée</span>
                            : <span style={{ fontSize:'.68rem', color:'var(--text-muted)' }}>—</span>}
                        </td>
                        <td style={td}>{fmtDate(i.date)}</td>
                        <td style={td}>{i.type_interv || '–'}</td>
                        <td style={{ ...td, maxWidth: 200 }}><strong>{i.description}</strong></td>
                        <td style={td}>{i.intervenant || '–'}</td>
                        {canViewCosts && <td style={{ ...td, fontWeight: 600 }}>{i.cout != null ? i.cout.toLocaleString('fr-FR', { minimumFractionDigits: 2 }) + ' €' : '–'}</td>}
                        <td style={td}>{i.kilometrage != null ? i.kilometrage.toLocaleString('fr-FR') + ' km' : '–'}</td>
                        <td style={td}>{i.heures != null ? i.heures.toLocaleString('fr-FR') + ' h' : '–'}</td>
                        <td style={td}>
                          {i.prochain_rdv
                            ? <span style={{ fontWeight: 600, color: i.prochain_rdv <= today ? 'var(--red)' : 'var(--green-mid)' }}>{i.prochain_rdv}</span>
                            : '–'}
                        </td>
                        <td style={{ ...td, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.observation || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>)}
      </div>
      )}

      {vehiculeModal && (
        <Modal title={vehiculeModal.id ? "Modifier le véhicule" : 'Nouveau véhicule'} onClose={() => setVehiculeModal(null)} onSave={saveVehicule} onDelete={vehiculeModal.id ? deleteVehicule : null} maxWidth={480}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Nom *</label>
              <input autoFocus value={vehiculeModal.nom} onChange={e => setVehiculeModal({ ...vehiculeModal, nom: e.target.value })} placeholder="ex. Renault Kangoo, Chariot Manitou" />
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={vehiculeModal.type} onChange={e => setVehiculeModal({ ...vehiculeModal, type: e.target.value })}>
                <option value="">—</option>
                {TYPE_OPTIONS.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Marque</label><input value={vehiculeModal.marque} onChange={e => setVehiculeModal({ ...vehiculeModal, marque: e.target.value })} /></div>
            <div className="form-group"><label>Modèle</label><input value={vehiculeModal.modele} onChange={e => setVehiculeModal({ ...vehiculeModal, modele: e.target.value })} /></div>
            <div className="form-group"><label>N° de série / Immatriculation</label><input value={vehiculeModal.num_serie} onChange={e => setVehiculeModal({ ...vehiculeModal, num_serie: e.target.value })} /></div>
            <div className="form-group"><label>Année</label><input type="number" value={vehiculeModal.annee} onChange={e => setVehiculeModal({ ...vehiculeModal, annee: e.target.value })} placeholder="2020" /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Notes</label>
              <textarea rows={2} value={vehiculeModal.notes} onChange={e => setVehiculeModal({ ...vehiculeModal, notes: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {intervModal && (
        <Modal title={intervModal.id ? "Modifier l'intervention" : 'Nouvelle intervention'} onClose={() => setIntervModal(null)} onSave={saveInterv} onDelete={intervModal.id ? deleteInterv : null} maxWidth={500}>
          {intervModal.id && (intervModal.created_by || intervModal.updated_by || intervModal.valide_par) && (
            <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', background: 'var(--cream)', borderRadius: 8, padding: '.5rem .8rem', marginBottom: '.8rem', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {intervModal.created_by && <span>👤 Créée par <strong>{nameOf(intervModal.created_by)}</strong></span>}
              {intervModal.updated_by && intervModal.updated_by !== intervModal.created_by && <span>✏️ Modifiée par <strong>{nameOf(intervModal.updated_by)}</strong></span>}
              {intervModal.valide_par && <span>✅ Validée par <strong>{nameOf(intervModal.valide_par)}</strong>{intervModal.valide_le ? ` le ${new Date(intervModal.valide_le).toLocaleDateString('fr-FR')}` : ''}</span>}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1', display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!intervModal.en_attente} onChange={e => toggleEnAttente(e.target.checked)} style={{ width: 16, height: 16 }} />
                ⏳ En attente — ne peut pas être faite dans l'immédiat
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!intervModal.valide} onChange={e => toggleValide(e.target.checked)} style={{ width: 16, height: 16 }} />
                ✅ Effectuée
              </label>
            </div>
            <div className="form-group"><label>Date *</label><input type="date" value={intervModal.date} onChange={e => setIntervModal({ ...intervModal, date: e.target.value })} /></div>
            <div className="form-group">
              <label>Type d'intervention</label>
              <select value={intervModal.type_interv} onChange={e => setIntervModal({ ...intervModal, type_interv: e.target.value })}>
                <option value="">—</option>
                {INTERV_OPTIONS.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Description *</label>
              <textarea rows={2} value={intervModal.description} onChange={e => setIntervModal({ ...intervModal, description: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
            <div className="form-group"><label>Intervenant / Entreprise</label><input value={intervModal.intervenant} onChange={e => setIntervModal({ ...intervModal, intervenant: e.target.value })} placeholder="Nom ou société" /></div>
            {canViewCosts && <div className="form-group"><label>Coût (€)</label><input type="number" step="0.01" value={intervModal.cout} onChange={e => setIntervModal({ ...intervModal, cout: e.target.value })} /></div>}
            <div className="form-group"><label>Kilométrage relevé</label><input type="number" step="1" value={intervModal.kilometrage} onChange={e => setIntervModal({ ...intervModal, kilometrage: e.target.value })} placeholder="ex. 45000" /></div>
            <div className="form-group"><label>Nombre d'heures</label><input type="number" step="0.1" value={intervModal.heures} onChange={e => setIntervModal({ ...intervModal, heures: e.target.value })} placeholder="ex. 1250.5" /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Prochain RDV d'entretien</label>
              <input type="date" value={intervModal.prochain_rdv || ''} onChange={e => setIntervModal({ ...intervModal, prochain_rdv: e.target.value })} />
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Observation</label>
              <textarea rows={2} value={intervModal.observation} onChange={e => setIntervModal({ ...intervModal, observation: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function KpiCard({ label, value, color }) {
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem', textAlign: 'center', borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: '.68rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '.2rem' }}>{label}</div>
      <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.3rem', color }}>{value}</div>
    </div>
  )
}

const td = { padding: '.65rem .9rem', borderBottom: '1px solid var(--border)' }
