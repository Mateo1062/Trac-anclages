import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import useIsMobile from '../lib/useIsMobile'
import DossiersParcelles from '../components/DossiersParcelles'
import Modal from '../components/Modal'
import { phytoDisplayName } from '../lib/phytoNames'
import { fmtDate } from '../lib/formatDate'

// Types d'intervention saisis depuis la Carte — voir Carte.jsx TYPES_INTERVENTION.
const TYPE_ICON = {
  'Traitement et protection des cultures': '🧪',
  'Ferti minérale et foliaire': '🌱',
  'Plantation': '🌾',
  'Semis': '🌰',
  'Fertilisation et amendement organique': '💩',
  'Désherbage mécanique': '🌿',
  'Travail du sol': '🚜',
  'Récolte': '🚛',
  'Irrigation': '💧',
  'Moisson': '🌾',
  'Récolte PDT': '🥔',
}

export default function MesParcelles() {
  const isMobile = useIsMobile()
  const { campagneActive } = useCampagne()
  const [loading, setLoading] = useState(true)
  const [parcelles, setParcelles] = useState([])
  const [events, setEvents] = useState([])
  const [doseSuiviByParcelle, setDoseSuiviByParcelle] = useState({})
  const [profiles, setProfiles] = useState([]) // pour afficher qui a saisi une intervention
  const [dossierId, setDossierId] = useState(null)
  const [search, setSearch] = useState('')
  const [detailEvent, setDetailEvent] = useState(null)

  useEffect(() => { loadAll() }, [campagneActive])

  // Même convention que Céréales/Récolte PDT : une ligne sans campagne (saisie
  // avant l'existence de ce champ) est rattachée à la campagne courante par
  // défaut, plutôt que d'être filtrée côté serveur (où elle serait exclue à
  // tort par un simple .eq('campagne', ...) puisque NULL n'égale jamais rien).
  // PostgREST plafonne à 1000 lignes par requête — sans pagination, une table
  // qui dépasse ce total (interventions_phyto en a plus de 11 000 maintenant)
  // ne renvoyait que les 1000 premières lignes, souvent les plus anciennes :
  // la campagne active pouvait alors sembler presque vide alors que ses
  // données existent bien, juste hors de cette première page.
  async function loadScoped(table, columns) {
    const all = []
    for (let page = 0; ; page++) {
      const { data, error } = await supabase.from(table).select(columns).range(page * 1000, page * 1000 + 999)
      if (error || !data) break
      all.push(...data)
      if (data.length < 1000) break
    }
    return all.filter(r => (r.campagne || defaultCampagne()) === campagneActive)
  }

  async function loadAll() {
    setLoading(true)
    const [pa, iv, mo, re, ph, profilesData] = await Promise.all([
      supabase.from('parcelles').select('id,nom,surface,entite,culture_actuelle,campagne').order('nom').then(r => (r.data || []).filter(p => (p.campagne || defaultCampagne()) === campagneActive)),
      loadScoped('interventions_phyto', '*'),
      loadScoped('cereales_moisson', '*'),
      loadScoped('pdt_recolte_pesees', '*'),
      supabase.from('profiles').select('id,display_name').then(r => r.data || []),
      // dose_max_campagne peut ne pas exister si migration_A_EXECUTER_48.sql n'a pas
      // encore été exécutée — on retente sans cette colonne dans ce cas (le suivi de
      // dépassement de dose ne s'affiche simplement pas).
      supabase.from('db_phyto').select('id,nom,nom_secondaire,num_amm,categorie,dose_max_campagne,stock_unite').then(async r => {
        if (r.error && /dose_max_campagne|nom_secondaire|column/i.test(r.error.message)) {
          return (await supabase.from('db_phyto').select('id,nom,num_amm,categorie')).data || []
        }
        return r.data || []
      }),
    ])
    setParcelles(pa)

    const dbPhytoById = Object.fromEntries(ph.map(p => [p.id, p]))
    // Repli par nom : la quasi-totalité des interventions existantes ont été
    // saisies en tapant le nom du produit sans cliquer la suggestion de la liste
    // (produit_id resté vide) — sans ce repli, la vérification EPHY ne s'affichait
    // donc jamais en pratique, même si le code existait.
    const dbPhytoByName = Object.fromEntries(ph.map(p => [(p.nom || '').trim().toLowerCase(), p]))
    const ammsToCheck = [...new Set(ph.map(p => (p.num_amm || '').trim()).filter(Boolean))]
    let ephyByAmm = {}
    if (ammsToCheck.length) {
      // delai_rentree_h peut ne pas exister si migration_A_EXECUTER_39.sql n'a pas
      // encore été exécutée — on retente sans cette colonne dans ce cas.
      let { data: ephyRows, error: ephyErr } = await supabase.from('ephy_produits').select('numero_amm,etat_autorisation,delai_rentree_h').in('numero_amm', ammsToCheck)
      if (ephyErr && /delai_rentree_h|column/i.test(ephyErr.message)) {
        ;({ data: ephyRows } = await supabase.from('ephy_produits').select('numero_amm,etat_autorisation').in('numero_amm', ammsToCheck))
      }
      ephyByAmm = Object.fromEntries((ephyRows || []).map(e => [e.numero_amm, e]))
    }

    function homologationFor(row) {
      const prod = row.produit_id ? dbPhytoById[row.produit_id] : dbPhytoByName[(row.produit_nom || '').trim().toLowerCase()]
      if (!prod) return null // pas un produit reconnu (Travail du sol, Récolte, Irrigation… ou nom introuvable dans la base)
      if ((prod.categorie || 'phyto') !== 'phyto') return null // oligo-élément : pas d'AMM à vérifier
      if (!prod.num_amm?.trim()) return { status: 'inconnu', label: "N° AMM non renseigné", delaiH: null }
      const ephy = ephyByAmm[prod.num_amm.trim()]
      if (!ephy) return { status: 'inconnu', label: 'AMM introuvable dans EPHY', delaiH: null }
      // delai_rentree_h : extrait automatiquement du texte libre EPHY — null si non
      // trouvé/ambigu (pas "aucun délai requis") ; affiché quel que soit le statut
      // d'homologation, le délai physique reste réel même sur un produit retiré.
      const delaiH = ephy.delai_rentree_h ?? null
      if (ephy.etat_autorisation === 'AUTORISE') return { status: 'ok', label: 'Homologué', delaiH }
      return { status: 'retire', label: `Retiré${ephy.etat_autorisation ? ` (${ephy.etat_autorisation})` : ''}`, delaiH }
    }

    // Un traitement phyto/ferti dont le produit n'est pas confirmé homologué
    // (retiré, AMM introuvable, ou produit inconnu du catalogue) ne s'affiche
    // pas dans le détail — l'événement en lui-même reste réel, mais on ne veut
    // pas laisser croire qu'un produit non vérifié a été correctement utilisé.
    // Les autres types (mécanisation, ferti organique...) n'ont pas d'AMM à
    // vérifier de toute façon et restent toujours affichés.
    const PHYTO_OBSERVATION_TYPES = new Set(['Traitement et protection des cultures', 'Ferti minérale et foliaire'])
    const evInterventions = iv
      .map(r => ({ raw: r, homologation: homologationFor(r) }))
      .filter(({ raw, homologation }) => !(PHYTO_OBSERVATION_TYPES.has(raw.observation) && homologation?.status !== 'ok'))
      .map(({ raw: r, homologation }) => ({
        id: `iv-${r.id}`, date: r.date, type: r.observation || 'Intervention',
        parcelle_id: r.parcelle_id, parcelle_nom: r.parcelle,
        detail: r.produit_nom ? `${r.produit_nom}${r.quantite != null ? ` — ${r.quantite} ${r.unite || ''}` : ''}` : (r.sous_type || ''),
        surface_ha: r.surface_ha, homologation, raw: r,
      }))
    const evMoisson = mo.map(r => ({
      id: `mo-${r.id}`, date: r.date, type: 'Moisson',
      parcelle_id: r.parcelle_id, parcelle_nom: r.parcelle_nom,
      detail: `${r.culture || ''}${r.poids_net != null ? ` — ${(r.poids_net / 1000).toFixed(2)} t nettes` : ''}`,
      surface_ha: null, homologation: null, raw: r,
    }))
    const evRecolte = re.map(r => ({
      id: `re-${r.id}`, date: r.date, type: 'Récolte PDT',
      parcelle_id: r.parcelle_id, parcelle_nom: r.parcelle_nom,
      detail: `${r.variete || ''}${r.poids_net != null ? ` — ${(r.poids_net / 1000).toFixed(2)} t nettes` : ''}${r.nb_palox ? ` (${r.nb_palox} palox)` : ''}`,
      surface_ha: r.surface_ha, homologation: null, raw: r,
    }))

    setEvents([...evInterventions, ...evMoisson, ...evRecolte].sort((a, b) => (b.date || '').localeCompare(a.date || '')))

    // Suivi de dose homologuée par campagne (ex. Revus/Revus Top : 6 L/ha toutes
    // interventions confondues) — dose_max_campagne saisie à la main dans Base de
    // données > Phytosanitaires (migration_A_EXECUTER_48.sql). Le cumul réel est la
    // SOMME des doses/ha de chaque passage (pas une moyenne) : 3 passages à 2 L/ha
    // = 6 L/ha cumulés, exactement comme la réglementation DMA. Alerte seulement —
    // aucun réajustement des quantités réellement enregistrées.
    const paById = Object.fromEntries(pa.map(p => [p.id, p]))
    const doseMap = {} // parcelle_id -> { [produit.id]: { nom, unite, max, cumul } }
    for (const r of iv) {
      if (!r.parcelle_id || r.quantite == null) continue
      const prod = r.produit_id ? dbPhytoById[r.produit_id] : dbPhytoByName[(r.produit_nom || '').trim().toLowerCase()]
      if (!prod || (prod.categorie || 'phyto') !== 'phyto' || prod.dose_max_campagne == null) continue
      const surface = r.surface_ha || paById[r.parcelle_id]?.surface
      if (!surface) continue
      const doseHa = r.quantite / surface
      doseMap[r.parcelle_id] ??= {}
      const cur = doseMap[r.parcelle_id][prod.id] ??= { nom: phytoDisplayName(prod), unite: prod.stock_unite || '', max: prod.dose_max_campagne, cumul: 0 }
      cur.cumul += doseHa
    }
    setDoseSuiviByParcelle(Object.fromEntries(Object.entries(doseMap).map(([pid, produits]) => [pid, Object.values(produits)])))
    setProfiles(profilesData)
    setLoading(false)
  }

  function entryParcelleId(e) { return e.parcelle_id }

  function renderStats(parc, rows) {
    const nbPhyto = rows.filter(r => r.homologation).length
    const nbRetires = rows.filter(r => r.homologation?.status === 'retire').length
    return [
      { label: 'Événements', value: rows.length },
      { label: 'Produits phyto', value: nbPhyto },
      { label: 'Non homologués', value: nbRetires, accent: nbRetires === 0 },
    ]
  }

  function nameOf(id) { return profiles.find(p => p.id === id)?.display_name || '—' }

  function renderRow(e) {
    return [
      fmtDate(e.date),
      <span key="type">{TYPE_ICON[e.type] || '📋'} {e.type}</span>,
      e.detail || '–',
      <span key="auteur" style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{e.raw?.user_id ? nameOf(e.raw.user_id) : '–'}</span>,
      e.homologation ? (
        <div key="homol" style={{ display: 'flex', flexDirection: 'column', gap: '.25rem', alignItems: 'flex-start' }}>
          <span style={{
            fontSize: '.7rem', fontWeight: 700, padding: '.12rem .5rem', borderRadius: 50,
            background: e.homologation.status === 'ok' ? 'var(--green-pale)' : e.homologation.status === 'retire' ? '#fdf0ef' : 'var(--amber-pale, #fef3c7)',
            color: e.homologation.status === 'ok' ? 'var(--green-mid)' : e.homologation.status === 'retire' ? 'var(--red)' : 'var(--amber)',
          }}>
            {e.homologation.status === 'ok' ? '✅' : e.homologation.status === 'retire' ? '⚠️' : '❓'} {e.homologation.label}
          </span>
          {e.homologation.delaiH != null ? (
            <span style={{ fontSize: '.66rem', fontWeight: 700, color: 'var(--blue, #3968b3)' }}>⏱️ {e.homologation.delaiH}h avant rentrée</span>
          ) : (
            <span style={{ fontSize: '.62rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>⏱️ délai à vérifier sur l'étiquette</span>
          )}
        </div>
      ) : '–',
    ]
  }

  // Bloc "suivi de dose homologuée" affiché en haut du détail d'une parcelle,
  // avant la liste des saisies — une alerte par produit dont dose_max_campagne
  // est renseignée, jamais un réajustement des quantités enregistrées.
  function renderDoseSuivi(parc) {
    const produits = doseSuiviByParcelle[parc.id]
    if (!produits || produits.length === 0) return null
    return (
      <div style={{ marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
        <div style={{ fontSize: '.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)' }}>
          🧮 Suivi des doses homologuées (cumul campagne {campagneActive})
        </div>
        {produits.map(p => {
          const pct = p.max > 0 ? (p.cumul / p.max) * 100 : 0
          const status = pct >= 100 ? 'depasse' : pct >= 80 ? 'proche' : 'ok'
          const color = status === 'depasse' ? 'var(--red)' : status === 'proche' ? 'var(--amber)' : 'var(--green-mid)'
          const bg = status === 'depasse' ? '#fdf0ef' : status === 'proche' ? 'var(--amber-pale, #fef3c7)' : 'var(--green-pale)'
          return (
            <div key={p.nom} style={{ background: bg, border: `1px solid ${color}`, borderRadius: 10, padding: '.6rem .9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: '.85rem' }}>{p.nom}</strong>
                <span style={{ fontSize: '.82rem', fontWeight: 700, color }}>
                  {status === 'depasse' ? '❌ Dépassement' : status === 'proche' ? '⚠️ Proche de la limite' : '✅ Dans les clous'}
                </span>
              </div>
              <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginTop: 2 }}>
                Cumul appliqué : <strong>{p.cumul.toFixed(2)} {p.unite}/ha</strong> — dose max homologuée : <strong>{p.max} {p.unite}/ha</strong>
              </div>
              <div style={{ height: 6, background: 'rgba(0,0,0,.08)', borderRadius: 50, overflow: 'hidden', marginTop: '.4rem' }}>
                <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: color, borderRadius: 50 }} />
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  function exportCSV(parc) {
    const rows = events.filter(e => e.parcelle_id === parc.id)
    const header = ['Date', 'Type', 'Détail', 'Homologation', 'Délai rentrée (h)']
    const lines = [header.join(';'), ...rows.map(e => [
      e.date || '', e.type || '', (e.detail || '').replace(/;/g, ','), e.homologation?.label || '', e.homologation?.delaiH ?? '',
    ].join(';'))]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `MesParcelles_${parc.nom.replace(/[^a-z0-9]/gi, '_')}_${campagneActive}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ background: 'white', borderBottom: '1px solid var(--border)', padding: '.7rem 1.5rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--ink)' }}>🌾 MesParcelles</h2>
        <span style={{ fontSize: '.76rem', color: 'var(--text-muted)', fontWeight: 600 }}>🗓️ {campagneActive}</span>
        <span style={{ fontSize: '.76rem', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          Interventions, moisson et récolte consolidées par parcelle, avec vérification EPHY des produits phyto.
        </span>
      </div>
      <div style={{ fontSize: '.7rem', color: 'var(--text-muted)', padding: '.4rem 1.5rem', background: 'var(--cream)', borderBottom: '1px solid var(--border)' }}>
        ⏱️ Le délai avant rentrée est extrait automatiquement du texte libre des fiches EPHY — à vérifier sur l'étiquette du produit en cas de doute.
      </div>
      <DossiersParcelles
        parcelles={parcelles}
        entries={events}
        entryParcelleId={entryParcelleId}
        dossierId={dossierId}
        setDossierId={setDossierId}
        search={search}
        setSearch={setSearch}
        renderStats={renderStats}
        onAdd={exportCSV}
        addLabel="📤 Exporter CSV"
        rowHeaders={['Date', 'Type', 'Détail', 'Saisi par', 'Homologation EPHY']}
        renderRow={renderRow}
        onRowClick={setDetailEvent}
        isMobile={isMobile}
        emptyHint="Aucune parcelle."
        headerExtra={null}
        beforeRows={renderDoseSuivi}
      />

      {detailEvent && (
        <Modal title={`${TYPE_ICON[detailEvent.type] || '📋'} ${detailEvent.type} — ${fmtDate(detailEvent.date)}`} onClose={() => setDetailEvent(null)} maxWidth={480}>
          <DetailEvenement e={detailEvent} profiles={profiles} />
        </Modal>
      )}
    </div>
  )
}

function DetailEvenement({ e, profiles = [] }) {
  const r = e.raw || {}
  const nameOf = id => profiles.find(p => p.id === id)?.display_name || '—'
  const row = (label, value) => value == null || value === '' ? null : (
    <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '.45rem 0', borderBottom: '1px solid var(--border)', fontSize: '.85rem' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontWeight: 600, textAlign: 'right' }}>{value}</span>
    </div>
  )
  const isIntervention = e.id.startsWith('iv-')
  const isMoisson = e.id.startsWith('mo-')
  const isRecolte = e.id.startsWith('re-')
  return (
    <div>
      {row('Parcelle', e.parcelle_nom)}
      {isIntervention && (
        <>
          {row('Culture', r.culture)}
          {row('Produit', r.produit_nom)}
          {row('Quantité', r.quantite != null ? `${r.quantite} ${r.unite || ''}` : null)}
          {row('Surface', r.surface_ha != null ? `${r.surface_ha} ha${r.zone_geometrie ? ' 📐 (zone tracée)' : ''}` : null)}
          {row('Sous-type', r.sous_type)}
          {row('Zone parcelle', [r.fourrieres && 'Fourrières', r.rive && 'Rive'].filter(Boolean).join(', ') || null)}
          {row('Observation', r.observation !== e.type ? r.observation : null)}
          {row('Remarque', r.remarque)}
          {row('Saisie par', r.user_id ? nameOf(r.user_id) : null)}
        </>
      )}
      {isMoisson && (
        <>
          {row('Culture', r.culture)}
          {row('Poids brut', r.poids_brut != null ? `${(r.poids_brut / 1000).toFixed(2)} t` : null)}
          {row('Poids net', r.poids_net != null ? `${(r.poids_net / 1000).toFixed(2)} t` : null)}
          {row('Humidité', r.humidite != null ? `${r.humidite} %` : null)}
          {row('Lieu de stockage', r.lieu_stockage)}
          {row('Lieu de livraison', r.lieu_livraison)}
          {row('Entité livraison', r.entite_livraison)}
        </>
      )}
      {isRecolte && (
        <>
          {row('Variété', r.variete)}
          {row('Poids brut', r.poids_brut != null ? `${r.poids_brut} kg` : null)}
          {row('Poids net', r.poids_net != null ? `${r.poids_net} kg` : null)}
          {row('Nb palox', r.nb_palox)}
          {row('Surface', r.surface_ha != null ? `${r.surface_ha} ha` : null)}
          {row('Tracteur', r.tracteur)}
          {row('Conducteur', r.conducteur)}
          {row('Observation', r.observation)}
        </>
      )}
      {e.homologation && (
        <div style={{ marginTop: '.8rem', padding: '.6rem .8rem', borderRadius: 8, background: e.homologation.status === 'ok' ? 'var(--green-pale)' : e.homologation.status === 'retire' ? '#fdf0ef' : 'var(--amber-pale, #fef3c7)' }}>
          <div style={{ fontWeight: 700, fontSize: '.85rem', color: e.homologation.status === 'ok' ? 'var(--green-mid)' : e.homologation.status === 'retire' ? 'var(--red)' : 'var(--amber)' }}>
            {e.homologation.status === 'ok' ? '✅' : e.homologation.status === 'retire' ? '⚠️' : '❓'} {e.homologation.label}
          </div>
          {e.homologation.delaiH != null ? (
            <div style={{ fontSize: '.78rem', color: 'var(--blue, #3968b3)', fontWeight: 600, marginTop: '.2rem' }}>⏱️ {e.homologation.delaiH}h avant rentrée</div>
          ) : (
            <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '.2rem' }}>⏱️ délai à vérifier sur l'étiquette</div>
          )}
        </div>
      )}
    </div>
  )
}
