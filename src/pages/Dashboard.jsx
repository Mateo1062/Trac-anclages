import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import InterventionEditModal from '../components/InterventionEditModal'
import InterventionChampEditModal from '../components/InterventionChampEditModal'
import Modal from '../components/Modal'
import PhotoLightbox from '../components/PhotoLightbox'
import { phytoDisplayName } from '../lib/phytoNames'
import { intervTypeLabel } from '../lib/interventionLabels'
import { groupInterventionsByEvent } from '../lib/groupInterventions'
import { num, fmtDate, fmtDateFull, fmtEur, gridStyle, Card, Empty, Rows, KpiStrip, DetailModal, Sparkline, RefreshButton } from '../components/DashboardUI'

/* ─────────────────────────────────────────────────────────
   Tableaux de bord — un par espace de travail. Mêmes composants visuels
   (DashboardUI) que le Tableau de bord salarié restreint : une seule et
   même interface pour tout le monde, seul le contenu affiché change selon
   les restrictions de chacun.
───────────────────────────────────────────────────────── */

export function DashboardAgricole() {
  const { perms, canViewRendement, canViewCosts } = useAuth()
  const [d, setD] = useState(null)
  const [detail, setDetail] = useState(null)
  const [editingInterv, setEditingInterv] = useState(null) // { type, intervention }
  const [editingChamp, setEditingChamp] = useState(null) // évènement interventions_phyto (groupInterventionsByEvent)
  const [editingMapPoint, setEditingMapPoint] = useState(null) // intervention_points (marquée directement sur la Carte)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    const [interventions, moisson, plants, entretiens, outils, pesees, parcelles, phyto, entretiensVehicules, vehicules, entretiensBatiments, batiments, profiles, mapPoints] = await Promise.all([
      // Limite plus large que le nombre d'évènements affichés (30) : un même évènement
      // terrain (une visite = souvent plusieurs produits) tient sur plusieurs lignes —
      // le regroupement se fait après coup (groupInterventionsByEvent).
      supabase.from('interventions_phyto').select('*').order('date', { ascending: false }).limit(120),
      supabase.from('cereales_moisson').select('*'),
      supabase.from('plants_pdt').select('*').order('date', { ascending: false }).limit(8),
      supabase.from('interventions_outils').select('*').order('date', { ascending: false }).limit(30),
      supabase.from('outils_agricoles').select('id,nom'),
      supabase.from('pdt_recolte_pesees').select('*'),
      supabase.from('parcelles').select('id,nom,surface,culture_actuelle'),
      supabase.from('db_phyto').select('*').not('stock_actuel', 'is', null),
      supabase.from('interventions_vehicules').select('*').order('date', { ascending: false }).limit(30),
      supabase.from('vehicules_entretien').select('id,nom'),
      supabase.from('interventions_batiments').select('*').order('date', { ascending: false }).limit(30),
      supabase.from('batiments_agricoles').select('id,nom'),
      supabase.from('profiles').select('id,display_name'),
      // Points d'intervention marqués directement sur la Carte (hors parcelle/outil) —
      // table éventuellement pas encore créée (migration_A_EXECUTER_63.sql), pas bloquant.
      supabase.from('intervention_points').select('*').order('date_intervention', { ascending: false }).limit(10),
    ])
    setD({
      interventions: interventions.data || [], moisson: moisson.data || [], plants: plants.data || [],
      entretiens: entretiens.data || [], outils: Object.fromEntries((outils.data || []).map(o => [o.id, o.nom])),
      pesees: pesees.data || [], parcelles: parcelles.data || [], phyto: phyto.data || [],
      entretiensVehicules: entretiensVehicules.data || [], vehicules: Object.fromEntries((vehicules.data || []).map(v => [v.id, v.nom])),
      entretiensBatiments: entretiensBatiments.data || [], batiments: Object.fromEntries((batiments.data || []).map(b => [b.id, b.nom])),
      profiles: profiles.data || [], mapPoints: mapPoints.error ? [] : (mapPoints.data || []),
    })
    if (isRefresh) setRefreshing(false)
  }
  useEffect(() => { load() }, [])

  function applyLocalUpdate(updated) {
    setD(prev => ({
      ...prev,
      entretiens: prev.entretiens.map(x => x.id === updated.id ? { ...x, ...updated } : x),
      entretiensVehicules: prev.entretiensVehicules.map(x => x.id === updated.id ? { ...x, ...updated } : x),
      entretiensBatiments: prev.entretiensBatiments.map(x => x.id === updated.id ? { ...x, ...updated } : x),
    }))
  }
  function applyLocalDelete(id) {
    setD(prev => ({
      ...prev,
      entretiens: prev.entretiens.filter(x => x.id !== id),
      entretiensVehicules: prev.entretiensVehicules.filter(x => x.id !== id),
      entretiensBatiments: prev.entretiensBatiments.filter(x => x.id !== id),
    }))
  }

  async function saveMapPoint() {
    const e = editingMapPoint
    const payload = { date_intervention: e.date_intervention || null, description: e.description?.trim() || null, notes: e.notes?.trim() || null }
    const { error } = await supabase.from('intervention_points').update(payload).eq('id', e.id)
    if (error) { alert(error.message); return }
    setD(prev => ({ ...prev, mapPoints: prev.mapPoints.map(p => p.id === e.id ? { ...p, ...payload } : p) }))
    setEditingMapPoint(null)
  }
  async function deleteMapPoint() {
    if (!confirm('Supprimer ce point ?')) return
    const { error } = await supabase.from('intervention_points').delete().eq('id', editingMapPoint.id)
    if (error) { alert(error.message); return }
    setD(prev => ({ ...prev, mapPoints: prev.mapPoints.filter(p => p.id !== editingMapPoint.id) }))
    setEditingMapPoint(null)
  }

  if (!d) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement du tableau de bord…</div>

  const today = new Date().toISOString().split('T')[0]
  const in30j = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]

  const moissonParCulture = Object.values(d.moisson.reduce((map, m) => {
    const k = (m.culture || '?').trim().toUpperCase()
    if (!map[k]) map[k] = { culture: m.culture, kg: 0, nb: 0, parcelleIds: new Set() }
    map[k].kg += num(m.poids_net); map[k].nb++
    if (m.parcelle_id) map[k].parcelleIds.add(m.parcelle_id)
    return map
  }, {})).map(r => {
    const surface = [...r.parcelleIds].reduce((s, id) => s + num(d.parcelles.find(p => p.id === id)?.surface), 0)
    return { ...r, surface, rdt: surface ? (r.kg / 100) / surface : null }
  }).sort((a, b) => b.kg - a.kg)

  const pdtKg = d.pesees.reduce((s, p) => s + num(p.poids_net), 0)
  const pdtParcelles = [...new Set(d.pesees.map(p => p.parcelle_id).filter(Boolean))]
  const pdtSurface = pdtParcelles.reduce((s, id) => s + num(d.parcelles.find(p => p.id === id)?.surface), 0)
  const pdtPalox = d.pesees.reduce((s, p) => s + num(p.nb_palox), 0)

  const entretiensDus = d.entretiens.filter(e => e.prochain_rdv && e.prochain_rdv <= in30j)
    .sort((a, b) => (a.prochain_rdv || '').localeCompare(b.prochain_rdv || ''))
  // Interventions outils signalées mais qui ne peuvent pas être faites dans
  // l'immédiat (pièce manquante, dispo atelier…) — voir OutilsAgricoles.jsx.
  const interventionsEnAttente = d.entretiens.filter(e => e.en_attente)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  // Planifiées mais pas encore commencées — distinct de "en attente" (bloqué).
  const interventionsAFaire = d.entretiens.filter(e => e.a_faire)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  // Même chose côté Entretien global (véhicules/matériel hors outils agricoles).
  const entretiensVehiculesEnAttente = d.entretiensVehicules.filter(e => e.en_attente)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  // Et côté Bâtiment.
  const batimentsEnAttente = d.entretiensBatiments.filter(e => e.en_attente)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  const phytoBas = d.phyto.filter(p => num(p.stock_actuel) <= 10).sort((a, b) => num(a.stock_actuel) - num(b.stock_actuel))
  const moissonTotalT = d.moisson.reduce((s, m) => s + num(m.poids_net), 0) / 1000

  // Une visite terrain = souvent plusieurs produits appliqués ensemble (ex. un
  // mélange de plusieurs phytos) — regroupés en un seul évènement (une seule ligne
  // dans "Dernières interventions"), modifiable en un clic (tous les produits +
  // date + sous-type/défanage) via InterventionChampEditModal.
  const interventionEvents = groupInterventionsByEvent(d.interventions)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 30)

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '.9rem 1.1rem' }}>
      <div style={{ display: 'flex', marginBottom: '.6rem' }}>
        <RefreshButton onClick={() => load(true)} loading={refreshing} />
      </div>
      <KpiStrip kpis={[
        ...(canViewRendement ? [
          { value: `${moissonTotalT.toFixed(0)} T`, label: 'moisson totale' },
          { value: `${(pdtKg / 1000).toFixed(0)} T`, label: 'PDT récoltées' },
          { value: pdtSurface ? `${((pdtKg / 1000) / pdtSurface).toFixed(1)} t/ha` : '—', label: 'rendement PDT' },
        ] : []),
        { value: entretiensDus.length + phytoBas.length + interventionsEnAttente.length + interventionsAFaire.length + entretiensVehiculesEnAttente.length + batimentsEnAttente.length, label: 'alertes actives' },
      ]} />
      <div style={gridStyle}>
        {interventionsEnAttente.length > 0 && (
          <Card icon="⏳" title="Interventions outils en attente" alert count={interventionsEnAttente.length}>
            <Rows onDetail={setDetail} onPhotos={setLightboxPhotos} rows={interventionsEnAttente.map(e => ({
              date: fmtDate(e.date), main: `${d.outils[e.outil_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: '⏳ en attente', badgeBg: 'var(--amber-pale)', badgeColor: 'var(--amber)',
              photos: e.photos,
              onClick: () => setEditingInterv({ type: 'outil', intervention: e }),
            }))} />
          </Card>
        )}
        {interventionsAFaire.length > 0 && (
          <Card icon="📋" title="Interventions outils à faire prochainement" alert count={interventionsAFaire.length}>
            <Rows onDetail={setDetail} onPhotos={setLightboxPhotos} rows={interventionsAFaire.map(e => ({
              date: fmtDate(e.date), main: `${d.outils[e.outil_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: '📋 à faire prochainement', badgeBg: '#dbeafe', badgeColor: 'var(--blue, #2563eb)',
              photos: e.photos,
              onClick: () => setEditingInterv({ type: 'outil', intervention: e }),
            }))} />
          </Card>
        )}
        {entretiensVehiculesEnAttente.length > 0 && (
          <Card icon="⏳" title="Entretien global — interventions en attente" alert count={entretiensVehiculesEnAttente.length}>
            <Rows onDetail={setDetail} rows={entretiensVehiculesEnAttente.map(e => ({
              date: fmtDate(e.date), main: `${d.vehicules[e.vehicule_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: '⏳ en attente', badgeBg: 'var(--amber-pale)', badgeColor: 'var(--amber)',
              onClick: () => setEditingInterv({ type: 'vehicule', intervention: e }),
            }))} />
          </Card>
        )}
        {batimentsEnAttente.length > 0 && (
          <Card icon="⏳" title="Bâtiment — interventions en attente" alert count={batimentsEnAttente.length}>
            <Rows onDetail={setDetail} onPhotos={setLightboxPhotos} rows={batimentsEnAttente.map(e => ({
              date: fmtDate(e.date), main: `${d.batiments[e.batiment_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: '⏳ en attente', badgeBg: 'var(--amber-pale)', badgeColor: 'var(--amber)',
              photos: e.photos,
              onClick: () => setEditingInterv({ type: 'batiment', intervention: e }),
            }))} />
          </Card>
        )}
        {entretiensDus.length > 0 && (
          <Card icon="🔧" title="Alerte — entretiens à prévoir" alert count={entretiensDus.length}>
            <Rows onDetail={setDetail} rows={entretiensDus.map(e => ({
              date: fmtDate(e.prochain_rdv), main: `${d.outils[e.outil_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: e.prochain_rdv < today ? '⚠️ dépassé' : 'bientôt',
              badgeBg: 'var(--amber-pale)', badgeColor: 'var(--amber)',
              detail: { title: `Entretien à prévoir — ${d.outils[e.outil_id] || ''}`, fields: [
                ['Outil', d.outils[e.outil_id]], ['Prochain RDV', fmtDateFull(e.prochain_rdv)],
                ['Dernier entretien', fmtDateFull(e.date)], ['Type', e.type_interv], ['Description', e.description],
                ['Intervenant', e.intervenant], ['Observation', e.observation],
              ]},
            }))} />
          </Card>
        )}
        {phytoBas.length > 0 && (
          <Card icon="🧪" title="Alerte — stocks phyto bas" alert count={phytoBas.length}>
            <Rows onDetail={setDetail} rows={phytoBas.map(p => ({
              date: '', main: phytoDisplayName(p),
              badge: num(p.stock_actuel) <= 0 ? '❌ épuisé' : '⚠️ faible',
              badgeBg: 'var(--amber-pale)', badgeColor: num(p.stock_actuel) <= 0 ? 'var(--red)' : 'var(--amber)',
              right: `${num(p.stock_actuel)} ${p.stock_unite || ''}`,
              detail: { title: `Stock — ${phytoDisplayName(p)}`, fields: [
                ['Produit', phytoDisplayName(p)], ['Stock actuel', `${num(p.stock_actuel)} ${p.stock_unite || ''}`],
                ['N° AMM', p.num_amm], ['Substance active', p.substance_active], ['Usage', p.usage],
              ]},
            }))} />
          </Card>
        )}

        <Card icon="🧪" title="Dernières interventions" count={interventionEvents.length}>
          {interventionEvents.length === 0 ? <Empty>Aucune intervention.</Empty> : (
            <Rows onPhotos={setLightboxPhotos} rows={interventionEvents.map(ev => ({
              date: fmtDate(ev.date), main: `${intervTypeLabel(ev)} — ${ev.parcelle || '—'}`,
              right: ev.items.length > 1 ? `${ev.items.length} produits` : null,
              photos: ev.items.flatMap(it => it.photos || []),
              onClick: () => setEditingChamp(ev),
            }))} />
          )}
        </Card>

        {(() => {
          const vehiculesValides = d.entretiensVehicules.filter(e => e.valide !== false && !e.en_attente)
          return (
            <Card icon="🚜" title="Entretien global" count={Math.min(vehiculesValides.length, 6)}>
              {vehiculesValides.length === 0 ? <Empty>Aucune intervention validée.</Empty> : (
                <Rows onDetail={setDetail} rows={vehiculesValides.slice(0, 6).map(e => ({
                  date: fmtDate(e.date), main: `${d.vehicules[e.vehicule_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
                  right: (canViewCosts && e.cout) ? fmtEur(e.cout) : null,
                  onClick: () => setEditingInterv({ type: 'vehicule', intervention: e }),
                }))} />
              )}
            </Card>
          )
        })()}

        <Card icon="🔧" title="Interventions (depuis la Carte)" count={d.mapPoints.length}>
          {d.mapPoints.length === 0 ? <Empty>Aucune intervention marquée sur la carte.</Empty> : (
            <Rows rows={d.mapPoints.map(p => ({
              date: fmtDate(p.date_intervention), main: p.description || 'Intervention',
              onClick: () => setEditingMapPoint(p),
            }))} />
          )}
        </Card>

        {canViewRendement && (
        <Card icon="🌾" title="Récap moisson" count={moissonParCulture.length}>
          {moissonParCulture.length === 0 ? <Empty>Aucune entrée de moisson.</Empty> : (
            <Rows onDetail={setDetail} rows={moissonParCulture.map(r => ({
              date: '', main: r.culture,
              badge: r.rdt ? `${r.rdt.toFixed(1)} qx/ha` : null,
              right: `${(r.kg / 1000).toFixed(1)} T`,
              detail: { title: `Moisson — ${r.culture}`, fields: [
                ['Culture', r.culture], ['Total récolté', `${(r.kg / 1000).toFixed(2)} T`],
                ['Bennes', r.nb], ['Parcelles', r.parcelleIds.size],
                ['Surface', r.surface ? `${r.surface.toFixed(2)} ha` : null],
                ['Rendement', r.rdt ? `${r.rdt.toFixed(1)} qx/ha` : null],
              ]},
            }))} />
          )}
        </Card>
        )}

        {canViewRendement && (
        <Card icon="🥔" title="Rendements PDT (récolte)">
          {d.pesees.length === 0 ? <Empty>Aucune pesée de récolte.</Empty> : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.4rem', textAlign: 'center', padding: '.4rem .2rem' }}>
              {[[`${(pdtKg / 1000).toFixed(1)} T`, 'récoltées'], [pdtSurface ? `${((pdtKg / 1000) / pdtSurface).toFixed(1)} t/ha` : '—', 'rendement'], [pdtPalox, 'palox']].map(([v, l], i) => (
                <div key={i}>
                  <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--green-mid)' }}>{v}</div>
                  <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{l}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
        )}

        <Card icon="🌱" title="Plants PDT — mouvements" count={d.plants.length}>
          {d.plants.length === 0 ? <Empty>Aucun mouvement de plants.</Empty> : (
            <Rows onDetail={setDetail} rows={d.plants.map(p => ({
              date: fmtDate(p.date), main: `${p.variete || '—'}${p.calibre ? ' · ' + p.calibre : ''}`,
              badge: p.type === 'entree' ? '↓ Entrée' : p.type === 'retour' ? '↩ Retour' : '↑ Sortie',
              badgeBg: p.type === 'sortie' ? 'var(--amber-pale)' : 'var(--green-pale)',
              badgeColor: p.type === 'sortie' ? 'var(--amber)' : 'var(--green-mid)',
              right: p.quantite ? `${num(p.quantite)} ${p.unite || 'kg'}` : null,
              detail: { title: `${p.type === 'entree' ? 'Entrée' : p.type === 'retour' ? 'Retour' : 'Sortie'} plants — ${p.variete || ''}`, fields: [
                ['Date', fmtDateFull(p.date)], ['Variété', p.variete], ['Calibre', p.calibre], ['Lot', p.lot],
                ['Quantité', p.quantite ? `${p.quantite} ${p.unite || 'kg'}` : null], ['Agriculteur', p.agri_nom],
                ['Fournisseur', p.fournisseur], ['Réf. chargement', p.ref_chargement],
                ['Prix unitaire', p.prix_unitaire ? `${p.prix_unitaire} €` : null], ['Observation', p.observation],
              ]},
            }))} />
          )}
        </Card>

        {(() => {
          const entretiensValides = d.entretiens.filter(e => e.valide !== false && !e.en_attente)
          return (
            <Card icon="🔧" title="Derniers entretiens outils" count={Math.min(entretiensValides.length, 6)}>
              {entretiensValides.length === 0 ? <Empty>Aucun entretien validé.</Empty> : (
                <Rows onDetail={setDetail} onPhotos={setLightboxPhotos} rows={entretiensValides.slice(0, 6).map(e => ({
                  date: fmtDate(e.date), main: `${d.outils[e.outil_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
                  right: (canViewCosts && e.cout) ? fmtEur(e.cout) : null,
                  photos: e.photos,
                  onClick: () => setEditingInterv({ type: 'outil', intervention: e }),
                }))} />
              )}
            </Card>
          )
        })()}

        {(() => {
          const batimentsValides = d.entretiensBatiments.filter(e => e.valide !== false && !e.en_attente)
          return (
            <Card icon="🏚️" title="Interventions bâtiments" count={Math.min(batimentsValides.length, 6)}>
              {batimentsValides.length === 0 ? <Empty>Aucune intervention validée.</Empty> : (
                <Rows onDetail={setDetail} onPhotos={setLightboxPhotos} rows={batimentsValides.slice(0, 6).map(e => ({
                  date: fmtDate(e.date), main: `${d.batiments[e.batiment_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
                  right: (canViewCosts && e.cout) ? fmtEur(e.cout) : null,
                  photos: e.photos,
                  onClick: () => setEditingInterv({ type: 'batiment', intervention: e }),
                }))} />
              )}
            </Card>
          )
        })()}
      </div>

      {editingInterv && (
        <InterventionEditModal
          type={editingInterv.type}
          intervention={editingInterv.intervention}
          profiles={d.profiles}
          hideCout={!canViewCosts}
          onClose={() => setEditingInterv(null)}
          onSaved={applyLocalUpdate}
          onDeleted={applyLocalDelete}
        />
      )}
      {editingChamp && (
        <InterventionChampEditModal
          event={editingChamp}
          onClose={() => setEditingChamp(null)}
          onSaved={() => load(true)}
          onDeleted={() => load(true)}
        />
      )}
      {editingMapPoint && (
        <Modal title="Intervention (Carte)" onClose={() => setEditingMapPoint(null)} onSave={saveMapPoint} onDelete={deleteMapPoint} maxWidth={420}>
          <div style={{ display: 'grid', gap: '.8rem' }}>
            <div className="form-group"><label>Date</label>
              <input type="date" value={editingMapPoint.date_intervention || ''} onChange={e => setEditingMapPoint({ ...editingMapPoint, date_intervention: e.target.value })} />
            </div>
            <div className="form-group"><label>Description</label>
              <input autoFocus value={editingMapPoint.description || ''} onChange={e => setEditingMapPoint({ ...editingMapPoint, description: e.target.value })} />
            </div>
            <div className="form-group"><label>Notes</label>
              <textarea rows={3} value={editingMapPoint.notes || ''} onChange={e => setEditingMapPoint({ ...editingMapPoint, notes: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
            <div style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>📍 Position modifiable depuis la Carte (glisser le point).</div>
          </div>
        </Modal>
      )}
      {lightboxPhotos && <PhotoLightbox photos={lightboxPhotos} onClose={() => setLightboxPhotos(null)} />}
      {detail && <DetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

/* ════════════════ FRIGO (tableau de bord salarié restreint) ════════════════
   Rôle sans accès à un espace de travail complet : uniquement les
   interventions agricoles (parcelles), Entretien global (véhicules/matériel)
   et Bâtiment — rien d'autre (pas de stock, moisson, PDT, planning…). */
export function DashboardFrigo() {
  const [d, setD] = useState(null)
  const [editingInterv, setEditingInterv] = useState(null) // { type, intervention }
  const [editingChamp, setEditingChamp] = useState(null)
  const [lightboxPhotos, setLightboxPhotos] = useState(null)
  const [refreshing, setRefreshing] = useState(false)

  async function load(isRefresh = false) {
    if (isRefresh) setRefreshing(true)
    const [interventions, entretiensVehicules, entretiensBatiments, vehicules, batiments, profiles] = await Promise.all([
      supabase.from('interventions_phyto').select('*').order('date', { ascending: false }).limit(60),
      supabase.from('interventions_vehicules').select('*').order('date', { ascending: false }).limit(20),
      supabase.from('interventions_batiments').select('*').order('date', { ascending: false }).limit(20),
      supabase.from('vehicules_entretien').select('id,nom'),
      supabase.from('batiments_agricoles').select('id,nom'),
      supabase.from('profiles').select('id,display_name'),
    ])
    setD({
      interventions: interventions.data || [],
      entretiensVehicules: entretiensVehicules.data || [],
      entretiensBatiments: entretiensBatiments.data || [],
      vehicules: Object.fromEntries((vehicules.data || []).map(v => [v.id, v.nom])),
      batiments: Object.fromEntries((batiments.data || []).map(b => [b.id, b.nom])),
      profiles: profiles.data || [],
    })
    if (isRefresh) setRefreshing(false)
  }
  useEffect(() => { load() }, [])

  function applyLocalUpdate(updated) {
    setD(prev => ({
      ...prev,
      entretiensVehicules: prev.entretiensVehicules.map(x => x.id === updated.id ? { ...x, ...updated } : x),
      entretiensBatiments: prev.entretiensBatiments.map(x => x.id === updated.id ? { ...x, ...updated } : x),
    }))
  }
  function applyLocalDelete(id) {
    setD(prev => ({
      ...prev,
      entretiensVehicules: prev.entretiensVehicules.filter(x => x.id !== id),
      entretiensBatiments: prev.entretiensBatiments.filter(x => x.id !== id),
    }))
  }

  if (!d) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement du tableau de bord…</div>

  const interventionEvents = groupInterventionsByEvent(d.interventions)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 15)

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '.9rem 1.1rem' }}>
      <div style={{ display: 'flex', marginBottom: '.6rem' }}>
        <RefreshButton onClick={() => load(true)} loading={refreshing} />
      </div>
      <div style={gridStyle}>
        <Card icon="🧪" title="Interventions agricoles" count={interventionEvents.length}>
          {interventionEvents.length === 0 ? <Empty>Aucune intervention.</Empty> : (
            <Rows onPhotos={setLightboxPhotos} rows={interventionEvents.map(ev => ({
              date: fmtDate(ev.date), main: `${intervTypeLabel(ev)} — ${ev.parcelle || '—'}`,
              right: ev.items.length > 1 ? `${ev.items.length} produits` : null,
              photos: ev.items.flatMap(it => it.photos || []),
              onClick: () => setEditingChamp(ev),
            }))} />
          )}
        </Card>

        <Card icon="🚜" title="Entretien global" count={d.entretiensVehicules.length}>
          {d.entretiensVehicules.length === 0 ? <Empty>Aucune intervention.</Empty> : (
            <Rows rows={d.entretiensVehicules.map(e => ({
              date: fmtDate(e.date), main: `${d.vehicules[e.vehicule_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: e.en_attente ? '⏳ en attente' : (e.valide !== false ? '✅ effectuée' : null),
              badgeBg: e.en_attente ? 'var(--amber-pale)' : 'var(--green-pale)',
              badgeColor: e.en_attente ? 'var(--amber)' : 'var(--green-mid)',
              onClick: () => setEditingInterv({ type: 'vehicule', intervention: e }),
            }))} />
          )}
        </Card>

        <Card icon="🏚️" title="Bâtiment" count={d.entretiensBatiments.length}>
          {d.entretiensBatiments.length === 0 ? <Empty>Aucune intervention.</Empty> : (
            <Rows onPhotos={setLightboxPhotos} rows={d.entretiensBatiments.map(e => ({
              date: fmtDate(e.date), main: `${d.batiments[e.batiment_id] || '—'} — ${[e.type_interv, e.description].filter(Boolean).join(' · ')}`,
              badge: e.en_attente ? '⏳ en attente' : (e.valide !== false ? '✅ effectuée' : null),
              badgeBg: e.en_attente ? 'var(--amber-pale)' : 'var(--green-pale)',
              badgeColor: e.en_attente ? 'var(--amber)' : 'var(--green-mid)',
              photos: e.photos,
              onClick: () => setEditingInterv({ type: 'batiment', intervention: e }),
            }))} />
          )}
        </Card>
      </div>

      {editingInterv && (
        <InterventionEditModal
          type={editingInterv.type}
          intervention={editingInterv.intervention}
          profiles={d.profiles}
          hideCout
          onClose={() => setEditingInterv(null)}
          onSaved={applyLocalUpdate}
          onDeleted={applyLocalDelete}
        />
      )}
      {editingChamp && (
        <InterventionChampEditModal
          event={editingChamp}
          onClose={() => setEditingChamp(null)}
          onSaved={() => load(true)}
          onDeleted={() => load(true)}
        />
      )}
      {lightboxPhotos && <PhotoLightbox photos={lightboxPhotos} onClose={() => setLightboxPhotos(null)} />}
    </div>
  )
}
