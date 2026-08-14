import { supabase } from './supabase'

// Registre de vérifications de cohérence des données — chaque check est une
// fonction indépendante qui renvoie une liste d'anomalies. Pensé pour grossir
// avec le temps : ajouter un nouveau check = ajouter une entrée à CHECKS,
// sans toucher au reste (page Diagnostic, navigation…).
//
// Chaque anomalie : { severity: 'error'|'warn', title, detail, section, hint }
//   - section : id de section App.jsx vers laquelle "🔍 Localiser" doit naviguer
//   - hint    : texte distinctif (nom, référence…) copié dans le presse-papier
//               pour le retrouver vite dans la recherche de cette page

// Tables portant un champ `campagne` (voir migration_A_EXECUTER_74.sql) — une
// ligne avec campagne NULL retombe sur "la campagne du jour", qui a déjà causé
// une vraie confusion en changeant de valeur au 1er août. On alerte désormais
// dès qu'une NOUVELLE ligne est saisie sans campagne, plutôt que de découvrir
// le problème des mois plus tard.
const CAMPAGNE_TABLES = [
  { table: 'parcelles',              section: 'parcelle-carte',    label: 'Parcelles' },
  { table: 'cereales_moisson',       section: 'cereales',          label: 'Céréales — Moisson' },
  { table: 'cereales_contrats',      section: 'cereales',          label: 'Céréales — Contrats' },
  { table: 'cereales_livraisons',    section: 'cereales',          label: 'Céréales — Livraisons' },
  { table: 'plants_pdt',             section: 'plants-pdt',        label: 'Plants PDT' },
  { table: 'pdt_recolte_pesees',     section: 'recolte-pdt',       label: 'Récolte PDT' },
  { table: 'interventions_phyto',    section: 'stock-interventions', label: 'Interventions phyto' },
  { table: 'interventions_batiments', section: 'batiments',        label: 'Bâtiments — Interventions' },
  { table: 'interventions_outils',   section: 'outils',            label: 'Outils — Interventions' },
  { table: 'contrats',               section: 'sorties',           label: 'Sorties — Contrats' },
  { table: 'bons_sortie',            section: 'sorties',           label: 'Sorties — Bons' },
  { table: 'cp_surfaces',            section: 'commande-phyto',    label: 'Commande Phyto — Surfaces' },
  { table: 'engrais_apports',        section: 'engrais',           label: 'Calcul Engrais — Apports' },
  { table: 'cr_fiches',              section: 'cout-revient',      label: 'Coût de revient — Fiches' },
]

async function checkCampagneNull() {
  const issues = []
  await Promise.all(CAMPAGNE_TABLES.map(async ({ table, section, label }) => {
    const { data, error } = await supabase.from(table).select('id').is('campagne', null)
    if (error || !data?.length) return
    issues.push({
      severity: 'warn',
      title: `${label} : ${data.length} ligne(s) sans campagne`,
      detail: `La table "${table}" a ${data.length} ligne(s) où le champ campagne est vide — elles retombent sur la campagne du jour au lieu de rester rattachées à leur vraie campagne, et peuvent sembler "disparaître" au changement de saison.`,
      section, hint: null,
    })
  }))
  return issues
}

// Campagne "2024-2025" — campagne de démonstration (import DAPLOS d'exemple,
// voir Cereales.jsx) qui ne doit jamais compter parmi les vraies données. Déjà
// nettoyée une fois dans cr_fiches (migration_A_EXECUTER_75.sql) — ce check
// repère si elle traîne aussi ailleurs, table par table.
async function checkCampagneDemo() {
  const issues = []
  await Promise.all(CAMPAGNE_TABLES.map(async ({ table, section, label }) => {
    const { data, error } = await supabase.from(table).select('id').eq('campagne', '2024-2025')
    if (error || !data?.length) return
    issues.push({
      severity: 'warn',
      title: `${label} : ${data.length} ligne(s) encore en 2024-2025 (démo)`,
      detail: `La table "${table}" a ${data.length} ligne(s) taguée(s) campagne "2024-2025" (campagne de démonstration) — probablement à nettoyer, comme cela a déjà été fait pour Coût de revient.`,
      section, hint: null,
    })
  }))
  return issues
}

// Carte : "Broyage" est une sous-catégorie de "Travail du sol" (avec
// Déchaumage/Décompactage/Labour, voir TYPES_INTERVENTION/SOUS_TYPES_TRAVAIL_SOL
// dans Carte.jsx) — une ligne sous_type="Broyage" dont le type principal n'est
// pas "Travail du sol" est mal classée (souvent un reliquat d'une saisie/import
// antérieur à l'introduction des sous-catégories).
async function checkBroyageMalClasse() {
  const { data, error } = await supabase.from('interventions_phyto').select('id,date,parcelle,observation').eq('sous_type', 'Broyage')
  if (error || !data?.length) return []
  const malClasses = data.filter(r => r.observation !== 'Travail du sol')
  if (!malClasses.length) return []
  return [{
    severity: 'warn',
    title: `${malClasses.length} intervention(s) "Broyage" pas classée(s) sous Travail du sol`,
    detail: `Carte > interventions : ${malClasses.length} ligne(s) ont sous_type="Broyage" mais un type principal différent de "Travail du sol" (ex. ${malClasses.slice(0, 3).map(r => `${r.parcelle || '?'} le ${r.date || '?'} — actuellement "${r.observation || 'vide'}"`).join(' ; ')}) — à corriger dans Carte ou MesParcelles.`,
    section: 'parcelle-carte', hint: malClasses[0]?.parcelle || null,
  }]
}

