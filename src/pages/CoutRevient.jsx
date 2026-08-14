import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/useToast'
import useIsMobile from '../lib/useIsMobile'
import { groupInterventions, sortGroupsByDateDesc, sortGroupsByDateAsc } from '../lib/groupInterventions'
import { printLogoHtml } from '../lib/printLogo'
import { useCampagne } from '../lib/CampagneContext'
import { defaultCampagne } from '../lib/campagne'
import { phytoDisplayName, phytoMatches } from '../lib/phytoNames'
import { prixEffectif } from '../lib/prixEffectif'
import { fmtDate } from '../lib/formatDate'

/* ═══════════════════════════════════════════════════════════
   COÛT DE REVIENT — Fiches parcellaires
   ┌─────────────────────────────────────────────────────┐
   │ Panneau gauche  : liste des fiches (par culture)    │
   │ Panneau droit   : fiche sélectionnée                │
   │   ├── En-tête : parcelle, culture, surface, campagne│
   │   ├── Onglets : Intrants · Phyto · Méca · Autres   │
   │   ├── Tableau de saisie ligne par ligne             │
   │   └── Récapitulatif total €/ha + impression         │
   └─────────────────────────────────────────────────────┘
══════════════════════════════════════════════════════════ */

const SOURCE_TABS = [
  { key: 'intrant',      label: '🌱 Intrants',       color: 'var(--green-mid)' },
  { key: 'phyto',        label: '🧪 Phyto',          color: '#8e44ad' },
  { key: 'mecanisation', label: '🚜 Travaux du sol', color: 'var(--amber)' },
  { key: 'main_oeuvre',  label: '👷 Main d\'œuvre',  color: 'var(--blue)' },
  { key: 'autre',        label: '📦 Autres',         color: 'var(--text-muted)' },
]

const SOURCE_COLOR = Object.fromEntries(SOURCE_TABS.map(t => [t.key, t.color]))

