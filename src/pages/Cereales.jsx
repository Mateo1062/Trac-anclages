import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/AuthContext'
import { useToast } from '../lib/useToast'
import { isCerealCulture, parcelleMatchesCulture } from '../lib/cultureCodes'
import { defaultCampagne, campagnesDisponibles, isAtOrBeforeCampagne } from '../lib/campagne'
import { useCampagne } from '../lib/CampagneContext'
import useIsMobile from '../lib/useIsMobile'
import { fmtDate } from '../lib/formatDate'
import Modal from '../components/Modal'
import DossiersParcelles from '../components/DossiersParcelles'

/* ═══════════════════════════════════════════════════════════
   ACHAT / VENTE CÉRÉALES
   Contrats (comme les contrats PDT) + livraisons rattachées :
   chaque contrat engage un tonnage d'une culture, la barre de
   progression suit ce qui a été livré/enlevé.
═══════════════════════════════════════════════════════════ */

const CULTURES = ['Blé tendre', 'Blé dur', 'Orge d\'hiver', 'Orge de printemps', 'Escourgeon', 'Colza', 'Maïs', 'Tournesol', 'Pois', 'Féverole', 'Avoine', 'Seigle', 'Triticale', 'Luzerne']
const LIEUX_STOCKAGE = ['Cellule Orge', 'Cellule Blé', 'Hangar', 'Fredo', 'Soufflet (externe)', 'SCARA (externe)']
const LIEU_COLOR = { 'Cellule Orge': '#3d7a42', 'Cellule Blé': '#4a9050', 'Hangar': '#c9922c', 'Fredo': '#3498db', 'Soufflet (externe)': '#e8a33d', 'SCARA (externe)': '#c77d1f' }
// Noms des coopératives — reconnus à la fois dans lieu_stockage (stockage externe,
// nouvelle saisie) et lieu_livraison (sortie directe, ancienne saisie) pour ne pas
// perdre l'historique déjà enregistré avant l'ajout de ces lieux de stockage dédiés.
const COOP_NAMES = ['SCARA', 'Soufflet']
const coopMatch = nom => COOP_NAMES.find(c => (nom || '').toLowerCase().includes(c.toLowerCase())) || null

// Champs identiques malgré des noms différents dans les fiches (une seule entité
// possède le champ sous un nom, une autre le possède/l'exploite sous un autre nom)
// — à compléter au cas par cas quand on identifie une telle correspondance.
// "LA DIGUE" (EARL MILLARD) et "SALON" (SCEA HEMARD BAILLOT) ne sont plus fusionnés :
// SCEA Hémard Baillot ne doit plus être mélangée avec La Digue, même sur ce champ.
const CHAMPS_IDENTIQUES_NOMS_DIFFERENTS = []

// Détecte les parcelles administrativement scindées entre deux entités du Groupe
// Millard (ex. "RTE GOURGANCON" / EARL MILLARD et "RTE GOURGANCON MT" / SCEA
// MILLARD-TISSERANT) — même champ physique, même nom hormis le suffixe " MT" — plus
// les correspondances explicites listées ci-dessus (noms complètement différents).
// À la moisson on les suit comme un seul champ ; la répartition du tonnage entre
// les entités se fait plus tard, selon les quintaux à livrer de chacune.
function computeChampGroupes(parcelles) {
  const norm = n => (n || '').trim().toUpperCase().replace(/\s+MT$/, '').trim()
  const byName = {}
  parcelles.forEach(p => {
    const k = norm(p.nom)
    if (!k) return
    ;(byName[k] ??= []).push(p)
  })
  const autoGroups = Object.entries(byName)
    .filter(([, arr]) => arr.length > 1
      && new Set(arr.map(p => p.entite)).size > 1
      && arr.some(p => /millard/i.test(p.entite || '')))
    .map(([key, arr]) => ({ key: `auto:${key}`, arr }))

  const usedIds = new Set(autoGroups.flatMap(g => g.arr.map(p => p.id)))
  const manualGroups = CHAMPS_IDENTIQUES_NOMS_DIFFERENTS.map((noms, i) => {
    const wanted = noms.map(n => n.trim().toUpperCase())
    const matches = parcelles.filter(p => wanted.includes((p.nom || '').trim().toUpperCase()) && !usedIds.has(p.id))
    if (matches.length < 2) return null
    // Exige la même culture pour rester cohérent (un champ = une seule culture à la fois) ;
    // si plusieurs cultures cohabitent (nom réutilisé sur des saisons différentes), ne
    // garde que le sous-ensemble le plus nombreux.
    const byCulture = {}
    matches.forEach(p => { (byCulture[(p.culture_actuelle || '').trim().toUpperCase()] ??= []).push(p) })
    const best = Object.values(byCulture).sort((a, b) => b.length - a.length)[0]
    if (best.length < 2) return null
    return { key: `manual:${i}`, arr: best }
  }).filter(Boolean)

  return [...autoGroups, ...manualGroups].map(({ key, arr }) => {
    const primary = arr.find(p => !/\sMT$/i.test((p.nom || '').trim())) || arr[0]
    return {
      key,
      memberIds: arr.map(p => p.id),
      members: arr,
      primary,
      surfaceTotal: arr.reduce((s, p) => s + (p.surface || 0), 0),
      culture: primary.culture_actuelle,
      label: `${primary.nom} (groupé — ${arr.map(p => p.entite).filter(Boolean).join(' + ')})`,
    }
  })
}

const EMPTY = {
  type: 'vente', reference: '', culture: '', recolte: String(new Date().getFullYear()),
  tiers_nom: '', entite: '', tonnage_contracte: '', prix_contracte: '',
  a_la_moisson: false, date_fin: '', statut: 'en_cours', notes: '',
  deja_livre: false,
}

const STATUT_LABEL = { en_cours: 'En cours', complete: 'Complété', annule: 'Annulé' }
const STATUT_COLOR = { en_cours: 'var(--green-mid)', complete: 'var(--blue, #2563eb)', annule: 'var(--red)' }
const TYPE_META = {
  vente: { label: 'Vente', icon: '↑', color: 'var(--green-mid)', tiers: 'Acheteur' },
  achat: { label: 'Achat', icon: '↓', color: 'var(--amber)', tiers: 'Fournisseur' },
}

const PAGE_TABS = [
  { key: 'stock',      label: '📦 Stock' },
  { key: 'commerce',   label: '💶 Commerce' },
  { key: 'dossiers',   label: '📁 Dossiers parcelles' },
  { key: 'stock-physique', label: '🏬 Stock physique' },
  { key: 'contrats',   label: '📑 Contrats' },
  { key: 'rendements', label: '📊 Rendements' },
  { key: 'reste-livrer', label: '🧮 Reste à livrer / entité' },
]