// Coût de revient : une fiche liée à une parcelle qui n'existe plus (parcelle
// supprimée/réimportée avec un nouvel id) reste orpheline — son parcelle_id ne
// correspond plus à rien, elle ne se resynchronise donc plus jamais (nom, culture,
// surface, entité figés depuis la dernière synchro).
async function checkCoutRevientOrphelines() {
  const [{ data: fiches }, { data: parcelles }] = await Promise.all([
    supabase.from('cr_fiches').select('id,nom,parcelle_id').not('parcelle_id', 'is', null),
    supabase.from('parcelles').select('id'),
  ])
  if (!fiches?.length) return []
  const parcelleIds = new Set((parcelles || []).map(p => p.id))
  return fiches.filter(f => !parcelleIds.has(f.parcelle_id)).map(f => ({
    severity: 'warn',
    title: `Fiche "${f.nom}" liée à une parcelle introuvable`,
    detail: `Coût de revient > fiche "${f.nom}" pointe vers une parcelle qui n'existe plus (supprimée ou réimportée) — elle ne se resynchronise plus automatiquement.`,
    section: 'cout-revient', hint: f.nom,
  }))
}

// Céréales : une livraison rattachée à un contrat qui n'existe plus (contrat
// supprimé après coup) — la livraison perd alors son acheteur/prix dans tous les
// récaps (Commerce, Stock) sans que ce soit visible autrement qu'un "–" silencieux.
async function checkCerealesLivraisonsOrphelines() {
  const [{ data: livraisons }, { data: contrats }] = await Promise.all([
    supabase.from('cereales_livraisons').select('id,date,contrat_id').not('contrat_id', 'is', null),
    supabase.from('cereales_contrats').select('id'),
  ])
  if (!livraisons?.length) return []
  const contratIds = new Set((contrats || []).map(c => c.id))
  return livraisons.filter(l => !contratIds.has(l.contrat_id)).map(l => ({
    severity: 'warn',
    title: `Livraison du ${l.date || '–'} liée à un contrat introuvable`,
    detail: `Céréales > Sorties : une livraison référence un contrat qui n'existe plus — elle apparaît sans acheteur/prix dans les récaps.`,
    section: 'cereales', hint: l.date || null,
  }))
}

// Céréales : un contrat de vente dont le tonnage déjà livré dépasse le tonnage
// contracté — soit une sur-livraison réelle (à documenter/avenant), soit une
// livraison mal rattachée à ce contrat par erreur.
async function checkCerealesContratsDepasses() {
  const [{ data: contrats }, { data: livraisons }] = await Promise.all([
    supabase.from('cereales_contrats').select('id,tiers_nom,type,tonnage_contracte,statut').eq('type', 'vente'),
    supabase.from('cereales_livraisons').select('contrat_id,quantite').not('contrat_id', 'is', null),
  ])
  if (!contrats?.length) return []
  const livreByContrat = {}
  for (const l of livraisons || []) livreByContrat[l.contrat_id] = (livreByContrat[l.contrat_id] || 0) + (l.quantite || 0)
  return contrats.filter(c => (livreByContrat[c.id] || 0) > (c.tonnage_contracte || 0) + 0.01).map(c => ({
    severity: 'error',
    title: `Contrat "${c.tiers_nom}" : livré (${(livreByContrat[c.id] || 0).toFixed(2)} t) > contracté (${(c.tonnage_contracte || 0).toFixed(2)} t)`,
    detail: `Céréales > Commerce/Contrats : le tonnage déjà livré sur ce contrat dépasse le tonnage contracté — vérifier qu'une livraison n'a pas été rattachée au mauvais contrat.`,
    section: 'cereales', hint: c.tiers_nom,
  }))
}

// Céréales : sorties sans "lieu d'enlèvement" renseigné — invisibles dans le
// détail par lieu de l'onglet Stock physique alors que comptées dans le total
// global (voir la bannière déjà affichée directement dans cet onglet).
async function checkCerealesSortiesSansLieu() {
  const { data } = await supabase.from('cereales_livraisons').select('id,date,quantite').is('lieu_enlevement', null)
  if (!data?.length) return []
  const total = data.reduce((s, l) => s + (l.quantite || 0), 0)
  if (total <= 0.01) return []
  return [{
    severity: 'warn',
    title: `${data.length} sortie(s) céréales sans lieu d'enlèvement (${total.toFixed(2)} t)`,
    detail: `Céréales > Stock physique : ce tonnage est déduit du total global mais d'aucun lieu précis dans le détail par lieu — cause l'écart déjà signalé dans cet onglet.`,
    section: 'cereales', hint: null,
  }]
}

export const CHECKS = [
  { id: 'campagne-null',        label: 'Campagne manquante (toutes tables)', run: checkCampagneNull },
  { id: 'campagne-demo',        label: 'Campagne 2024-2025 (démo) résiduelle', run: checkCampagneDemo },
  { id: 'broyage-mal-classe',   label: 'Broyage mal classé (hors Travail du sol)', run: checkBroyageMalClasse },
  { id: 'cr-orphelines',        label: 'Coût de revient — fiches orphelines', run: checkCoutRevientOrphelines },
  { id: 'cereales-livr-orph',   label: 'Céréales — livraisons orphelines',    run: checkCerealesLivraisonsOrphelines },
  { id: 'cereales-depasse',     label: 'Céréales — contrats dépassés',        run: checkCerealesContratsDepasses },
  { id: 'cereales-sans-lieu',   label: 'Céréales — sorties sans lieu',        run: checkCerealesSortiesSansLieu },
]

export async function runAllChecks(onProgress) {
  const results = []
  for (const check of CHECKS) {
    try {
      const issues = await check.run()
      results.push(...issues)
    } catch (e) {
      results.push({ severity: 'error', title: `Vérification "${check.label}" a échoué`, detail: e.message, section: null, hint: null })
    }
    onProgress?.(check.id)
  }
  return results
}
