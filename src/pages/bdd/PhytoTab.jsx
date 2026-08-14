import { useState, useRef, useEffect } from 'react'
import { useSupabaseTable } from '../../lib/useSupabaseTable'
import { supabase } from '../../lib/supabase'
import DataTable from '../../components/DataTable'
import Modal from '../../components/Modal'
import { prixEffectif } from '../../lib/prixEffectif'

// Base de données unifiée : phytosanitaires (db_phyto) ET intrants (db_intrants,
// semences/engrais/fertilisation/autre) au même endroit, avec des filtres par
// catégorie plutôt que des onglets séparés — plus simple à parcourir d'un coup
// d'œil, et on ne perd jamais aucune des deux catégories de vue.
const EMPTY = { nom: '', nom_secondaire: '', num_amm: '', substance_active: '', usage: '', dar: '', source: 'Manuel', stock_actuel: '', stock_unite: 'L', categorie: '', prix_unitaire: '', dose_max_campagne: '', prix_previsionnel: '', date_effet_prix: '' }
const EMPTY_INTRANT = { nom: '', categorie: 'semences', fournisseur: '', lot: '', composition: '', unite: 'kg', stock: '', prix_unitaire: '', prix_previsionnel: '', date_effet_prix: '' }

// Classement par type — phytosanitaires : Fongicide/Herbicide/Insecticide/Adjuvant
// (+ Oligo-élément déjà existant) ; intrants : Semences/Engrais/Fertilisant.
// "Engrais", "Semences" ET "Fertilisant" restent atteignables depuis les deux
// sources (categorie === 'engrais'/'semences'/'fertilisant' sur db_phyto OU
// db_intrants) sans devoir changer de table — utile par exemple pour des
// semences ou fertilisants enregistrés par erreur dans le catalogue phyto.
// Tout produit dont la catégorie ne correspond à aucun de ces types connus
// tombe dans "Autre / non classé" plutôt que d'être masqué, le temps d'être reclassé.
const CROSS_SOURCE_TYPES = ['engrais', 'semences', 'fertilisant']
const PHYTO_TYPES = ['fongicide', 'herbicide', 'insecticide', 'adjuvant', 'regulateur']
const INTRANT_TYPES = []
const CATS = [
  { key: 'all',         label: 'Tous' },
  { key: 'fongicide',   label: '🧪 Fongicides' },
  { key: 'herbicide',   label: '🧪 Herbicides' },
  { key: 'insecticide', label: '🧪 Insecticides' },
  { key: 'adjuvant',    label: '🧪 Adjuvants' },
  { key: 'regulateur',  label: '🌿 Régulateurs de croissance' },
  { key: 'oligo',       label: '🍃 Oligo-éléments' },
  { key: 'engrais',     label: '🌾 Engrais' },
  { key: 'fertilisant', label: '💧 Fertilisants' },
  { key: 'semences',    label: '🌱 Semences' },
  { key: 'autre',       label: '📦 Autre / non classé' },
]
const CAT_LABEL = { fongicide: 'Fongicide', herbicide: 'Herbicide', insecticide: 'Insecticide', adjuvant: 'Adjuvant', regulateur: 'Régulateur de croissance', oligo: 'Oligo-élément', engrais: 'Engrais' }
const INTRANT_CAT_LABELS = { semences: '🌱 Semences', engrais: '🌾 Engrais', fertilisant: '💧 Fertilisant', ferti: '💧 Fertilisant', autre: '📦 Autre' }
// Fonction EPHY (ANSES) -> catégorie auto-suggérée à l'import, pour ne pas tout
// reclasser à la main — reste modifiable ensuite comme n'importe quel produit.
function categorieFromEphyFonction(fonctions, typeProduit) {
  const f = (fonctions || '').toLowerCase()
  // Un adjuvant n'a pas de "fonction" phytopharmaceutique (fongicide/herbicide…)
  // dans EPHY — il est identifié par son TYPE de produit ("Produit adjuvant"),
  // pas par sa fonction (souvent vide pour ces produits). Sans ce champ, un vrai
  // adjuvant homologué (ex. ACTIROB B) ne matchait jamais et restait "Autre".
  if ((typeProduit || '').toLowerCase().includes('adjuvant')) return 'adjuvant'
  if (f.includes('fongicide')) return 'fongicide'
  if (f.includes('herbicide')) return 'herbicide'
  if (f.includes('insecticide')) return 'insecticide'
  if (f.includes('adjuvant')) return 'adjuvant'
  if (f.includes('régulateur') || f.includes('regulateur')) return 'regulateur'
  return ''
}