export default function Cereales() {
  const { user } = useAuth()
  const { showToast, ToastEl } = useToast()
  const isMobile = useIsMobile()

  const [pageTab, setPageTab]       = useState('stock')
  const [kpiOuvert, setKpiOuvert]   = useState(false) // chiffres clés repliés par défaut sur mobile
  const [dossierId, setDossierId]   = useState(null)
  const [dossierSearch, setDossierSearch] = useState('')
  const [dossierSubTab, setDossierSubTab] = useState('parcelles') // 'parcelles' | 'autres'
  const [histoFilter, setHistoFilter] = useState('both') // 'both' | 'sorti' | 'a_sortir' — histogramme Stock physique
  const [contrats, setContrats]     = useState([])
  const [livraisons, setLivraisons] = useState([]) // toutes, groupées côté rendu
  const [moisson, setMoisson]       = useState([])
  const [parcelles, setParcelles]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [tableMissing, setTableMissing] = useState(false)
  const [moissonMissing, setMoissonMissing] = useState(false)

  // Campagne (année agricole) : repartir sur une base vierge chaque année pour
  // contrats/moisson/sorties/rendements, tout en gardant les campagnes passées
  // consultables via le sélecteur. Le Stock, lui, reste toujours cumulatif sur
  // toutes les campagnes (le grain physiquement en cellule ne "change pas d'année").
  const { campagneActive, registerCampagnes } = useCampagne()
  const campagneOf = r => r.campagne || defaultCampagne()
  // Un contrat de vente/achat signé pour la campagne suivante (vente anticipée
  // avant même la récolte) ne "part" pas avec le temps comme le fait le stock —
  // il reste suivi à la fois sur la campagne active ET la suivante, pour voir
  // l'avancement des ventes en cours de campagne comme celui déjà engagé pour
  // la campagne d'après.
  function nextCampagne(c) {
    const y1 = parseInt((c || '').split('-')[0], 10)
    return Number.isFinite(y1) ? `${y1 + 1}-${y1 + 2}` : c
  }
  // Trié par date (la plus récente en premier) puis, à date égale, par ordre de
  // saisie (la première entrée saisie ce jour-là apparaît en premier).
  const moissonCampagne   = moisson.filter(m => campagneOf(m) === campagneActive).sort((a, b) => {
    const parDate = (b.date || '').localeCompare(a.date || '')
    if (parDate !== 0) return parDate
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
  const contratsCampagne  = contrats.filter(c => {
    const co = campagneOf(c)
    return co === campagneActive || co === nextCampagne(campagneActive)
  })
  // Livraisons/ventes déjà réalisées : rattachées à leur campagne propre, elles ne
  // "suivent" pas la campagne suivante (contrairement aux contrats engagés ci-dessus).
  const livraisonsCampagne = livraisons.filter(l => campagneOf(l) === campagneActive)
  const campagnesListe = campagnesDisponibles([...contrats, ...moisson, ...livraisons])
  useEffect(() => { registerCampagnes(campagnesListe) }, [campagnesListe.join(',')])

  const [filterType, setFilterType]     = useState('all')
  const [filterStatut, setFilterStatut] = useState('en_cours')
  const [editing, setEditing]           = useState(null)
  const [newLiv, setNewLiv]             = useState(null) // saisie livraison dans le modal
  const [editingMoisson, setEditingMoisson] = useState(null)
  const [editingFiche, setEditingFiche] = useState(null) // fiche de sortie (bon d'enlèvement)

  useEffect(() => { loadAll() }, [])

  async function loadAll() {
    setLoading(true)
    const [{ data: c, error: e1 }, { data: l }, { data: m, error: e2 }, { data: pc }] = await Promise.all([
      supabase.from('cereales_contrats').select('*').order('created_at', { ascending: false }),
      supabase.from('cereales_livraisons').select('*').order('date', { ascending: false }),
      supabase.from('cereales_moisson').select('*').order('date', { ascending: false }),
      supabase.from('parcelles').select('id,nom,surface,entite,culture_actuelle,campagne').order('nom'),
    ])
    if (e1 && /does not exist|relation|could not find the table/i.test(e1.message)) setTableMissing(true)
    if (e2 && /does not exist|relation|could not find the table/i.test(e2.message)) setMoissonMissing(true)
    setContrats(c || [])
    setLivraisons(l || [])
    setMoisson(m || [])
    setParcelles(pc || [])
    setLoading(false)
  }

  /* ── CRUD entrée moisson ── */
  function openNewMoisson() {
    setEditingMoisson({
      date: new Date().toISOString().split('T')[0], campagne: campagneActive,
      culture: '', parcelle_id: '', parcelle_nom: '', parcelle_ids_groupe: null, lieu_stockage: '', lieu_livraison: '', entite_livraison: '',
      poids_brut: '', poids_net: '', humidite: '', ps: '', proteine: '', calibrage: '',
      benne: '', conducteur: '', observation: '',
    })
  }
  async function saveMoisson() {
    const e = editingMoisson
    if (!e.date) { alert('La date est obligatoire.'); return }
    if (!e.culture?.trim()) { alert('La culture est obligatoire.'); return }
    if (!e.poids_net) { alert('Le poids net est obligatoire.'); return }
    const payload = {
      ...e,
      parcelle_id: e.parcelle_id || null,
      parcelle_ids_groupe: e.parcelle_ids_groupe || null,
      poids_brut: parseFloat(e.poids_brut) || null,
      poids_net:  parseFloat(e.poids_net),
      humidite:   parseFloat(e.humidite) || null,
      ps:         parseFloat(e.ps) || null,
      proteine:   parseFloat(e.proteine) || null,
      calibrage:  parseFloat(e.calibrage) || null,
      lieu_stockage: e.lieu_stockage || null,
      lieu_livraison: e.lieu_stockage ? null : (e.lieu_livraison || null),
      entite_livraison: e.lieu_stockage ? null : (e.entite_livraison || null),
      user_id:    user?.id || null,
    }
    delete payload.created_at
    let error, data
    if (e.id) {
      ;({ error } = await supabase.from('cereales_moisson').update(payload).eq('id', e.id))
    } else {
      ;({ data, error } = await supabase.from('cereales_moisson').insert(payload).select().single())
    }
    if (error && /parcelle_ids_groupe|lieu_stockage|lieu_livraison|entite_livraison|campagne|ps|proteine|calibrage|column/i.test(error.message)) {
      const { lieu_stockage, lieu_livraison, parcelle_ids_groupe, entite_livraison, campagne, ps, proteine, calibrage, ...fallback } = payload
      if (e.id) {
        ;({ error } = await supabase.from('cereales_moisson').update(fallback).eq('id', e.id))
      } else {
        ;({ data, error } = await supabase.from('cereales_moisson').insert(fallback).select().single())
      }
      if (!error) alert('⚠️ Lieu de stockage/livraison/groupe/entité/campagne/PS/protéine/calibrage non enregistré — exécute migration_A_EXECUTER_10.sql, migration_A_EXECUTER_12.sql, migration_A_EXECUTER_15.sql, migration_A_EXECUTER_16.sql, migration_A_EXECUTER_20.sql et migration_A_EXECUTER_44.sql dans Supabase → SQL Editor.')
    }
    if (error) { alert(error.message); return }
    if (e.id) setMoisson(prev => prev.map(x => x.id === e.id ? { ...x, ...payload } : x))
    else setMoisson(prev => [data, ...prev])
    setEditingMoisson(null)
    showToast('✅ Entrée moisson enregistrée')
  }
  async function delMoisson() {
    if (!confirm('Supprimer cette entrée de moisson ?')) return
    await supabase.from('cereales_moisson').delete().eq('id', editingMoisson.id)
    setMoisson(prev => prev.filter(x => x.id !== editingMoisson.id))
    setEditingMoisson(null)
    showToast('🗑️ Entrée supprimée')
  }

  const livredByContrat = livraisonsCampagne.reduce((map, l) => {
    map[l.contrat_id] = (map[l.contrat_id] || 0) + (l.quantite || 0)
    return map
  }, {})

  /* ── CRUD contrat ── */
  function openNew(type) { setEditing({ ...EMPTY, type, campagne: campagneActive }); setNewLiv(null) }
  function openEdit(c) {
    setEditing({ ...c, tonnage_contracte: c.tonnage_contracte ?? '', prix_contracte: c.prix_contracte ?? '' })
    setNewLiv(null)
  }

  async function save() {
    if (!editing.culture?.trim()) { alert('La culture est obligatoire.'); return }
    if (!editing.tiers_nom?.trim()) { alert(`Le champ ${TYPE_META[editing.type].tiers.toLowerCase()} est obligatoire.`); return }
    if (!editing.tonnage_contracte) { alert('Le tonnage contracté est obligatoire.'); return }
    const isNew = !editing.id
    // "Déjà livré" n'est qu'un déclencheur d'UI (créer la livraison liée juste
    // après le contrat) — jamais envoyé tel quel à cereales_contrats.
    const wantsLivraisonInitiale = isNew && editing.deja_livre && newLiv?.date && newLiv?.quantite
    const payload = {
      ...editing,
      tonnage_contracte: parseFloat(editing.tonnage_contracte),
      prix_contracte:    parseFloat(editing.prix_contracte) || null,
      entite:            editing.entite || null,
      a_la_moisson:      !!editing.a_la_moisson,
      date_fin:          editing.a_la_moisson ? null : (editing.date_fin || null),
      user_id:           user?.id || null,
    }
    delete payload.created_at
    delete payload.date_debut
    delete payload.deja_livre
    // Champs calculés côté client (jamais des colonnes réelles) — ajoutés sur les
    // contrats affichés depuis l'onglet Commerce (commercePourCulture), repris ici
    // si le contrat a été ouvert depuis là plutôt que depuis l'onglet Contrats.
    delete payload.livre
    delete payload.reste
    let error, data
    if (editing.id) {
      ;({ error } = await supabase.from('cereales_contrats').update(payload).eq('id', editing.id))
    } else {
      ;({ data, error } = await supabase.from('cereales_contrats').insert(payload).select().single())
    }
    if (error && /entite|a_la_moisson|campagne|column/i.test(error.message)) {
      const { entite, a_la_moisson, campagne, ...fallback } = payload
      if (editing.id) {
        ;({ error } = await supabase.from('cereales_contrats').update(fallback).eq('id', editing.id))
      } else {
        ;({ data, error } = await supabase.from('cereales_contrats').insert(fallback).select().single())
      }
      if (!error) alert('⚠️ Entité / "à la moisson" / campagne non enregistré(e) — exécute migration_A_EXECUTER_11.sql, migration_A_EXECUTER_13.sql et migration_A_EXECUTER_20.sql dans Supabase → SQL Editor.')
    }
    if (error) { alert(error.message); return }
    if (editing.id) setContrats(prev => prev.map(c => c.id === editing.id ? { ...c, ...payload } : c))
    else setContrats(prev => [data, ...prev])
    // Contrat tout juste créé et marqué "déjà livré" : la livraison saisie dans le
    // même formulaire (date/tonnes/lieu de stockage) est créée dans la foulée,
    // sans avoir à rouvrir le contrat après coup.
    if (wantsLivraisonInitiale && data) {
      const livPayload = {
        contrat_id: data.id, date: newLiv.date, quantite: parseFloat(newLiv.quantite),
        lieu_enlevement: newLiv.lieu_enlevement || null,
        immatriculation: newLiv.immatriculation || null, ref_bon: newLiv.ref_bon || null,
        campagne: payload.campagne || campagneActive, user_id: user?.id || null,
      }
      let { data: livData, error: livErr } = await supabase.from('cereales_livraisons').insert(livPayload).select().single()
      if (livErr && /lieu_enlevement|campagne|column/i.test(livErr.message)) {
        const { lieu_enlevement, campagne, ...fallback } = livPayload
        ;({ data: livData, error: livErr } = await supabase.from('cereales_livraisons').insert(fallback).select().single())
      }
      if (livErr) alert(`Contrat enregistré, mais la livraison n'a pas pu être créée : ${livErr.message}`)
      else setLivraisons(prev => [livData, ...prev])
    }
    setEditing(null)
    setNewLiv(null)
    showToast(wantsLivraisonInitiale ? '✅ Contrat et livraison enregistrés' : '✅ Contrat enregistré')
  }

  async function del() {
    if (!confirm('Supprimer ce contrat et ses livraisons ?')) return
    await supabase.from('cereales_contrats').delete().eq('id', editing.id)
    setContrats(prev => prev.filter(c => c.id !== editing.id))
    setLivraisons(prev => prev.filter(l => l.contrat_id !== editing.id))
    setEditing(null)
    showToast('🗑️ Contrat supprimé')
  }

  /* ── Livraisons ── */
  async function addLivraison() {
    if (!newLiv?.date || !newLiv?.quantite) { alert('Date et quantité obligatoires.'); return }
    const payload = {
      contrat_id: editing.id,
      date: newLiv.date,
      quantite: parseFloat(newLiv.quantite),
      lieu_enlevement: newLiv.lieu_enlevement || null,
      immatriculation: newLiv.immatriculation || null,
      ref_bon: newLiv.ref_bon || null,
      observation: newLiv.observation || null,
      campagne: editing.campagne || campagneActive,
      user_id: user?.id || null,
    }
    let { data, error } = await supabase.from('cereales_livraisons').insert(payload).select().single()
    if (error && /lieu_enlevement|campagne|column/i.test(error.message)) {
      const { lieu_enlevement, campagne, ...fallback } = payload
      ;({ data, error } = await supabase.from('cereales_livraisons').insert(fallback).select().single())
    }
    if (error) { alert(error.message); return }
    setLivraisons(prev => [data, ...prev])
    setNewLiv(null)
    showToast('✅ Livraison ajoutée')
  }
  async function delLivraison(id) {
    if (!confirm('Supprimer cette livraison ?')) return
    await supabase.from('cereales_livraisons').delete().eq('id', id)
    setLivraisons(prev => prev.filter(l => l.id !== id))
  }

  /* ── Fiches de sortie (bons d'enlèvement) — enregistrement complet d'une sortie,
     avec ou sans contrat rattaché, pesée brut/tare et prix ── */
  const EMPTY_FICHE = {
    contrat_id: '', date: new Date().toISOString().split('T')[0], culture_libre: '', client_nom_libre: '', entite_libre: '',
    ref_bon: '', transporteur: '', immatriculation: '', lieu_enlevement: '',
    poids_brut: '', tare_pct: '', prix_ht: '', observation: '', is_semence: false,
  }
  function openNewFiche() { setEditingFiche({ ...EMPTY_FICHE, campagne: campagneActive }) }
  function openEditFiche(l) {
    setEditingFiche({
      ...EMPTY_FICHE, ...l,
      contrat_id: l.contrat_id || '',
      poids_brut: l.poids_brut ?? '', tare_pct: l.tare_pct ?? '', prix_ht: l.prix_ht ?? '',
    })
  }
  function ficheNet(f)   { const b = parseFloat(f.poids_brut) || 0, t = parseFloat(f.tare_pct) || 0; return b > 0 ? +(b - b * t / 100).toFixed(4) : (parseFloat(f.poids_brut) || null) }
  function ficheTotal(f) { const n = ficheNet(f), p = parseFloat(f.prix_ht) || 0; return n && p ? +(n * p).toFixed(2) : null }

  // Édite une ligne d'expédition (sortie) — qu'elle vienne d'une fiche de sortie
  // propre ou d'une livraison directe moisson (pas de fiche, l'entrée moisson
  // elle-même fait office de sortie). Réutilisé par l'onglet Sorties et par
  // l'onglet Commerce (mêmes lignes, juste groupées différemment).
  function editVenteRow(l) {
    if (!l.direct) { openEditFiche(l); return }
    const m = moissonCampagne.find(x => `moisson-${x.id}` === l.id)
    if (m) setEditingMoisson({ ...m, parcelle_id: m.parcelle_id || '' })
    else setPageTab('moisson')
  }

  async function saveFiche() {
    const f = editingFiche
    if (!f.date) { alert('La date est obligatoire.'); return }
    if (!f.contrat_id && !f.client_nom_libre?.trim()) { alert("Choisis un contrat ou renseigne le client (hors contrat)."); return }
    const net = ficheNet(f)
    if (!net) { alert('Le poids brut est obligatoire.'); return }
    const payload = {
      contrat_id: f.contrat_id || null,
      date: f.date,
      quantite: net,
      poids_brut: parseFloat(f.poids_brut) || null,
      tare_pct: parseFloat(f.tare_pct) || null,
      prix_ht: parseFloat(f.prix_ht) || null,
      ref_bon: f.ref_bon || null,
      transporteur: f.transporteur || null,
      immatriculation: f.immatriculation || null,
      lieu_enlevement: f.lieu_enlevement || null,
      client_nom_libre: f.contrat_id ? null : (f.client_nom_libre || null),
      culture_libre: f.contrat_id ? null : (f.culture_libre || null),
      entite_libre: f.contrat_id ? null : (f.entite_libre || null),
      observation: f.observation || null,
      campagne: f.campagne || campagneActive,
      user_id: user?.id || null,
      is_semence: !!f.is_semence,
    }
    let error, data
    if (f.id) {
      ;({ error } = await supabase.from('cereales_livraisons').update(payload).eq('id', f.id))
    } else {
      ;({ data, error } = await supabase.from('cereales_livraisons').insert(payload).select().single())
    }
    if (error && /is_semence|column/i.test(error.message)) {
      const { is_semence, ...withoutSemence } = payload
      if (f.id) {
        ;({ error } = await supabase.from('cereales_livraisons').update(withoutSemence).eq('id', f.id))
      } else {
        ;({ data, error } = await supabase.from('cereales_livraisons').insert(withoutSemence).select().single())
      }
      if (!error) alert('⚠️ Fiche enregistrée sans le marqueur "semences" — exécute migration_A_EXECUTER_38.sql dans Supabase → SQL Editor.')
    }
    if (error && /transporteur|poids_brut|tare_pct|prix_ht|lieu_enlevement|client_nom_libre|culture_libre|entite_libre|campagne|column/i.test(error.message)) {
      const { campagne, is_semence, ...fallback } = payload
      if (f.id) {
        ;({ error } = await supabase.from('cereales_livraisons').update(fallback).eq('id', f.id))
      } else {
        ;({ data, error } = await supabase.from('cereales_livraisons').insert(fallback).select().single())
      }
      if (!error) alert('⚠️ Fiche de sortie enregistrée sans campagne — exécute migration_A_EXECUTER_17.sql et migration_A_EXECUTER_20.sql dans Supabase → SQL Editor pour la traçabilité complète.')
    }
    if (error) { alert(error.message); return }
    if (f.id) setLivraisons(prev => prev.map(l => l.id === f.id ? { ...l, ...payload } : l))
    else setLivraisons(prev => [data, ...prev])
    setEditingFiche(null)
    showToast('✅ Fiche de sortie enregistrée')
  }

  async function delFiche() {
    if (!confirm('Supprimer cette fiche de sortie ?')) return
    await supabase.from('cereales_livraisons').delete().eq('id', editingFiche.id)
    setLivraisons(prev => prev.filter(l => l.id !== editingFiche.id))
    setEditingFiche(null)
    showToast('🗑️ Fiche supprimée')
  }

  /* ── KPIs (campagne active) ── */
  const enCours = contratsCampagne.filter(c => c.statut === 'en_cours')
  const kpi = type => {
    const cs = enCours.filter(c => c.type === type)
    const contracte = cs.reduce((s, c) => s + (c.tonnage_contracte || 0), 0)
    const livre = cs.reduce((s, c) => s + (livredByContrat[c.id] || 0), 0)
    return { contracte, livre, n: cs.length }
  }
  const kv = kpi('vente'), ka = kpi('achat')

  const displayed = contratsCampagne.filter(c =>
    (filterType === 'all' || c.type === filterType) &&
    (filterStatut === 'all' || c.statut === filterStatut)
  )

  /* ── Rendements moisson (quintaux) — campagne active ── */
  const totMoissonKg = moissonCampagne.reduce((s, m) => s + (m.poids_net || 0), 0)
  // Le parcellaire change à chaque campagne (import DAPLOS) — le dossier de
  // récolte ne doit lister que les parcelles de la campagne active (`parcelles`
  // brut reste utilisé tel quel pour les lookups par id des entrées existantes,
  // qui restent valides quelle que soit la campagne consultée).
  const parcellesCampagne = parcelles.filter(p => (p.campagne || defaultCampagne()) === campagneActive)
  const champGroupes = computeChampGroupes(parcellesCampagne)
  const groupByMemberId = {} // parcelle_id -> groupe (pour les champs scindés Millard)
  champGroupes.forEach(g => g.memberIds.forEach(id => { groupByMemberId[id] = g }))
  // Repli automatique : si un seul membre d'un groupe a des entrées moisson à son nom
  // (l'autre membre n'en a aucune), ces entrées représentent en réalité tout le champ
  // groupé — même si elles n'ont pas été saisies via le dossier fusionné (parcelle_ids_groupe
  // absent). Sans ça, le rendement se calcule sur la surface d'un seul membre alors que la
  // récolte couvre tout le champ, ce qui le fausse fortement (ex. LA DIGUE seule vs LA DIGUE
  // + SALON). Si plusieurs membres ont chacun leurs propres entrées, on ne fusionne QUE
  // celles explicitement marquées groupées, pour ne pas compter la surface deux fois.
  const groupMemberIdsAvecEntrees = {} // group.key -> Set(parcelle_id) ayant au moins une entrée
  moissonCampagne.forEach(m => {
    const g = m.parcelle_id ? groupByMemberId[m.parcelle_id] : null
    if (!g) return
    ;(groupMemberIdsAvecEntrees[g.key] ??= new Set()).add(m.parcelle_id)
  })
  function resolveGroupMembers(m) {
    const groupe = m.parcelle_id ? groupByMemberId[m.parcelle_id] : null
    if (!groupe) return null
    const explicite = Array.isArray(m.parcelle_ids_groupe) && m.parcelle_ids_groupe.length > 0
    const implicite = !explicite && groupMemberIdsAvecEntrees[groupe.key]?.size === 1
    return (explicite || implicite) ? groupe.members : null
  }
  // Dossiers parcelles (Céréales) : les champs groupés (Millard) n'apparaissent qu'une
  // fois, sous un dossier virtuel combinant surface/entités des parcelles membres — les
  // entrées moisson des deux parcelles s'y retrouvent ensemble (voir entryParcelleId).
  const dossierParcellesCereales = [
    ...champGroupes.map(g => ({
      id: g.primary.id, nom: g.label, surface: g.surfaceTotal,
      entite: g.members.map(p => p.entite).filter(Boolean).join(' + '),
      _primaryEntite: g.primary.entite,
      culture_actuelle: g.culture, _groupeMemberIds: g.memberIds,
    })),
    ...parcellesCampagne.filter(p => !groupByMemberId[p.id]),
  ]

  /* ── Stock & sorties : récap physique + théorique, diagramme, prix moyens.
     Le Stock est cumulatif JUSQU'À la campagne active (grain physiquement en
     cellule, indépendant de l'année) — mais jamais au-delà : en consultant une
     campagne passée (ex. 2024-2025 importée comme démonstration), le stock ne
     doit pas inclure les campagnes suivantes (2025-2026, 2026-2027…), sinon la
     démo se retrouve mélangée avec le stock réel actuel. Calculé à partir des
     données brutes non filtrées par égalité (suffixe "All"/"UpTo"), mais bornées
     chronologiquement — tandis que l'onglet Sorties lui-même n'affiche que la
     campagne active exactement. ── */
  // 2024-2025 est une campagne de démonstration (données importées depuis un
  // vieux fichier DAPLOS pour montrer le fonctionnement multi-campagne) — elle
  // ne doit jamais compter dans le stock cumulatif réel, ni pour elle-même ni
  // pour les campagnes suivantes qui la verraient sinon remonter dans leur stock.
  const STOCK_CAMPAGNES_EXCLUES = new Set(['2024-2025'])
  const campagneAtOrBefore = r => !STOCK_CAMPAGNES_EXCLUES.has(campagneOf(r)) && isAtOrBeforeCampagne(campagneOf(r), campagneActive)
  const contratById = Object.fromEntries(contrats.map(c => [c.id, c]))
  const sortiesDirectesDe = (moissonRows) => moissonRows
    .filter(m => !m.lieu_stockage && m.lieu_livraison)
    .map(m => {
      const parc = parcelles.find(p => p.id === m.parcelle_id)
      return {
        id: `moisson-${m.id}`, date: m.date, quantite: (m.poids_net || 0) / 1000,
        contrat: null, direct: true, lieuLivraison: m.lieu_livraison, culture: m.culture,
        entiteLivraison: m.entite_livraison || parc?.entite || null, campagne: m.campagne,
      }
    })
  const sortiesDe = (livraisonsRows, moissonRows) => [
    // Livraisons rattachées à un contrat de vente, ou fiches de sortie saisies hors
    // contrat (client_nom_libre renseigné à la place) — les deux sont des sorties.
    ...livraisonsRows.map(l => ({ ...l, contrat: contratById[l.contrat_id] }))
      .filter(l => l.contrat?.type === 'vente' || (!l.contrat_id && l.client_nom_libre)),
    ...sortiesDirectesDe(moissonRows),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  const sortiesDirectes = sortiesDirectesDe(moissonCampagne) // campagne active — onglet Sorties
  const sorties = sortiesDe(livraisonsCampagne, moissonCampagne)
  // Cumulatif jusqu'à la campagne active seulement (pas au-delà) — voir note plus haut.
  const moissonUpTo = moisson.filter(campagneAtOrBefore)
  const livraisonsUpTo = livraisons.filter(campagneAtOrBefore)
  const sortiesAll = sortiesDe(livraisonsUpTo, moissonUpTo) // jusqu'à la campagne active — Stock uniquement
  // Sorties qui ne tracent à aucune parcelle : elles viennent du stock déjà mélangé
  // (fiche de sortie / livraison rattachée à un contrat), pas d'une moisson directe.
  const sortiesHorsParcelle = sorties.filter(l => !l.direct)

  const receptions = livraisonsUpTo // achats jusqu'à la campagne active, alimentent le stock
    .map(l => ({ ...l, contrat: contratById[l.contrat_id] }))
    .filter(l => l.contrat?.type === 'achat')

  const totMoissonTAll = moissonUpTo.reduce((s, m) => s + (m.poids_net || 0), 0) / 1000
  const totReceptionsT = receptions.reduce((s, l) => s + (l.quantite || 0), 0)
  const totSortiesTAll = sortiesAll.reduce((s, l) => s + (l.quantite || 0), 0)
  const totSortiesT   = sorties.reduce((s, l) => s + (l.quantite || 0), 0) // campagne active — onglet Sorties
  const stockPhysiqueT  = totMoissonTAll + totReceptionsT - totSortiesTAll
  const resteALivrerVentesT = Math.max(0, kv.contracte - kv.livre)
  const stockTheoriqueT = stockPhysiqueT - resteALivrerVentesT

  // Répartition par lieu de stockage — cumulative jusqu'à la campagne active (pas
  // au-delà, voir note plus haut). Les entrées livrées directement (non stockées)
  // n'y figurent pas ; seules celles dont ni le stockage ni la livraison ne sont
  // renseignés restent en "Non précisé". Les sorties (fiches de sortie / bons
  // d'enlèvement) renseignant un "lieu d'enlèvement" sont déduites du lieu
  // correspondant, sinon un lieu ne se viderait jamais visuellement même après
  // enlèvement du grain qui y était stocké.
  const sortiesParLieu = sortiesAll.reduce((map, l) => {
    if (!l.lieu_enlevement) return map
    map[l.lieu_enlevement] = (map[l.lieu_enlevement] || 0) + (l.quantite || 0) * 1000
    return map
  }, {})
  // Les réceptions (achats) n'ont aucun lieu de stockage renseigné (le formulaire
  // de réception ne demande que date/tonnes/immat./réf. bon) — sans cette ligne,
  // leur tonnage manquait purement et simplement du détail par lieu, alors qu'il
  // est bien compté dans "Stock physique total"/"Dont Blé"/"Dont Orge" : les deux
  // chiffres ne pouvaient jamais se recouper tant qu'il y avait des réceptions.
  const receptionsBleT = receptions.filter(l => /bl[ée]/i.test(l.contrat?.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
  const receptionsOrgeT = receptions.filter(l => /orge|escourgeon/i.test(l.contrat?.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
  const receptionsAutresT = totReceptionsT - receptionsBleT - receptionsOrgeT
  // Non clampé ici (peut être négatif si le lieu d'enlèvement saisi sur une sortie
  // ne correspond pas exactement au lieu de stockage saisi à l'entrée) — le clamp à
  // 0 se fait seulement à l'affichage (une barre ne peut pas être négative), mais le
  // manque doit rester visible dans la réconciliation ci-dessous plutôt que d'être
  // silencieusement perdu, sinon la somme "par lieu" ne colle jamais au total du haut.
  const moissonParLieuRaw = Object.values(moissonUpTo.filter(m => m.lieu_stockage || !m.lieu_livraison).reduce((map, m) => {
    const l = m.lieu_stockage || 'Non précisé'
    map[l] ??= { lieu: l, kg: 0 }
    map[l].kg += m.poids_net || 0
    return map
  }, {})).map(l => ({ ...l, kg: l.kg - (sortiesParLieu[l.lieu] || 0) }))
  const stockParLieu = [
    ...moissonParLieuRaw.map(l => ({ ...l, kg: Math.max(0, l.kg) })),
    ...(receptionsBleT > 0 ? [{ lieu: 'Réceptions Blé (achats)', kg: receptionsBleT * 1000 }] : []),
    ...(receptionsOrgeT > 0 ? [{ lieu: 'Réceptions Orge (achats)', kg: receptionsOrgeT * 1000 }] : []),
    ...(receptionsAutresT > 0 ? [{ lieu: 'Réceptions autres (achats)', kg: receptionsAutresT * 1000 }] : []),
  ].sort((a, b) => b.kg - a.kg)
  const maxLieuKg = Math.max(1, ...stockParLieu.map(l => l.kg))
  // Écart entre le total du haut (Stock physique total) et la somme des barres par
  // lieu — deux causes possibles, toutes deux honnêtement affichées plutôt que
  // masquées : (1) des sorties sans "lieu d'enlèvement" renseigné, déduites du total
  // global mais d'aucun lieu précis ; (2) un lieu dont les sorties enregistrées
  // dépassent ce qui y avait été stocké (mismatch de saisie entre lieu_stockage à
  // l'entrée et lieu_enlèvement à la sortie), écrêté à 0 pour l'affichage de sa barre.
  const sortiesSansLieuKg = sortiesAll.filter(l => !l.lieu_enlevement).reduce((s, l) => s + (l.quantite || 0) * 1000, 0)
  const clampedLossKg = moissonParLieuRaw.reduce((s, l) => s + Math.max(0, -l.kg), 0)
  const stockNonVentileKg = sortiesSansLieuKg + clampedLossKg

  const prixMoyen = rows => {
    const q = rows.reduce((s, r) => s + r.qte, 0)
    if (!q) return null
    return rows.reduce((s, r) => s + r.qte * r.prix, 0) / q
  }
  // Valeur totale vendue (onglet Sorties) : somme directe qté × prix ligne par ligne,
  // en reprenant le prix propre à la fiche (prix_ht) s'il est saisi, sinon le prix du
  // contrat rattaché — même règle que la colonne "Prix" de ce tableau (voir plus bas).
  // NE PAS faire totSortiesT × un prix moyen : ça appliquerait le prix moyen des lignes
  // tarifées à TOUT le tonnage, y compris les sorties sans prix connu, et surestimerait
  // la valeur réelle.
  // Les sorties marquées "semences" (usage interne, pas une vente commerciale — voir
  // is_semence sur la fiche de sortie) sont exclues : ce n'est pas une vente, même si un
  // prix/coût a été saisi pour la traçabilité comptable interne.
  const sortiesAvecPrix = sorties.filter(l => !l.is_semence && (l.prix_ht ?? l.contrat?.prix_contracte) != null)
  const valeurTotaleVendue = sortiesAvecPrix.reduce((s, l) => s + (l.quantite || 0) * (l.prix_ht ?? l.contrat.prix_contracte), 0)
  // par champ (campagne active)
  const parChamp = Object.values(moissonCampagne.reduce((map, m) => {
    const key = m.parcelle_id || `__${m.parcelle_nom || 'Sans parcelle'}`
    if (!map[key]) {
      const parc = parcelles.find(x => x.id === m.parcelle_id)
      // Champ groupé (Millard) : la surface prise en compte pour le rendement est
      // celle du champ entier (toutes les entités membres), pas juste la parcelle
      // primaire à laquelle l'entrée est techniquement rattachée — on garde aussi
      // les membres (id/entité/surface) pour pouvoir répartir la récolte entre eux
      // au prorata de leur surface dans le calcul "par entité" ci-dessous.
      const groupMembers = resolveGroupMembers(m)
      const surfaceGroupe = groupMembers ? groupMembers.reduce((s, p) => s + (p.surface || 0), 0) : null
      map[key] = { key, nom: parc?.nom || m.parcelle_nom || 'Sans parcelle', surface: surfaceGroupe ?? (parc?.surface || null),
        entite: parc?.entite || null, groupMembers, cultures: new Set(), kg: 0, nb: 0 }
    }
    map[key].kg += m.poids_net || 0
    map[key].nb++
    if (m.culture) map[key].cultures.add(m.culture)
    return map
  }, {})).sort((a, b) => b.kg - a.kg)
  const surfacesMoisson = parChamp.reduce((s, r) => s + (r.surface || 0), 0)
  const rdtGlobalQ = surfacesMoisson > 0 ? (totMoissonKg / 100) / surfacesMoisson : null
  // par entité — un champ groupé répartit sa récolte entre ses entités membres au
  // prorata de leur surface, au lieu de tout attribuer à l'entité de la parcelle
  // primaire (sinon l'entité "secondaire" du groupe disparaît complètement ici).
  const parEntite = Object.values(parChamp.reduce((map, r) => {
    if (r.groupMembers) {
      const totalSurface = r.groupMembers.reduce((s, p) => s + (p.surface || 0), 0) || 1
      r.groupMembers.forEach(p => {
        const e = p.entite || 'Sans entité'
        map[e] ??= { entite: e, kg: 0, surface: 0, champs: 0 }
        map[e].kg += r.kg * ((p.surface || 0) / totalSurface)
        map[e].surface += p.surface || 0
        map[e].champs++
      })
      return map
    }
    const e = r.entite || 'Sans entité'
    map[e] ??= { entite: e, kg: 0, surface: 0, champs: 0 }
    map[e].kg += r.kg
    map[e].surface += r.surface || 0
    map[e].champs++
    return map
  }, {})).sort((a, b) => b.kg - a.kg)

  /* ── Reste à livrer par entité, séparé Blé / Orge : chaque culture a son propre
     rendement constaté (les deux ne se valent pas), donc surface × rendement et
     déjà-livré sont calculés indépendamment pour chaque groupe, puis comparés.
     SCEA HEMARD BAILLOT et SARL ROPAMIL sont exclues de ce calcul. ── */
  const ENTITES_EXCLUES_RESTE_A_LIVRER = [/scea hemard baillot/i, /sarl ropamil/i]
  const estEntiteExclue = e => ENTITES_EXCLUES_RESTE_A_LIVRER.some(re => re.test(e || ''))
  const BLE_CODES = new Set(['BTH', 'BTP', 'BDH', 'BDP'])
  const ORGE_CODES = new Set(['ORH', 'ORP', 'ESC'])
  const isBleTexte = c => /bl[ée]/i.test(c || '')
  const isOrgeTexte = c => /orge|escourgeon/i.test(c || '')

  // Statistiques de rendement (global, par champ, par entité) pour un groupe de
  // cultures (Blé ou Orge) — réutilisé par l'onglet Rendements ET par le calcul
  // du reste à livrer par entité, qui a besoin du même rendement constaté.
  function statsPourGroupe(matchTexte, matchParcelle = () => true) {
    const byParcelle = {}
    moissonCampagne.filter(m => matchTexte(m.culture) && matchParcelle(parcelles.find(p => p.id === m.parcelle_id))).forEach(m => {
      const key = m.parcelle_id || `__${m.parcelle_nom || ''}`
      if (!byParcelle[key]) {
        const parc = parcelles.find(p => p.id === m.parcelle_id)
        const groupMembers = resolveGroupMembers(m)
        const surfaceGroupe = groupMembers ? groupMembers.reduce((s, p) => s + (p.surface || 0), 0) : null
        byParcelle[key] = { key, nom: parc?.nom || m.parcelle_nom || 'Sans parcelle', entite: parc?.entite || null, groupMembers, surface: surfaceGroupe ?? (parc?.surface || 0), kg: 0 }
      }
      byParcelle[key].kg += m.poids_net || 0
    })
    const rows = Object.values(byParcelle).sort((a, b) => b.kg - a.kg)
    const totKg = rows.reduce((s, r) => s + r.kg, 0)
    const totSurface = rows.reduce((s, r) => s + r.surface, 0)
    const rdtQ = totSurface > 0 ? (totKg / 100) / totSurface : null
    // Un champ groupé répartit sa récolte entre ses entités membres au prorata de
    // leur surface (voir parEntite plus haut pour la même logique, toutes cultures).
    const parEntiteRows = Object.values(rows.reduce((map, r) => {
      if (r.groupMembers) {
        const totalSurface = r.groupMembers.reduce((s, p) => s + (p.surface || 0), 0) || 1
        r.groupMembers.forEach(p => {
          const e = p.entite || 'Sans entité'
          map[e] ??= { entite: e, kg: 0, surface: 0, champs: 0 }
          map[e].kg += r.kg * ((p.surface || 0) / totalSurface)
          map[e].surface += p.surface || 0
          map[e].champs++
        })
        return map
      }
      const e = r.entite || 'Sans entité'
      map[e] ??= { entite: e, kg: 0, surface: 0, champs: 0 }
      map[e].kg += r.kg
      map[e].surface += r.surface
      map[e].champs++
      return map
    }, {})).sort((a, b) => b.kg - a.kg)
    return { rows, totKg, totSurface, rdtQ, parEntiteRows }
  }
  function rendementPourGroupe(matchTexte) { return statsPourGroupe(matchTexte).rdtQ }
  function surfaceParEntitePourGroupe(codes) {
    const map = {}
    parcelles.filter(p => codes.has((p.culture_actuelle || '').trim().toUpperCase()) && !estEntiteExclue(p.entite)).forEach(p => {
      const e = p.entite || 'Sans entité'
      map[e] = (map[e] || 0) + (p.surface || 0)
    })
    return map
  }
  function livreParEntitePourGroupe(matchTexte) {
    const map = {}
    sorties.forEach(l => {
      // Une sortie "semences" (usage interne, is_semence) n'est pas une vente —
      // elle ne doit pas compter comme du tonnage déjà livré vis-à-vis du reste à
      // livrer, sinon le reste à livrer par entité serait sous-estimé.
      if (l.is_semence) return
      const culture = l.contrat?.culture || l.culture_libre || l.culture || ''
      if (!matchTexte(culture)) return
      const e = l.contrat?.entite || l.entiteLivraison || l.entite_libre || 'Sans entité'
      if (estEntiteExclue(e)) return
      map[e] = (map[e] || 0) + (l.quantite || 0)
    })
    return map
  }
  // Tonnage réellement contracté (vente, contrats en cours) par entité — pour le
  // "reste réel", qui déduit ce qui est vraiment dû sur les contrats plutôt que
  // de se baser sur une estimation de production (surface × rendement).
  function contracteParEntitePourGroupe(matchTexte) {
    const map = {}
    contratsCampagne.filter(c => c.type === 'vente' && c.statut === 'en_cours' && matchTexte(c.culture)).forEach(c => {
      const e = c.entite || 'Sans entité'
      if (estEntiteExclue(e)) return
      map[e] = (map[e] || 0) + (c.tonnage_contracte || 0)
    })
    return map
  }
  function buildResteRows(surfaceMap, livreMap, rdtQ, contracteMap) {
    const rdtTHa = rdtQ != null ? rdtQ / 10 : null
    return [...new Set([...Object.keys(surfaceMap), ...Object.keys(livreMap), ...Object.keys(contracteMap)])]
      .map(entite => {
        const surface = surfaceMap[entite] || 0
        const production = rdtTHa != null ? surface * rdtTHa : null
        const livre = livreMap[entite] || 0
        const reste = production != null ? Math.max(0, production - livre) : null
        const contracte = contracteMap[entite] || 0
        const resteReel = Math.max(0, contracte - livre)
        return { entite, surface, production, livre, reste, contracte, resteReel }
      })
      .sort((a, b) => (b.resteReel ?? 0) - (a.resteReel ?? 0))
  }

  const statsBle = statsPourGroupe(isBleTexte)
  const statsOrge = statsPourGroupe(isOrgeTexte)
  const rdtBleQ = statsBle.rdtQ
  const rdtOrgeQ = statsOrge.rdtQ
  const resteBle = buildResteRows(surfaceParEntitePourGroupe(BLE_CODES), livreParEntitePourGroupe(isBleTexte), rdtBleQ, contracteParEntitePourGroupe(isBleTexte))
  const resteOrge = buildResteRows(surfaceParEntitePourGroupe(ORGE_CODES), livreParEntitePourGroupe(isOrgeTexte), rdtOrgeQ, contracteParEntitePourGroupe(isOrgeTexte))

  // Orge de printemps (ORP) : convention retenue — "Fond des Vignes" est semée au
  // printemps, tout le reste de l'ORP est semé à l'automne. Affiché en complément
  // dans le bloc "Orge" existant (pas de tableau séparé).
  const isOrgePrintempsTexte = c => /orge.*print/i.test(c || '')
  const statsOrgePrintempsSemisPrintemps = statsPourGroupe(isOrgePrintempsTexte, p => /vigne/i.test(p?.nom || ''))
  const statsOrgePrintempsSemisAutomne = statsPourGroupe(isOrgePrintempsTexte, p => !/vigne/i.test(p?.nom || ''))

  // ── Onglet Commerce : ventes séparées Blé / Orge, avec prix moyen sur ce qui est
  // déjà vendu (livré) — pas de prix moyen sur l'engagé, qui n'est pas encore une vente réalisée.
  function commercePourCulture(matchTexte) {
    // Le stockage chez une coopérative (SCARA/Soufflet) n'est pas une vente — grain
    // toujours à nous, juste stocké ailleurs — donc exclu des ventes/tonnage vendu
    // (visible séparément via "Stocké chez coopératives" plus bas). Idem pour les
    // sorties marquées "semences" (usage interne — is_semence) : ce n'est pas une
    // vente commerciale, donc exclu du tonnage/valeur vendus de cet onglet Commerce.
    const venteRows = sorties.filter(l => matchTexte(l.contrat?.culture || l.culture_libre || l.culture || '') && !(l.direct && coopMatch(l.lieuLivraison)) && !l.is_semence)
    const tonnageVendu = venteRows.reduce((s, l) => s + (l.quantite || 0), 0)
    // Tonnage sorti pour semences (usage interne) — pas une vente, affiché à part
    // pour ne pas disparaître silencieusement du suivi.
    const semenceT = sorties.filter(l => matchTexte(l.contrat?.culture || l.culture_libre || l.culture || '') && l.is_semence).reduce((s, l) => s + (l.quantite || 0), 0)
    const prixVendu = prixMoyen(venteRows
      .filter(l => (l.prix_ht ?? l.contrat?.prix_contracte) != null)
      .map(l => ({ qte: l.quantite || 0, prix: l.prix_ht ?? l.contrat?.prix_contracte })))
    const contratsRows = contratsCampagne
      .filter(c => c.type === 'vente' && c.statut === 'en_cours' && matchTexte(c.culture))
      .map(c => {
        const livre = livredByContrat[c.id] || 0
        return { ...c, livre, reste: Math.max(0, (c.tonnage_contracte || 0) - livre) }
      })
    const tonnageEngage = contratsRows.reduce((s, c) => s + c.reste, 0)
    return { tonnageVendu, prixVendu, tonnageEngage, venteRows, contratsRows, semenceT }
  }
  const commerceBle = commercePourCulture(isBleTexte)
  const commerceOrge = commercePourCulture(isOrgeTexte)

  // ── Sorties/stockage vers les coopératives (SCARA, Soufflet) : stockage chez le
  // tiers plutôt qu'une vente définitive. Deux façons d'avoir été saisi coexistent :
  // - historique : sortie directe (moisson livrée, lieu_livraison = nom de la coop,
  //   pas de lieu_stockage) — avant l'ajout des lieux de stockage dédiés.
  // - actuel : entrée moisson avec lieu_stockage = "Soufflet (externe)"/"SCARA (externe)",
  //   un lieu de stockage comme un autre (n'est plus compté comme une sortie).
  // Les deux sont combinés pour ne pas perdre l'historique déjà saisi. ──
  // Cumulatif (sortiesAll/moisson, pas la campagne active) : du grain stocké chez
  // une coopérative y reste tant qu'il n'a pas été vendu — comme le stock physique
  // sur site, ce n'est pas un événement propre à une seule campagne, donc il ne
  // doit pas disparaître de la vue en changeant de campagne.
  const sortiesCoop = sortiesAll.filter(l => l.direct && coopMatch(l.lieuLivraison))
  const moissonCoopExterne = moissonUpTo.filter(m => coopMatch(m.lieu_stockage))
  const recapCoop = COOP_NAMES.map(coop => {
    const legacyRows = sortiesCoop.filter(l => coopMatch(l.lieuLivraison) === coop)
    const nouveauRows = moissonCoopExterne.filter(m => coopMatch(m.lieu_stockage) === coop)
    const tonnage = legacyRows.reduce((s, l) => s + (l.quantite || 0), 0) + nouveauRows.reduce((s, m) => s + (m.poids_net || 0), 0) / 1000
    return { coop, tonnage, nb: legacyRows.length + nouveauRows.length }
  }).filter(r => r.nb > 0)
  function coopParCulture(matchTexte) {
    const legacyT = sortiesCoop.filter(l => matchTexte(l.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
    const nouveauT = moissonCoopExterne.filter(m => matchTexte(m.culture)).reduce((s, m) => s + (m.poids_net || 0), 0) / 1000
    return legacyT + nouveauT
  }
  const coopBleT = coopParCulture(isBleTexte)
  const coopOrgeT = coopParCulture(isOrgeTexte)
  // Détail par coopérative (pour annoter chaque camembert) — SCARA / Soufflet séparés.
  function coopDetailParCulture(matchTexte) {
    return COOP_NAMES.map(coop => {
      const legacyT = sortiesCoop.filter(l => coopMatch(l.lieuLivraison) === coop && matchTexte(l.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
      const nouveauT = moissonCoopExterne.filter(m => coopMatch(m.lieu_stockage) === coop && matchTexte(m.culture)).reduce((s, m) => s + (m.poids_net || 0), 0) / 1000
      return { coop, tonnage: legacyT + nouveauT }
    }).filter(r => r.tonnage > 0)
  }
  const coopDetailBle = coopDetailParCulture(isBleTexte)
  const coopDetailOrge = coopDetailParCulture(isOrgeTexte)

  // ── Stock physique "sur site" par culture — exclut le stockage externe (coop),
  // qu'il soit tagué à l'ancienne (sortie directe) ou via lieu_stockage : ce
  // tonnage est ajouté séparément (coopBleT/coopOrgeT) pour les camemberts
  // engagé/stocké coop/libre du Stock. ──
  function stockPhysiquePourCulture(matchTexte) {
    const moissonT = moissonUpTo.filter(m => matchTexte(m.culture) && !coopMatch(m.lieu_stockage)).reduce((s, m) => s + (m.poids_net || 0), 0) / 1000
    const receptionsT = receptions.filter(l => matchTexte(l.contrat?.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
    const sortiesT = sortiesAll.filter(l => matchTexte(l.contrat?.culture || l.culture_libre || l.culture || '')).reduce((s, l) => s + (l.quantite || 0), 0)
    return moissonT + receptionsT - sortiesT
  }
  const stockPhysiqueBleT = stockPhysiquePourCulture(isBleTexte)
  const stockPhysiqueOrgeT = stockPhysiquePourCulture(isOrgeTexte)

  // Tonnage engagé (contrats de vente en cours, reste à livrer) groupé par acheteur.
  function engagementParAcheteur(commerceData) {
    const map = {}
    commerceData.contratsRows.forEach(c => {
      if (c.reste <= 0) return
      const key = c.tiers_nom?.trim() || 'Sans nom'
      map[key] = (map[key] || 0) + c.reste
    })
    return Object.entries(map).map(([acheteur, tonnage]) => ({ acheteur, tonnage })).sort((a, b) => b.tonnage - a.tonnage)
  }
  const engageBle = engagementParAcheteur(commerceBle)
  const engageOrge = engagementParAcheteur(commerceOrge)
  const libreBleT = Math.max(0, stockPhysiqueBleT - engageBle.reduce((s, e) => s + e.tonnage, 0))
  const libreOrgeT = Math.max(0, stockPhysiqueOrgeT - engageOrge.reduce((s, e) => s + e.tonnage, 0))

  // Tonnage déjà vendu, groupé par acheteur — pour le récap Commerce.
  function venduParAcheteur(commerceData) {
    const map = {}
    commerceData.venteRows.forEach(l => {
      const key = l.direct ? `🚚 ${l.lieuLivraison || 'Livraison directe'}` : (l.contrat?.tiers_nom?.trim() || l.client_nom_libre?.trim() || 'Sans nom')
      map[key] = (map[key] || 0) + (l.quantite || 0)
    })
    return Object.entries(map).map(([acheteur, tonnage]) => ({ acheteur, tonnage })).sort((a, b) => b.tonnage - a.tonnage)
  }
  const venduParAcheteurBle = venduParAcheteur(commerceBle)
  const venduParAcheteurOrge = venduParAcheteur(commerceOrge)

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  if (tableMissing) return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: '2rem' }}>
      <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, padding: '2rem', maxWidth: 520, textAlign: 'center' }}>
        <div style={{ fontSize: '2.2rem', marginBottom: '.6rem' }}>🌾</div>
        <h3 style={{ marginBottom: '.6rem' }}>Tables céréales non créées</h3>
        <p style={{ fontSize: '.86rem', color: 'var(--text-muted)' }}>
          Exécute le fichier <strong>migration_cereales.sql</strong> (à la racine du projet)
          dans Supabase → SQL Editor, puis recharge cette page.
        </p>
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {ToastEl}

      {/* Header + KPIs — sur mobile, les chiffres clés sont repliés par défaut pour
           que le contenu (onglets, listes) reste visible sans avoir à scroller. */}
      <div style={{ background: 'var(--green-deep)', padding: isMobile ? '.6rem 1rem' : '1rem 1.5rem', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isMobile ? '.5rem' : '.8rem', flexWrap: 'wrap', gap: '.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '.6rem' : '1rem', flexWrap: 'wrap' }}>
            <h2 style={{ color: 'white', fontSize: isMobile ? '.95rem' : '1.1rem', fontWeight: 700 }}>Céréales</h2>
            <span style={{ fontSize: '.72rem', color: 'rgba(255,255,255,.5)', fontWeight: 600 }}>🗓️ {campagneActive}</span>
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            {pageTab === 'moisson' ? (
              <button className="btn-sm" onClick={openNewMoisson}
                style={{ background: 'var(--green-accent)', color: 'white', borderColor: 'var(--green-light)', fontWeight: 700 }}>
                + Entrée moisson
              </button>
            ) : (
              <>
                <button className="btn-sm" onClick={() => openNew('achat')}
                  style={{ background: 'var(--amber)', color: 'white', borderColor: '#b45309', fontWeight: 700 }}>
                  ↓ Contrat achat
                </button>
                <button className="btn-sm" onClick={() => openNew('vente')}
                  style={{ background: 'var(--green-accent)', color: 'white', borderColor: 'var(--green-light)', fontWeight: 700 }}>
                  ↑ Contrat vente
                </button>
              </>
            )}
          </div>
        </div>
        {isMobile ? (
          <button onClick={() => setKpiOuvert(o => !o)} style={{
            display: 'flex', alignItems: 'center', gap: '.4rem', background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,.7)', fontSize: '.74rem', fontWeight: 600, padding: '.2rem 0',
          }}>
            {kpiOuvert ? '▾' : '▸'} Chiffres clés {!kpiOuvert && `— Ventes ${kv.livre.toFixed(1)}/${kv.contracte.toFixed(1)} t`}
          </button>
        ) : null}
        {(!isMobile || kpiOuvert) && (
          <div style={{ display: 'flex', gap: isMobile ? '.5rem' : '1rem', flexWrap: 'wrap', marginTop: isMobile ? '.5rem' : 0 }}>
            {[
              { label: `Ventes en cours (${kv.n})`, value: `${kv.livre.toFixed(1)} / ${kv.contracte.toFixed(1)} t`, color: 'var(--green-light)' },
              { label: `Achats en cours (${ka.n})`, value: `${ka.livre.toFixed(1)} / ${ka.contracte.toFixed(1)} t`, color: '#fbbf24' },
              { label: 'Reste à livrer (ventes)', value: `${Math.max(0, kv.contracte - kv.livre).toFixed(1)} t`, color: 'white' },
              { label: 'Reste à recevoir (achats)', value: `${Math.max(0, ka.contracte - ka.livre).toFixed(1)} t`, color: 'white' },
            ].map(k => (
              <div key={k.label} style={{ background: 'rgba(255,255,255,.1)', borderRadius: 9, padding: isMobile ? '.4rem .7rem' : '.45rem .9rem', minWidth: isMobile ? 100 : 120 }}>
                <div style={{ fontSize: '.65rem', color: 'rgba(255,255,255,.55)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
                <div style={{ fontSize: isMobile ? '.9rem' : '1.02rem', fontWeight: 700, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Onglets */}
      <div className="tab-scroll-fade" style={{ background: 'white', borderBottom: '2px solid var(--border)', display: 'flex', gap: '.1rem', padding: '0 1.5rem', flexShrink: 0, overflowX: 'auto' }}>
        {PAGE_TABS.map(t => (
          <button key={t.key} onClick={() => setPageTab(t.key)} style={{
            padding: '.55rem 1.1rem', background: 'none', border: 'none', whiteSpace: 'nowrap',
            borderBottom: pageTab === t.key ? '3px solid var(--green-mid)' : '3px solid transparent',
            cursor: 'pointer', fontSize: '.84rem', fontWeight: pageTab === t.key ? 700 : 500,
            color: pageTab === t.key ? 'var(--green-mid)' : 'var(--text-muted)',
            marginBottom: -2, transition: 'all .15s',
          }}>{t.label}</button>
        ))}
      </div>

      {/* ══ Onglet Moisson : saisie sortie de champ ══ */}
      {pageTab === 'moisson' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.5rem' }}>
          {moissonMissing ? (
            <div style={{ background: 'var(--amber-pale, #fef3c7)', border: '1px solid var(--amber)', borderRadius: 10, padding: '.9rem 1.2rem', fontSize: '.85rem' }}>
              ⚠️ Exécute <strong>migration_cereales_moisson.sql</strong> dans Supabase → SQL Editor, puis recharge la page.
            </div>
          ) : moissonCampagne.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '.6rem' }}>🌾</div>
              Aucune entrée de moisson pour la campagne {campagneActive} — cliquez "+ Entrée moisson" à chaque benne en sortie de champ.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                {[
                  { label: 'Total récolté', value: `${(totMoissonKg / 1000).toFixed(2)} t` },
                  { label: 'Rendement global', value: rdtGlobalQ ? `${rdtGlobalQ.toFixed(1)} q/ha` : '—' },
                  { label: 'Entrées', value: String(moissonCampagne.length) },
                ].map(k => (
                  <div key={k.label} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.55rem 1rem' }}>
                    <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--green-mid)' }}>{k.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', minWidth: 860, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                  <thead style={{ background: 'var(--cream)' }}>
                    <tr>
                      {['Date', 'Culture', 'Champ', 'Lieu de stockage / livraison', 'Poids brut (kg)', 'Poids net (kg)', 'Humidité (%)', 'Qualité', 'Benne', 'Conducteur', 'Obs.'].map(h => (
                        <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {moissonCampagne.map(m => {
                      const parc = parcelles.find(x => x.id === m.parcelle_id)
                      return (
                        <tr key={m.id} onClick={() => setEditingMoisson({ ...m, parcelle_id: m.parcelle_id || '' })} style={{ cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <td style={tdL}>{fmtDate(m.date)}</td>
                          <td style={{ ...tdL, fontWeight: 700 }}>{m.culture}</td>
                          <td style={tdL}>
                            {parc?.nom || m.parcelle_nom || '–'}
                            {m.parcelle_ids_groupe?.length > 0 && (
                              <span title="Champ groupé — répartition à faire entre les entités" style={{ marginLeft:6, fontSize:'.65rem', fontWeight:700, color:'var(--amber)', background:'var(--amber-pale,#fef3c7)', borderRadius:50, padding:'.1rem .4rem' }}>groupé</span>
                            )}
                          </td>
                          <td style={tdL}>{m.lieu_stockage
                            ? <span style={{ display:'inline-flex', alignItems:'center', gap:'.3rem' }}><span style={{ width:8, height:8, borderRadius:2, background: LIEU_COLOR[m.lieu_stockage] || 'var(--text-muted)', display:'inline-block' }} />{m.lieu_stockage}</span>
                            : m.lieu_livraison
                              ? <span style={{ color:'#3498db', fontWeight:600 }}>🚚 {m.lieu_livraison}{m.entite_livraison ? ` · 🏷️ ${m.entite_livraison}` : ''}</span>
                              : '–'}</td>
                          <td style={tdL}>{m.poids_brut != null ? m.poids_brut.toLocaleString('fr-FR') : '–'}</td>
                          <td style={{ ...tdL, fontWeight: 700 }}>{m.poids_net.toLocaleString('fr-FR')}</td>
                          <td style={tdL}>{m.humidite ?? '–'}</td>
                          <td style={{ ...tdL, fontSize: '.72rem', color: 'var(--text-muted)' }}>
                            {[m.ps != null && `PS ${m.ps}`, m.proteine != null && `Prot. ${m.proteine}%`, m.calibrage != null && `Calib. ${m.calibrage}%`].filter(Boolean).join(' · ') || '–'}
                          </td>
                          <td style={tdL}>{m.benne || '–'}</td>
                          <td style={tdL}>{m.conducteur || '–'}</td>
                          <td style={{ ...tdL, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.observation || '–'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: 'var(--green-pale)', fontWeight: 700 }}>
                      <td style={tdL} colSpan={5}>TOTAL — {moissonCampagne.length} entrée(s)</td>
                      <td style={tdL}>{totMoissonKg.toLocaleString('fr-FR')} kg</td>
                      <td style={tdL} colSpan={5}>{(totMoissonKg / 1000).toFixed(2)} t</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ Onglet Stock : uniquement le physique — tonnage et répartition par lieu.
           Les prix moyens / ventes sont dans l'onglet Commerce. ══ */}
      {pageTab === 'stock' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))', gap: '.8rem', marginBottom: '1.4rem' }}>
            {[
              { label: 'Engagé (ventes restant à livrer)', value: `${resteALivrerVentesT.toFixed(2)} t`, color: 'var(--amber)' },
              { label: 'Stock théorique disponible', value: `${stockTheoriqueT.toFixed(2)} t`, color: stockTheoriqueT < 0 ? 'var(--red)' : 'var(--green-mid)' },
            ].map(k => (
              <div key={k.label} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '.9rem 1.1rem', borderTop: `4px solid ${k.color}` }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '.3rem' }}>{k.label}</div>
                <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.3rem', color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          <h3 style={{ fontSize: '.95rem', marginBottom: '.8rem' }}>Stock engagé par acheteur / stock libre</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: '1rem', marginBottom: '1.4rem' }}>
            <StockCulturePie titre="🌾 Blé" color="#c9922c" stockPhysique={stockPhysiqueBleT} engagements={engageBle} coopDetail={coopDetailBle} libre={libreBleT} />
            <StockCulturePie titre="🌿 Orge" color="#3d7a42" stockPhysique={stockPhysiqueOrgeT} engagements={engageOrge} coopDetail={coopDetailOrge} libre={libreOrgeT} />
          </div>

          <SortiEngageHisto histoFilter={histoFilter} setHistoFilter={setHistoFilter} commerceBle={commerceBle} commerceOrge={commerceOrge} />

          {/* "Stock engagé" ci-dessus ne montre que les acheteurs avec un contrat encore en
              cours (reste à livrer) — une fois expédié, le grain sort du stock (engagé ou
              pas) et disparaît logiquement de ce donut. Vivescia (et tout acheteur sans
              contrat, juste une expédition directe) n'y apparaît donc jamais tant qu'aucun
              contrat n'est créé — normal, mais peu lisible sans ce récap historique à côté. */}
          <h3 style={{ fontSize: '.95rem', marginBottom: '.4rem' }}>Vendu par acheteur — toute la campagne (déjà expédié, contrat ou non)</h3>
          <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
            Historique de tout ce qui est déjà parti, quel que soit l'acheteur — contrairement au donut ci-dessus qui ne montre que l'engagé (reste à livrer sur un contrat en cours).
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '1rem', marginBottom: '1.4rem' }}>
            {[['🌾 Blé', venduParAcheteurBle, '#c9922c'], ['🌿 Orge', venduParAcheteurOrge, '#3d7a42']].map(([titre, rows, color]) => (
              <div key={titre} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '.6rem .9rem', fontWeight: 700, fontSize: '.85rem', borderBottom: '1px solid var(--border)' }}>{titre}</div>
                {rows.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.8rem' }}>Aucune vente.</div>
                ) : (
                  <table style={{ width: '100%', fontSize: '.82rem', borderCollapse: 'collapse' }}>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.acheteur}>
                          <td style={tdL}>{r.acheteur}</td>
                          <td style={{ ...tdL, fontWeight: 700, color, textAlign: 'right' }}>{r.tonnage.toFixed(2)} t</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>

          <h3 style={{ fontSize: '.95rem', marginBottom: '.8rem' }}>Sorties directes vers les coopératives</h3>
          {recapCoop.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)', marginBottom: '1.4rem' }}>
              Aucune sortie directe vers SCARA ou Soufflet pour cette campagne.
            </div>
          ) : (
            <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: '1.4rem' }}>
              <table style={{ width: '100%', minWidth: 380, fontSize: '.85rem', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--cream)' }}>
                  <tr>
                    {['Coopérative', 'Livraisons', 'Total sorti (t)'].map(h => (
                      <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recapCoop.map(r => (
                    <tr key={r.coop}>
                      <td style={{ ...tdL, fontWeight: 700 }}>{r.coop}</td>
                      <td style={tdL}>{r.nb}</td>
                      <td style={{ ...tdL, fontWeight: 700, color: 'var(--green-mid)' }}>{r.tonnage.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ background: 'var(--green-pale)', fontWeight: 700 }}>
                    <td style={tdL}>TOTAL</td>
                    <td style={tdL}>{recapCoop.reduce((s, r) => s + r.nb, 0)}</td>
                    <td style={tdL}>{recapCoop.reduce((s, r) => s + r.tonnage, 0).toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>
            Stock physique = entrées moisson + réceptions (achats) − sorties (ventes livrées), tout stockage confondu — détail par lieu dans l'onglet 🏬 Stock physique. Stock théorique disponible = stock physique moins ce qui est déjà engagé sur des ventes en cours. Les livraisons directes chez SCARA/Soufflet sont du stockage chez le tiers (pas une vente définitive) et restent comptées dans le stock engagé/libre ci-dessus tant qu'aucun contrat de vente n'y est rattaché.
          </div>
        </div>
      )}

      {/* ══ Onglet Stock physique : tonnage réellement en stock, tout stockage
           confondu, avec détail par lieu (silos, cellules…). ══ */}
      {pageTab === 'stock-physique' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(220px, 100%), 1fr))', gap: '.8rem', marginBottom: '1.4rem' }}>
            {[
              { label: 'Stock physique total', value: `${stockPhysiqueT.toFixed(2)} t`, color: 'var(--green-mid)' },
              { label: 'Dont Blé', value: `${stockPhysiqueBleT.toFixed(2)} t`, color: '#c9922c' },
              { label: 'Dont Orge', value: `${stockPhysiqueOrgeT.toFixed(2)} t`, color: '#3d7a42' },
            ].map(k => (
              <div key={k.label} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '.9rem 1.1rem', borderTop: `4px solid ${k.color}` }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: '.3rem' }}>{k.label}</div>
                <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.3rem', color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>

          <h3 style={{ fontSize: '.95rem', marginBottom: '.4rem' }}>Stock ferme / Stock coopératives par culture</h3>
          <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
            "Stock ferme" = sur site (silos, hangar, Fredo). "Stock coop" = stocké chez SCARA/Soufflet — calculés à partir de toutes les entrées moisson, réceptions (achats) et sorties de tous les contrats, quel que soit l'onglet où ils ont été saisis.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem', marginBottom: '1.4rem' }}>
            {[
              { titre: '🌾 Blé', color: '#c9922c', ferme: stockPhysiqueBleT, coop: coopBleT, contrats: commerceBle.contratsRows },
              { titre: '🌿 Orge', color: '#3d7a42', ferme: stockPhysiqueOrgeT, coop: coopOrgeT, contrats: commerceOrge.contratsRows },
            ].map(g => {
              const max = Math.max(1, g.ferme, g.coop)
              const societes = [...new Set(g.contrats.map(c => c.entite).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'))
              return (
                <div key={g.titre} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.1rem' }}>
                  <div style={{ fontWeight: 700, fontSize: '.9rem', marginBottom: '.7rem' }}>{g.titre}</div>
                  <div style={{ marginBottom: '.6rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', marginBottom: '.25rem' }}>
                      <span>🏠 Stock ferme</span>
                      <span style={{ fontWeight: 700, color: g.color }}>{g.ferme.toFixed(2)} t</span>
                    </div>
                    <div style={{ height: 16, background: 'var(--cream-dark)', borderRadius: 50, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 50, transition: 'width .4s', width: `${(g.ferme / max) * 100}%`, background: g.color }} />
                    </div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.8rem', marginBottom: '.25rem' }}>
                      <span>🚛 Stock coopératives</span>
                      <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>{g.coop.toFixed(2)} t</span>
                    </div>
                    <div style={{ height: 16, background: 'var(--cream-dark)', borderRadius: 50, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 50, transition: 'width .4s', width: `${(g.coop / max) * 100}%`, background: 'var(--stone,#5c6b54)' }} />
                    </div>
                  </div>
                  <div style={{ marginTop: '.8rem', paddingTop: '.6rem', borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '.35rem' }}>
                      Sociétés sous contrat de vente en cours ({societes.length})
                    </div>
                    {societes.length === 0 ? (
                      <span style={{ fontSize: '.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Aucune</span>
                    ) : (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
                        {societes.map(s => (
                          <span key={s} style={{ fontSize: '.74rem', fontWeight: 600, padding: '.15rem .55rem', borderRadius: 50, background: 'var(--green-pale)', color: 'var(--green-mid)' }}>{s}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <SortiEngageHisto histoFilter={histoFilter} setHistoFilter={setHistoFilter} commerceBle={commerceBle} commerceOrge={commerceOrge} />

          <h3 style={{ fontSize: '.95rem', marginBottom: '.8rem' }}>Détail par lieu de stockage</h3>
          {stockParLieu.length === 0 || totMoissonKg === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
              Aucune entrée de moisson pour l'instant.
            </div>
          ) : (
            <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1.1rem 1.3rem', display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
              {stockParLieu.map(l => (
                <div key={l.lieu}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.82rem', marginBottom: '.25rem' }}>
                    <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '.4rem' }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: LIEU_COLOR[l.lieu] || 'var(--stone,#5c6b54)', display: 'inline-block' }} />
                      {l.lieu}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{(l.kg / 1000).toFixed(2)} t</span>
                  </div>
                  <div style={{ height: 14, background: 'var(--cream-dark)', borderRadius: 50, overflow: 'hidden' }}>
                    <div style={{ height: '100%', borderRadius: 50, transition: 'width .4s', width: `${(l.kg / maxLieuKg) * 100}%`, background: LIEU_COLOR[l.lieu] || 'var(--stone,#5c6b54)' }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {stockNonVentileKg > 1 && (
            <div style={{ marginTop: '1rem', background: 'var(--amber-pale, #fdf6e9)', border: '1px solid var(--amber)', borderRadius: 10, padding: '.7rem 1rem', fontSize: '.78rem' }}>
              ⚠️ <strong>{(stockNonVentileKg / 1000).toFixed(2)} t</strong> du total ci-dessus ne sont rattachées à aucun lieu dans le détail — c'est l'écart que tu observes entre le total et la somme des lieux. Deux causes possibles :
              {sortiesSansLieuKg > 1 && <> des sorties (<strong>{(sortiesSansLieuKg / 1000).toFixed(2)} t</strong>) sans "lieu d'enlèvement" renseigné sur leur fiche ;</>}
              {clampedLossKg > 1 && <> {sortiesSansLieuKg > 1 ? 'et' : ''} un lieu (<strong>{(clampedLossKg / 1000).toFixed(2)} t</strong>) dont les sorties enregistrées dépassent ce qui y avait été stocké, probablement un lieu d'enlèvement saisi différemment du lieu de stockage d'origine.</>}
              {' '}Renseigner systématiquement le lieu d'enlèvement (identique au lieu de stockage) sur les fiches de sortie règle ça pour les prochaines saisies.
            </div>
          )}

          <div style={{ marginTop: '1rem', fontSize: '.76rem', color: 'var(--text-muted)' }}>
            Tout stockage confondu, tonnage cumulatif (indépendant de la campagne active) — c'est ce qui est physiquement dans les cellules aujourd'hui.
          </div>
        </div>
      )}

      {/* ══ Onglet Commerce : ventes séparées Blé / Orge — prix moyen sur les ventes
           déjà réalisées uniquement (pas de prix moyen sur l'engagé) ══ */}
      {pageTab === 'commerce' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Blé et Orge séparés — campagne {campagneActive}. "Expédié" = déjà livré (fiches de sortie, livraisons rattachées à un contrat, ou moisson livrée directement). "Engagé" = tonnage restant à livrer sur les contrats de vente en cours. Clique une ligne pour la modifier.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: '1.2rem' }}>
            <CommerceBloc titre="🌾 Blé" data={commerceBle} color="#c9922c" coopStockeT={coopBleT} venduParAcheteurRows={venduParAcheteurBle}
              onEditVenteRow={editVenteRow} onEditContrat={openEdit} onNewContrat={() => openNew('vente')} />
            <CommerceBloc titre="🌿 Orge" data={commerceOrge} color="#3d7a42" coopStockeT={coopOrgeT} venduParAcheteurRows={venduParAcheteurOrge}
              onEditVenteRow={editVenteRow} onEditContrat={openEdit} onNewContrat={() => openNew('vente')} />
          </div>
        </div>
      )}

      {/* ══ Onglet Sorties : ce qui a déjà été livré (ventes) + fiches de sortie ══ */}
      {pageTab === 'sorties' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {[
              { label: 'Total sorti', value: `${totSortiesT.toFixed(2)} t` },
              { label: 'Sorties', value: String(sorties.length) },
              { label: 'Valeur totale', value: sortiesAvecPrix.length > 0 ? `${valeurTotaleVendue.toFixed(0)} €` : '—' },
            ].map(k => (
              <div key={k.label} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.55rem 1rem' }}>
                <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--green-mid)' }}>{k.value}</div>
              </div>
            ))}
            <button className="btn-sm primary" onClick={openNewFiche} style={{ marginLeft: 'auto' }}>+ Fiche de sortie (bon d'enlèvement)</button>
          </div>
          {sorties.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
              Aucune sortie enregistrée — crée une fiche de sortie, ou les entrées moisson livrées directement apparaîtront ici.
            </div>
          ) : (
            <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', minWidth: 900, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--cream)' }}>
                  <tr>
                    {['Date', 'Culture', 'Client', 'Quantité (t)', 'Prix (€/t)', 'Valeur (€)', 'Transporteur', 'Immat.', 'Réf. bon'].map(h => (
                      <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorties.map(l => {
                    const prix = l.prix_ht ?? l.contrat?.prix_contracte ?? null
                    return (
                    <tr key={l.id} onClick={() => editVenteRow(l)} style={{ cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={tdL}>{fmtDate(l.date)}</td>
                      <td style={{ ...tdL, fontWeight: 700 }}>{l.contrat?.culture || l.culture_libre || l.culture || '–'}</td>
                      <td style={tdL}>{l.direct
                        ? <span style={{ color:'#3498db', fontWeight:600 }}>🚚 {l.lieuLivraison}{l.entiteLivraison ? <span style={{ display:'block', fontSize:'.7rem', color:'var(--text-muted)', fontWeight:400 }}>🏷️ {l.entiteLivraison}</span> : ''}</span>
                        : (l.contrat?.tiers_nom || l.client_nom_libre || '–')}</td>
                      <td style={{ ...tdL, fontWeight: 700 }}>{(l.quantite || 0).toFixed(2)}</td>
                      <td style={tdL}>{prix != null ? prix.toFixed(2) : '–'}</td>
                      <td style={tdL}>{prix != null ? ((l.quantite || 0) * prix).toFixed(0) : '–'}</td>
                      <td style={tdL}>{l.transporteur || '–'}</td>
                      <td style={tdL}>{l.immatriculation || '–'}</td>
                      <td style={tdL}>{l.direct ? 'Livraison directe (moisson)' : (l.ref_bon || '–')}</td>
                    </tr>
                  )})}
                </tbody>
                <tfoot>
                  <tr style={{ background: 'var(--green-pale)', fontWeight: 700 }}>
                    <td style={tdL} colSpan={3}>TOTAL</td>
                    <td style={tdL}>{totSortiesT.toFixed(2)}</td>
                    <td style={tdL} colSpan={4}></td>
                    <td style={tdL}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══ Onglet Dossiers parcelles : fusion entrées moisson + sorties directes
           (elles tracent à une parcelle précise) ; les sorties issues du stock déjà
           mélangé (fiches/contrats) n'ont aucune traçabilité parcelle possible —
           elles vivent dans le sous-onglet "Sorties hors parcelle" à côté. ══ */}
      {pageTab === 'dossiers' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ background: 'white', borderBottom: '1px solid var(--border)', display: 'flex', gap: '.3rem', padding: '.6rem 1.2rem', flexShrink: 0 }}>
            <button onClick={() => setDossierSubTab('parcelles')} className="btn-sm" style={{ padding: '.3rem .7rem', fontSize: '.78rem',
              ...(dossierSubTab === 'parcelles' ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}>
              📁 Par parcelle
            </button>
            <button onClick={() => setDossierSubTab('autres')} className="btn-sm" style={{ padding: '.3rem .7rem', fontSize: '.78rem',
              ...(dossierSubTab === 'autres' ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}) }}>
              🚚 Sorties hors parcelle ({sortiesHorsParcelle.length})
            </button>
            <div style={{ marginLeft: 'auto' }}>
              {dossierSubTab === 'parcelles' ? (
                <button className="btn-sm primary" onClick={openNewMoisson} style={{ padding: '.3rem .7rem', fontSize: '.78rem' }}>
                  + Entrée moisson
                </button>
              ) : (
                <button className="btn-sm primary" onClick={openNewFiche} style={{ padding: '.3rem .7rem', fontSize: '.78rem' }}>
                  + Fiche de sortie
                </button>
              )}
            </div>
          </div>

          {dossierSubTab === 'parcelles' ? (
            <DossiersParcelles
              parcelles={dossierParcellesCereales.filter(p => isCerealCulture(p.culture_actuelle) && !/scea hemard baillot/i.test((p._primaryEntite ?? p.entite) || ''))}
              entries={moissonCampagne}
              entryParcelleId={m => groupByMemberId[m.parcelle_id]?.primary.id || m.parcelle_id}
              isMobile={isMobile}
              dossierId={dossierId} setDossierId={setDossierId}
              search={dossierSearch} setSearch={setDossierSearch}
              emptyHint="Aucune parcelle céréale trouvée (blé, orge, escourgeon, maïs… dans Parcelles)."
              renderStats={(parc, rows) => {
                const net = rows.reduce((s, r) => s + (r.poids_net || 0), 0)
                const netDirect = rows.filter(r => r.lieu_livraison && !r.lieu_stockage).reduce((s, r) => s + (r.poids_net || 0), 0)
                return [
                  { label: 'Entrées', value: String(rows.length) },
                  { label: 'Récolté', value: `${(net / 1000).toFixed(2)} t` },
                  { label: 'Sorti directement', value: `${(netDirect / 1000).toFixed(2)} t` },
                  { label: 'Rendement', value: parc.surface > 0 && net > 0 ? `${((net / 100) / parc.surface).toFixed(1)} q/ha` : '–', accent: true },
                ]
              }}
              onAdd={parc => setEditingMoisson({
                date: new Date().toISOString().split('T')[0], campagne: campagneActive,
                culture: '', parcelle_id: parc.id, parcelle_nom: parc.nom,
                parcelle_ids_groupe: parc._groupeMemberIds || null,
                lieu_stockage: '', lieu_livraison: '', entite_livraison: '',
                poids_brut: '', poids_net: '', humidite: '',
                benne: '', conducteur: '', observation: '',
              })}
              addLabel="+ Entrée moisson"
              rowHeaders={['Type', 'Date', 'Culture', 'Poids net', 'Lieu', 'Humidité', 'Benne', 'Conducteur']}
              renderRow={m => {
                const direct = !!(m.lieu_livraison && !m.lieu_stockage)
                const coopExterne = m.lieu_stockage && coopMatch(m.lieu_stockage)
                const coopDirect = direct && coopMatch(m.lieu_livraison)
                const badge = (coopExterne || coopDirect)
                  ? <span style={{ color: '#c77d1f', fontWeight: 600, whiteSpace: 'nowrap' }}>🏬 Stocké coop. (non vendu)</span>
                  : direct
                    ? <span style={{ color: '#3498db', fontWeight: 600, whiteSpace: 'nowrap' }}>🚚 Sortie directe (vendue)</span>
                    : <span style={{ color: 'var(--green-mid)', fontWeight: 600, whiteSpace: 'nowrap' }}>🌾 Entrée stockée</span>
                return [
                  badge,
                  m.date, m.culture, m.poids_net != null ? m.poids_net.toLocaleString('fr-FR') + ' kg' : '–',
                  m.lieu_stockage || (m.lieu_livraison ? `🚚 ${m.lieu_livraison}` : '–'),
                  m.humidite != null ? m.humidite + ' %' : '–', m.benne || '–', m.conducteur || '–']
              }}
              onRowClick={m => setEditingMoisson({ ...m, parcelle_id: m.parcelle_id || '' })}
            />
          ) : (
            <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
              <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                Sorties qui ne proviennent pas directement d'une parcelle — fiches de sortie et livraisons rattachées à un contrat, tirées du stock déjà mélangé (aucune traçabilité parcelle possible). Campagne {campagneActive}.
              </div>
              {sortiesHorsParcelle.some(l => l.is_semence) && (
                <div style={{ display: 'inline-block', background: 'var(--cream)', borderRadius: 9, padding: '.55rem .9rem', marginBottom: '1rem', fontSize: '.8rem' }}>
                  🌾 Dont semences : <strong>{sortiesHorsParcelle.filter(l => l.is_semence).reduce((s, l) => s + (l.quantite || 0), 0).toFixed(2)} t</strong>
                </div>
              )}
              {sortiesHorsParcelle.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
                  Aucune sortie hors parcelle pour cette campagne.
                </div>
              ) : (
                <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', minWidth: 820, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                    <thead style={{ background: 'var(--cream)' }}>
                      <tr>
                        {['Date', 'Culture', 'Client', 'Quantité (t)', 'Prix (€/t)', 'Réf. bon'].map(h => (
                          <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortiesHorsParcelle.map(l => {
                        const prix = l.prix_ht ?? l.contrat?.prix_contracte ?? null
                        return (
                          <tr key={l.id} onClick={() => openEditFiche(l)} style={{ cursor: 'pointer' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}>
                            <td style={tdL}>{fmtDate(l.date)}</td>
                            <td style={{ ...tdL, fontWeight: 700 }}>
                              {l.contrat?.culture || l.culture_libre || l.culture || '–'}
                              {l.is_semence && <span style={{ marginLeft: 6, fontSize: '.68rem', fontWeight: 700, color: 'var(--amber)' }}>🌾 semences</span>}
                            </td>
                            <td style={tdL}>{l.contrat?.tiers_nom || l.client_nom_libre || '–'}</td>
                            <td style={{ ...tdL, fontWeight: 700 }}>{(l.quantite || 0).toFixed(2)}</td>
                            <td style={tdL}>{prix != null ? prix.toFixed(2) : '–'}</td>
                            <td style={tdL}>{l.ref_bon || '–'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: 'var(--green-pale)', fontWeight: 700 }}>
                        <td style={tdL} colSpan={3}>TOTAL</td>
                        <td style={tdL}>{sortiesHorsParcelle.reduce((s, l) => s + (l.quantite || 0), 0).toFixed(2)}</td>
                        <td style={tdL} colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ══ Onglet Rendements (quintaux/ha) ══ */}
      {pageTab === 'rendements' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          {moissonCampagne.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
              Les rendements se calculeront à partir des entrées de moisson.
            </div>
          ) : (
            <>
              {/* Global */}
              <div style={{ background: 'var(--green-deep)', borderRadius: 14, padding: '1rem 1.4rem', marginBottom: '1.2rem', display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '.68rem', color: 'rgba(255,255,255,.6)', textTransform: 'uppercase' }}>Rendement global</div>
                  <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '2rem', color: 'white' }}>
                    {rdtGlobalQ ? `${rdtGlobalQ.toFixed(1)} q/ha` : '—'}
                  </div>
                </div>
                <div style={{ fontSize: '.85rem', color: 'rgba(255,255,255,.85)' }}>
                  {(totMoissonKg / 1000).toFixed(2)} t récoltées · {surfacesMoisson.toFixed(2)} ha moissonnés
                </div>
              </div>

              {/* Blé vs Orge — rendements distincts */}
              <h3 style={{ fontSize: '.95rem', marginBottom: '.6rem' }}>Blé et Orge séparés</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: '1.2rem', marginBottom: '1.4rem' }}>
                <RendementBloc titre="🌾 Blé" stats={statsBle} color="#c9922c" />
                <RendementBloc titre="🌿 Orge" stats={statsOrge} color="#3d7a42"
                  extraLines={[
                    { label: 'ORP semis printemps (Fond des Vignes)', rdtQ: statsOrgePrintempsSemisPrintemps.rdtQ },
                    { label: 'ORP semis automne (reste)', rdtQ: statsOrgePrintempsSemisAutomne.rdtQ },
                  ]} />
              </div>

              {/* Par entité */}
              <h3 style={{ fontSize: '.95rem', marginBottom: '.6rem' }}>Par entité</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(260px, 100%), 1fr))', gap: '.8rem', marginBottom: '1.4rem' }}>
                {parEntite.map(e => (
                  <div key={e.entite} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '.9rem 1.1rem', borderTop: '4px solid var(--green-mid)' }}>
                    <div style={{ fontWeight: 700, fontSize: '.9rem', marginBottom: '.3rem' }}>{e.entite}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.4rem', color: 'var(--green-mid)' }}>
                        {e.surface > 0 ? `${((e.kg / 100) / e.surface).toFixed(1)} q/ha` : '—'}
                      </span>
                      <span style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>{(e.kg / 1000).toFixed(1)} t · {e.champs} champ(s)</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Par champ */}
              <h3 style={{ fontSize: '.95rem', marginBottom: '.6rem' }}>Par champ</h3>
              <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table style={{ width: '100%', minWidth: 640, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                  <thead style={{ background: 'var(--cream)' }}>
                    <tr>
                      {['Champ', 'Entité', 'Culture(s)', 'Surface (ha)', 'Récolté (t)', 'Rendement (q/ha)'].map(h => (
                        <th key={h} style={{ padding: '.55rem .75rem', textAlign: 'left', fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parChamp.map(r => (
                      <tr key={r.key}>
                        <td style={{ ...tdL, fontWeight: 700 }}>{r.nom}</td>
                        <td style={tdL}>{r.groupMembers ? r.groupMembers.map(p => p.entite).filter(Boolean).join(' + ') : (r.entite || '–')}</td>
                        <td style={tdL}>{[...r.cultures].join(', ') || '–'}</td>
                        <td style={tdL}>{r.surface ?? '–'}</td>
                        <td style={{ ...tdL, fontWeight: 700 }}>{(r.kg / 1000).toFixed(2)}</td>
                        <td style={{ ...tdL, fontWeight: 700, color: 'var(--green-mid)' }}>
                          {r.surface > 0 ? ((r.kg / 100) / r.surface).toFixed(1) : '–'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ Onglet Reste à livrer par entité — Blé et Orge séparés (rendements différents) ══ */}
      {pageTab === 'reste-livrer' && (
        <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
          <div style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
            Estimation par entité = surface de la culture (Blé ou Orge) × rendement constaté pour cette culture, moins ce qui a déjà été livré (contrats, livraisons directes, fiches de sortie). Blé et Orge sont calculés séparément car leurs rendements diffèrent.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))', gap: '1.2rem' }}>
            <ResteALivrerBloc titre="🌾 Blé" rdtQ={rdtBleQ} rows={resteBle} color="#c9922c" />
            <ResteALivrerBloc titre="🌿 Orge" rdtQ={rdtOrgeQ} rows={resteOrge} color="#3d7a42" />
          </div>
        </div>
      )}

      {/* Filtres */}
      {pageTab === 'contrats' && (<>
      <div style={{ padding: '.8rem 1.5rem', background: 'white', borderBottom: '1px solid var(--border)', display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {[['all', 'Tous'], ['vente', '↑ Ventes'], ['achat', '↓ Achats']].map(([k, l]) => (
          <button key={k} className="btn-sm" onClick={() => setFilterType(k)}
            style={filterType === k ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>{l}</button>
        ))}
        <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 .3rem' }} />
        {['en_cours', 'complete', 'annule', 'all'].map(s => (
          <button key={s} className="btn-sm" onClick={() => setFilterStatut(s)}
            style={filterStatut === s ? { background: 'var(--green-mid)', color: 'white', borderColor: 'var(--green-mid)' } : {}}>
            {s === 'all' ? 'Tous statuts' : STATUT_LABEL[s]}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: '.8rem', color: 'var(--text-muted)' }}>{displayed.length} contrat(s)</span>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflow: 'auto', padding: '1.2rem 1.5rem' }}>
        {displayed.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '.6rem' }}>🌾</div>
            Aucun contrat — cliquez "↑ Contrat vente" ou "↓ Contrat achat" pour commencer.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))', gap: '1rem' }}>
            {displayed.map(c => {
              const meta  = TYPE_META[c.type] || TYPE_META.vente
              const livre = livredByContrat[c.id] || 0
              const cible = c.tonnage_contracte || 0
              const pct   = cible > 0 ? Math.min(100, (livre / cible) * 100) : 0
              const reste = Math.max(0, cible - livre)
              const overshoot = livre > cible
              return (
                <div key={c.id} onClick={() => openEdit(c)}
                  style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 14, padding: '1.1rem 1.2rem', cursor: 'pointer', transition: 'box-shadow .15s', borderTop: `4px solid ${meta.color}` }}
                  onMouseEnter={e => e.currentTarget.style.boxShadow = 'var(--shadow-md)'}
                  onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '.6rem' }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '.95rem' }}>
                        <span style={{ color: meta.color }}>{meta.icon} {meta.label}</span>
                        {' — '}{c.culture}{c.recolte ? ` (récolte ${c.recolte})` : ''}
                      </div>
                      <div style={{ fontSize: '.82rem', color: 'var(--text-muted)' }}>
                        {c.tiers_nom}{c.reference ? ` · ${c.reference}` : ''}
                      </div>
                      {c.entite && <div style={{ fontSize: '.74rem', color: 'var(--green-mid)', fontWeight: 600 }}>🏷️ {c.entite}</div>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '.3rem' }}>
                      <span style={{ fontSize: '.72rem', fontWeight: 600, padding: '.2rem .6rem', borderRadius: 50, background: STATUT_COLOR[c.statut] + '20', color: STATUT_COLOR[c.statut] }}>
                        {STATUT_LABEL[c.statut]}
                      </span>
                      {campagneOf(c) !== campagneActive && (
                        <span title="Contrat engagé pour la campagne suivante — visible ici pour suivre l'avancement des ventes en amont" style={{ fontSize: '.66rem', fontWeight: 600, color: 'var(--amber)' }}>
                          🗓️ {campagneOf(c)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ fontSize: '.78rem', color: 'var(--text-muted)', marginBottom: '.9rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    {c.prix_contracte != null && <span>💶 {c.prix_contracte} €/t</span>}
                    {c.a_la_moisson ? <span>🌾 À la moisson</span> : c.date_fin && <span>📅 Échéance {c.date_fin}</span>}
                    {c.prix_contracte != null && cible > 0 && <span>Σ {(cible * c.prix_contracte).toFixed(0)} €</span>}
                  </div>

                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.75rem', fontWeight: 600, marginBottom: '.3rem' }}>
                      <span style={{ color: overshoot ? 'var(--red)' : meta.color }}>{livre.toFixed(2)} t {c.type === 'achat' ? 'reçues' : 'livrées'}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{cible.toFixed(2)} t contractées</span>
                    </div>
                    <div style={{ height: 10, background: 'var(--cream-dark)', borderRadius: 50, overflow: 'hidden' }}>
                      <div style={{ height: '100%', borderRadius: 50, transition: 'width .4s', width: `${pct}%`,
                        background: overshoot ? 'var(--red)' : pct >= 90 ? 'var(--amber)' : 'var(--green-accent)' }} />
                    </div>
                    <div style={{ fontSize: '.72rem', marginTop: '.3rem', color: overshoot ? 'var(--red)' : 'var(--text-muted)', fontWeight: overshoot ? 700 : 400 }}>
                      {overshoot
                        ? `⚠️ Dépassement de ${(livre - cible).toFixed(2)} t`
                        : `${pct.toFixed(0)}% — reste ${reste.toFixed(2)} t`}
                    </div>
                  </div>

                  {c.notes && <div style={{ fontSize: '.75rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '.5rem', borderTop: '1px solid var(--border)', paddingTop: '.4rem' }}>{c.notes}</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
      </>)}

      {/* Modal entrée moisson */}
      {editingMoisson && (
        <Modal title={editingMoisson.id ? 'Modifier l\'entrée moisson' : 'Nouvelle entrée moisson'}
          onClose={() => setEditingMoisson(null)} onSave={saveMoisson} onDelete={editingMoisson.id ? delMoisson : null} maxWidth={620}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group"><label>Date *</label>
              <input type="date" value={editingMoisson.date} onChange={e => setEditingMoisson({ ...editingMoisson, date: e.target.value })} /></div>
            <div className="form-group"><label>Culture *</label>
              <input autoFocus list="cultures-list-moisson" placeholder="ex. Blé tendre" value={editingMoisson.culture}
                onChange={e => setEditingMoisson({ ...editingMoisson, culture: e.target.value })} />
              <datalist id="cultures-list-moisson">{CULTURES.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Champ (parcelle)</label>
              {/* Seules les parcelles de la culture choisie sont proposées. Si cette entrée a
                  été ouverte depuis un dossier groupé (Millard), parcelle_ids_groupe est déjà
                  posé — le champ groupé n'apparaît que là, pas dans cette liste générale. */}
              {editingMoisson.parcelle_ids_groupe?.length > 0 ? (
                <>
                  <input disabled value={editingMoisson.parcelle_nom || ''} />
                  <div style={{ fontSize: '.7rem', color: 'var(--amber)', marginTop: 3, fontWeight: 600 }}>
                    ⓘ Champ groupé — la répartition entre entités se fera plus tard selon les quintaux à livrer.
                  </div>
                </>
              ) : (() => {
                const filtered = parcellesCampagne.filter(p =>
                  parcelleMatchesCulture(editingMoisson.culture, p.culture_actuelle) || p.id === editingMoisson.parcelle_id)
                return (
                  <>
                    <select value={editingMoisson.parcelle_id} onChange={e => {
                      const parc = parcelles.find(x => x.id === e.target.value)
                      setEditingMoisson({ ...editingMoisson, parcelle_id: e.target.value, parcelle_nom: parc?.nom || '' })
                    }}>
                      <option value="">— Aucun —</option>
                      {filtered.map(p => <option key={p.id} value={p.id}>{p.nom}{p.surface ? ` (${p.surface} ha)` : ''}{p.entite ? ` · ${p.entite}` : ''}</option>)}
                    </select>
                    {editingMoisson.culture?.trim() && (
                      <div style={{ fontSize: '.7rem', color: 'var(--text-muted)', marginTop: 3 }}>
                        {filtered.length} parcelle{filtered.length > 1 ? 's' : ''} en {editingMoisson.culture}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>
            <div className="form-group"><label>Lieu de stockage</label>
              <select value={editingMoisson.lieu_stockage || ''} onChange={e => setEditingMoisson({ ...editingMoisson, lieu_stockage: e.target.value })}>
                <option value="">— Non précisé —</option>
                {LIEUX_STOCKAGE.map(l => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
            {!editingMoisson.lieu_stockage && (
              <div className="form-group"><label>Lieu de livraison (si non stockée)</label>
                <input type="text" value={editingMoisson.lieu_livraison || ''} onChange={e => setEditingMoisson({ ...editingMoisson, lieu_livraison: e.target.value })} placeholder="ex. livrée directement chez Soufflet" />
              </div>
            )}
            {!editingMoisson.lieu_stockage && (() => {
              const parc = parcelles.find(p => p.id === editingMoisson.parcelle_id)
              return (
                <div className="form-group" style={{ gridColumn: '1/-1' }}>
                  <label>Entité — pour le compte de qui ce tonnage est livré</label>
                  <input list="entites-livraison-list" value={editingMoisson.entite_livraison || ''}
                    onChange={e => setEditingMoisson({ ...editingMoisson, entite_livraison: e.target.value })}
                    placeholder={parc?.entite ? `Par défaut : ${parc.entite} (entité du champ)` : 'ex. EARL MILLARD'} />
                  <datalist id="entites-livraison-list">{[...new Set(parcelles.map(p => p.entite).filter(Boolean))].map(e => <option key={e} value={e} />)}</datalist>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-muted)', marginTop: 3 }}>
                    Un champ peut appartenir à une entité mais être livré pour le compte d'une autre — laisser vide pour reprendre l'entité du champ.
                  </div>
                </div>
              )
            })()}
            <div className="form-group"><label>Poids brut (kg)</label>
              <input type="number" step="1" value={editingMoisson.poids_brut} onChange={e => setEditingMoisson({ ...editingMoisson, poids_brut: e.target.value })} /></div>
            <div className="form-group"><label>Poids net (kg) *</label>
              <input type="number" step="1" value={editingMoisson.poids_net} onChange={e => setEditingMoisson({ ...editingMoisson, poids_net: e.target.value })} /></div>
            <div className="form-group"><label>Humidité (%)</label>
              <input type="number" step="0.1" value={editingMoisson.humidite} onChange={e => setEditingMoisson({ ...editingMoisson, humidite: e.target.value })} /></div>
            {/* Qualité à la réception — champs propres à chaque culture, saisis dès que
                la culture tapée correspond (comparaison texte souple, comme pour le reste
                du formulaire — pas besoin d'avoir choisi un code RPG exact). */}
            {isBleTexte(editingMoisson.culture) && (
              <>
                <div className="form-group"><label>PS — Poids spécifique (kg/hL)</label>
                  <input type="number" step="0.1" value={editingMoisson.ps} onChange={e => setEditingMoisson({ ...editingMoisson, ps: e.target.value })} /></div>
                <div className="form-group"><label>Protéine (%)</label>
                  <input type="number" step="0.1" value={editingMoisson.proteine} onChange={e => setEditingMoisson({ ...editingMoisson, proteine: e.target.value })} /></div>
              </>
            )}
            {isOrgeTexte(editingMoisson.culture) && (
              <>
                <div className="form-group"><label>PS — Poids spécifique (kg/hL)</label>
                  <input type="number" step="0.1" value={editingMoisson.ps} onChange={e => setEditingMoisson({ ...editingMoisson, ps: e.target.value })} /></div>
                <div className="form-group"><label>Protéine (%)</label>
                  <input type="number" step="0.1" value={editingMoisson.proteine} onChange={e => setEditingMoisson({ ...editingMoisson, proteine: e.target.value })} /></div>
                <div className="form-group"><label>Calibrage (%)</label>
                  <input type="number" step="0.1" value={editingMoisson.calibrage} onChange={e => setEditingMoisson({ ...editingMoisson, calibrage: e.target.value })} /></div>
              </>
            )}
            <div className="form-group"><label>Benne / remorque</label>
              <input value={editingMoisson.benne || ''} onChange={e => setEditingMoisson({ ...editingMoisson, benne: e.target.value })} /></div>
            <div className="form-group"><label>Conducteur</label>
              <input value={editingMoisson.conducteur || ''} onChange={e => setEditingMoisson({ ...editingMoisson, conducteur: e.target.value })} /></div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Observation</label>
              <textarea rows={2} value={editingMoisson.observation || ''} onChange={e => setEditingMoisson({ ...editingMoisson, observation: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>
        </Modal>
      )}

      {/* Modal contrat */}
      {editing && (
        <Modal title={editing.id ? `Modifier le contrat ${TYPE_META[editing.type].label.toLowerCase()}` : `Nouveau contrat ${TYPE_META[editing.type].label.toLowerCase()}`}
          onClose={() => setEditing(null)} onSave={save} onDelete={editing.id ? del : null} maxWidth={620}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group">
              <label>Type</label>
              <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>
                <option value="vente">↑ Vente</option>
                <option value="achat">↓ Achat</option>
              </select>
            </div>
            <div className="form-group">
              <label>Référence</label>
              <input placeholder="ex. CER-2026-001" value={editing.reference || ''} onChange={e => setEditing({ ...editing, reference: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Culture *</label>
              <input autoFocus list="cultures-list" placeholder="ex. Blé tendre" value={editing.culture} onChange={e => setEditing({ ...editing, culture: e.target.value })} />
              <datalist id="cultures-list">{CULTURES.map(c => <option key={c} value={c} />)}</datalist>
            </div>
            <div className="form-group">
              <label>Récolte</label>
              <input placeholder="2026" value={editing.recolte || ''} onChange={e => setEditing({ ...editing, recolte: e.target.value })} />
            </div>
            <div className="form-group">
              <label>{TYPE_META[editing.type].tiers} *</label>
              <input list="tiers-nom-list" placeholder={editing.type === 'achat' ? 'ex. EARL Dupont' : 'ex. Soufflet, Vivescia…'} value={editing.tiers_nom} onChange={e => setEditing({ ...editing, tiers_nom: e.target.value })} />
              <datalist id="tiers-nom-list">
                {[...new Set(contrats.filter(c => c.type === editing.type).map(c => c.tiers_nom).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr')).map(n => <option key={n} value={n} />)}
              </datalist>
            </div>
            <div className="form-group">
              <label>Entité (qui a contracté)</label>
              <input list="entites-list" placeholder="ex. SARL ROPAMIL" value={editing.entite || ''} onChange={e => setEditing({ ...editing, entite: e.target.value })} />
              <datalist id="entites-list">{[...new Set(parcelles.map(p => p.entite).filter(Boolean))].map(e => <option key={e} value={e} />)}</datalist>
            </div>
            <div className="form-group"><label>Tonnage contracté (t) *</label>
              <input type="number" step="0.01" value={editing.tonnage_contracte} onChange={e => setEditing({ ...editing, tonnage_contracte: e.target.value })} /></div>
            <div className="form-group"><label>Prix contracté (€/t)</label>
              <input type="number" step="0.01" value={editing.prix_contracte} onChange={e => setEditing({ ...editing, prix_contracte: e.target.value })} /></div>
            <div className="form-group">
              <label>Échéance</label>
              <label style={{ display:'flex', alignItems:'center', gap:'.4rem', fontWeight:400, fontSize:'.82rem', marginBottom:'.35rem', cursor:'pointer' }}>
                <input type="checkbox" checked={!!editing.a_la_moisson}
                  onChange={e => setEditing({ ...editing, a_la_moisson: e.target.checked, date_fin: e.target.checked ? '' : editing.date_fin })} />
                🌾 À la moisson (pas de date fixe)
              </label>
              {!editing.a_la_moisson && (
                <input type="date" value={editing.date_fin || ''} onChange={e => setEditing({ ...editing, date_fin: e.target.value })} />
              )}
            </div>
            <div className="form-group"><label>Statut</label>
              <select value={editing.statut} onChange={e => setEditing({ ...editing, statut: e.target.value })}>
                <option value="en_cours">En cours</option>
                <option value="complete">Complété</option>
                <option value="annule">Annulé</option>
              </select>
            </div>
            <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Notes</label>
              <textarea rows={2} value={editing.notes || ''} onChange={e => setEditing({ ...editing, notes: e.target.value })}
                style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
            </div>
          </div>

          {/* Livraisons du contrat — en modification : liste + ajout au fil de l'eau.
              À la création : case "déjà livré" pour saisir directement la première
              livraison (date, tonnes, lieu de stockage d'où c'est parti) sans avoir
              à ré-ouvrir le contrat juste après l'avoir créé. */}
          {!editing.id && (
            <div style={{ marginTop: '1.2rem', borderTop: '2px solid var(--border)', paddingTop: '.9rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontWeight: 600, fontSize: '.85rem', cursor: 'pointer', marginBottom: newLiv ? '.7rem' : 0 }}>
                <input type="checkbox" checked={!!editing.deja_livre}
                  onChange={e => {
                    setEditing({ ...editing, deja_livre: e.target.checked })
                    setNewLiv(e.target.checked ? { date: new Date().toISOString().split('T')[0], quantite: editing.tonnage_contracte || '', lieu_enlevement: '', immatriculation: '', ref_bon: '' } : null)
                  }} />
                🚚 {editing.type === 'achat' ? 'Déjà réceptionné (en tout ou partie) ?' : 'Déjà livré (en tout ou partie) ?'}
              </label>
              {newLiv && <LivraisonQuickFields newLiv={newLiv} setNewLiv={setNewLiv} />}
            </div>
          )}

          {editing.id && (
            <div style={{ marginTop: '1.2rem', borderTop: '2px solid var(--border)', paddingTop: '.9rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.6rem', flexWrap: 'wrap', gap: '.5rem' }}>
                <strong style={{ fontSize: '.9rem' }}>
                  🚚 {editing.type === 'achat' ? 'Réceptions' : 'Livraisons'} ({livraisons.filter(l => l.contrat_id === editing.id).length})
                </strong>
                {!newLiv && <button className="btn-sm primary" onClick={() => setNewLiv({ date: new Date().toISOString().split('T')[0], quantite: '', lieu_enlevement: '', immatriculation: '', ref_bon: '' })}>+ Ajouter</button>}
              </div>

              {newLiv && (
                <div style={{ marginBottom: '.7rem', background: 'var(--cream)', padding: '.6rem', borderRadius: 8 }}>
                  <LivraisonQuickFields newLiv={newLiv} setNewLiv={setNewLiv} />
                  <div style={{ display: 'flex', gap: '.4rem', marginTop: '.5rem', justifyContent: 'flex-end' }}>
                    <button className="btn-sm" onClick={() => setNewLiv(null)}>Annuler</button>
                    <button className="btn-sm primary" onClick={addLivraison}>✓ Ajouter</button>
                  </div>
                </div>
              )}

              {livraisons.filter(l => l.contrat_id === editing.id).length > 0 && (
                <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', minWidth: 520, fontSize: '.8rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: 'var(--cream)' }}>
                        {['Date', 'Tonnes', 'Lieu', 'Immat.', 'Réf. bon', ''].map(h => (
                          <th key={h} style={{ padding: '.4rem .6rem', textAlign: 'left', fontSize: '.68rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {livraisons.filter(l => l.contrat_id === editing.id).map(l => (
                        <tr key={l.id}>
                          <td style={tdL}>{fmtDate(l.date)}</td>
                          <td style={{ ...tdL, fontWeight: 700 }}>{l.quantite}</td>
                          <td style={tdL}>{l.lieu_enlevement || '–'}</td>
                          <td style={tdL}>{l.immatriculation || '–'}</td>
                          <td style={tdL}>{l.ref_bon || '–'}</td>
                          <td style={tdL}>
                            <button onClick={e => { e.stopPropagation(); delLivraison(l.id) }}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--red)', fontSize: '.8rem' }}>🗑</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Modal>
      )}

      {/* Modal fiche de sortie (bon d'enlèvement) */}
      {editingFiche && (
        <Modal title={editingFiche.id ? 'Modifier la fiche de sortie' : 'Nouvelle fiche de sortie'}
          onClose={() => setEditingFiche(null)} onSave={saveFiche} onDelete={editingFiche.id ? delFiche : null} maxWidth={640}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem' }}>
            <div className="form-group"><label>Date *</label>
              <input type="date" value={editingFiche.date} onChange={e => setEditingFiche({ ...editingFiche, date: e.target.value })} /></div>
            <div className="form-group"><label>N° Bon de sortie</label>
              <input placeholder="ex. BS-2026-001" value={editingFiche.ref_bon || ''} onChange={e => setEditingFiche({ ...editingFiche, ref_bon: e.target.value })} /></div>

            <div className="form-group" style={{ gridColumn: '1/-1' }}>
              <label>Contrat de vente (optionnel)</label>
              <select value={editingFiche.contrat_id || ''} onChange={e => setEditingFiche({ ...editingFiche, contrat_id: e.target.value })}>
                <option value="">— Hors contrat (enlèvement direct) —</option>
                {contratsCampagne.filter(c => c.type === 'vente').map(c => (
                  <option key={c.id} value={c.id}>{c.reference || 'Sans réf.'} — {c.tiers_nom} — {c.culture}{c.recolte ? ` (${c.recolte})` : ''}</option>
                ))}
              </select>
            </div>

            {!editingFiche.contrat_id && (
              <>
                <div className="form-group"><label>Culture</label>
                  <input list="cultures-list-fiche" value={editingFiche.culture_libre || ''} onChange={e => setEditingFiche({ ...editingFiche, culture_libre: e.target.value })} />
                  <datalist id="cultures-list-fiche">{CULTURES.map(c => <option key={c} value={c} />)}</datalist>
                </div>
                <div className="form-group"><label>Client *</label>
                  <input value={editingFiche.client_nom_libre || ''} onChange={e => setEditingFiche({ ...editingFiche, client_nom_libre: e.target.value })} placeholder="ex. Soufflet, Vivescia…" /></div>
                <div className="form-group" style={{ gridColumn: '1/-1' }}><label>Entité (pour le compte de qui)</label>
                  <input list="entites-fiche-list" value={editingFiche.entite_libre || ''} onChange={e => setEditingFiche({ ...editingFiche, entite_libre: e.target.value })} placeholder="ex. SARL ROPAMIL" />
                  <datalist id="entites-fiche-list">{[...new Set(parcelles.map(p => p.entite).filter(Boolean))].map(e => <option key={e} value={e} />)}</datalist>
                </div>
              </>
            )}

            <div className="form-group"><label>Lieu d'enlèvement</label>
              <input list="lieux-enlevement-list" value={editingFiche.lieu_enlevement || ''} onChange={e => setEditingFiche({ ...editingFiche, lieu_enlevement: e.target.value })} />
              <datalist id="lieux-enlevement-list">{LIEUX_STOCKAGE.map(l => <option key={l} value={l} />)}</datalist>
            </div>
            <div className="form-group"><label>Transporteur</label>
              <input value={editingFiche.transporteur || ''} onChange={e => setEditingFiche({ ...editingFiche, transporteur: e.target.value })} /></div>
            <div className="form-group"><label>Immatriculation</label>
              <input value={editingFiche.immatriculation || ''} onChange={e => setEditingFiche({ ...editingFiche, immatriculation: e.target.value })} placeholder="AB-123-CD" /></div>

            <div className="form-group"><label>Poids brut (t) *</label>
              <input type="number" step="0.001" value={editingFiche.poids_brut} onChange={e => setEditingFiche({ ...editingFiche, poids_brut: e.target.value })} /></div>
            <div className="form-group"><label>Tare (%)</label>
              <input type="number" step="0.1" value={editingFiche.tare_pct} onChange={e => setEditingFiche({ ...editingFiche, tare_pct: e.target.value })} /></div>
            <div className="form-group"><label>Prix HT (€/t)</label>
              <input type="number" step="0.01" value={editingFiche.prix_ht} onChange={e => setEditingFiche({ ...editingFiche, prix_ht: e.target.value })} /></div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.85rem', cursor: 'pointer', gridColumn: '1 / -1' }}>
              <input type="checkbox" checked={!!editingFiche.is_semence} onChange={e => setEditingFiche({ ...editingFiche, is_semence: e.target.checked })} />
              🌾 Sortie destinée aux semences (plutôt qu'une vente commerciale classique)
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.8rem', background: 'var(--green-pale)', borderRadius: 10, padding: '1rem', marginTop: '.9rem' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '.2rem' }}>Poids net</div>
              <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.5rem', color: 'var(--green-mid)' }}>
                {ficheNet(editingFiche) != null ? ficheNet(editingFiche).toFixed(3) + ' t' : '—'}
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '.2rem' }}>Total HT</div>
              <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: '1.5rem', color: 'var(--green-mid)' }}>
                {ficheTotal(editingFiche) != null ? ficheTotal(editingFiche).toLocaleString('fr-FR', { minimumFractionDigits: 2 }) + ' €' : '—'}
              </div>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: '.9rem' }}>
            <label>Observation</label>
            <textarea rows={2} value={editingFiche.observation || ''} onChange={e => setEditingFiche({ ...editingFiche, observation: e.target.value })}
              style={{ width: '100%', padding: '.6rem .85rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none', resize: 'vertical' }} />
          </div>
        </Modal>
      )}
    </div>
  )
}

const tdL = { padding: '.45rem .6rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }

/* Champs de saisie rapide d'une livraison/réception — réutilisés à la fois lors
   de la création d'un contrat ("déjà livré") et pour en ajouter une à un contrat
   existant. Grille responsive (auto-fit) plutôt que des colonnes fixes, pour ne
   pas se retrouver écrasé sur mobile/tablette avec 5 champs sur une seule ligne. */
function LivraisonQuickFields({ newLiv, setNewLiv }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))', gap: '.5rem' }}>
      <div className="form-group"><label style={{ fontSize: '.68rem' }}>Date *</label>
        <input type="date" value={newLiv.date} onChange={e => setNewLiv({ ...newLiv, date: e.target.value })} /></div>
      <div className="form-group"><label style={{ fontSize: '.68rem' }}>Tonnes *</label>
        <input type="number" step="0.01" value={newLiv.quantite} onChange={e => setNewLiv({ ...newLiv, quantite: e.target.value })} /></div>
      <div className="form-group">
        <label style={{ fontSize: '.68rem' }}>Lieu de stockage (d'où c'est parti)</label>
        <input list="lieux-enlevement-list-contrat" value={newLiv.lieu_enlevement || ''} onChange={e => setNewLiv({ ...newLiv, lieu_enlevement: e.target.value })} />
        <datalist id="lieux-enlevement-list-contrat">{LIEUX_STOCKAGE.map(l => <option key={l} value={l} />)}</datalist>
      </div>
      <div className="form-group"><label style={{ fontSize: '.68rem' }}>Immat.</label>
        <input value={newLiv.immatriculation} onChange={e => setNewLiv({ ...newLiv, immatriculation: e.target.value })} /></div>
      <div className="form-group"><label style={{ fontSize: '.68rem' }}>Réf. bon</label>
        <input value={newLiv.ref_bon} onChange={e => setNewLiv({ ...newLiv, ref_bon: e.target.value })} /></div>
    </div>
  )
}

function RendementBloc({ titre, stats, color, extraLines }) {
  const { rdtQ, totKg, totSurface, rows, parEntiteRows } = stats
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: 'var(--green-deep)', padding: '.9rem 1.2rem', display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.5rem' }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: '1rem' }}>{titre}</span>
          <span style={{ color: 'white', fontSize: '.9rem' }}>
            {rdtQ != null ? <><strong>{rdtQ.toFixed(1)} q/ha</strong> — {(totKg / 1000).toFixed(2)} t · {totSurface.toFixed(2)} ha</> : '—'}
          </span>
        </div>
        {extraLines?.filter(l => l.rdtQ != null).map(l => (
          <div key={l.label} style={{ textAlign: 'right', fontSize: '.76rem', color: 'rgba(255,255,255,.65)' }}>
            {l.label} : <strong style={{ color: 'white' }}>{l.rdtQ.toFixed(1)} q/ha</strong>
          </div>
        ))}
      </div>
      {rdtQ == null ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
          Pas encore de moisson enregistrée pour cette culture.
        </div>
      ) : (
        <div style={{ padding: '.9rem 1.1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '.9rem' }}>
            {parEntiteRows.map(e => (
              <div key={e.entite} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', background: 'var(--cream)', borderRadius: 8, padding: '.5rem .8rem' }}>
                <span style={{ fontWeight: 700, fontSize: '.84rem' }}>{e.entite}</span>
                <span style={{ fontSize: '.8rem' }}>
                  <strong style={{ color }}>{e.surface > 0 ? ((e.kg / 100) / e.surface).toFixed(1) : '–'} q/ha</strong>
                  <span style={{ color: 'var(--text-muted)' }}> · {(e.kg / 1000).toFixed(1)} t · {e.champs} champ(s)</span>
                </span>
              </div>
            ))}
          </div>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <table style={{ width: '100%', minWidth: 460, fontSize: '.8rem', borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--cream)' }}>
                <tr>
                  {['Champ', 'Entité', 'Surface (ha)', 'Récolté (t)', 'Rendement'].map(h => (
                    <th key={h} style={{ padding: '.45rem .6rem', textAlign: 'left', fontSize: '.66rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key}>
                    <td style={{ ...tdL, fontWeight: 700 }}>{r.nom}</td>
                    <td style={tdL}>{r.groupMembers ? r.groupMembers.map(p => p.entite).filter(Boolean).join(' + ') : (r.entite || '–')}</td>
                    <td style={tdL}>{r.surface || '–'}</td>
                    <td style={tdL}>{(r.kg / 1000).toFixed(2)}</td>
                    <td style={{ ...tdL, fontWeight: 700, color }}>{r.surface > 0 ? ((r.kg / 100) / r.surface).toFixed(1) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ResteALivrerBloc({ titre, rdtQ, rows, color }) {
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: 'var(--green-deep)', padding: '.9rem 1.2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.5rem' }}>
        <span style={{ color: 'white', fontWeight: 700, fontSize: '1rem' }}>{titre}</span>
        <span style={{ color: 'white', fontSize: '.9rem' }}>
          Rendement : <strong>{rdtQ != null ? `${rdtQ.toFixed(1)} q/ha` : '—'}</strong>
        </span>
      </div>
      {rdtQ == null ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
          Pas encore de moisson enregistrée pour cette culture.
        </div>
      ) : (
        <>
        <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', padding: '.7rem 1.1rem 0' }}>
          "Reste estimé" = production estimée (surface × rendement) moins déjà livré — une projection. "Reste réel" = tonnage réellement contracté (vente, en cours) moins déjà livré — ce qui est vraiment dû.
        </div>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{ width: '100%', minWidth: 680, fontSize: '.82rem', borderCollapse: 'collapse' }}>
            <thead style={{ background: 'var(--cream)' }}>
              <tr>
                {['Entité', 'Surface (ha)', 'Estimé (t)', 'Contracté (t)', 'Livré (t)', 'Reste estimé (t)', 'Reste réel (t)'].map(h => (
                  <th key={h} style={{ padding: '.5rem .7rem', textAlign: 'left', fontSize: '.68rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.entite}>
                  <td style={{ ...tdL, fontWeight: 700 }}>{r.entite}</td>
                  <td style={tdL}>{r.surface.toFixed(2)}</td>
                  <td style={tdL}>{r.production != null ? r.production.toFixed(2) : '–'}</td>
                  <td style={tdL}>{r.contracte.toFixed(2)}</td>
                  <td style={tdL}>{r.livre.toFixed(2)}</td>
                  <td style={tdL}>{r.reste != null ? r.reste.toFixed(2) : '–'}</td>
                  <td style={{ ...tdL, fontWeight: 700, color: r.resteReel > 0 ? color : 'var(--green-mid)' }}>{r.resteReel.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--cream)', fontWeight: 700 }}>
                <td style={tdL}>TOTAL</td>
                <td style={tdL}>{rows.reduce((s, r) => s + r.surface, 0).toFixed(2)}</td>
                <td style={tdL}>{rows.reduce((s, r) => s + (r.production || 0), 0).toFixed(2)}</td>
                <td style={tdL}>{rows.reduce((s, r) => s + r.contracte, 0).toFixed(2)}</td>
                <td style={tdL}>{rows.reduce((s, r) => s + r.livre, 0).toFixed(2)}</td>
                <td style={tdL}>{rows.reduce((s, r) => s + (r.reste || 0), 0).toFixed(2)}</td>
                <td style={tdL}>{rows.reduce((s, r) => s + r.resteReel, 0).toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        </>
      )}
    </div>
  )
}

const PIE_PALETTE = ['#3968b3', '#8e44ad', '#16a085', '#c0392b', '#3d7a42']
const COOP_COLORS = ['#e8a33d', '#c77d1f']
const LIBRE_COLOR = '#9ca3af'

/* Camembert générique (donut SVG, sans lib externe) — un segment par acheteur
   engagé + un segment "Stock libre". */
function DonutChart({ segments, size = 150, thickness = 24 }) {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
        {total <= 0 ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
        ) : segments.filter(s => s.value > 0).map((s, i) => {
          const frac = s.value / total
          const dash = frac * c
          const el = (
            <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset} />
          )
          offset += dash
          return el
        })}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem', minWidth: 150 }}>
        {total <= 0 ? (
          <span style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>Aucune donnée</span>
        ) : segments.filter(s => s.value > 0).map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem' }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
            <strong>{s.value.toFixed(1)} t</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: '.68rem', minWidth: 32, textAlign: 'right' }}>({((s.value / total) * 100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* Stock engagé (vendu, par acheteur) vs stock stocké chez une coopérative (livré
   mais pas vendu) vs stock libre, pour une culture (Blé ou Orge). Chaque segment
   est annoté de sa catégorie pour ne pas confondre "vendu" et "stocké". */
/* Histogramme "Déjà sorti / Va sortir (engagé)" par culture — utilisé à la fois
   dans l'onglet Stock et dans l'onglet Stock physique (mêmes données, mêmes
   filtres, pas de duplication). */
function SortiEngageHisto({ histoFilter, setHistoFilter, commerceBle, commerceOrge }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.6rem', marginBottom: '.8rem' }}>
        <h3 style={{ fontSize: '.95rem' }}>Déjà sorti / Va sortir (engagé) par culture</h3>
        <div style={{ display: 'flex', background: 'var(--cream)', borderRadius: 999, padding: 2 }}>
          {[['both', 'Les deux'], ['sorti', '✅ Déjà sorti'], ['a_sortir', '🚚 Va sortir']].map(([k, l]) => (
            <button key={k} onClick={() => setHistoFilter(k)} style={{ border: 'none', cursor: 'pointer', borderRadius: 999, padding: '.35rem .8rem', fontSize: '.76rem', fontWeight: 600, background: histoFilter === k ? 'white' : 'transparent', boxShadow: histoFilter === k ? 'var(--shadow-xs)' : 'none' }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1rem', marginBottom: '1.4rem' }}>
        {[
          { titre: '🌾 Blé', color: '#c9922c', sorti: commerceBle.tonnageVendu, aSortir: commerceBle.tonnageEngage },
          { titre: '🌿 Orge', color: '#3d7a42', sorti: commerceOrge.tonnageVendu, aSortir: commerceOrge.tonnageEngage },
        ].map(g => {
          const bars = [
            ...(histoFilter !== 'a_sortir' ? [{ label: '✅ Déjà sorti', value: g.sorti, color: g.color }] : []),
            ...(histoFilter !== 'sorti' ? [{ label: '🚚 Va sortir (engagé)', value: g.aSortir, color: 'var(--amber)' }] : []),
          ]
          const max = Math.max(1, ...bars.map(b => b.value))
          return (
            <div key={g.titre} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.1rem' }}>
              <div style={{ fontWeight: 700, fontSize: '.9rem', marginBottom: '.9rem' }}>{g.titre}</div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1.2rem', height: 130 }}>
                {bars.map(b => (
                  <div key={b.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '.4rem', flex: 1 }}>
                    <span style={{ fontSize: '.82rem', fontWeight: 700, color: b.color }}>{b.value.toFixed(2)} t</span>
                    <div style={{ width: '100%', maxWidth: 70, height: Math.max(4, (b.value / max) * 90), borderRadius: '6px 6px 0 0', background: b.color, transition: 'height .4s' }} />
                    <span style={{ fontSize: '.72rem', color: 'var(--text-muted)', textAlign: 'center' }}>{b.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function StockCulturePie({ titre, color, stockPhysique, engagements, coopDetail = [], libre }) {
  const coopTotal = coopDetail.reduce((s, c) => s + c.tonnage, 0)
  const segments = [
    ...engagements.map((e, i) => ({ label: `${e.acheteur} — engagé (vendu)`, value: e.tonnage, color: PIE_PALETTE[i % PIE_PALETTE.length] })),
    ...coopDetail.map((c, i) => ({ label: `${c.coop} — stocké (non vendu)`, value: c.tonnage, color: COOP_COLORS[i % COOP_COLORS.length] })),
    { label: 'Stock libre (sur site, non engagé)', value: libre, color: LIBRE_COLOR },
  ]
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1rem 1.2rem' }}>
      <div style={{ fontWeight: 700, fontSize: '.95rem', marginBottom: '.2rem', color }}>{titre}</div>
      <div style={{ fontSize: '.76rem', color: 'var(--text-muted)', marginBottom: '.8rem' }}>
        Stock physique sur site : {stockPhysique.toFixed(2)} t{coopTotal > 0 ? ` + ${coopTotal.toFixed(2)} t chez les coopératives` : ''}
      </div>
      <DonutChart segments={segments} />
    </div>
  )
}

function CommerceBloc({ titre, data, color, coopStockeT = 0, venduParAcheteurRows = [], onEditVenteRow, onEditContrat, onNewContrat }) {
  const { tonnageVendu, prixVendu, tonnageEngage, venteRows, contratsRows, semenceT = 0 } = data
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ background: 'var(--green-deep)', padding: '.9rem 1.2rem' }}>
        <span style={{ color: 'white', fontWeight: 700, fontSize: '1rem' }}>{titre}</span>
      </div>
      <div style={{ padding: '.9rem 1.1rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.6rem', marginBottom: '1.1rem' }}>
          {[
            { label: 'Tonnage expédié', value: `${tonnageVendu.toFixed(2)} t` },
            { label: 'Prix moyen expédié', value: prixVendu != null ? `${prixVendu.toFixed(2)} €/t` : '—' },
            { label: 'Tonnage engagé (restant)', value: `${tonnageEngage.toFixed(2)} t` },
            { label: 'Stocké chez coopératives', value: `${coopStockeT.toFixed(2)} t` },
            ...(semenceT > 0 ? [{ label: '🌾 Semences (usage interne, hors ventes)', value: `${semenceT.toFixed(2)} t` }] : []),
          ].map(k => (
            <div key={k.label} style={{ background: 'var(--cream)', borderRadius: 9, padding: '.55rem .8rem', borderTop: `3px solid ${color}` }}>
              <div style={{ fontSize: '.6rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
              <div style={{ fontSize: '.92rem', fontWeight: 700, color: 'var(--ink)' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {venduParAcheteurRows.length > 0 && (
          <>
            <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '.4rem' }}>Tonnage expédié par acheteur</div>
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: '1.1rem' }}>
              <table style={{ width: '100%', minWidth: 320, fontSize: '.8rem', borderCollapse: 'collapse' }}>
                <thead style={{ background: 'var(--cream)' }}>
                  <tr>
                    {['Acheteur', 'Tonnage (t)'].map(h => (
                      <th key={h} style={{ padding: '.4rem .6rem', textAlign: 'left', fontSize: '.64rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {venduParAcheteurRows.map(r => (
                    <tr key={r.acheteur}>
                      <td style={tdL}>{r.acheteur}</td>
                      <td style={{ ...tdL, fontWeight: 700, color }}>{r.tonnage.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <>
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.4rem' }}>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>Contrats en cours</div>
                {onNewContrat && <button className="btn-sm" onClick={onNewContrat} style={{ fontSize: '.72rem', padding: '.25rem .6rem' }}>+ Nouveau contrat</button>}
              </div>
              {contratsRows.length > 0 && (
                <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: '1.1rem' }}>
                  <table style={{ width: '100%', minWidth: 420, fontSize: '.8rem', borderCollapse: 'collapse' }}>
                    <thead style={{ background: 'var(--cream)' }}>
                      <tr>
                        {['Tiers', 'Contracté (t)', 'Livré (t)', 'Reste (t)', 'Prix (€/t)'].map(h => (
                          <th key={h} style={{ padding: '.4rem .6rem', textAlign: 'left', fontSize: '.64rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {contratsRows.map(c => (
                        <tr key={c.id} onClick={() => onEditContrat?.(c)} style={{ cursor: onEditContrat ? 'pointer' : 'default' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                          onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <td style={tdL}>{c.tiers_nom || '–'}</td>
                          <td style={tdL}>{(c.tonnage_contracte || 0).toFixed(2)}</td>
                          <td style={tdL}>{c.livre.toFixed(2)}</td>
                          <td style={{ ...tdL, fontWeight: 700, color }}>{c.reste.toFixed(2)}</td>
                          <td style={tdL}>{c.prix_contracte != null ? c.prix_contracte.toFixed(2) : '–'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>

            {venteRows.length > 0 && (
              <>
                <div style={{ fontSize: '.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '.4rem' }}>Expéditions déjà effectuées</div>
                <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <table style={{ width: '100%', minWidth: 420, fontSize: '.8rem', borderCollapse: 'collapse' }}>
                    <thead style={{ background: 'var(--cream)' }}>
                      <tr>
                        {['Date', 'Client', 'Quantité (t)', 'Prix (€/t)'].map(h => (
                          <th key={h} style={{ padding: '.4rem .6rem', textAlign: 'left', fontSize: '.64rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {venteRows.map(l => {
                        const prix = l.prix_ht ?? l.contrat?.prix_contracte ?? null
                        return (
                          <tr key={l.id} onClick={() => onEditVenteRow?.(l)} style={{ cursor: onEditVenteRow ? 'pointer' : 'default' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}>
                            <td style={tdL}>{fmtDate(l.date)}</td>
                            <td style={tdL}>{l.direct ? `🚚 ${l.lieuLivraison}` : (l.contrat?.tiers_nom || l.client_nom_libre || '–')}</td>
                            <td style={{ ...tdL, fontWeight: 700 }}>{(l.quantite || 0).toFixed(2)}</td>
                            <td style={tdL}>{prix != null ? prix.toFixed(2) : '–'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {contratsRows.length === 0 && venteRows.length === 0 && (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
                Aucune expédition ni contrat en cours pour cette culture.
              </div>
            )}
        </>
      </div>
    </div>
  )
}