// Sous-catégories phyto imposées (triées A→Z) — le champ Catégorie devient un
// select restreint à ces 5 valeurs pour les lignes phyto, afin que la vue par
// catégorie puisse répartir chaque produit de façon fiable.
// Ordre demandé (pas alphabétique) — aligné sur le classement de Base de données.
const PHYTO_SUBCATS = ['Fongicide', 'Herbicide', 'Insecticide', 'Régulateur de croissance', 'Adjuvant', 'Oligo-élément', 'Engrais', 'Fertilisant']
// "Fertilisant" scindé en minérale/organique (ex. "14-48" = minérale, "Fientes" =
// organique) — plus précis que Base de données, qui n'a qu'un seul "Fertilisant".
const INTRANT_SUBCATS = ['Fertilisant minérale', 'Fertilisant organique', 'Semences', 'Engrais']
// Correspondance avec les valeurs (minuscules) de categorie dans Base de données
// (db_phyto/db_intrants) — permet de pré-remplir la catégorie Coût de revient
// automatiquement quand on choisit un produit déjà classé là-bas.
const DB_CATEGORIE_TO_COUT_REVIENT = {
  fongicide: 'Fongicide', herbicide: 'Herbicide', insecticide: 'Insecticide',
  regulateur: 'Régulateur de croissance', adjuvant: 'Adjuvant', oligo: 'Oligo-élément',
  semences: 'Semences', engrais: 'Engrais',
}
// "Fertilisant"/"ferti" (alias historique, voir migration 76) n'a pas de
// distinction minérale/organique côté Base de données — par défaut on classe
// en "minérale" (cas largement majoritaire, ex. 14-48), à corriger à la main
// pour les rares engrais organiques (Fientes…). Cas à part car le libellé
// cible diffère selon la source (PHYTO_SUBCATS a juste "Fertilisant", pas
// INTRANT_SUBCATS).
function mapDbCategorieToCoutRevient(dbCategorie, source) {
  const c = (dbCategorie || '').trim().toLowerCase()
  if (c === 'fertilisant' || c === 'ferti') return source === 'phyto' ? 'Fertilisant' : 'Fertilisant minérale'
  return DB_CATEGORIE_TO_COUT_REVIENT[c] || null
}
// Déduit une catégorie phyto (même codes que db_phyto) depuis la fonction
// officielle EPHY (ANSES) d'un produit — même logique que le reclassement
// automatique de Base de données > Phyto (PhytoTab.jsx), pour rattraper les
// produits dont la catégorie n'a jamais été renseignée là-bas, sans deviner
// au-delà de ce qu'EPHY affirme clairement.
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
// Clé de recherche insensible à la casse ET aux accents — deux lignes du même
// produit saisies différemment ("Amino Céréales" vs "AMINO CEREALES" vs "amino
// cereales") doivent être reconnues comme identiques par la mémoire "collante"
// et les recherches par nom, sinon certaines lignes restent bloquées dans
// "Autre" sans explication alors que le "même" produit est déjà classé ailleurs.
function normKey(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

/* Regroupe des lignes de coût par libellé produit (A→Z), chaque groupe gardant
   le détail (une entrée par passage/usage) trié du plus récent au plus ancien. */
function groupByLibelle(arr) {
  const map = new Map()
  for (const l of arr) {
    const key = (l.libelle || '(sans nom)').trim()
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(l)
  }
  return Array.from(map.entries())
    .map(([libelle, ls]) => ({
      libelle,
      lignes: ls.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      totalHa: ls.reduce((s, l) => s + (l.montant_ha || 0), 0),
      totalTotal: ls.reduce((s, l) => s + (l.montant_total || 0), 0),
    }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'))
}

/* Bloc "catégorie" de la vue par produit : en-tête toujours visible (nom du
   produit + total), détail (une ligne par passage) dépliable au clic — reste
   rapide à parcourir tout en donnant accès au détail sans tout charger d'un coup.
   showParcelle : affiche le nom de la parcelle sur chaque ligne de détail (vue globale). */
function CategorySection({ title, color, items, expanded, toggle, onEdit, showParcelle, ficheById, onRecategorize, subcatOptions, onRecategorizeSubcat }) {
  const [recatOpenFor, setRecatOpenFor] = useState(null)
  if (!items.length) return null
  const total = items.reduce((s, it) => s + it.totalHa, 0)
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: (color || 'var(--text-muted)') + '18', padding: '.55rem .9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.4rem' }}>
        <strong style={{ fontSize: '.82rem', color: color || 'var(--text-main)' }}>{title}</strong>
        <span style={{ fontSize: '.78rem', fontWeight: 700, color: color || 'var(--text-muted)' }}>{total.toFixed(2)} €/ha</span>
      </div>
      <div>
        {items.map(it => {
          const key = `${title}|${it.libelle}`
          const isOpen = expanded.has(key)
          return (
            <div key={key} style={{ borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                <div onClick={() => toggle(key)}
                  style={{ flex: 1, minWidth: 0, padding: '.55rem .9rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.3rem', cursor: 'pointer' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <span style={{ fontSize: '.84rem', minWidth: 0 }}>
                    <span style={{ marginRight: '.4rem', color: 'var(--green-accent)' }}>{isOpen ? '▾' : '▸'}</span>
                    {it.libelle} <span style={{ color: 'var(--text-muted)', fontSize: '.74rem' }}>({it.lignes.length} passage{it.lignes.length > 1 ? 's' : ''})</span>
                  </span>
                  <span style={{ fontSize: '.8rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{it.totalHa.toFixed(2)} €/ha</span>
                </div>
                {onRecategorize && (
                  <div style={{ position: 'relative', flexShrink: 0, paddingRight: '.6rem' }}>
                    <button onClick={e => { e.stopPropagation(); setRecatOpenFor(recatOpenFor === key ? null : key) }}
                      title="Reclasser tous les passages de cet élément"
                      className="btn-sm" style={{ padding: '.2rem .5rem', fontSize: '.7rem' }}>🔄</button>
                    {recatOpenFor === key && (
                      <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'white', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-md)', zIndex: 300, minWidth: 210, maxHeight: 320, overflowY: 'auto' }}>
                        {subcatOptions?.length > 0 && (
                          <>
                            <div style={{ padding: '.4rem .7rem', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Sous-catégorie…</div>
                            {subcatOptions.map(sc => (
                              <div key={sc} onClick={() => { onRecategorizeSubcat(it.lignes, sc); setRecatOpenFor(null) }}
                                style={{ padding: '.5rem .7rem', cursor: 'pointer', fontSize: '.82rem' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                                onMouseLeave={e => e.currentTarget.style.background = ''}>
                                {sc}
                              </div>
                            ))}
                          </>
                        )}
                        <div style={{ padding: '.4rem .7rem', fontSize: '.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>Grande catégorie…</div>
                        {SOURCE_TABS.map(t => (
                          <div key={t.key} onClick={() => { onRecategorize(it.lignes, t.key); setRecatOpenFor(null) }}
                            style={{ padding: '.5rem .7rem', cursor: 'pointer', fontSize: '.82rem' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}>
                            {t.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {isOpen && (
                <div style={{ background: 'var(--cream)', padding: '.3rem .9rem .6rem', display: 'flex', flexDirection: 'column', gap: '.15rem' }}>
                  {it.lignes.map(l => (
                    <div key={l.id} onClick={() => onEdit(l)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.2rem 1rem', padding: '.3rem .4rem', fontSize: '.78rem', cursor: 'pointer', borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.background = 'white'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <span style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}>
                        <span>{l.date ? new Date(l.date).toLocaleDateString('fr-FR') : 'Sans date'}</span>
                        {showParcelle && <span style={{ color: 'var(--green-mid)', fontWeight: 600 }}>{ficheById[l.fiche_id]?.parcelle_nom || ficheById[l.fiche_id]?.nom || '—'}</span>}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>{l.quantite_ha != null ? `${l.quantite_ha} ${l.unite || ''}/ha` : '–'}</span>
                      <span style={{ fontWeight: 600 }}>{l.montant_ha != null ? (+l.montant_ha).toFixed(2) + ' €/ha' : '–'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* Vue par catégorie, réutilisée à la fois pour une fiche seule et pour la vue
   globale (toutes fiches) — seule la liste de lignes passée en entrée diffère. */
function CategorieBreakdown({ lignes, expanded, toggle, onEdit, showParcelle, ficheById, onRecategorize, onRecategorizeSubcat }) {
  const autresPhyto = groupByLibelle(lignes.filter(l => l.source === 'phyto' && !PHYTO_SUBCATS.includes((l.categorie || '').trim())))
  const autresIntrant = groupByLibelle(lignes.filter(l => l.source === 'intrant' && !INTRANT_SUBCATS.includes((l.categorie || '').trim())))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {onRecategorize && (
        <div style={{ fontSize: '.76rem', color: 'var(--text-muted)', background: 'var(--cream)', borderRadius: 8, padding: '.5rem .8rem' }}>
          🔄 Clique le bouton à côté d'un élément pour déplacer tous ses passages vers une autre grande catégorie (ex. "Broyage" classé par erreur dans Intrants → Travaux du sol).
        </div>
      )}

      {(INTRANT_SUBCATS.some(sc => lignes.some(l => l.source === 'intrant' && (l.categorie || '').trim() === sc)) || autresIntrant.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, color: SOURCE_COLOR.intrant, padding: '0 .2rem' }}>🌱 Intrants</div>
          {INTRANT_SUBCATS.map(sc => (
            <CategorySection key={sc} title={sc} color={SOURCE_COLOR.intrant}
              items={groupByLibelle(lignes.filter(l => l.source === 'intrant' && (l.categorie || '').trim() === sc))}
              expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById}
              onRecategorize={onRecategorize} subcatOptions={INTRANT_SUBCATS} onRecategorizeSubcat={onRecategorizeSubcat} />
          ))}
          <CategorySection title="Autre / non catégorisé" color={SOURCE_COLOR.intrant}
            items={autresIntrant} expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById}
            onRecategorize={onRecategorize} subcatOptions={INTRANT_SUBCATS} onRecategorizeSubcat={onRecategorizeSubcat} />
        </div>
      )}

      {(PHYTO_SUBCATS.some(sc => lignes.some(l => l.source === 'phyto' && (l.categorie || '').trim() === sc)) || autresPhyto.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          <div style={{ fontSize: '.78rem', fontWeight: 700, color: '#8e44ad', padding: '0 .2rem' }}>🧪 Phyto</div>
          {PHYTO_SUBCATS.map(sc => (
            <CategorySection key={sc} title={sc} color="#8e44ad"
              items={groupByLibelle(lignes.filter(l => l.source === 'phyto' && (l.categorie || '').trim() === sc))}
              expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById}
              onRecategorize={onRecategorize} subcatOptions={PHYTO_SUBCATS} onRecategorizeSubcat={onRecategorizeSubcat} />
          ))}
          <CategorySection title="Autre / non catégorisé" color="#8e44ad"
            items={autresPhyto} expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById}
            onRecategorize={onRecategorize} subcatOptions={PHYTO_SUBCATS} onRecategorizeSubcat={onRecategorizeSubcat} />
        </div>
      )}

      <CategorySection title="🚜 Travaux du sol" color={SOURCE_COLOR.mecanisation}
        items={groupByLibelle(lignes.filter(l => l.source === 'mecanisation'))}
        expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById} onRecategorize={onRecategorize} />
      <CategorySection title="👷 Main d'œuvre" color={SOURCE_COLOR.main_oeuvre}
        items={groupByLibelle(lignes.filter(l => l.source === 'main_oeuvre'))}
        expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById} onRecategorize={onRecategorize} />
      <CategorySection title="📦 Autres" color={SOURCE_COLOR.autre}
        items={groupByLibelle(lignes.filter(l => l.source === 'autre'))}
        expanded={expanded} toggle={toggle} onEdit={onEdit} showParcelle={showParcelle} ficheById={ficheById} onRecategorize={onRecategorize} />

      {lignes.length === 0 && (
        <div style={{ textAlign: 'center', padding: '2.5rem', background: 'white', borderRadius: 12, border: '2px dashed var(--border)', color: 'var(--text-muted)' }}>
          Aucune ligne de coût.
        </div>
      )}
    </div>
  )
}

/* Vue "Prix de revient par culture" : agrège toutes les fiches (et leurs lignes
   de coût) par culture — coût total, surface cumulée et coût moyen €/ha par
   culture, avec une barre segmentée par grande catégorie et un détail dépliable
   (réutilise CategorieBreakdown, filtré aux fiches de la culture cliquée). */
function CoutParCultureView({ fiches, lignes, ficheById, onEdit }) {
  const [openCulture, setOpenCulture] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const toggle = key => setExpanded(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  if (!fiches.length) {
    return (
      <div style={{ textAlign: 'center', padding: '2.5rem', background: 'white', borderRadius: 12, border: '2px dashed var(--border)', color: 'var(--text-muted)' }}>
        Aucune fiche.
      </div>
    )
  }

  const map = new Map()
  for (const f of fiches) {
    const c = f.culture || 'Non défini'
    if (!map.has(c)) map.set(c, { culture: c, ficheIds: new Set(), surface: 0, totalTotal: 0, bySource: {} })
    const e = map.get(c)
    e.ficheIds.add(f.id)
    e.surface += f.surface_ha || 0
  }
  for (const l of lignes) {
    const f = ficheById[l.fiche_id]
    if (!f) continue
    const c = f.culture || 'Non défini'
    const e = map.get(c)
    if (!e) continue
    e.totalTotal += (l.montant_total || 0)
    e.bySource[l.source] = (e.bySource[l.source] || 0) + (l.montant_total || 0)
  }
  const rows = Array.from(map.values())
    .map(e => ({ ...e, coutHa: e.surface > 0 ? e.totalTotal / e.surface : 0 }))
    .sort((a, b) => b.totalTotal - a.totalTotal)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
      {rows.map(r => {
        const isOpen = openCulture === r.culture
        return (
          <div key={r.culture} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div onClick={() => setOpenCulture(isOpen ? null : r.culture)}
              style={{ padding: '.8rem 1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '.94rem', fontWeight: 700, flex: '1 1 160px' }}>
                <span style={{ marginRight: '.4rem', color: 'var(--green-accent)' }}>{isOpen ? '▾' : '▸'}</span>{r.culture}
              </span>
              <span style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>{r.ficheIds.size} fiche{r.ficheIds.size > 1 ? 's' : ''} · {r.surface.toFixed(1)} ha</span>
              <span style={{ fontSize: '.9rem', fontWeight: 800, color: 'var(--green-mid)' }}>{r.coutHa.toFixed(0)} €/ha</span>
              <span style={{ fontSize: '.78rem', color: 'var(--text-muted)' }}>{r.totalTotal.toFixed(0)} € total</span>
            </div>
            {r.totalTotal > 0 && (
              <div style={{ height: 7, display: 'flex', margin: '0 1rem .8rem', borderRadius: 4, overflow: 'hidden' }}>
                {SOURCE_TABS.map(t => {
                  const v = r.bySource[t.key] || 0
                  const pct = (v / r.totalTotal) * 100
                  return pct > 0 ? <div key={t.key} title={`${t.label} : ${v.toFixed(0)} €`} style={{ width: `${pct}%`, background: t.color }} /> : null
                })}
              </div>
            )}
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--border)', padding: '.8rem 1rem', background: 'var(--cream)' }}>
                <CategorieBreakdown
                  lignes={lignes.filter(l => r.ficheIds.has(l.fiche_id))}
                  expanded={expanded} toggle={toggle} onEdit={onEdit}
                  showParcelle={true} ficheById={ficheById} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function CoutRevient() {
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()
  const { campagneActive, registerCampagnes } = useCampagne()
  const [fiches,   setFiches]   = useState([])
  const [activeId, setActiveId] = useState(null)
  const [lignes,   setLignes]   = useState([])
  const [search,   setSearch]   = useState('')
  const [vueMode,  setVueMode]  = useState('categorie') // 'date' | 'categorie' — catégorie par défaut
  const [expandedItems, setExpandedItems] = useState(() => new Set())
  const toggleItem = key => setExpandedItems(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  // ── Vue globale : agrège les lignes de coût de TOUTES les fiches (toutes
  // parcelles) de la campagne active, pour un aperçu ferme entière — chargée
  // à la demande seulement (évite de tout charger si l'utilisateur ne l'ouvre pas).
  const [viewGlobal, setViewGlobal] = useState(false)
  // Vue "Prix de revient par culture" — agrège toutes les fiches par culture
  // (coût total, surface, €/ha moyen), réutilise le même chargement que Vue globale.
  const [viewParCulture, setViewParCulture] = useState(false)
  const [globalLignes, setGlobalLignes] = useState([])
  const [globalLoading, setGlobalLoading] = useState(false)
  async function loadGlobalLignes() {
    const ficheIds = fiches.map(f => f.id)
    if (!ficheIds.length) { setGlobalLignes([]); return }
    setGlobalLoading(true)
    const PAGE = 1000
    // La première page donne le compte exact, ce qui permet de lancer toutes les
    // pages suivantes EN PARALLÈLE au lieu d'une boucle séquentielle (page par
    // page) — pour ~4000+ lignes sur une campagne, ça évite d'accumuler la
    // latence réseau de 4-5 allers-retours l'un après l'autre.
    const first = await supabase.from('cr_lignes').select('*', { count: 'exact' }).in('fiche_id', ficheIds).range(0, PAGE - 1)
    const all = first.data ? [...first.data] : []
    const total = first.count ?? all.length
    if (total > PAGE) {
      const extraPages = Math.ceil(total / PAGE) - 1
      const rest = await Promise.all(
        Array.from({ length: extraPages }, (_, i) => i + 1).map(p =>
          supabase.from('cr_lignes').select('*').in('fiche_id', ficheIds).range(p * PAGE, p * PAGE + PAGE - 1)
        )
      )
      rest.forEach(r => { if (r.data) all.push(...r.data) })
    }
    setGlobalLignes(all)
    setGlobalLoading(false)
  }
  useEffect(() => { if (viewGlobal || viewParCulture) loadGlobalLignes() }, [viewGlobal, viewParCulture, fiches])

  // BDD reference data for suggestions
  const [intrants, setIntrants] = useState([])
  const [phytos,   setPhytos]   = useState([])
  const [outils,   setOutils]   = useState([])
  const [parcelles, setParcelles] = useState([])
  const [interventionsPhyto, setInterventionsPhyto] = useState([])

  // Modals
  const [ficheModal, setFicheModal] = useState(null)
  const [ligneModal, setLigneModal] = useState(null)
  const [parcelleQ, setParcelleQ] = useState('')
  const [showParcelleDd, setShowParcelleDd] = useState(false)

  useEffect(() => { loadAll() }, [campagneActive])
  useEffect(() => { if (activeId) loadLignes(activeId) }, [activeId])
  // cr_fiches est déjà filtré côté serveur par campagne active (fiches ci-dessus) —
  // pour que le sélecteur de campagne propose aussi les campagnes qui n'ont de
  // données QUE dans cette table (ex. 2026-2027 via Coût de revient), il faut une
  // requête séparée non filtrée.
  useEffect(() => {
    supabase.from('cr_fiches').select('campagne').then(({ data }) => {
      registerCampagnes([...new Set((data || []).map(r => r.campagne).filter(Boolean))])
    })
  }, [])

  // db_intrants.prix_unitaire / prix_previsionnel peuvent ne pas exister tant que les
  // migrations 50 et 70 n'ont pas été exécutées — on retente avec de moins en moins de
  // colonnes plutôt que de bloquer le chargement.
  async function loadIntrants() {
    let r = await supabase.from('db_intrants').select('id,nom,categorie,unite,stock,prix_unitaire,prix_previsionnel,date_effet_prix').order('nom')
    if (r.error && /prix_previsionnel|date_effet_prix/i.test(r.error.message)) {
      r = await supabase.from('db_intrants').select('id,nom,categorie,unite,stock,prix_unitaire').order('nom')
    }
    if (r.error && /prix_unitaire|column/i.test(r.error.message)) {
      return (await supabase.from('db_intrants').select('id,nom,categorie,unite,stock').order('nom')).data || []
    }
    return r.data || []
  }
  async function loadPhytos() {
    // "categorie" manquait ici alors qu'elle existe sur db_phyto (voir PhytoTab.jsx)
    // — sans elle, le niveau 2 du tri automatique (Base de données) ne pouvait
    // JAMAIS classer un seul produit phyto, quelle que soit sa catégorie déjà
    // renseignée là-bas : tout retombait silencieusement sur EPHY (niveau 3),
    // qui ne couvre pas tout (biostimulants, produits sans fonction/type reconnu).
    let r = await supabase.from('db_phyto').select('id,nom,nom_secondaire,num_amm,categorie,substance_active,prix_unitaire,prix_previsionnel,date_effet_prix').order('nom')
    if (r.error && /prix_previsionnel|date_effet_prix/i.test(r.error.message)) {
      r = await supabase.from('db_phyto').select('id,nom,nom_secondaire,num_amm,categorie,substance_active,prix_unitaire').order('nom')
    }
    return r.data || []
  }

  async function loadAll() {
    const [{ data: f }, i, p, { data: o }, { data: pa }, ip] = await Promise.all([
      supabase.from('cr_fiches').select('*').eq('campagne', campagneActive).order('culture').order('nom'),
      loadIntrants(),
      loadPhytos(),
      supabase.from('outils_agricoles').select('id,nom,type,cout_ha').order('nom'),
      supabase.from('parcelles').select('id,nom,culture_actuelle,surface,entite').order('nom'),
      loadAllInterventions(),
    ])
    // Le parcellaire change à chaque campagne (import DAPLOS) — sans ce filtre,
    // une parcelle d'une ancienne campagne (ex. 2024-2025) génère quand même une
    // fiche parcellaire dans la campagne active via ensureFichesForAllParcelles,
    // qui ne fait aucune distinction de campagne sur les parcelles reçues.
    const parcellesCampagne = (pa || []).filter(p => (p.campagne || defaultCampagne()) === campagneActive)
    setIntrants(i || [])
    setPhytos(p || [])
    setOutils(o || [])
    setParcelles(parcellesCampagne)
    setInterventionsPhyto(ip)
    // Une parcelle doit avoir une fiche pour LA campagne active — pas seulement une
    // fiche "à vie" (voir migration_A_EXECUTER_27.sql : unicité (parcelle_id, campagne)).
    let allFiches = await ensureFichesForAllParcelles(f || [], parcellesCampagne)
    allFiches = await syncFicheDataFromParcelles(allFiches, parcellesCampagne)
    allFiches = await removeFichesCulturesExclues(allFiches, parcellesCampagne)
    allFiches = await removeFichesOrphelinesPdtDupliquees(allFiches)
    setFiches(allFiches)
    const nextActiveId = allFiches.length ? allFiches[0].id : null
    setActiveId(nextActiveId)
    await autoImportInterventionsAsLignes(allFiches, ip, p, i)
    // Si la fiche restée/redevenue active en a reçu de nouvelles, l'effet sur
    // activeId ne se redéclenche pas tout seul quand l'id ne change pas —
    // on recharge donc ses lignes explicitement pour les voir sans rafraîchir.
    if (nextActiveId) loadLignes(nextActiveId)
  }

  // PostgREST plafonne à 1000 lignes par requête par défaut — on pagine pour tout charger.
  async function loadAllInterventions() {
    const all = []
    for (let page = 0; ; page++) {
      const { data, error } = await supabase.from('interventions_phyto').select('*')
        .not('parcelle_id', 'is', null).range(page * 1000, page * 1000 + 999)
      if (error || !data) break
      all.push(...data)
      if (data.length < 1000) break
    }
    return all
  }

  // Parcelles hors culture de vente (bordures, bandes, jachère, luzerne, oignon,
  // plants, SNE…) — pas de suivi de coût de revient pour celles-ci.
  const CULTURES_EXCLUES_CR = new Set(['BOR', 'BTA', 'JAC', 'LUZ', 'OIG', 'PPH', 'SNE'])

  /* Une fiche parcellaire existe automatiquement pour chaque parcelle enregistrée —
     crée les fiches manquantes (parcelles importées/ajoutées depuis la dernière visite),
     hors cultures exclues. */
  async function ensureFichesForAllParcelles(existingFiches, allParcelles) {
    const linkedIds = new Set(existingFiches.map(f => f.parcelle_id).filter(Boolean))
    const missing = allParcelles.filter(p => !linkedIds.has(p.id) && !CULTURES_EXCLUES_CR.has((p.culture_actuelle || '').trim().toUpperCase()))
    if (!missing.length) return existingFiches
    const rows = missing.map(p => ({
      nom: p.nom, culture: p.culture_actuelle || null, parcelle_nom: p.nom, parcelle_id: p.id,
      entite: p.entite || null, surface_ha: p.surface || null, campagne: campagneActive,
    }))
    // upsert + ignoreDuplicates : sûr même si l'effet se déclenche deux fois (React
    // StrictMode en dev) ou si l'utilisateur a deux onglets ouverts — la contrainte
    // d'unicité sur (parcelle_id, campagne) (migration_A_EXECUTER_27.sql) empêche
    // tout doublon côté base, quoi qu'il arrive côté client.
    let created = []
    let firstError = null
    for (let i = 0; i < rows.length; i += 500) {
      const { data, error } = await supabase.from('cr_fiches')
        .upsert(rows.slice(i, i + 500), { onConflict: 'parcelle_id,campagne', ignoreDuplicates: true })
        .select()
      if (!error && data) created.push(...data)
      if (error && !firstError) firstError = error
    }
    if (created.length) showToast(`🪄 ${created.length} fiche(s) parcellaire(s) créée(s) automatiquement pour la campagne ${campagneActive}`)
    if (firstError) {
      console.error('ensureFichesForAllParcelles:', firstError)
      alert(`Échec de la création des fiches parcellaires : ${firstError.message}`)
    }
    const { data: fresh, error: freshError } = await supabase.from('cr_fiches').select('*').eq('campagne', campagneActive).order('culture').order('nom')
    if (freshError) { console.error('ensureFichesForAllParcelles — relecture:', freshError); alert(`Échec de la relecture des fiches : ${freshError.message}`) }
    return fresh || [...existingFiches, ...created]
  }

  /* Resynchronise toutes les fiches liées à une parcelle avec les données actuelles de
     cette parcelle (nom, culture, entité, surface) — si la parcelle a été renommée,
     réaffectée à une autre entité, ou que sa surface/culture a changé depuis la création
     de la fiche, la fiche décroche sinon. Le titre de la fiche (nom) n'est mis à jour QUE
     s'il n'a jamais été personnalisé (encore égal à l'ancien parcelle_nom), pour ne jamais
     écraser un titre choisi à la main (ex. "Blé 2026 — Rosée Nord"). Comparaisons
     normalisées (nombre/texte trim) pour ne pas déclencher un ré-enregistrement à chaque
     chargement à cause d'un simple écart de type (ex. "5.6" vs 5.6) ; mises à jour envoyées
     en parallèle (pas une requête séquentielle par fiche) pour rester rapide même avec des
     centaines de fiches. */
  const normNum = v => (v == null || v === '' ? null : Number(v))
  const normTxt = v => (v == null || v === '' ? null : String(v).trim())
  async function syncFicheDataFromParcelles(fichesList, allParcelles) {
    const parcById = Object.fromEntries(allParcelles.map(p => [p.id, p]))
    const updates = []
    for (const f of fichesList) {
      if (!f.parcelle_id) continue
      const p = parcById[f.parcelle_id]
      if (!p) continue
      const patch = {}
      if (p.nom && normTxt(f.parcelle_nom) !== normTxt(p.nom)) {
        patch.parcelle_nom = p.nom
        if (normTxt(f.nom) === normTxt(f.parcelle_nom)) patch.nom = p.nom
      }
      if (normTxt(p.culture_actuelle) !== normTxt(f.culture)) patch.culture = p.culture_actuelle || null
      if (normTxt(p.entite) !== normTxt(f.entite)) patch.entite = p.entite || null
      if (normNum(p.surface) !== normNum(f.surface_ha)) patch.surface_ha = p.surface || null
      if (Object.keys(patch).length) updates.push({ id: f.id, patch })
    }
    if (!updates.length) return fichesList
    await Promise.all(updates.map(u => supabase.from('cr_fiches').update(u.patch).eq('id', u.id)))
    showToast(`🔄 ${updates.length} fiche(s) resynchronisée(s) depuis les parcelles`)
    return fichesList.map(f => {
      const u = updates.find(x => x.id === f.id)
      return u ? { ...f, ...u.patch } : f
    })
  }

  /* Retire les fiches dont la parcelle liée est maintenant sur une culture exclue du
     coût de revient (ex. bordures BOR/BTA) — uniquement si la fiche est encore vide
     (aucune ligne de coût saisie), pour ne jamais supprimer un historique réel. Un seul
     aller-retour pour récupérer les fiche_id ayant au moins une ligne, au lieu d'une
     requête de comptage par fiche candidate. */
  async function removeFichesCulturesExclues(fichesList, allParcelles) {
    const parcById = Object.fromEntries(allParcelles.map(p => [p.id, p]))
    const candidates = fichesList.filter(f => {
      if (!f.parcelle_id) return false
      const p = parcById[f.parcelle_id]
      return p && CULTURES_EXCLUES_CR.has((p.culture_actuelle || '').trim().toUpperCase())
    })
    if (!candidates.length) return fichesList
    const { data: lignes, error } = await supabase.from('cr_lignes').select('fiche_id').in('fiche_id', candidates.map(f => f.id))
    if (error) return fichesList // en cas de souci réseau, on ne supprime rien plutôt que de mal supprimer
    const ficheIdsAvecLignes = new Set((lignes || []).map(l => l.fiche_id))
    const toRemove = candidates.filter(f => !ficheIdsAvecLignes.has(f.id))
    if (!toRemove.length) return fichesList
    await Promise.all(toRemove.map(f => supabase.from('cr_fiches').delete().eq('id', f.id)))
    showToast(`🗑️ ${toRemove.length} fiche(s) retirée(s) (culture exclue du coût de revient)`)
    const removedIds = new Set(toRemove.map(f => f.id))
    return fichesList.filter(f => !removedIds.has(f.id))
  }

  /* Fiches orphelines historiques en culture "PDT" (texte libre, sans parcelle liée) —
     doublons d'une fiche déjà correctement rattachée à la vraie parcelle (code RPG
     "PTC"). On les retire dès qu'une fiche liée existe déjà pour le même nom, sans
     jamais en créer de nouvelle (le remplaçant lié, s'il doit exister, est déjà géré
     par ensureFichesForAllParcelles) — et seulement si elles sont encore vides. */
  async function removeFichesOrphelinesPdtDupliquees(fichesList) {
    const linkedByName = new Map()
    fichesList.filter(f => f.parcelle_id).forEach(f => linkedByName.set((f.parcelle_nom || f.nom || '').trim().toUpperCase(), f))
    const candidates = fichesList.filter(f =>
      !f.parcelle_id && (f.culture || '').trim().toUpperCase() === 'PDT' &&
      linkedByName.has((f.parcelle_nom || f.nom || '').trim().toUpperCase())
    )
    if (!candidates.length) return fichesList
    const { data: lignes, error } = await supabase.from('cr_lignes').select('fiche_id').in('fiche_id', candidates.map(f => f.id))
    if (error) return fichesList
    const ficheIdsAvecLignes = new Set((lignes || []).map(l => l.fiche_id))
    const toRemove = candidates.filter(f => !ficheIdsAvecLignes.has(f.id))
    if (!toRemove.length) return fichesList
    await Promise.all(toRemove.map(f => supabase.from('cr_fiches').delete().eq('id', f.id)))
    showToast(`🗑️ ${toRemove.length} fiche(s) doublon(s) "PDT" retirée(s) (déjà remplacées par la fiche liée à la parcelle)`)
    const removedIds = new Set(toRemove.map(f => f.id))
    return fichesList.filter(f => !removedIds.has(f.id))
  }

  // Toute intervention réelle (traitement phyto, travail du sol, récolte,
  // irrigation…) redirigée vers la bonne catégorie de coût selon son type — pas
  // besoin de Commande Phyto, seul le prix reste à saisir à la main s'il n'est
  // pas déjà connu (voir prixEffectif ci-dessous).
  const SOURCE_FOR_OBSERVATION = {
    'Traitement et protection des cultures': 'phyto',
    'Ferti minérale et foliaire': 'phyto',
    'Fertilisation et amendement organique': 'intrant',
    // Plantation/Semis (plants ou semences, ex. variété de betterave) manquaient
    // ici — elles tombaient dans 'autre' (source par défaut), donc jamais vues
    // par le tri automatique/manuel phyto/intrant, quel que soit le produit lié
    // en Base de données. Voir productSourceFor (interventionProductSource.js).
    'Plantation': 'intrant',
    'Semis': 'intrant',
    'Travail du sol': 'mecanisation',
    'Désherbage mécanique': 'mecanisation',
    'Récolte': 'mecanisation',
    'Irrigation': 'mecanisation',
  }

  /* Crée automatiquement une ligne de coût pour chaque intervention terrain de
     la campagne active qui n'en a pas encore — plus besoin de cliquer "+
     Ajouter au coût" à la main pour chacune. Le prix est repris directement du
     prix (effectif à la date de l'intervention) déjà renseigné en Base de
     données quand il existe ; sinon la ligne est créée avec un prix vide, à
     compléter comme avant.
     Dédoublonnage sur deux niveaux : ref_intervention_id (lien exact, pour les
     lignes créées par cette fonction) ET, pour les lignes historiques créées à
     la main avant l'existence de cette colonne, une clé fiche+date+libellé —
     sans ce deuxième filet, toute intervention déjà importée à la main avant
     ce jour serait dupliquée au premier passage automatique. */
  async function autoImportInterventionsAsLignes(fichesList, allInterventions, phytosList, intrantsList) {
    const fichesByParcelle = new Map()
    fichesList.forEach(f => { if (f.parcelle_id) fichesByParcelle.set(f.parcelle_id, f) })
    if (!fichesByParcelle.size) return

    const candidates = allInterventions.filter(i =>
      i.parcelle_id && fichesByParcelle.has(i.parcelle_id) &&
      (i.campagne || defaultCampagne()) === campagneActive
    )
    if (!candidates.length) return

    const phytoByIdLocal = Object.fromEntries((phytosList || []).map(p => [p.id, p]))
    const phytoByNomLocal = Object.fromEntries((phytosList || []).map(p => [normKey(p.nom), p]))
    const intrantByIdLocal = Object.fromEntries((intrantsList || []).map(x => [x.id, x]))
    const intrantByNomLocal = Object.fromEntries((intrantsList || []).map(x => [normKey(x.nom), x]))
    const phytoForLocal = (id, nom) => (id && phytoByIdLocal[id]) || phytoByNomLocal[normKey(nom)] || null
    const intrantForLocal = (id, nom) => (id && intrantByIdLocal[id]) || intrantByNomLocal[normKey(nom)] || null

    const ficheIds = [...fichesByParcelle.values()].map(f => f.id)
    const existingLignes = []
    for (let i = 0; i < ficheIds.length; i += 200) {
      const { data, error } = await supabase.from('cr_lignes').select('fiche_id,date,libelle,categorie,ref_intervention_id').in('fiche_id', ficheIds.slice(i, i + 200))
      if (!error && data) existingLignes.push(...data)
    }
    const importedIds = new Set(existingLignes.map(l => l.ref_intervention_id).filter(Boolean))
    const legacyKeys = new Set(existingLignes.filter(l => !l.ref_intervention_id).map(l => `${l.fiche_id}|${l.date}|${normKey(l.libelle)}`))
    // Mémoire "collante" : si ce produit a déjà été classé une fois dans une
    // vraie sous-catégorie (Fongicide, Engrais, Fertilisant…) sur une autre
    // ligne, une nouvelle ligne créée plus tard pour ce même produit (nouvel
    // épandage) reprend directement cette catégorie au lieu de retomber dans
    // "Autre" à chaque fois — sinon reclasser un produit ne "tenait" jamais
    // pour ses prochains passages.
    // Clé PAR SOURCE (pas juste par libellé) : "Fertilisant" est une valeur
    // valide côté phyto (PHYTO_SUBCATS) mais PAS côté intrant (INTRANT_SUBCATS a
    // "Fertilisant minérale"/"organique") — un même produit vendu/tracé à la fois
    // en phyto et en intrant faisait sinon gagner la mauvaise valeur selon
    // l'ordre de parcours, et la ligne "gagnante" restait invalide pour sa propre
    // source (donc toujours vue comme "Autre", et réécrite différemment à
    // chaque passage — l'impression de "revenir" dans Autre après correction).
    const knownCategorieByLibelle = new Map()
    for (const l of existingLignes) {
      const cat = (l.categorie || '').trim()
      const subcats = l.source === 'phyto' ? PHYTO_SUBCATS : l.source === 'intrant' ? INTRANT_SUBCATS : null
      if (cat && subcats?.includes(cat)) knownCategorieByLibelle.set(`${l.source}|${normKey(l.libelle)}`, cat)
    }

    const rows = []
    for (const i of candidates) {
      if (importedIds.has(i.id)) continue
      const f = fichesByParcelle.get(i.parcelle_id)
      const libelle = i.produit_nom || i.sous_type || i.observation || 'Intervention'
      if (legacyKeys.has(`${f.id}|${i.date}|${normKey(libelle)}`)) continue
      const source = SOURCE_FOR_OBSERVATION[i.observation] || 'autre'
      const s = f.surface_ha
      const quantiteHa = (i.quantite != null && s > 0) ? +(i.quantite / s).toFixed(4) : null
      const produit = phytoForLocal(i.produit_id, i.produit_nom) || intrantForLocal(i.produit_id, i.produit_nom)
      const prix = produit ? prixEffectif(produit, i.date) : null
      const montant_ha = (quantiteHa > 0 && prix > 0) ? +(quantiteHa * prix).toFixed(4) : null
      const montant_total = (montant_ha > 0 && s > 0) ? +(montant_ha * s).toFixed(2) : null
      const categorie = knownCategorieByLibelle.get(`${source}|${normKey(libelle)}`)
        || (produit ? mapDbCategorieToCoutRevient(produit.categorie, source) : null)
        || i.observation || null
      rows.push({
        fiche_id: f.id, source, categorie, libelle,
        date: i.date || null, quantite_ha: quantiteHa, unite: i.unite || null,
        prix_unitaire: prix ?? null, montant_ha, montant_total,
        ref_intrant_id: source === 'intrant' ? (i.produit_id || null) : null,
        ref_phyto_id: source === 'phyto' ? (i.produit_id || null) : null, ref_outil_id: null,
        ref_intervention_id: i.id,
      })
    }
    if (!rows.length) return

    let inserted = 0
    let firstError = null
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      let { data, error } = await supabase.from('cr_lignes').insert(chunk).select('id')
      if (error && /ref_intervention_id|column/i.test(error.message)) {
        // migration_A_EXECUTER_88.sql pas encore exécutée — retente sans le lien
        // précis (le dédoublonnage par fiche+date+libellé reste actif ensuite).
        ;({ data, error } = await supabase.from('cr_lignes').insert(chunk.map(({ ref_intervention_id, ...r }) => r)).select('id'))
      }
      if (!error && data) inserted += data.length
      if (error && !firstError) firstError = error
    }
    if (inserted) showToast(`🪄 ${inserted} ligne(s) de coût créée(s) automatiquement depuis les interventions`)
    // Ne jamais échouer en silence — sinon "il ne se passe rien" est impossible
    // à diagnostiquer (contrainte de base manquante, RLS, colonne inattendue…).
    if (firstError) {
      console.error('autoImportInterventionsAsLignes:', firstError)
      alert(`Import automatique des lignes de coût — échec partiel : ${firstError.message}`)
    }
  }

  async function loadLignes(ficheId) {
    const { data } = await supabase
      .from('cr_lignes').select('*')
      .eq('fiche_id', ficheId)
      .order('source').order('created_at')
    setLignes(data || [])
  }

  // Reconstruit à chaque frappe/render sinon (Vue globale/par culture repassent
  // sur ~190 fiches à chaque rendu) — mémoïsé pour ne recalculer que si la liste
  // de fiches change réellement.
  const ficheById = useMemo(() => Object.fromEntries(fiches.map(f => [f.id, f])), [fiches])
  const activeFiche = fiches.find(f => f.id === activeId)
  const autoPhytoRows = activeFiche?.parcelle_id
    ? interventionsPhyto.filter(i => i.parcelle_id === activeFiche.parcelle_id)
    : []
  const phytoById = Object.fromEntries(phytos.map(p => [p.id, p]))
  const phytoByNom = Object.fromEntries(phytos.map(p => [normKey(p.nom), p]))
  const intrantById = Object.fromEntries(intrants.map(i => [i.id, i]))
  const intrantByNom = Object.fromEntries(intrants.map(i => [normKey(i.nom), i]))
  // Fiche produit reliée : par id si connu, sinon par nom (interventions importées
  // sans produit_id, ex. DAPLOS/Excel) — pour retrouver la matière active dans les deux cas.
  const phytoFor = (produitId, produitNom) =>
    (produitId && phytoById[produitId]) || phytoByNom[normKey(produitNom)] || null
  const intrantFor = (produitId, produitNom) =>
    (produitId && intrantById[produitId]) || intrantByNom[normKey(produitNom)] || null
  const filtered    = fiches.filter(f =>
    !search || f.nom.toLowerCase().includes(search.toLowerCase()) ||
    (f.culture || '').toLowerCase().includes(search.toLowerCase())
  )

  // Lignes de coût groupées par date d'intervention (pas par catégorie) — une
  // catégorie reste visible sur chaque ligne via un badge coloré, mais ne sépare
  // plus la liste en onglets séparés.
  const lignesByDate = Object.values(
    lignes.reduce((map, l) => {
      const d = l.date || 'Sans date'
      map[d] ??= { date: d, lignes: [] }
      map[d].lignes.push(l)
      return map
    }, {})
  ).sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  /* Catégorise automatiquement toutes les lignes phyto/intrant de la campagne
     active (toutes fiches confondues) d'après la catégorie déjà renseignée en
     Base de données pour le produit lié (par ref_phyto_id/ref_intrant_id, ou
     par nom si le lien n'est pas connu) — ne touche jamais une ligne déjà
     classée dans une des sous-catégories imposées (PHYTO_SUBCATS/
     INTRANT_SUBCATS), pour ne jamais écraser un choix déjà fait à la main.
     "Fertilisant" reste volontairement de côté (voir DB_CATEGORIE_TO_COUT_REVIENT) —
     minérale/organique ne se devine pas depuis la Base de données. */
  async function autoCategorizeAllLignes() {
    if (!fiches.length) { alert('Aucune fiche chargée pour cette campagne.'); return }
    const ficheIds = fiches.map(f => f.id)
    const allLignes = []
    for (let i = 0; i < ficheIds.length; i += 200) {
      const { data, error } = await supabase.from('cr_lignes').select('id,source,categorie,libelle,ref_phyto_id,ref_intrant_id,ref_intervention_id').in('fiche_id', ficheIds.slice(i, i + 200))
      if (error) { console.error('autoCategorizeAllLignes — select:', error); alert(`Échec de la lecture des lignes : ${error.message}`); return }
      if (data) allLignes.push(...data)
    }
    if (!allLignes.length) { alert('Aucune ligne de coût pour cette campagne.'); return }

    const phytoByIdLocal = Object.fromEntries(phytos.map(p => [p.id, p]))
    const phytoByNomLocal = Object.fromEntries(phytos.map(p => [normKey(phytoDisplayName(p)), p]))
    const intrantByIdLocal = Object.fromEntries(intrants.map(x => [x.id, x]))
    const intrantByNomLocal = Object.fromEntries(intrants.map(x => [normKey(x.nom), x]))

    // Rattrapage : des lignes historiques (Plantation/Semis, importées avant que
    // ces deux types soient reconnus comme "intrant" dans SOURCE_FOR_OBSERVATION)
    // sont restées classées en source 'autre' — jamais vues par le tri phyto/
    // intrant ci-dessous, quel que soit le nombre de clics sur ce bouton. On les
    // ré-affecte d'abord à leur vraie source (via l'intervention d'origine),
    // avant le tri normal qui pourra ensuite leur trouver une sous-catégorie.
    const autreLignes = allLignes.filter(l => l.source === 'autre' && l.ref_intervention_id)
    if (autreLignes.length) {
      const interventionById = Object.fromEntries(interventionsPhyto.map(i => [i.id, i]))
      const sourceFixes = []
      for (const l of autreLignes) {
        const interv = interventionById[l.ref_intervention_id]
        if (!interv) continue
        const trueSource = SOURCE_FOR_OBSERVATION[interv.observation]
        if (!trueSource || trueSource === 'autre' || trueSource === l.source) continue
        const patch = { source: trueSource }
        if (trueSource === 'intrant') patch.ref_intrant_id = interv.produit_id || intrantByNomLocal[normKey(l.libelle)]?.id || null
        if (trueSource === 'phyto') patch.ref_phyto_id = interv.produit_id || phytoByNomLocal[normKey(l.libelle)]?.id || null
        sourceFixes.push({ id: l.id, patch })
        // Répercuté en mémoire tout de suite pour que le tri qui suit voie la
        // bonne source sans devoir relire la base.
        Object.assign(l, patch)
      }
      if (sourceFixes.length) {
        let firstSourceError = null
        for (let i = 0; i < sourceFixes.length; i += 50) {
          const batch = sourceFixes.slice(i, i + 50)
          const results = await Promise.all(batch.map(({ id, patch }) => supabase.from('cr_lignes').update(patch).eq('id', id)))
          const err = results.find(r => r.error)?.error
          if (err && !firstSourceError) firstSourceError = err
        }
        if (firstSourceError) {
          console.error('autoCategorizeAllLignes — correction de source:', firstSourceError)
          alert(`Échec de la correction de source (Plantation/Semis) : ${describeSupabaseError(firstSourceError)}`)
          return
        }
      }
    }

    // Mémoire "collante" : un produit déjà classé à la main sur une ligne (ex.
    // "14-48" → Fertilisant) sert de modèle pour toute autre ligne du même
    // produit encore dans "Autre" — y compris quand la Base de données ne
    // permet aucun classement automatique (ex. Fertilisant minérale/organique).
    // Clé PAR SOURCE : "Fertilisant" est valide côté phyto mais PAS côté intrant
    // (qui a "Fertilisant minérale"/"organique") — sans cette distinction, un
    // même produit tracé à la fois en phyto et en intrant pouvait faire gagner
    // la mauvaise valeur à la mémoire collante selon l'ordre de parcours, et la
    // ligne "gagnante" redevenait alors invalide pour sa PROPRE source — donc
    // toujours revue comme "Autre" et réécrite différemment à chaque passage.
    const knownCategorieByLibelle = new Map()
    for (const l of allLignes) {
      const cat = (l.categorie || '').trim()
      const subcats = l.source === 'phyto' ? PHYTO_SUBCATS : l.source === 'intrant' ? INTRANT_SUBCATS : null
      if (cat && subcats?.includes(cat)) knownCategorieByLibelle.set(`${l.source}|${normKey(l.libelle)}`, cat)
    }

    const updates = []
    const pendingEphy = [] // { l, p } — phyto restés sans catégorie après collant+Base de données, avec un N° AMM à vérifier
    for (const l of allLignes) {
      if (l.source !== 'phyto' && l.source !== 'intrant') continue
      const subcats = l.source === 'phyto' ? PHYTO_SUBCATS : INTRANT_SUBCATS
      if (subcats.includes((l.categorie || '').trim())) continue
      const key = normKey(l.libelle)
      let mapped = knownCategorieByLibelle.get(`${l.source}|${key}`)
      const p = l.source === 'phyto'
        ? (l.ref_phyto_id && phytoByIdLocal[l.ref_phyto_id]) || phytoByNomLocal[key]
        : (l.ref_intrant_id && intrantByIdLocal[l.ref_intrant_id]) || intrantByNomLocal[key]
      if (!mapped) mapped = p ? mapDbCategorieToCoutRevient(p.categorie, l.source) : null
      if (mapped) updates.push({ id: l.id, categorie: mapped })
      else if (l.source === 'phyto' && p?.num_amm?.trim()) pendingEphy.push({ l, p })
    }

    // Gros tri EPHY : pour les phyto encore sans catégorie, vérifie leur N° AMM
    // dans EPHY (ANSES) — la fonction officielle (fongicide/herbicide/
    // insecticide/adjuvant/régulateur) tranche quand la Base de données locale
    // n'a jamais été renseignée. Mêmes règles de correspondance que Base de
    // données > Phyto ("🪄 Reclasser depuis EPHY"), jamais de supposition au-delà
    // de ce qu'EPHY affirme clairement.
    let ephyChecked = 0
    if (pendingEphy.length) {
      const amms = [...new Set(pendingEphy.map(({ p }) => p.num_amm.trim()))]
      const ephyByAmm = {}
      for (let i = 0; i < amms.length; i += 200) {
        const { data, error } = await supabase.from('ephy_produits').select('numero_amm,fonctions,type_produit').in('numero_amm', amms.slice(i, i + 200))
        if (error) { console.error('autoCategorizeAllLignes — select ephy:', error); alert(`Échec de la vérification EPHY : ${error.message}`); return }
        (data || []).forEach(e => { ephyByAmm[e.numero_amm] = e })
      }
      // Repêchage pour les N° AMM saisis avec un écart de forme (espace interne,
      // texte parasite type "AMM 2090029"…) qui empêche la correspondance exacte
      // ci-dessus — on ne garde que les chiffres pour retenter un à un.
      const missingAmms = amms.filter(a => !ephyByAmm[a])
      for (const a of missingAmms) {
        const digits = a.replace(/\D/g, '')
        if (digits.length < 5) continue
        const { data } = await supabase.from('ephy_produits').select('numero_amm,fonctions,type_produit').ilike('numero_amm', `%${digits}%`).limit(1)
        if (data?.[0]) ephyByAmm[a] = data[0]
      }
      for (const { l, p } of pendingEphy) {
        ephyChecked++
        const dbCat = categorieFromEphyFonction(ephyByAmm[p.num_amm.trim()]?.fonctions, ephyByAmm[p.num_amm.trim()]?.type_produit)
        const mapped = dbCat ? mapDbCategorieToCoutRevient(dbCat, 'phyto') : null
        if (mapped) updates.push({ id: l.id, categorie: mapped })
      }
    }

    // Produits restés sans aucune correspondance (ni mémoire collante, ni Base de
    // données, ni EPHY) — le plus souvent parce que la ligne n'a ni ref_phyto_id/
    // ref_intrant_id ni libellé correspondant exactement à un produit connu.
    // Listés explicitement plutôt que laissés silencieusement dans "Autre", pour
    // que l'utilisateur sache QUOI corriger (orthographe du libellé, ou produit
    // à catégoriser une première fois en Base de données).
    const updatedIds = new Set(updates.map(u => u.id))
    const unresolvedLibelles = [...new Set(
      allLignes
        .filter(l => l.source === 'phyto' || l.source === 'intrant')
        .filter(l => !(l.source === 'phyto' ? PHYTO_SUBCATS : INTRANT_SUBCATS).includes((l.categorie || '').trim()))
        .filter(l => !updatedIds.has(l.id))
        .map(l => (l.libelle || '(sans nom)').trim())
    )].sort()

    if (!updates.length) {
      alert(`Rien à catégoriser automatiquement — les lignes phyto/intrant sont déjà classées, ou aucune correspondance trouvée (Base de données, lignes déjà classées${ephyChecked ? `, ni EPHY sur ${ephyChecked} produit(s) vérifié(s)` : ''}).${unresolvedLibelles.length ? `\n\nProduit(s) sans correspondance (${unresolvedLibelles.length}) :\n${unresolvedLibelles.join('\n')}` : ''}`)
      return
    }
    if (!confirm(`Catégoriser automatiquement ${updates.length} ligne(s) de coût (Base de données, lignes déjà classées${ephyChecked ? `, EPHY sur ${ephyChecked} produit(s)` : ''}) ?${unresolvedLibelles.length ? `\n\n⚠️ ${unresolvedLibelles.length} produit(s) resteront quand même sans correspondance :\n${unresolvedLibelles.join('\n')}` : ''}`)) return

    // Regroupe par catégorie cible pour mettre à jour par lots de 200 (plutôt
    // qu'une requête par ligne) — voir chunkedUpdateLignes.
    const idsByCategorie = new Map()
    for (const u of updates) {
      if (!idsByCategorie.has(u.categorie)) idsByCategorie.set(u.categorie, [])
      idsByCategorie.get(u.categorie).push(u.id)
    }
    let done = 0, firstError = null
    for (const [categorie, ids] of idsByCategorie) {
      const error = await chunkedUpdateLignes(ids, { categorie })
      if (!error) done += ids.length
      else if (!firstError) firstError = error
    }
    if (done) showToast(`🏷️ ${done} ligne(s) catégorisée(s) automatiquement`)
    if (firstError) { console.error('autoCategorizeAllLignes — update:', firstError); alert(`Échec partiel : ${describeSupabaseError(firstError)}`) }
    if (activeId) loadLignes(activeId)
    if (viewGlobal || viewParCulture) loadGlobalLignes()
  }

  /* ── TOTALS ── */
  function totalForSource(src) {
    return lignes.filter(l => l.source === src).reduce((s, l) => s + (l.montant_ha || 0), 0)
  }
  const grandTotalHa    = lignes.reduce((s, l) => s + (l.montant_ha   || 0), 0)
  const grandTotalTotal = lignes.reduce((s, l) => s + (l.montant_total || 0), 0)

  /* Supprime TOUTES les fiches (et leurs lignes) de la campagne active puis les
     recrée entièrement à partir des parcelles/interventions actuelles — utile
     quand un lien fiche ↔ parcelle est faussé (ex. deux parcelles au nom très
     proche, mauvais parcelle_id) et qu'un simple resync ne suffit pas à le
     corriger. Récupérable depuis la Corbeille si besoin (cr_fiches/cr_lignes
     en font partie). */
  async function resetAllFichesForCampagne() {
    if (!confirm(`Supprimer TOUTES les fiches parcellaires de la campagne ${campagneActive} (et leurs lignes de coût), puis les recréer entièrement à partir des parcelles et interventions actuelles ?\n\nLes notes ou lignes ajoutées à la main qui ne correspondent à aucune intervention seront perdues (récupérables depuis la Corbeille).`)) return
    const ficheIds = fiches.map(f => f.id)
    if (!ficheIds.length) { alert('Aucune fiche à supprimer pour cette campagne — rien à faire.'); return }
    showToast('🗑️ Suppression puis recréation en cours…')
    for (let i = 0; i < ficheIds.length; i += 200) {
      const chunk = ficheIds.slice(i, i + 200)
      const { error } = await supabase.from('cr_lignes').delete().in('fiche_id', chunk)
      if (error) { console.error('reset — delete cr_lignes:', error); alert(`Échec de la suppression des lignes de coût : ${error.message}`); return }
    }
    for (let i = 0; i < ficheIds.length; i += 200) {
      const chunk = ficheIds.slice(i, i + 200)
      const { error } = await supabase.from('cr_fiches').delete().in('id', chunk)
      if (error) { console.error('reset — delete cr_fiches:', error); alert(`Échec de la suppression des fiches : ${error.message}`); return }
    }
    // Vérifie que la suppression a vraiment eu lieu côté serveur avant de
    // recréer — sinon une suppression silencieusement refusée (RLS) donnerait
    // l'impression que "rien ne se passe" au réaffichage des mêmes fiches.
    const { data: stillThere, error: checkError } = await supabase.from('cr_fiches').select('id').eq('campagne', campagneActive).limit(1)
    if (checkError) { console.error('reset — vérification:', checkError); alert(`Échec de la vérification après suppression : ${checkError.message}`); return }
    if (stillThere?.length) { alert("La suppression n'a rien retiré côté serveur (probablement bloquée par les droits d'accès) — aucune fiche n'a été recréée. Vérifie les policies RLS sur cr_fiches/cr_lignes (DELETE)."); return }
    setFiches([])
    setActiveId(null)
    setLignes([])
    await loadAll()
    showToast(`✅ Fiches de la campagne ${campagneActive} recréées`)
  }

  /* ── FICHE CRUD ── */
  function openNewFiche() {
    setFicheModal({ nom: '', culture: '', parcelle_nom: '', parcelle_id: null, entite: '', surface_ha: '', campagne: campagneActive, notes: '' })
    setParcelleQ('')
  }
  function openEditFiche() {
    if (!activeFiche) return
    setFicheModal({ ...activeFiche })
    setParcelleQ(activeFiche.parcelle_nom || '')
  }

  async function saveFiche() {
    if (!ficheModal.nom?.trim()) { alert('Le nom est obligatoire.'); return }
    const payload = { ...ficheModal, surface_ha: parseFloat(ficheModal.surface_ha) || null }
    delete payload.created_at
    if (ficheModal.id) {
      const { error } = await supabase.from('cr_fiches').update(payload).eq('id', ficheModal.id)
      if (error) { alert(error.message); return }
      setFiches(prev => prev.map(f => f.id === ficheModal.id ? { ...f, ...payload } : f))
    } else {
      const { data, error } = await supabase.from('cr_fiches').insert(payload).select().single()
      if (error) { alert(error.message); return }
      setFiches(prev => [...prev, data])
      setActiveId(data.id)
    }
    setFicheModal(null)
    showToast('✅ Fiche enregistrée')
  }

  async function deleteFiche() {
    if (!activeFiche) return
    if (!confirm(`Supprimer la fiche "${activeFiche.nom}" et toutes ses lignes de coût ?`)) return
    await deleteFicheById(activeFiche.id)
    setLignes([])
    setFicheModal(null)
  }

  async function deleteFicheDirect(f) {
    if (!confirm(`Supprimer la fiche "${f.nom}" et toutes ses lignes de coût ?`)) return
    await deleteFicheById(f.id)
    if (activeId === f.id) setLignes([])
  }

  async function deleteFicheById(id) {
    await supabase.from('cr_lignes').delete().eq('fiche_id', id)
    await supabase.from('cr_fiches').delete().eq('id', id)
    const remaining = fiches.filter(f => f.id !== id)
    setFiches(remaining)
    if (activeId === id) setActiveId(remaining[0]?.id || null)
    showToast('🗑️ Fiche supprimée')
  }

  /* ── LIGNE CRUD ── */
  function openNewLigne() {
    if (!activeId) return
    setLigneModal({
      fiche_id: activeId, source: 'phyto', categorie: '', libelle: '',
      date: new Date().toISOString().split('T')[0],
      quantite_ha: '', unite: '', prix_unitaire: '', montant_ha: '', montant_total: '',
      ref_intrant_id: null, ref_phyto_id: null, ref_outil_id: null,
    })
  }
  function openEditLigne(l) { setLigneModal({ ...l }) }

  function addLigneFromIntervention(i) {
    if (!activeId) return
    const source = SOURCE_FOR_OBSERVATION[i.observation] || 'autre'
    const s = activeFiche?.surface_ha
    const quantiteHa = (i.quantite != null && s > 0) ? +(i.quantite / s).toFixed(4) : ''
    // Prix pré-rempli avec le prix effectif du produit À LA DATE DE L'INTERVENTION (pas la
    // date du jour) : si un prix prévisionnel avec date d'effet est passé, il ne s'applique
    // que si l'intervention est elle-même postérieure à cette date.
    const produit = phytoFor(i.produit_id, i.produit_nom) || intrantFor(i.produit_id, i.produit_nom)
    const prix = produit ? prixEffectif(produit, i.date) : null
    setLigneModal({
      fiche_id: activeId, source, categorie: i.observation || null,
      libelle: i.produit_nom || i.sous_type || i.observation || 'Intervention',
      date: i.date || new Date().toISOString().split('T')[0],
      quantite_ha: quantiteHa, unite: i.unite || '', prix_unitaire: prix ?? '', montant_ha: '', montant_total: '',
      ref_intrant_id: null, ref_phyto_id: source === 'phyto' ? (i.produit_id || null) : null, ref_outil_id: null,
    })
  }

  /* Auto-calculate montant_ha and montant_total */
  function calcLigne(l) {
    const q = parseFloat(l.quantite_ha)
    const p = parseFloat(l.prix_unitaire)
    const s = activeFiche?.surface_ha || 0
    let ha = parseFloat(l.montant_ha)
    // If qty and price filled → auto-calc
    if (q > 0 && p > 0) ha = +(q * p).toFixed(4)
    const total = ha > 0 && s > 0 ? +(ha * s).toFixed(2) : null
    return { montant_ha: ha || null, montant_total: total }
  }

  async function saveLigne() {
    if (!ligneModal.libelle?.trim()) { alert('Le libellé est obligatoire.'); return }
    const calc    = calcLigne(ligneModal)
    const payload = {
      fiche_id:       ligneModal.fiche_id,
      source:         ligneModal.source,
      categorie:      ligneModal.categorie || null,
      libelle:        ligneModal.libelle,
      date:           ligneModal.date || null,
      quantite_ha:    parseFloat(ligneModal.quantite_ha)    || null,
      unite:          ligneModal.unite   || null,
      prix_unitaire:  parseFloat(ligneModal.prix_unitaire)  || null,
      montant_ha:     parseFloat(ligneModal.montant_ha)     || calc.montant_ha,
      montant_total:  parseFloat(ligneModal.montant_total)  || calc.montant_total,
      ref_intrant_id: ligneModal.ref_intrant_id || null,
      ref_phyto_id:   ligneModal.ref_phyto_id   || null,
      ref_outil_id:   ligneModal.ref_outil_id   || null,
    }
    if (ligneModal.id) {
      let { error } = await supabase.from('cr_lignes').update(payload).eq('id', ligneModal.id)
      if (error && /\bdate\b|column/i.test(error.message)) {
        const { date, ...fallback } = payload
        ;({ error } = await supabase.from('cr_lignes').update(fallback).eq('id', ligneModal.id))
        if (!error) showToast('⚠️ Date non enregistrée — exécute migration_A_EXECUTER_50.sql dans Supabase → SQL Editor.')
      }
      if (error) { console.error('saveLigne — update:', error); alert(describeSupabaseError(error)); return }
      setLignes(prev => prev.map(l => l.id === ligneModal.id ? { ...l, ...payload, id: ligneModal.id } : l))
      if (viewGlobal) setGlobalLignes(prev => prev.map(l => l.id === ligneModal.id ? { ...l, ...payload, id: ligneModal.id } : l))
    } else {
      let { data, error } = await supabase.from('cr_lignes').insert(payload).select().single()
      if (error && /\bdate\b|column/i.test(error.message)) {
        const { date, ...fallback } = payload
        ;({ data, error } = await supabase.from('cr_lignes').insert(fallback).select().single())
        if (!error) showToast('⚠️ Date non enregistrée — exécute migration_A_EXECUTER_50.sql dans Supabase → SQL Editor.')
      }
      if (error) { console.error('saveLigne — insert:', error); alert(describeSupabaseError(error)); return }
      setLignes(prev => [...prev, data])
      if (viewGlobal) setGlobalLignes(prev => [...prev, data])
    }
    setLigneModal(null)
    showToast('✅ Ligne enregistrée')
  }

  // Met à jour le prix de toutes les lignes de coût (toutes fiches, toute la
  // campagne active) ayant un produit phyto ou un intrant lié, avec le prix EFFECTIF
  // à la date de chaque ligne (prixEffectif) — pas bêtement le prix courant de la Base
  // de données : une ligne datée d'avant la date d'effet d'un prix prévisionnel garde
  // son ancien prix, seules celles datées à partir de cette date basculent sur le
  // nouveau prix. Ne touche pas les lignes saisies librement (sans ref_phyto_id/
  // ref_intrant_id) : rien à aller chercher pour elles.
  async function syncAllPrices() {
    if (!confirm("Mettre à jour le prix de toutes les lignes de coût phyto et intrants (toutes les fiches de la campagne) avec le prix effectif de la Base de données à la date de chaque ligne ?")) return
    const ficheIds = fiches.map(f => f.id)
    if (!ficheIds.length) return
    const { data: allLignes, error } = await supabase.from('cr_lignes').select('*')
      .in('fiche_id', ficheIds)
      .or('ref_phyto_id.not.is.null,ref_intrant_id.not.is.null')
    if (error) { alert(error.message); return }
    const ficheSurfaceById = Object.fromEntries(fiches.map(f => [f.id, f.surface_ha]))
    const updates = []
    for (const l of allLignes || []) {
      const prod = l.ref_phyto_id ? phytoById[l.ref_phyto_id] : (l.ref_intrant_id ? intrantById[l.ref_intrant_id] : null)
      const newPrix = prod ? prixEffectif(prod, l.date) : null
      if (newPrix == null || newPrix === l.prix_unitaire) continue
      const montant_ha = l.quantite_ha != null ? +(l.quantite_ha * newPrix).toFixed(4) : l.montant_ha
      const surface = ficheSurfaceById[l.fiche_id]
      const montant_total = montant_ha != null && surface > 0 ? +(montant_ha * surface).toFixed(2) : l.montant_total
      updates.push({ id: l.id, patch: { prix_unitaire: newPrix, montant_ha, montant_total } })
    }
    if (!updates.length) { showToast('✅ Tous les prix étaient déjà à jour'); return }
    await Promise.all(updates.map(u => supabase.from('cr_lignes').update(u.patch).eq('id', u.id)))
    showToast(`✅ ${updates.length} ligne(s) de coût mise(s) à jour avec les prix actuels`)
    if (activeId) loadLignes(activeId)
  }

  async function deleteLigne() {
    if (!confirm('Supprimer cette ligne ?')) return
    await supabase.from('cr_lignes').delete().eq('id', ligneModal.id)
    setLignes(prev => prev.filter(l => l.id !== ligneModal.id))
    if (viewGlobal) setGlobalLignes(prev => prev.filter(l => l.id !== ligneModal.id))
    setLigneModal(null)
    showToast('🗑️ Ligne supprimée')
  }

  // Déplace en une fois tous les passages d'un même élément (ex. "Broyage") vers
  // une autre grande catégorie — corrige un mauvais classement (source) sans
  // avoir à rouvrir chaque ligne une par une. Le libellé/la catégorie détaillée
  // (ex. "Broyage") ne change pas, seule la grande catégorie (source) bouge.
  // Découpe une mise à jour .in('id', ids) en lots de 200 — un seul appel avec
  // beaucoup d'ids (ex. "tous les passages" d'un produit courant sur toute la
  // campagne, désormais nombreux depuis l'import automatique des lignes) peut
  // dépasser la longueur d'URL acceptée par PostgREST et échouer en Bad Request.
  async function chunkedUpdateLignes(ids, patch) {
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from('cr_lignes').update(patch).in('id', ids.slice(i, i + 200))
      if (error) return error
    }
    return null
  }
  // Message complet (message + details + hint + code Postgres/PostgREST) —
  // error.message seul masque souvent la vraie cause (contrainte violée,
  // colonne manquante…) derrière un texte générique comme "Bad Request".
  function describeSupabaseError(error) {
    return [error.message, error.details, error.hint, error.code ? `(code ${error.code})` : null].filter(Boolean).join('\n')
  }

  async function recategorizeLignes(lignesToMove, newSource) {
    if (!lignesToMove.length) return
    const label = SOURCE_TABS.find(t => t.key === newSource)?.label || newSource
    if (!confirm(`Déplacer ${lignesToMove.length} passage(s) de "${lignesToMove[0].libelle}" vers ${label} ?`)) return
    const ids = lignesToMove.map(l => l.id)
    const error = await chunkedUpdateLignes(ids, { source: newSource })
    if (error) { console.error('recategorizeLignes:', error); alert(`Échec (${ids.length} ligne(s)) : ${describeSupabaseError(error)}`); return }
    const idSet = new Set(ids)
    setLignes(prev => prev.map(l => idSet.has(l.id) ? { ...l, source: newSource } : l))
    setGlobalLignes(prev => prev.map(l => idSet.has(l.id) ? { ...l, source: newSource } : l))
    showToast(`✅ ${lignesToMove.length} passage(s) déplacé(s) vers ${label}`)
  }

  // Reclasse en masse dans une sous-catégorie (ex. "Fientes" → Fertilisant
  // organique) sans changer la grande catégorie (source) — même principe que
  // recategorizeLignes, mais sur le champ categorie plutôt que source.
  async function recategorizeSubcat(lignesToMove, newCategorie) {
    if (!lignesToMove.length) return
    if (!confirm(`Déplacer ${lignesToMove.length} passage(s) de "${lignesToMove[0].libelle}" vers "${newCategorie}" ?`)) return
    const ids = lignesToMove.map(l => l.id)
    const error = await chunkedUpdateLignes(ids, { categorie: newCategorie })
    if (error) { console.error('recategorizeSubcat:', error); alert(`Échec (${ids.length} ligne(s)) : ${describeSupabaseError(error)}`); return }
    const idSet = new Set(ids)
    setLignes(prev => prev.map(l => idSet.has(l.id) ? { ...l, categorie: newCategorie } : l))
    setGlobalLignes(prev => prev.map(l => idSet.has(l.id) ? { ...l, categorie: newCategorie } : l))
    showToast(`✅ ${lignesToMove.length} passage(s) déplacé(s) vers "${newCategorie}"`)
  }

  /* ── PRINT / EXPORT PDF ── */
  const INTERVENTION_COLORS = {
    'Traitement et protection des cultures': '#8e44ad',
    'Ferti minérale et foliaire':            '#27ae60',
    'Fertilisation et amendement organique': '#16a085',
    'Plantation':                            'var(--amber, #d68a1f)',
    'Désherbage mécanique':                  '#7f8c8d',
  }
  const FALLBACK_INTERVENTION_COLOR = '#4a7c59'

  // Imprime la page elle-même (window.print() + zone .print-area, voir index.css)
  // plutôt que d'ouvrir une popup window.open() : sur mobile/app native, une
  // popup casse le bouton retour matériel (fait quitter l'appli) et n'ouvre pas
  // toujours le vrai dialogue d'impression natif — même pattern que la
  // Confirmation d'achat dans Planning.jsx.
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    if (!printing) return
    document.body.classList.add('printing-active')
    function onAfterPrint() {
      document.body.classList.remove('printing-active')
      setPrinting(false)
    }
    window.addEventListener('afterprint', onAfterPrint)
    const t = setTimeout(() => window.print(), 80)
    return () => { clearTimeout(t); window.removeEventListener('afterprint', onAfterPrint) }
  }, [printing])
  function printFiche() {
    if (!activeFiche) return
    setPrinting(true)
  }

  // Données de la fiche à imprimer — recalculées à la volée à partir du même
  // state que l'écran (rien de dupliqué en base), utilisées uniquement par la
  // zone .print-area ci-dessous.
  const printSurface = activeFiche?.surface_ha || 0
  const printGrouped = activeFiche ? SOURCE_TABS.map(t => ({
    ...t,
    lignes: lignes.filter(l => l.source === t.key),
    total:  lignes.filter(l => l.source === t.key).reduce((s, l) => s + (l.montant_ha || 0), 0),
  })).filter(g => g.lignes.length > 0) : []
  const printParcelleInterventions = activeFiche?.parcelle_id
    ? interventionsPhyto.filter(i => i.parcelle_id === activeFiche.parcelle_id)
    : []
  const printInterventionGroups = (() => {
    const eventGroups = sortGroupsByDateAsc(groupInterventions(printParcelleInterventions))
    const byType = new Map()
    for (const g of eventGroups) {
      if (!byType.has(g.type)) byType.set(g.type, { type: g.type, color: INTERVENTION_COLORS[g.type] || FALLBACK_INTERVENTION_COLOR, events: [] })
      byType.get(g.type).events.push(g)
    }
    return Array.from(byType.values()).sort((a, b) => (a.events[0]?.date || '').localeCompare(b.events[0]?.date || ''))
  })()

  /* ══ Render ══ */
  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
      {ToastEl}

      {/* ── Left panel: liste fiches — on mobile, hidden once une fiche (ou la vue globale) est sélectionnée ── */}
      {(!isMobile || (!activeFiche && !viewGlobal && !viewParCulture)) && (
      <div style={{ width: isMobile ? '100%' : 280, borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', background:'white', flexShrink:0 }}>
        <div style={{ padding:'.9rem', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:'.5rem' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <h3 style={{ fontSize:'.95rem', fontWeight:700 }}>Fiches parcellaires</h3>
            <div style={{ display:'flex', gap:'.35rem' }}>
              <button className="btn-sm" onClick={autoCategorizeAllLignes} title="Catégoriser automatiquement toutes les lignes phyto/intrant d'après la Base de données et EPHY" style={{ padding:'.33rem .5rem', fontSize:'.76rem' }}>🏷️</button>
              <button className="btn-sm" onClick={resetAllFichesForCampagne} title="Supprimer et recréer toutes les fiches de cette campagne depuis les parcelles/interventions actuelles" style={{ padding:'.33rem .5rem', fontSize:'.76rem' }}>🔄</button>
              <button className="btn-sm primary" onClick={openNewFiche} style={{ padding:'.33rem .65rem', fontSize:'.76rem' }}>+ Nouvelle</button>
            </div>
          </div>
          <input type="text" placeholder="🔍 Parcelle, culture…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ padding:'.42rem .75rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.82rem', outline:'none' }} />
        </div>
        <div style={{ padding:'.5rem .5rem 0', display:'flex', flexDirection:'column', gap:0 }}>
          <div onClick={() => { setViewGlobal(true); setViewParCulture(false) }}
            style={{ padding:'.65rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3,
              background: viewGlobal ? 'var(--green-pale)' : 'var(--cream)',
              border: viewGlobal ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
              display:'flex', alignItems:'center', gap:'.5rem', fontWeight:700, fontSize:'.86rem',
              color: viewGlobal ? 'var(--green-mid)' : 'var(--text-main)' }}>
            🌍 Vue globale — toutes les parcelles
          </div>
          <div onClick={() => { setViewParCulture(true); setViewGlobal(false) }}
            style={{ padding:'.65rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3,
              background: viewParCulture ? 'var(--green-pale)' : 'var(--cream)',
              border: viewParCulture ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
              display:'flex', alignItems:'center', gap:'.5rem', fontWeight:700, fontSize:'.86rem',
              color: viewParCulture ? 'var(--green-mid)' : 'var(--text-main)' }}>
            📊 Prix de revient par culture
          </div>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'.5rem' }}>
          {filtered.length === 0 && (
            <div style={{ padding:'1.5rem', textAlign:'center', color:'var(--text-muted)', fontSize:'.82rem' }}>
              Aucune fiche — créez-en une.
            </div>
          )}
          {/* Group by culture */}
          {Array.from(new Set(filtered.map(f => f.culture || 'Non défini'))).map(culture => (
            <div key={culture}>
              <div style={{ fontSize:'.68rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:'var(--text-muted)', padding:'.4rem .6rem .2rem' }}>{culture}</div>
              {filtered.filter(f => (f.culture || 'Non défini') === culture).map(f => {
                const total = lignes.filter(l => l.fiche_id === f.id).reduce((s, l) => s + (l.montant_ha || 0), 0)
                return (
                  <div key={f.id} onClick={() => { setActiveId(f.id); setViewGlobal(false); setViewParCulture(false) }}
                    style={{ padding:'.65rem .85rem', borderRadius:9, cursor:'pointer', marginBottom:3, position:'relative',
                      background: activeId===f.id ? 'var(--green-pale)' : 'transparent',
                      border: activeId===f.id ? '1.5px solid var(--green-accent)' : '1.5px solid transparent',
                      transition:'all .12s' }}
                    onMouseEnter={e => { if (activeId!==f.id) e.currentTarget.style.background='#f5f5f5' }}
                    onMouseLeave={e => { if (activeId!==f.id) e.currentTarget.style.background='transparent' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div style={{ fontWeight:600, fontSize:'.86rem', color: activeId===f.id ? 'var(--green-mid)' : 'var(--text-main)' }}>{f.nom}</div>
                      <button onClick={e => { e.stopPropagation(); deleteFicheDirect(f) }} title="Supprimer cette fiche"
                        style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-muted)', fontSize:'.8rem', padding:'0 0 0 .5rem', lineHeight:1, flexShrink:0 }}
                        onMouseEnter={e=>e.currentTarget.style.color='var(--red)'}
                        onMouseLeave={e=>e.currentTarget.style.color='var(--text-muted)'}>🗑️</button>
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', marginTop:2 }}>
                      <span style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{f.parcelle_nom || f.entite || '—'} · {f.surface_ha ? f.surface_ha+'ha' : '?ha'}</span>
                      {total > 0 && <span style={{ fontSize:'.72rem', fontWeight:700, color:'var(--green-mid)' }}>{total.toFixed(0)} €/ha</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      )}

      {/* ── Right panel: fiche detail (ou vue globale) — on mobile, only shown once selected ── */}
      {(!isMobile || activeFiche || viewGlobal || viewParCulture) && (
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {viewParCulture ? (
          <>
            <div style={{ background:'var(--green-deep)', padding:'1rem 1.5rem', flexShrink:0, display:'flex', alignItems:'center', gap:'.6rem' }}>
              {isMobile && <button className="btn-sm" onClick={()=>setViewParCulture(false)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', flexShrink:0 }}>← Retour</button>}
              <div>
                <h2 style={{ color:'white', fontSize:'1.15rem', fontWeight:700 }}>📊 Prix de revient par culture</h2>
                <div style={{ color:'rgba(255,255,255,.6)', fontSize:'.78rem', marginTop:'.25rem' }}>
                  Campagne {campagneActive} · {fiches.length} fiche{fiches.length>1?'s':''}
                </div>
              </div>
            </div>
            <div style={{ flex:1, overflow:'auto', padding:'1rem 1.5rem' }}>
              {globalLoading ? (
                <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)' }}>Chargement…</div>
              ) : (
                <CoutParCultureView fiches={fiches} lignes={globalLignes} ficheById={ficheById} onEdit={openEditLigne} />
              )}
            </div>
          </>
        ) : viewGlobal ? (
          <>
            <div style={{ background:'var(--green-deep)', padding:'1rem 1.5rem', flexShrink:0, display:'flex', alignItems:'center', gap:'.6rem' }}>
              {isMobile && <button className="btn-sm" onClick={()=>setViewGlobal(false)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', flexShrink:0 }}>← Retour</button>}
              <div>
                <h2 style={{ color:'white', fontSize:'1.15rem', fontWeight:700 }}>🌍 Vue globale — toutes les parcelles</h2>
                <div style={{ color:'rgba(255,255,255,.6)', fontSize:'.78rem', marginTop:'.25rem' }}>
                  Campagne {campagneActive} · {fiches.length} fiche{fiches.length>1?'s':''} · {globalLignes.length} ligne{globalLignes.length>1?'s':''} de coût
                </div>
              </div>
              <div style={{ marginLeft:'auto', background:'var(--green-accent)', borderRadius:8, padding:'.4rem 1rem', textAlign:'center' }}>
                <div style={{ fontSize:'.65rem', color:'rgba(255,255,255,.7)', textTransform:'uppercase', letterSpacing:'.04em' }}>TOTAL FERME</div>
                <div style={{ fontSize:'1.2rem', fontWeight:800, color:'white' }}>{globalLignes.reduce((s,l)=>s+(l.montant_total||0),0).toFixed(2)} €</div>
              </div>
            </div>
            <div style={{ flex:1, overflow:'auto', padding:'1rem 1.5rem' }}>
              {globalLoading ? (
                <div style={{ textAlign:'center', padding:'2rem', color:'var(--text-muted)' }}>Chargement…</div>
              ) : (
                <CategorieBreakdown lignes={globalLignes} expanded={expandedItems} toggle={toggleItem} onEdit={openEditLigne} showParcelle={true} ficheById={ficheById} onRecategorize={recategorizeLignes} onRecategorizeSubcat={recategorizeSubcat} />
              )}
            </div>
          </>
        ) : !activeFiche ? (
          <div style={{ flex:1, display:'grid', placeItems:'center', color:'var(--text-muted)' }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:'3rem', marginBottom:'.5rem' }}>📊</div>
              <p>Sélectionnez une fiche ou créez-en une nouvelle</p>
            </div>
          </div>
        ) : (
          <>
            {/* Fiche header */}
            <div style={{ background:'var(--green-deep)', padding:'1rem 1.5rem', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', flexWrap:'wrap', gap:'.6rem' }}>
                <div style={{ display:'flex', alignItems:'flex-start', gap:'.6rem' }}>
                  {isMobile && <button className="btn-sm" onClick={()=>setActiveId(null)} style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', flexShrink:0 }}>← Retour</button>}
                  <div>
                    <h2 style={{ color:'white', fontSize:'1.15rem', fontWeight:700 }}>{activeFiche.nom}</h2>
                    <div style={{ color:'rgba(255,255,255,.6)', fontSize:'.78rem', marginTop:'.25rem' }}>
                      {[activeFiche.culture, activeFiche.parcelle_nom, activeFiche.entite, activeFiche.campagne].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
                <div style={{ display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap' }}>
                  <button className="btn-sm" onClick={syncAllPrices} title="Recharge le prix de toutes les lignes phyto/intrants (toutes les fiches) depuis la Base de données"
                    style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', fontSize:'.78rem' }}>🔄 Mettre à jour les prix</button>
                  <button className="btn-sm" onClick={openEditFiche}
                    style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', fontSize:'.78rem' }}>✏️ Modifier</button>
                  <button className="btn-sm" onClick={printFiche}
                    style={{ background:'rgba(255,255,255,.12)', color:'white', borderColor:'rgba(255,255,255,.3)', fontSize:'.78rem' }}>📄 Exporter PDF</button>
                </div>
              </div>

              {/* KPI row */}
              <div style={{ display:'flex', gap:'1rem', marginTop:'.9rem', flexWrap:'wrap' }}>
                {SOURCE_TABS.map(t => {
                  const tot = totalForSource(t.key)
                  return tot > 0 ? (
                    <div key={t.key} style={{ background:'rgba(255,255,255,.1)', borderRadius:8, padding:'.4rem .85rem', textAlign:'center' }}>
                      <div style={{ fontSize:'.65rem', color:'rgba(255,255,255,.55)', textTransform:'uppercase', letterSpacing:'.04em' }}>{t.label}</div>
                      <div style={{ fontSize:'1rem', fontWeight:700, color:'white' }}>{tot.toFixed(2)} €/ha</div>
                    </div>
                  ) : null
                })}
                <div style={{ background:'var(--green-accent)', borderRadius:8, padding:'.4rem 1rem', textAlign:'center', marginLeft:'auto' }}>
                  <div style={{ fontSize:'.65rem', color:'rgba(255,255,255,.7)', textTransform:'uppercase', letterSpacing:'.04em' }}>TOTAL</div>
                  <div style={{ fontSize:'1.2rem', fontWeight:800, color:'white' }}>{grandTotalHa.toFixed(2)} €/ha</div>
                  {activeFiche.surface_ha && (
                    <div style={{ fontSize:'.65rem', color:'rgba(255,255,255,.7)' }}>{grandTotalTotal.toFixed(2)} € sur {activeFiche.surface_ha} ha</div>
                  )}
                </div>
              </div>
            </div>

            {/* Interventions terrain — toujours visibles, indépendamment de l'onglet coût sélectionné */}
            {activeFiche.parcelle_id && (
              <div style={{ background:'white', borderBottom:'1px solid var(--border)', padding:'.9rem 1.5rem', flexShrink:0, maxHeight:220, overflowY:'auto' }}>
                <div style={{ fontSize:'.78rem', fontWeight:700, color:'var(--text-muted)', marginBottom:'.5rem', display:'flex', alignItems:'center', gap:'.4rem' }}>
                  🔄 Interventions enregistrées sur cette parcelle ({autoPhytoRows.length})
                </div>
                {autoPhytoRows.length === 0 ? (
                  <div style={{ fontSize:'.8rem', color:'var(--text-muted)', fontStyle:'italic' }}>
                    Aucune intervention liée à cette parcelle pour l'instant — elles apparaîtront ici automatiquement dès qu'enregistrées dans Commande Phyto &gt; Stock &amp; Interventions, ou importées via un fichier DAPLOS.
                  </div>
                ) : (
                  <div style={{ display:'flex', flexDirection:'column', gap:'.6rem' }}>
                    {sortGroupsByDateDesc(groupInterventions(autoPhytoRows)).map((g, gi) => (
                      <div key={gi} style={{ border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
                        <div style={{ background:'var(--green-pale)', padding:'.4rem .8rem', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                          <span style={{ fontWeight:700, fontSize:'.8rem' }}>{fmtDate(g.date)}</span>
                          <span style={{ fontSize:'.72rem', color:'var(--text-muted)' }}>{g.type} · {g.items.length} produit{g.items.length>1?'s':''}</span>
                        </div>
                        <table style={{ width:'100%', fontSize:'.8rem', borderCollapse:'collapse' }}>
                          <tbody>
                            {g.items.map(i => {
                              const produit = phytoFor(i.produit_id, i.produit_nom)
                              const s = activeFiche?.surface_ha
                              const qteHa = (i.quantite != null && s > 0) ? +(i.quantite / s).toFixed(3) : null
                              return (
                              <tr key={i.id}>
                                <td style={{ padding:'.35rem .8rem', borderTop:'1px solid var(--border)' }}>
                                  <strong>{i.produit_nom}</strong>
                                  {(produit?.substance_active || qteHa != null) && (
                                    <div style={{ fontSize:'.68rem', color:'var(--text-muted)' }}>
                                      {produit?.substance_active && <>🧬 {produit.substance_active}</>}
                                      {produit?.substance_active && qteHa != null && ' · '}
                                      {qteHa != null && `${qteHa} ${i.unite || ''}/ha`}
                                    </div>
                                  )}
                                </td>
                                <td style={{ padding:'.35rem .8rem', borderTop:'1px solid var(--border)', textAlign:'right', color:'var(--text-muted)' }}>{i.quantite} {i.unite}</td>
                                <td style={{ padding:'.35rem .8rem', borderTop:'1px solid var(--border)', textAlign:'right' }}>
                                  <button className="btn-sm" onClick={() => addLigneFromIntervention(i)} style={{ fontSize:'.72rem', padding:'.15rem .55rem' }}>
                                    + Ajouter au coût
                                  </button>
                                </td>
                              </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Lignes de coût — groupées par date d'intervention, pas par catégorie
                (chaque ligne garde sa catégorie visible via un badge coloré). */}
            <div style={{ flex:1, overflow:'auto', padding:'1rem 1.5rem' }}>
              <div style={{ fontSize:'.72rem', color:'var(--text-muted)', marginBottom:'.8rem' }}>
                💡 Utilisez "+ Ajouter au coût" sur une intervention ci-dessus pour reprendre son produit et sa quantité directement (il ne reste que le prix à saisir) — ou "+ Ajouter" pour une ligne saisie librement.
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'.8rem', flexWrap:'wrap', gap:'.6rem' }}>
                <div style={{ fontSize:'.82rem', color:'var(--text-muted)' }}>
                  {lignes.length === 0 ? 'Aucune ligne — ajoutez un poste de coût' : `${lignes.length} ligne(s) · ${grandTotalHa.toFixed(2)} €/ha`}
                </div>
                <div style={{ display:'flex', gap:'.5rem', alignItems:'center', flexWrap:'wrap' }}>
                  <div style={{ display:'flex', background:'var(--cream)', borderRadius:999, padding:2 }}>
                    <button onClick={() => setVueMode('date')} style={{ border:'none', cursor:'pointer', borderRadius:999, padding:'.35rem .8rem', fontSize:'.76rem', fontWeight:600, background: vueMode==='date' ? 'white' : 'transparent', boxShadow: vueMode==='date' ? 'var(--shadow-xs)' : 'none' }}>📅 Par date</button>
                    <button onClick={() => setVueMode('categorie')} style={{ border:'none', cursor:'pointer', borderRadius:999, padding:'.35rem .8rem', fontSize:'.76rem', fontWeight:600, background: vueMode==='categorie' ? 'white' : 'transparent', boxShadow: vueMode==='categorie' ? 'var(--shadow-xs)' : 'none' }}>🗂️ Par catégorie</button>
                  </div>
                  <button className="btn-sm primary" onClick={openNewLigne} style={{ fontSize:'.78rem' }}>+ Ajouter</button>
                </div>
              </div>

              {vueMode === 'categorie' ? (
                <CategorieBreakdown lignes={lignes} expanded={expandedItems} toggle={toggleItem} onEdit={openEditLigne} showParcelle={false} ficheById={{}} onRecategorize={recategorizeLignes} onRecategorizeSubcat={recategorizeSubcat} />
              ) : lignes.length === 0 ? (
                <div style={{ textAlign:'center', padding:'2.5rem', background:'white', borderRadius:12, border:'2px dashed var(--border)', color:'var(--text-muted)' }}>
                  <div style={{ fontSize:'2rem', marginBottom:'.5rem' }}>💶</div>
                  <p style={{ fontSize:'.85rem' }}>Cliquez "+ Ajouter" pour saisir un poste de coût</p>
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:'.9rem' }}>
                  {lignesByDate.map(g => {
                    const totalGroupe = g.lignes.reduce((s, l) => s + (l.montant_ha || 0), 0)
                    return (
                    <div key={g.date} style={{ background:'white', border:'1px solid var(--border)', borderRadius:12, overflow:'hidden' }}>
                      <div style={{ background:'var(--cream)', padding:'.5rem .9rem', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <strong style={{ fontSize:'.82rem' }}>{g.date === 'Sans date' ? g.date : new Date(g.date).toLocaleDateString('fr-FR')}</strong>
                        <span style={{ fontSize:'.78rem', fontWeight:700, color:'var(--green-mid)' }}>{totalGroupe.toFixed(2)} €/ha</span>
                      </div>
                      <div style={{ overflowX:'auto', WebkitOverflowScrolling:'touch' }}>
                        <table style={{ width:'100%', minWidth:680, fontSize:'.83rem', borderCollapse:'collapse' }}>
                          <thead style={{ background:'var(--cream)' }}>
                            <tr>
                              <th style={th}>Libellé</th>
                              <th style={th}>Catégorie</th>
                              <th style={th}>Matière active</th>
                              <th style={{...th, textAlign:'right'}}>Qté/ha</th>
                              <th style={th}>Unité</th>
                              <th style={{...th, textAlign:'right'}}>Prix unit.</th>
                              <th style={{...th, textAlign:'right'}}>€/ha</th>
                              {activeFiche.surface_ha && <th style={{...th, textAlign:'right'}}>Total</th>}
                              <th style={th}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.lignes.map(l => (
                              <tr key={l.id} onClick={() => openEditLigne(l)} style={{ cursor:'pointer' }}
                                onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                                onMouseLeave={e => e.currentTarget.style.background = ''}>
                                <td style={td}><strong>{l.libelle}</strong></td>
                                <td style={td}>
                                  <span style={{ fontSize:'.68rem', fontWeight:700, padding:'.1rem .45rem', borderRadius:50, background:(SOURCE_COLOR[l.source]||'var(--text-muted)')+'22', color:SOURCE_COLOR[l.source]||'var(--text-muted)' }}>
                                    {SOURCE_TABS.find(t=>t.key===l.source)?.label || l.source}
                                  </span>
                                  {l.categorie && <div style={{ fontSize:'.7rem', color:'var(--text-muted)', marginTop:2 }}>{l.categorie}</div>}
                                </td>
                                <td style={{...td, color:'var(--text-muted)', fontSize:'.78rem'}}>{l.source === 'phyto' ? (phytoFor(l.ref_phyto_id, l.libelle)?.substance_active || '–') : '–'}</td>
                                <td style={{...td, textAlign:'right'}}>{l.quantite_ha ?? '–'}</td>
                                <td style={td}>{l.unite || '–'}</td>
                                <td style={{...td, textAlign:'right'}}>{l.prix_unitaire != null ? l.prix_unitaire + ' €' : '–'}</td>
                                <td style={{...td, textAlign:'right', fontWeight:700, color: SOURCE_COLOR[l.source]}}>
                                  {l.montant_ha != null ? (+l.montant_ha).toFixed(2) + ' €' : '–'}
                                </td>
                                {activeFiche.surface_ha && (
                                  <td style={{...td, textAlign:'right', color:'var(--text-muted)'}}>
                                    {l.montant_total != null ? (+l.montant_total).toFixed(2) + ' €' : '–'}
                                  </td>
                                )}
                                <td style={td}><span style={{ color:'var(--green-accent)' }}>✏️</span></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}

      {/* ══ Fiche Modal ══ */}
      {ficheModal && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setFicheModal(null)}>
          <div className="modal" style={{ maxWidth:520 }}>
            <div className="modal-hdr">
              <h3>{ficheModal.id ? 'Modifier la fiche' : 'Nouvelle fiche parcellaire'}</h3>
              <button className="modal-close" onClick={() => setFicheModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
                <FG label="Nom de la fiche *" span={2}>
                  <input autoFocus value={ficheModal.nom} onChange={e=>setFicheModal({...ficheModal,nom:e.target.value})} placeholder="ex. Blé 2026 — Rosée Nord" />
                </FG>
                <FG label="Culture">
                  <select value={ficheModal.culture||''} onChange={e=>setFicheModal({...ficheModal,culture:e.target.value})}>
                    <option value="">— Choisir —</option>
                    {['Blé','Orge','Escourgeon','Betteraves','Maïs','Pommes de terre'].map(c=><option key={c}>{c}</option>)}
                    <option value="Autre">Autre</option>
                  </select>
                </FG>
                <FG label="Campagne">
                  <input value={ficheModal.campagne || campagneActive} disabled placeholder={campagneActive} />
                </FG>
                <FG label="Parcelle">
                  <div style={{ position:'relative' }}>
                    <input placeholder="🔍 Rechercher une parcelle…" value={parcelleQ}
                      onChange={e => { setParcelleQ(e.target.value); setFicheModal({ ...ficheModal, parcelle_nom: e.target.value, parcelle_id: null }); setShowParcelleDd(true) }}
                      onFocus={() => setShowParcelleDd(true)}
                      onBlur={() => setTimeout(() => setShowParcelleDd(false), 200)} />
                    {showParcelleDd && parcelleQ.length > 0 && parcelles.filter(p => p.nom.toLowerCase().includes(parcelleQ.toLowerCase())).length > 0 && (
                      <div style={{ position:'absolute', top:'100%', left:0, right:0, background:'white', border:'1px solid var(--border)', borderRadius:8, boxShadow:'var(--shadow-md)', zIndex:300, maxHeight:160, overflowY:'auto' }}>
                        {parcelles.filter(p => p.nom.toLowerCase().includes(parcelleQ.toLowerCase())).slice(0,8).map(p => (
                          <div key={p.id} onMouseDown={() => { setParcelleQ(p.nom); setFicheModal({ ...ficheModal, parcelle_nom: p.nom, parcelle_id: p.id, culture: ficheModal.culture || p.culture_actuelle || '', surface_ha: ficheModal.surface_ha || p.surface || '' }); setShowParcelleDd(false) }}
                            style={{ padding:'.55rem 1rem', cursor:'pointer', fontSize:'.84rem', borderBottom:'1px solid var(--border)' }}>
                            <strong>{p.nom}</strong>{p.culture_actuelle && <span style={{ color:'var(--text-muted)' }}> — {p.culture_actuelle}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </FG>
                <FG label="Entité">
                  <input value={ficheModal.entite||''} onChange={e=>setFicheModal({...ficheModal,entite:e.target.value})} placeholder="ex. EARL Millard" />
                </FG>
                <FG label="Surface (ha)" span={2}>
                  <input type="number" step="0.01" value={ficheModal.surface_ha||''} onChange={e=>setFicheModal({...ficheModal,surface_ha:e.target.value})} placeholder="ex. 12.5" />
                </FG>
                <FG label="Notes" span={2}>
                  <textarea rows={2} value={ficheModal.notes||''} onChange={e=>setFicheModal({...ficheModal,notes:e.target.value})}
                    style={{ width:'100%', padding:'.6rem .85rem', border:'1.5px solid var(--border)', borderRadius:8, fontSize:'.85rem', outline:'none', resize:'vertical' }} />
                </FG>
              </div>
            </div>
            <div className="modal-foot">
              {ficheModal.id && <button className="btn-danger" onClick={deleteFiche}>Supprimer</button>}
              <button className="btn-sm" onClick={() => setFicheModal(null)}>Annuler</button>
              <button className="btn-sm primary" onClick={saveFiche}>Enregistrer</button>
            </div>
          </div>
        </div>
      )}

      {/* ══ Ligne Modal ══ */}
      {ligneModal && (
        <LigneModal
          ligne={ligneModal}
          setLigne={setLigneModal}
          surface={activeFiche?.surface_ha ?? fiches.find(f => f.id === ligneModal.fiche_id)?.surface_ha}
          intrants={intrants}
          phytos={phytos}
          outils={outils}
          onSave={saveLigne}
          onDelete={ligneModal.id ? deleteLigne : null}
          onClose={() => setLigneModal(null)}
          calcLigne={calcLigne}
        />
      )}

      {/* Zone imprimable — invisible à l'écran, seule visible sur le document
          imprimé/PDF (voir .print-area dans index.css). */}
      {activeFiche && (
        <div className="print-area" style={{ fontFamily: 'Arial, sans-serif', padding: 40, color: '#1a2e1c', fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 28 }}>
            <div>
              <div style={{ fontSize: 22, fontWeight: 'bold', color: '#4a9050' }} dangerouslySetInnerHTML={{ __html: printLogoHtml() }} />
              <div style={{ color: '#888', fontSize: 11, marginTop: 3 }}>FICHE PARCELLAIRE</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{activeFiche.nom}</div>
              <div style={{ color: '#888', fontSize: 11 }}>Campagne {activeFiche.campagne || '—'}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
            {[['Culture', activeFiche.culture], ['Parcelle', activeFiche.parcelle_nom], ['Entité', activeFiche.entite], ['Surface', printSurface ? printSurface + ' ha' : null]].map(([label, val]) => (
              <div key={label} style={{ background: '#f5f2eb', borderRadius: 7, padding: '10px 14px' }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: '#6b7c6d' }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#1a2e1c', marginTop: 3 }}>{val || '—'}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', margin: '26px 0 10px', paddingBottom: 6, borderBottom: '2px solid #1a2e1c' }}>
            🌾 Interventions sur la parcelle ({printParcelleInterventions.length})
          </div>
          {printInterventionGroups.length === 0 ? (
            <div style={{ color: '#888', fontSize: 12, fontStyle: 'italic', marginBottom: 20 }}>Aucune intervention enregistrée sur cette parcelle.</div>
          ) : printInterventionGroups.map((g, gi) => {
            const nbProduits = g.events.reduce((s, e) => s + e.items.length, 0)
            return (
              <div key={gi} style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', padding: '6px 10px', borderRadius: '5px 5px 0 0', color: 'white', background: g.color }}>
                  {g.type} ({nbProduits} produit{nbProduits > 1 ? 's' : ''} sur {g.events.length} intervention{g.events.length > 1 ? 's' : ''})
                </div>
                {g.events.map((ev, evi) => (
                  <div key={evi} style={{ borderBottom: evi === g.events.length - 1 ? 'none' : '2px solid #eee' }}>
                    <div style={{ background: '#faf9f6', padding: '6px 10px', fontSize: 11, fontWeight: 700, color: '#4a7c59' }}>
                      {ev.date ? new Date(ev.date).toLocaleDateString('fr-FR') : '–'} — {ev.items.length} produit{ev.items.length > 1 ? 's' : ''} appliqué{ev.items.length > 1 ? 's' : ''} ensemble
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {ev.items.map((it, ii) => (
                          <tr key={ii}>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12 }}><strong>{it.produit_nom}</strong></td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right', fontWeight: 600, width: 100 }}>{it.quantite != null ? it.quantite : '–'}</td>
                            <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, width: 60 }}>{it.unite || '–'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )
          })}

          <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', margin: '26px 0 10px', paddingBottom: 6, borderBottom: '2px solid #1a2e1c' }}>
            💶 Coût de revient
          </div>
          {printGrouped.length === 0 ? (
            <div style={{ color: '#888', fontSize: 12, fontStyle: 'italic', marginBottom: 20 }}>Aucun poste de coût saisi.</div>
          ) : printGrouped.map(g => (
            <div key={g.key} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', padding: '6px 10px', borderRadius: '5px 5px 0 0', color: 'white', background: g.color }}>{g.label}</div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  {['Libellé','Catégorie','Qté/ha','Unité','Prix unit.','€/ha',`Total (${printSurface} ha)`].map((h, i) => (
                    <th key={h} style={{ background: '#f5f2eb', padding: '7px 10px', textAlign: i >= 2 && i !== 3 ? 'right' : 'left', fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: '#6b7c6d', borderBottom: '1px solid #dde8de' }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {g.lignes.map(l => (
                    <tr key={l.id}>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12 }}><strong>{l.libelle}</strong></td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12 }}>{l.categorie || '–'}</td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right' }}>{l.quantite_ha != null ? l.quantite_ha : '–'}</td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12 }}>{l.unite || '–'}</td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right' }}>{l.prix_unitaire != null ? l.prix_unitaire + ' €' : '–'}</td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right', fontWeight: 600 }}>{l.montant_ha != null ? (+l.montant_ha).toFixed(2) + ' €' : '–'}</td>
                      <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right', fontWeight: 600 }}>{l.montant_total != null ? (+l.montant_total).toFixed(2) + ' €' : '–'}</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f5f2eb', fontWeight: 700 }}>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12 }} colSpan={5}>Sous-total {g.label}</td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right' }}>{g.total.toFixed(2)} €/ha</td>
                    <td style={{ padding: '7px 10px', borderBottom: '1px solid #dde8de', fontSize: 12, textAlign: 'right' }}>{(g.total * printSurface).toFixed(2)} €</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}

          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <tbody><tr style={{ background: '#1a2e1c', color: 'white' }}>
              <td style={{ padding: '12px 14px', fontSize: 14, fontWeight: 700 }} colSpan={5}>COÛT DE REVIENT TOTAL</td>
              <td style={{ padding: '12px 14px', fontSize: 14, fontWeight: 700, textAlign: 'right' }}>{grandTotalHa.toFixed(2)} €/ha</td>
              <td style={{ padding: '12px 14px', fontSize: 14, fontWeight: 700, textAlign: 'right' }}>{grandTotalTotal.toFixed(2)} €</td>
            </tr></tbody>
          </table>

          {activeFiche.notes && (
            <div style={{ marginTop: 20, background: '#f5f2eb', padding: 12, borderRadius: 7, fontSize: 12 }}><strong>Notes :</strong> {activeFiche.notes}</div>
          )}
          <div style={{ marginTop: 28, fontSize: 10, color: '#aaa', borderTop: '1px solid #dde8de', paddingTop: 10, textAlign: 'center' }}>
            Document généré le {new Date().toLocaleDateString('fr-FR')}
          </div>
        </div>
      )}
    </div>
  )
}

/* ── Ligne Modal — picks from BDD or manual entry ── */
function LigneModal({ ligne, setLigne, surface, intrants, phytos, outils, onSave, onDelete, onClose, calcLigne }) {
  const [bddSearch, setBddSearch] = useState('')
  const [showBdd, setShowBdd]     = useState(false)

  // La catégorie est un champ de la ligne elle-même (plus un onglet actif de la
  // page parente) — se change ici, dans le formulaire.
  const source = ligne.source
  const sourceInfo = SOURCE_TABS.find(t => t.key === source)

  // Live calculation preview
  const preview = calcLigne(ligne)

  // Prix effectif à la date de la ligne (si déjà renseignée), sinon prix courant.
  function pickFromBdd(item, type) {
    const prix = prixEffectif(item, ligne.date)
    if (type === 'intrant') {
      // Catégorie reprise automatiquement si ce produit est déjà classé dans Base de
      // données (Fertilisant/Semences/Engrais) — reste modifiable ensuite via le select.
      setLigne({ ...ligne, libelle: item.nom, categorie: mapDbCategorieToCoutRevient(item.categorie, 'intrant') || ligne.categorie || '', unite: item.unite || '', ref_intrant_id: item.id, prix_unitaire: prix ?? ligne.prix_unitaire })
    } else if (type === 'phyto') {
      // Idem pour les phyto (Fongicide/Herbicide/Insecticide/Régulateur/Adjuvant) —
      // sinon laissée vide, à choisir explicitement parmi les sous-catégories (select ci-dessous).
      setLigne({ ...ligne, libelle: phytoDisplayName(item), categorie: mapDbCategorieToCoutRevient(item.categorie, 'phyto') || ligne.categorie || '', unite: 'L', ref_phyto_id: item.id, prix_unitaire: prix ?? ligne.prix_unitaire })
    } else if (type === 'outil') {
      // Coût/ha renseigné en Base de données (Matériel) repris automatiquement —
      // une ligne d'outil est une prestation au forfait/ha, pas une quantité×prix
      // comme un produit : on force donc la quantité à 1 ha pour que le montant/ha
      // affiché soit directement le coût/ha de l'outil.
      setLigne({
        ...ligne, libelle: item.nom, categorie: item.type || '', ref_outil_id: item.id,
        unite: 'ha', quantite_ha: item.cout_ha != null ? 1 : ligne.quantite_ha,
        prix_unitaire: item.cout_ha ?? ligne.prix_unitaire,
      })
    }
    setBddSearch('')
    setShowBdd(false)
  }

  // BDD search results based on source
  const bddItems = source === 'intrant'
    ? intrants.filter(i => !bddSearch || i.nom.toLowerCase().includes(bddSearch.toLowerCase()))
    : source === 'phyto'
    ? phytos.filter(p => phytoMatches(p, bddSearch))
    : source === 'mecanisation'
    ? outils.filter(o => !bddSearch || o.nom.toLowerCase().includes(bddSearch.toLowerCase()))
    : []

  const hasBdd = bddItems.length > 0

  return (
    <div className="modal-overlay" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth:540 }}>
        <div className="modal-hdr" style={{ background: sourceInfo?.color || 'var(--green-deep)' }}>
          <h3>{ligne.id ? 'Modifier' : 'Ajouter'} — {sourceInfo?.label}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* BDD picker */}
          {hasBdd && (
            <div style={{ marginBottom:'1rem' }}>
              <button className="btn-sm" onClick={() => setShowBdd(!showBdd)} style={{ width:'100%', justifyContent:'center', fontSize:'.82rem' }}>
                📥 {showBdd ? 'Masquer' : 'Charger depuis la base de données'}
              </button>
              {showBdd && (
                <div style={{ marginTop:'.6rem', border:'1px solid var(--border)', borderRadius:10, overflow:'hidden' }}>
                  <input type="text" placeholder="🔍 Rechercher…" value={bddSearch} onChange={e=>setBddSearch(e.target.value)}
                    style={{ width:'100%', padding:'.5rem .85rem', border:'none', borderBottom:'1px solid var(--border)', fontSize:'.83rem', outline:'none' }} />
                  <div style={{ maxHeight:160, overflowY:'auto' }}>
                    {bddItems.slice(0,12).map(item => (
                      <div key={item.id} onMouseDown={() => pickFromBdd(item, source === 'mecanisation' ? 'outil' : source)}
                        style={{ padding:'.5rem .85rem', cursor:'pointer', fontSize:'.82rem', borderBottom:'1px solid var(--border)', display:'flex', justifyContent:'space-between' }}
                        onMouseEnter={e => e.currentTarget.style.background='var(--green-pale)'}
                        onMouseLeave={e => e.currentTarget.style.background=''}>
                        <strong>{source === 'phyto' ? phytoDisplayName(item) : item.nom}</strong>
                        <span style={{ color:'var(--text-muted)', fontSize:'.75rem' }}>{source === 'mecanisation' && item.cout_ha != null ? `${item.cout_ha} €/ha` : (item.categorie || item.type || item.num_amm || '')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'.8rem' }}>
            <FG label="Libellé *" span={2}>
              <input autoFocus value={ligne.libelle} onChange={e=>setLigne({...ligne,libelle:e.target.value})} placeholder="Nom du produit, outil, prestation…" />
            </FG>
            <FG label="Type">
              <select value={source} onChange={e=>setLigne({...ligne,source:e.target.value})}>
                {SOURCE_TABS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </FG>
            <FG label="Date de l'intervention">
              <input type="date" value={ligne.date||''} onChange={e=>setLigne({...ligne,date:e.target.value})} />
            </FG>
            <FG label="Catégorie" span={2}>
              {source === 'phyto' ? (
                <select value={ligne.categorie||''} onChange={e=>setLigne({...ligne,categorie:e.target.value})}>
                  <option value="">— Choisir —</option>
                  {PHYTO_SUBCATS.map(c => <option key={c}>{c}</option>)}
                  {ligne.categorie && !PHYTO_SUBCATS.includes(ligne.categorie) && <option value={ligne.categorie}>{ligne.categorie} (ancien)</option>}
                </select>
              ) : source === 'intrant' ? (
                <select value={ligne.categorie||''} onChange={e=>setLigne({...ligne,categorie:e.target.value})}>
                  <option value="">— Choisir —</option>
                  {INTRANT_SUBCATS.map(c => <option key={c}>{c}</option>)}
                  {ligne.categorie && !INTRANT_SUBCATS.includes(ligne.categorie) && <option value={ligne.categorie}>{ligne.categorie} (ancien)</option>}
                </select>
              ) : (
                <input value={ligne.categorie||''} onChange={e=>setLigne({...ligne,categorie:e.target.value})} placeholder="ex. Travail du sol…" />
              )}
            </FG>
            <FG label="Unité">
              <select value={ligne.unite||''} onChange={e=>setLigne({...ligne,unite:e.target.value})}>
                <option value="">—</option>
                <option>L</option><option>kg</option><option>T</option>
                <option>h</option><option>U</option><option>sac</option><option>€</option>
              </select>
            </FG>
            <FG label="Quantité / ha">
              <input type="number" step="0.001" value={ligne.quantite_ha||''} onChange={e=>setLigne({...ligne,quantite_ha:e.target.value})} placeholder="dose/ha" />
            </FG>
            <FG label="Prix unitaire (€)">
              <input type="number" step="0.01" value={ligne.prix_unitaire||''} onChange={e=>setLigne({...ligne,prix_unitaire:e.target.value})} placeholder="€/L, €/kg, €/h…" />
            </FG>

            {/* Calculated preview */}
            {(preview.montant_ha || ligne.montant_ha) && (
              <div style={{ gridColumn:'1/-1', background:'var(--green-pale)', borderRadius:10, padding:'.7rem 1rem', display:'flex', gap:'2rem' }}>
                <div>
                  <div style={{ fontSize:'.7rem', color:'var(--text-muted)', textTransform:'uppercase' }}>€/ha calculé</div>
                  <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.3rem', color:'var(--green-mid)' }}>
                    {preview.montant_ha != null ? preview.montant_ha.toFixed(2) : '—'} €
                  </div>
                </div>
                {surface && (
                  <div>
                    <div style={{ fontSize:'.7rem', color:'var(--text-muted)', textTransform:'uppercase' }}>Total {surface} ha</div>
                    <div style={{ fontFamily:"'DM Serif Display',serif", fontSize:'1.3rem', color:'var(--green-mid)' }}>
                      {preview.montant_total != null ? preview.montant_total.toFixed(2) : '—'} €
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Manual override */}
            <FG label="€/ha (saisie directe si pas de qté × prix)">
              <input type="number" step="0.01" value={ligne.montant_ha||''} onChange={e=>setLigne({...ligne,montant_ha:e.target.value})} placeholder="ou saisir directement" />
            </FG>
            {surface && (
              <FG label={`Total (${surface} ha)`}>
                <input type="number" step="0.01" value={ligne.montant_total||''} onChange={e=>setLigne({...ligne,montant_total:e.target.value})} placeholder="auto-calculé" />
              </FG>
            )}
          </div>
        </div>
        <div className="modal-foot">
          {onDelete && <button className="btn-danger" onClick={onDelete}>Supprimer</button>}
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn-sm primary" onClick={onSave}>Enregistrer</button>
        </div>
      </div>
    </div>
  )
}

function FG({ label, span, children }) {
  return (
    <div className="form-group" style={span===2 ? { gridColumn:'1/-1' } : {}}>
      <label>{label}</label>
      {children}
    </div>
  )
}

const th = { padding:'.6rem .9rem', textAlign:'left', fontSize:'.72rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'.04em', color:'var(--text-muted)', borderBottom:'1px solid var(--border)', whiteSpace:'nowrap' }
const td = { padding:'.65rem .9rem', borderBottom:'1px solid var(--border)' }