export default function PhytoTab({ showToast, readOnly = false }) {
  const { items, create, update, remove } = useSupabaseTable('db_phyto', 'nom')
  const { items: intrantItems, create: createIntrantRow, update: updateIntrantRow, remove: removeIntrantRow } = useSupabaseTable('db_intrants', 'nom')
  const [localSearch, setLocalSearch] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [ephyQuery, setEphyQuery] = useState('')
  const [ephyResults, setEphyResults] = useState([])
  const [ephyLoading, setEphyLoading] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editingIntrant, setEditingIntrant] = useState(null)
  const [ephyByAmm, setEphyByAmm] = useState({})
  const ephyTimer = useRef(null)

  // Fusion des deux sources — chacune garde son _src d'origine pour savoir quel
  // modal ouvrir au clic et quelles colonnes lui sont propres.
  const allRows = [
    ...items.map(p => ({ ...p, _src: 'phyto' })),
    ...intrantItems.map(i => ({ ...i, _src: 'intrant' })),
  ]
  // "Engrais", "Semences" et "Fertilisant" sont atteignables depuis les deux
  // sources : un produit phyto peut être recatégorisé ainsi sans changer de
  // table, tout comme un intrant — priorité sur tout le reste pour ne jamais
  // apparaître deux fois (une fois sous sa catégorie, jamais aussi sous Autre).
  // "ferti" (ancienne valeur, avant migration_A_EXECUTER_76.sql) est traité
  // comme "fertilisant" ici pour rester cohérent même si la migration n'a pas
  // encore tourné sur toutes les lignes.
  function matchesCat(r) {
    if (catFilter === 'all') return true
    const norm = r.categorie === 'ferti' ? 'fertilisant' : r.categorie
    if (CROSS_SOURCE_TYPES.includes(norm)) return catFilter === norm
    if (r._src === 'phyto') {
      const cat = PHYTO_TYPES.includes(norm) ? norm : (norm === 'oligo' ? 'oligo' : 'autre')
      return catFilter === cat
    }
    // r._src === 'intrant', déjà couvert ci-dessus si engrais/semences/fertilisant
    return catFilter === 'autre'
  }
  const filtered = allRows
    .filter(r => (r.nom || '').toLowerCase().includes(localSearch.toLowerCase())
      || (r.num_amm || '').toLowerCase().includes(localSearch.toLowerCase()))
    .filter(matchesCat)
    .sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr'))

  // Noms secondaires (autres noms commerciaux du même produit) : stockés côté EPHY,
  // pas dans db_phyto — on les résout via le N° AMM pour les afficher dans la liste,
  // sinon un produit ajouté sous son nom principal ne montre jamais ses équivalents.
  useEffect(() => {
    const amms = [...new Set(items.map(p => (p.num_amm || '').trim()).filter(Boolean))]
    if (!amms.length) { setEphyByAmm({}); return }
    supabase.from('ephy_produits').select('numero_amm,nom_produit,noms_secondaires,fonctions,type_produit').in('numero_amm', amms)
      .then(({ data }) => setEphyByAmm(Object.fromEntries((data || []).map(e => [e.numero_amm, e]))))
  }, [items])

  function secondaryNamesFor(p) {
    const amm = p.num_amm?.trim()
    const ephy = amm ? ephyByAmm[amm] : null
    const fromEphy = ephy?.noms_secondaires ? ephy.noms_secondaires.split('|').map(s => s.trim()).filter(Boolean) : []
    // Le nom commercial saisi/trouvé à la création (nom_secondaire) prime — c'est
    // celui réellement utilisé pour ce produit — puis les autres noms connus d'EPHY.
    const names = [p.nom_secondaire, ...fromEphy].map(n => (n || '').trim()).filter(Boolean)
    // Le nom déjà utilisé comme nom principal du produit ne doit pas se répéter dans "autres noms".
    return [...new Set(names)].filter(n => n.toLowerCase() !== (p.nom || '').trim().toLowerCase())
  }

  // Reclasse en masse les produits phyto non encore classés (catégorie vide ou
  // héritée de l'ancien système générique) à partir de la fonction officielle
  // EPHY (ANSES) — ne devine rien : ne touche que ceux dont le N° AMM est connu
  // et dont la fonction correspond clairement à Fongicide/Herbicide/Insecticide/
  // Adjuvant. Les autres restent "Autre / non classé", à faire à la main.
  async function autoClasserDepuisEphy() {
    const candidats = items.filter(p => !PHYTO_TYPES.includes(p.categorie) && p.categorie !== 'oligo' && p.categorie !== 'engrais' && p.num_amm?.trim())
    const updates = candidats
      .map(p => ({ p, cat: categorieFromEphyFonction(ephyByAmm[p.num_amm.trim()]?.fonctions, ephyByAmm[p.num_amm.trim()]?.type_produit) }))
      .filter(({ cat }) => cat)
    if (!updates.length) { showToast('Aucun produit reconnu à reclasser automatiquement — le reste est à faire à la main.'); return }
    if (!confirm(`Reclasser automatiquement ${updates.length} produit(s) d'après leur fonction EPHY (fongicide/herbicide/insecticide/adjuvant) ?`)) return
    await Promise.all(updates.map(({ p, cat }) => update(p.id, { categorie: cat })))
    showToast(`✅ ${updates.length} produit(s) reclassé(s) automatiquement`)
  }

  function openNew(nomPrefill = '') { setEditing({ ...EMPTY, nom: typeof nomPrefill === 'string' ? nomPrefill : '' }) }
  function openEdit(p) { setEditing({ ...p }) }
  function openNewIntrant() { setEditingIntrant({ ...EMPTY_INTRANT }) }
  function openEditIntrant(i) { setEditingIntrant({ ...i }) }

  // Tolère l'absence des colonnes nom_secondaire/dose_max_campagne tant que les
  // migrations 43/48 n'ont pas été exécutées — réessaie sans ces champs plutôt
  // que de bloquer l'enregistrement.
  async function createProduit(payload) {
    try { return await create(payload) }
    catch (e) {
      if (!/nom_secondaire|dose_max_campagne|column/i.test(e.message)) throw e
      const { nom_secondaire, dose_max_campagne, ...fallback } = payload
      const r = await create(fallback)
      showToast('⚠️ Nom secondaire / dose max non enregistré(e) — exécute migration_A_EXECUTER_43.sql et migration_A_EXECUTER_48.sql dans Supabase → SQL Editor.')
      return r
    }
  }
  async function updateProduit(id, payload) {
    try { return await update(id, payload) }
    catch (e) {
      if (!/nom_secondaire|dose_max_campagne|column/i.test(e.message)) throw e
      const { nom_secondaire, dose_max_campagne, ...fallback } = payload
      const r = await update(id, fallback)
      showToast('⚠️ Nom secondaire / dose max non enregistré(e) — exécute migration_A_EXECUTER_43.sql et migration_A_EXECUTER_48.sql dans Supabase → SQL Editor.')
      return r
    }
  }

  async function save() {
    if (!editing.nom?.trim()) { alert('Le nom est obligatoire.'); return }
    const payload = {
      ...editing,
      _src: undefined, // marqueur UI (fusion phyto/intrants) — jamais une colonne réelle
      nom_secondaire: editing.nom_secondaire?.trim() || null,
      dar: editing.dar === '' ? null : parseInt(editing.dar),
      stock_actuel: editing.stock_actuel === '' || editing.stock_actuel == null ? null : parseFloat(editing.stock_actuel),
      prix_unitaire: editing.prix_unitaire === '' || editing.prix_unitaire == null ? null : parseFloat(editing.prix_unitaire),
      dose_max_campagne: editing.dose_max_campagne === '' || editing.dose_max_campagne == null ? null : parseFloat(editing.dose_max_campagne),
      prix_previsionnel: editing.prix_previsionnel === '' || editing.prix_previsionnel == null ? null : parseFloat(editing.prix_previsionnel),
      date_effet_prix: editing.date_effet_prix || null,
    }
    try {
      if (editing.id) await updateProduit(editing.id, payload)
      else await createProduit(payload)
      setEditing(null)
      showToast('✅ Produit enregistré')
    } catch (e) {
      if (/prix_previsionnel|date_effet_prix/i.test(e.message)) {
        const { prix_previsionnel, date_effet_prix, ...fallback } = payload
        try {
          if (editing.id) await updateProduit(editing.id, fallback)
          else await createProduit(fallback)
          setEditing(null)
          showToast('⚠️ Prix prévisionnel non enregistré — exécute migration_A_EXECUTER_70.sql dans Supabase → SQL Editor.')
          return
        } catch (e2) { alert(e2.message); return }
      }
      alert(e.message)
    }
  }
  async function del() {
    if (!confirm('Supprimer ce produit ?')) return
    await remove(editing.id)
    setEditing(null)
    showToast('🗑️ Supprimé')
  }

  /* ── Intrants (db_intrants) — mêmes tolérances de migration que l'ex-IntrantsTab ── */
  async function saveIntrant() {
    if (!editingIntrant.nom?.trim()) { alert('Le nom est obligatoire.'); return }
    const payload = {
      ...editingIntrant,
      _src: undefined, // marqueur UI (fusion phyto/intrants) — jamais une colonne réelle
      stock: editingIntrant.stock === '' ? null : parseFloat(editingIntrant.stock),
      prix_unitaire: editingIntrant.prix_unitaire === '' || editingIntrant.prix_unitaire == null ? null : parseFloat(editingIntrant.prix_unitaire),
      prix_previsionnel: editingIntrant.prix_previsionnel === '' || editingIntrant.prix_previsionnel == null ? null : parseFloat(editingIntrant.prix_previsionnel),
      date_effet_prix: editingIntrant.date_effet_prix || null,
    }
    try {
      if (editingIntrant.id) await updateIntrantRow(editingIntrant.id, payload)
      else await createIntrantRow(payload)
      setEditingIntrant(null)
      showToast('✅ Intrant enregistré')
    } catch (e) {
      if (/prix_previsionnel|date_effet_prix/i.test(e.message)) {
        const { prix_previsionnel, date_effet_prix, ...fallback } = payload
        try {
          if (editingIntrant.id) await updateIntrantRow(editingIntrant.id, fallback)
          else await createIntrantRow(fallback)
          setEditingIntrant(null)
          showToast('⚠️ Prix prévisionnel non enregistré — exécute migration_A_EXECUTER_70.sql dans Supabase → SQL Editor.')
          return
        } catch (e2) { alert(e2.message); return }
      }
      if (/prix_unitaire|column/i.test(e.message)) {
        const { prix_unitaire, prix_previsionnel, date_effet_prix, ...fallback } = payload
        try {
          if (editingIntrant.id) await updateIntrantRow(editingIntrant.id, fallback)
          else await createIntrantRow(fallback)
          setEditingIntrant(null)
          showToast('⚠️ Prix non enregistré — exécute migration_A_EXECUTER_50.sql dans Supabase → SQL Editor.')
          return
        } catch (e2) { alert(e2.message); return }
      }
      alert(e.message)
    }
  }
  async function delIntrant() {
    if (!confirm('Supprimer cet intrant ?')) return
    await removeIntrantRow(editingIntrant.id)
    setEditingIntrant(null)
    showToast('🗑️ Supprimé')
  }

  function onEphyInput(q) {
    setEphyQuery(q)
    clearTimeout(ephyTimer.current)
    if (!q || q.length < 2) { setEphyResults([]); return }
    ephyTimer.current = setTimeout(() => doEphySearch(q), 400)
  }

  async function doEphySearch(q) {
    setEphyLoading(true)
    try {
      // Produits autorisés d'abord, puis les retirés (indiqués, mais sélectionnables
      // comme les autres — l'état n'a aucun autre effet). Un même produit peut être
      // vendu sous plusieurs noms commerciaux (ex. "DANADIM PROGRESS" pour le produit
      // de référence "DIMATE BF 400") — noms_secondaires (migration_A_EXECUTER_32.sql)
      // les rend trouvables aussi.
      const { data, error } = await supabase.from('ephy_produits')
        .select('*')
        .or(`nom_produit.ilike.%${q}%,noms_secondaires.ilike.%${q}%,numero_amm.ilike.%${q}%`)
        .order('etat_autorisation')
        .order('nom_produit')
        .limit(15)
      if (error) throw error
      setEphyResults(data || [])
    } catch (e) {
      console.warn('Recherche EPHY locale indisponible:', e)
      setEphyResults([]) // fallback handled in render via local matches
    } finally {
      setEphyLoading(false)
    }
  }

  async function addFromEphy(p) {
    // Le nom principal enregistré est toujours le nom de référence EPHY. Si la
    // recherche a matché via un nom commercial secondaire (ex. on cherche
    // "UNIX MAX" et EPHY ne connaît ce produit que sous son nom de référence
    // "KAYAK"), le nom tapé/trouvé est conservé à part (nom_secondaire) — pour
    // que le produit reste trouvable sous les deux noms, avec le nom principal
    // toujours cohérent avec la fiche EPHY et le N° AMM.
    const query = ephyQuery.trim().toLowerCase()
    const primary = p.nom_produit || '–'
    let nomSecondaire = ''
    if (query && !primary.toLowerCase().includes(query)) {
      const secondaires = (p.noms_secondaires || '').split('|').map(s => s.trim()).filter(Boolean)
      const matched = secondaires.find(s => s.toLowerCase().includes(query))
      if (matched) nomSecondaire = matched
    }
    const payload = {
      nom: primary,
      nom_secondaire: nomSecondaire || null,
      num_amm: p.numero_amm || '',
      substance_active: p.substances_actives || '',
      usage: p.fonctions || '',
      dar: null,
      source: 'EPHY',
      // Auto-suggéré depuis la fonction officielle EPHY (ANSES) quand elle est
      // reconnue (Fongicide/Herbicide/Insecticide/Adjuvant) — sinon vide, à
      // classer manuellement plutôt que de deviner.
      categorie: categorieFromEphyFonction(p.fonctions),
    }
    try {
      await createProduit(payload)
      setEphyResults([])
      setEphyQuery('')
      showToast('✅ Produit EPHY ajouté' + (nomSecondaire ? ` — enregistré sous « ${primary} », aussi vendu sous « ${nomSecondaire} »` : ''))
    } catch (e) { alert(e.message) }
  }

  const localFallback = ephyQuery.length >= 2 && ephyResults.length === 0 && !ephyLoading
    ? items.filter(p => p.nom.toLowerCase().includes(ephyQuery.toLowerCase())
        || (p.num_amm || '').toLowerCase().includes(ephyQuery.toLowerCase()))
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'auto' }}>
      {/* Recherche + filtres "collants" (position: sticky) : restent visibles en
          haut pendant qu'on fait défiler la liste des produits en dessous, plutôt
          que de disparaître avec le reste — pratique sur une longue liste. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 50, background: 'white', boxShadow: '0 2px 6px rgba(20,34,22,.06)' }}>
      <div style={{ padding: '1rem 1.8rem', display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '.6rem', flex: 1, flexWrap: 'wrap', position: 'relative' }}>
          {!readOnly && (
          <input type="text" placeholder="🔍 Rechercher un produit E-Phy — nom ou N° AMM (ex: Roundup, 2090488)…" value={ephyQuery} onChange={e => onEphyInput(e.target.value)}
            style={{ padding: '.5rem .9rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', flex: '3 1 220px', minWidth: 0, outline: 'none' }} />
          )}
          <input type="text" placeholder="🔍 Filtrer ma liste…" value={localSearch} onChange={e => setLocalSearch(e.target.value)}
            style={{ padding: '.5rem .9rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', flex: readOnly ? '1 1 100%' : '1 1 160px', minWidth: 0, outline: 'none' }} />

          {!readOnly && ephyQuery.length >= 2 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, background: 'white', border: '1px solid var(--border)', borderRadius: 10, maxHeight: 220, overflowY: 'auto', zIndex: 200, boxShadow: 'var(--shadow-md)' }}>
              {ephyLoading && <div style={{ padding: '.7rem 1rem', color: 'var(--text-muted)', fontSize: '.82rem' }}>Recherche en cours…</div>}
              {!ephyLoading && ephyResults.map((p) => (
                <div key={p.id} onMouseDown={() => addFromEphy(p)} style={{ padding: '.6rem 1rem', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: '.83rem' }}>
                  <strong>{p.nom_produit}</strong> <span style={{ color: 'var(--text-muted)', fontSize: '.72rem' }}>AMM: {p.numero_amm || '–'}</span>
                  {p.etat_autorisation && p.etat_autorisation !== 'AUTORISE' && (
                    <span style={{ fontSize: '.66rem', fontWeight: 700, padding: '.08rem .45rem', borderRadius: 50, background: 'var(--red-pale, #fee2e2)', color: 'var(--red)', marginLeft: '.4rem' }}>
                      ⚠️ Retiré
                    </span>
                  )}
                  <br />
                  <span style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{p.substances_actives || '–'}{p.fonctions ? ` · ${p.fonctions}` : ''}</span>
                  {p.noms_secondaires && (
                    <div style={{ fontSize: '.7rem', color: 'var(--green-mid)', marginTop: 2 }}>🏷️ Aussi vendu sous : {p.noms_secondaires.replaceAll('|', ',')}</div>
                  )}
                </div>
              ))}
              {!ephyLoading && ephyResults.length === 0 && localFallback.length > 0 && (
                <>
                  <div style={{ padding: '.4rem 1rem', fontSize: '.72rem', color: 'var(--amber)', borderBottom: '1px solid var(--border)' }}>Aucun produit homologué trouvé — dans votre liste :</div>
                  {localFallback.slice(0, 6).map(p => (
                    <div key={p.id} onMouseDown={() => { openEdit(p); setEphyQuery(''); setEphyResults([]) }} style={{ padding: '.6rem 1rem', cursor: 'pointer', fontSize: '.83rem' }}>
                      <strong>{p.nom}</strong> <span style={{ color: 'var(--text-muted)', fontSize: '.72rem' }}>AMM: {p.num_amm || '–'}</span>
                    </div>
                  ))}
                </>
              )}
              {!ephyLoading && ephyResults.length === 0 && localFallback.length === 0 && (
                <div style={{ padding: '.7rem 1rem', fontSize: '.82rem' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '.5rem' }}>Aucun résultat pour « {ephyQuery} ».</div>
                  <a href={`https://ephy.anses.fr/recherche/${encodeURIComponent(ephyQuery)}`} target="_blank" rel="noreferrer"
                    onMouseDown={e => e.stopPropagation()}
                    style={{ display: 'block', padding: '.45rem .6rem', borderRadius: 8, background: 'var(--green-pale)', color: 'var(--green-mid)', fontWeight: 600, textDecoration: 'none', marginBottom: '.35rem' }}>
                    🔗 Chercher « {ephyQuery} » sur E-Phy (ANSES)
                  </a>
                  <div onMouseDown={() => { openNew(ephyQuery); setEphyQuery(''); setEphyResults([]) }}
                    style={{ padding: '.45rem .6rem', borderRadius: 8, background: 'var(--cream)', cursor: 'pointer', fontWeight: 600 }}>
                    ➕ Créer « {ephyQuery} » en saisie manuelle
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        {!readOnly && (
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
            <button className="btn-sm primary" onClick={openNew}>+ Saisie manuelle (phyto)</button>
            <button className="btn-sm primary" onClick={openNewIntrant}>+ Nouvel intrant</button>
            <button className="btn-sm" onClick={autoClasserDepuisEphy} title="Reclasse automatiquement les produits phyto non classés d'après leur fonction officielle EPHY (ANSES)">🪄 Auto-classer depuis EPHY</button>
          </div>
        )}
      </div>

      <div style={{ padding: '.6rem 1.8rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
        {CATS.map(c => (
          <button key={c.key} onClick={() => setCatFilter(c.key)} className="btn-sm"
            style={catFilter === c.key ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>
            {c.label}
          </button>
        ))}
      </div>
      </div>

      <div style={{ padding: '1rem 1.8rem 1.8rem' }}>
        <DataTable
          emptyMessage="Aucun produit dans cette catégorie"
          onRowClick={readOnly ? undefined : (r => r._src === 'phyto' ? openEdit(r) : openEditIntrant(r))}
          columns={[
            { key: 'nom', label: 'Produit', render: r => <strong>{r.nom}</strong> },
            { key: 'categorie', label: 'Catégorie', render: r => {
              const norm = r.categorie === 'ferti' ? 'fertilisant' : r.categorie
              const isCrossSource = CROSS_SOURCE_TYPES.includes(norm)
              const isOligo = r._src === 'phyto' && norm === 'oligo'
              const isNonClasse = !isCrossSource && !isOligo && (r._src !== 'phyto' || !PHYTO_TYPES.includes(norm))
              const CROSS_LABEL = { engrais: 'Engrais', semences: 'Semences', fertilisant: 'Fertilisant' }
              const label = isCrossSource ? CROSS_LABEL[norm]
                : r._src === 'phyto' ? (CAT_LABEL[norm] || 'Autre / non classé')
                : (INTRANT_CAT_LABELS[norm] || 'Autre')
              return (
                <span style={{ fontSize: '.72rem', fontWeight: 600, padding: '.15rem .55rem', borderRadius: 50,
                  background: isCrossSource ? 'var(--amber-pale, #fdedbf)' : isOligo ? '#eef7e6' : isNonClasse ? 'var(--cream)' : 'var(--green-pale)',
                  color: isCrossSource ? 'var(--amber, #d97e0a)' : isOligo ? 'var(--green-mid)' : isNonClasse ? 'var(--text-muted)' : 'var(--green-mid)' }}>
                  {label}
                </span>
              )
            }},
            { key: 'num_amm', label: 'N° AMM', hideOnNarrow: true, render: r => r._src === 'phyto' ? (r.num_amm || '–') : '–' },
            { key: 'noms_secondaires', label: 'Nom(s) secondaire(s)', hideOnNarrow: true, render: r => {
              if (r._src !== 'phyto') return '–'
              const names = secondaryNamesFor(r)
              return names.length ? <span style={{ color: 'var(--green-mid)', fontSize: '.8rem' }}>🏷️ {names.join(', ')}</span> : '–'
            }},
            { key: 'substance_active', label: 'Substance active', hideOnNarrow: true, render: r => r._src === 'phyto' ? (r.substance_active || '–') : '–' },
            { key: 'fournisseur', label: 'Fournisseur', hideOnNarrow: true, render: r => r._src === 'intrant' ? (r.fournisseur || '–') : '–' },
            { key: 'usage', label: 'Usage', hideOnNarrow: true, render: r => r._src === 'phyto' ? (r.usage || '–') : '–' },
            { key: 'dar', label: 'DAR (j)', hideOnNarrow: true, render: r => r._src === 'phyto' && r.dar != null ? `${r.dar} j` : '–' },
            { key: 'dose_max_campagne', label: 'Dose max/campagne', hideOnNarrow: true, render: r => r._src === 'phyto' && r.dose_max_campagne != null ? `${r.dose_max_campagne} ${r.stock_unite || ''}/ha` : '–' },
            { key: 'stock', label: 'Stock', render: r => r._src === 'phyto'
              ? (r.stock_actuel != null ? `${r.stock_actuel} ${r.stock_unite || ''}` : '–')
              : (r.stock != null ? `${r.stock} ${r.unite || ''}` : '–') },
            { key: 'prix_unitaire', label: 'Prix', render: r => {
              const unite = r._src === 'phyto' ? (r.stock_unite || 'u') : (r.unite || 'u')
              return (
                <>
                  {r.prix_unitaire != null ? `${r.prix_unitaire} €/${unite}` : '–'}
                  {r.date_effet_prix && r.prix_previsionnel != null && (
                    <div style={{ fontSize: '.72rem', color: 'var(--amber,#c47c1a)' }}>
                      {prixEffectif(r, new Date().toISOString().slice(0, 10)) === r.prix_previsionnel
                        ? `✅ ${r.prix_previsionnel} € depuis le ${new Date(r.date_effet_prix).toLocaleDateString('fr-FR')}`
                        : `📅 ${r.prix_previsionnel} € à partir du ${new Date(r.date_effet_prix).toLocaleDateString('fr-FR')}`}
                    </div>
                  )}
                </>
              )
            }},
            { key: 'source', label: 'Source', hideOnNarrow: true, render: r => r._src === 'phyto' ? (
              <span style={{ fontSize: '.72rem', fontWeight: 600, padding: '.15rem .55rem', borderRadius: 50, background: r.source === 'EPHY' ? 'var(--green-pale)' : 'var(--amber-pale)', color: r.source === 'EPHY' ? 'var(--green-mid)' : 'var(--amber)' }}>
                {r.source}
              </span>
            ) : <span style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>Intrant</span> },
          ]}
          rows={filtered}
        />
      </div>

      {editing && (
        <Modal title={editing.id ? 'Modifier le produit' : 'Nouveau produit phytosanitaire'} onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={480}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Nom du produit *</label><input autoFocus value={editing.nom} onChange={e => setEditing({ ...editing, nom: e.target.value })} placeholder="ex. Roundup" /></div>
            <div className="form-group">
              <label>Catégorie</label>
              <select value={editing.categorie || ''} onChange={e => setEditing({ ...editing, categorie: e.target.value })}>
                <option value="">— Choisir —</option>
                <option value="fongicide">Fongicide</option>
                <option value="herbicide">Herbicide</option>
                <option value="insecticide">Insecticide</option>
                <option value="adjuvant">Adjuvant</option>
                <option value="regulateur">Régulateur de croissance</option>
                <option value="oligo">Oligo-élément</option>
                <option value="engrais">Engrais</option>
                <option value="semences">Semences</option>
                <option value="fertilisant">Fertilisant</option>
                <option value="autre">Autre / non classé</option>
                {editing.categorie && !['fongicide','herbicide','insecticide','adjuvant','regulateur','oligo','engrais','semences','fertilisant','autre'].includes(editing.categorie) && (
                  <option value={editing.categorie}>{editing.categorie} (ancien)</option>
                )}
              </select>
            </div>
            <div className="form-group"><label>N° AMM</label><input value={editing.num_amm || ''} onChange={e => setEditing({ ...editing, num_amm: e.target.value })} /></div>
            <div className="form-group"><label>DAR (jours)</label><input type="number" value={editing.dar} onChange={e => setEditing({ ...editing, dar: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Nom commercial secondaire</label>
              <input value={editing.nom_secondaire || ''} onChange={e => setEditing({ ...editing, nom_secondaire: e.target.value })} placeholder="ex. nom sous lequel vous l'achetez, si différent du nom principal" />
            </div>
            {editing.id && secondaryNamesFor(editing).length > 0 && (
              <div style={{ gridColumn: '1/-1', fontSize: '.78rem', color: 'var(--green-mid)', background: 'var(--green-pale)', borderRadius: 8, padding: '.5rem .8rem' }}>
                🏷️ Aussi vendu sous : {secondaryNamesFor(editing).join(', ')} <span style={{ color: 'var(--text-muted)' }}>(d'après la fiche EPHY liée à ce N° AMM)</span>
              </div>
            )}
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Substance active</label><input value={editing.substance_active || ''} onChange={e => setEditing({ ...editing, substance_active: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Usage / Culture cible</label><input value={editing.usage || ''} onChange={e => setEditing({ ...editing, usage: e.target.value })} /></div>
            <div className="form-group"><label>Stock actuel</label><input type="number" step="0.01" value={editing.stock_actuel ?? ''} onChange={e => setEditing({ ...editing, stock_actuel: e.target.value })} placeholder="ex. 50" /></div>
            <div className="form-group"><label>Unité</label>
              <select value={editing.stock_unite || 'L'} onChange={e => setEditing({ ...editing, stock_unite: e.target.value })}>
                {['L','kg','g','mL'].map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Prix (€/{editing.stock_unite || 'unité'})</label>
              <input type="number" step="0.01" value={editing.prix_unitaire ?? ''} onChange={e => setEditing({ ...editing, prix_unitaire: e.target.value })} placeholder="ex. 12.50" />
            </div>
            {editing.id && (
              <div style={{ gridColumn: '1/-1', fontSize: '.72rem', color: 'var(--text-muted)' }}>
                💡 Ce prix se met à jour automatiquement dès qu'une offre fournisseur est validée pour ce produit dans Commande Phyto.
              </div>
            )}
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>💡 Prix prévisionnel (optionnel)</label>
              <p style={{ fontSize: '.72rem', color: 'var(--text-muted)', margin: '0 0 .4rem' }}>
                Remplacera automatiquement le prix ci-dessus à partir de la date indiquée — les coûts déjà enregistrés avant cette date gardent leur prix d'origine.
              </p>
            </div>
            <div className="form-group"><label>Prix prévisionnel (€/{editing.stock_unite || 'unité'})</label><input type="number" step="0.01" value={editing.prix_previsionnel ?? ''} onChange={e => setEditing({ ...editing, prix_previsionnel: e.target.value })} placeholder="ex. 14.00" /></div>
            <div className="form-group"><label>Date d'effet</label><input type="date" value={editing.date_effet_prix || ''} onChange={e => setEditing({ ...editing, date_effet_prix: e.target.value })} /></div>
            {['fongicide', 'herbicide', 'insecticide', 'adjuvant', 'regulateur'].includes(editing.categorie) && (
              <div className="form-group" style={{ gridColumn: '1/-1' }}>
                <label>Dose max homologuée par campagne ({editing.stock_unite || 'unité'}/ha, toutes interventions confondues)</label>
                <input type="number" step="0.01" value={editing.dose_max_campagne ?? ''} onChange={e => setEditing({ ...editing, dose_max_campagne: e.target.value })} placeholder="ex. 6 (Revus/Revus Top)" />
                <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: '.3rem' }}>
                  Utilisé dans MesParcelles pour alerter si le cumul appliqué sur une parcelle dépasse cette limite.
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {editingIntrant && (
        <Modal title={editingIntrant.id ? "Modifier l'intrant" : 'Nouvel intrant'} onClose={() => setEditingIntrant(null)} onSave={saveIntrant} onDelete={editingIntrant.id ? delIntrant : null} maxWidth={480}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Nom *</label><input autoFocus value={editingIntrant.nom} onChange={e => setEditingIntrant({ ...editingIntrant, nom: e.target.value })} placeholder="ex. Semences Bintje certifiées" /></div>
            <div className="form-group">
              <label>Catégorie</label>
              <select value={editingIntrant.categorie === 'ferti' ? 'fertilisant' : editingIntrant.categorie} onChange={e => setEditingIntrant({ ...editingIntrant, categorie: e.target.value })}>
                <option value="semences">Semences</option>
                <option value="engrais">Engrais</option>
                <option value="fertilisant">Fertilisant</option>
                <option value="autre">Autre</option>
              </select>
            </div>
            <div className="form-group"><label>Fournisseur</label><input value={editingIntrant.fournisseur || ''} onChange={e => setEditingIntrant({ ...editingIntrant, fournisseur: e.target.value })} /></div>
            <div className="form-group"><label>Lot / Référence</label><input value={editingIntrant.lot || ''} onChange={e => setEditingIntrant({ ...editingIntrant, lot: e.target.value })} /></div>
            <div className="form-group"><label>Stock</label><input type="number" value={editingIntrant.stock} onChange={e => setEditingIntrant({ ...editingIntrant, stock: e.target.value })} /></div>
            <div className="form-group">
              <label>Unité</label>
              <select value={editingIntrant.unite} onChange={e => setEditingIntrant({ ...editingIntrant, unite: e.target.value })}>
                <option>kg</option><option>t</option><option>L</option><option>unité</option><option>sac</option><option>palette</option>
              </select>
            </div>
            <div className="form-group"><label>Prix (€/{editingIntrant.unite || 'unité'})</label><input type="number" step="0.01" value={editingIntrant.prix_unitaire ?? ''} onChange={e => setEditingIntrant({ ...editingIntrant, prix_unitaire: e.target.value })} placeholder="ex. 0.85" /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>💡 Prix prévisionnel (optionnel)</label>
              <p style={{ fontSize: '.72rem', color: 'var(--text-muted)', margin: '0 0 .4rem' }}>
                Remplacera automatiquement le prix ci-dessus à partir de la date indiquée — les coûts déjà enregistrés avant cette date gardent leur prix d'origine.
              </p>
            </div>
            <div className="form-group"><label>Prix prévisionnel (€/{editingIntrant.unite || 'unité'})</label><input type="number" step="0.01" value={editingIntrant.prix_previsionnel ?? ''} onChange={e => setEditingIntrant({ ...editingIntrant, prix_previsionnel: e.target.value })} placeholder="ex. 0.95" /></div>
            <div className="form-group"><label>Date d'effet</label><input type="date" value={editingIntrant.date_effet_prix || ''} onChange={e => setEditingIntrant({ ...editingIntrant, date_effet_prix: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Composition / Notes</label><input value={editingIntrant.composition || ''} onChange={e => setEditingIntrant({ ...editingIntrant, composition: e.target.value })} /></div>
          </div>
        </Modal>
      )}
    </div>
  )
}
