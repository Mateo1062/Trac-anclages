import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { supabase } from './supabase'
import { defaultCampagne } from './campagne'

// Tables portant un champ `campagne` — sert à découvrir toutes les campagnes
// connues dès le démarrage de l'appli, plutôt que d'attendre qu'une page les
// signale elle-même via registerCampagnes(). Sans ça, arriver directement sur
// une page qui n'a rien à enregistrer (ex. Tableau de bord) ne proposait que la
// campagne courante dans le sélecteur, tant qu'aucune autre page n'avait été
// visitée.
const CAMPAGNE_TABLES = [
  'parcelles', 'interventions_phyto', 'cereales_moisson', 'cereales_livraisons',
  'cereales_contrats', 'pdt_recolte_pesees', 'cp_surfaces', 'cp_lignes', 'cp_offres',
  'engrais_apports', 'contrats',
]

// Campagne active globale — un seul sélecteur pour toute l'appli (menu
// principal) au lieu d'un sélecteur par onglet. Les pages qui utilisaient
// jusqu'ici leur propre `useState(defaultCampagne())` lisent maintenant
// cette valeur partagée via `useCampagne()`.
//
// `registerCampagnes` permet à chaque page, une fois ses données chargées,
// de signaler les campagnes qu'elle connaît (issues des données existantes)
// sans qu'il soit nécessaire de faire une requête coûteuse sur toutes les
// tables au démarrage de l'appli — la liste se complète progressivement.
const CampagneContext = createContext(null)

// Campagne affichée par défaut à l'ouverture de l'appli — volontairement figée
// (pas `defaultCampagne()`, qui calcule la campagne du jour) : l'appli ne doit
// jamais changer de campagne active toute seule au fil des jours/mois, ce qui a
// déjà causé une confusion (données 2025-2026 qui semblaient avoir disparu le
// jour où `defaultCampagne()` a basculé sur 2026-2027 au 1er août). L'utilisateur
// choisit lui-même quand passer à la campagne suivante via le sélecteur —
// à cette occasion-là seulement, mettre à jour cette valeur.
const DEFAULT_CAMPAGNE_AU_DEMARRAGE = '2025-2026'

export function CampagneProvider({ children }) {
  const [campagneActive, setCampagneActive] = useState(DEFAULT_CAMPAGNE_AU_DEMARRAGE)
  const [knownCampagnes, setKnownCampagnes] = useState(() => new Set([DEFAULT_CAMPAGNE_AU_DEMARRAGE, defaultCampagne()]))

  const registerCampagnes = useCallback((list) => {
    if (!list || !list.length) return
    setKnownCampagnes(prev => {
      let changed = false
      const next = new Set(prev)
      for (const c of list) { if (c && !next.has(c)) { next.add(c); changed = true } }
      return changed ? next : prev
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all(CAMPAGNE_TABLES.map(async table => {
      try {
        const { data, error } = await supabase.from(table).select('campagne').not('campagne', 'is', null)
        if (error) return []
        return (data || []).map(r => r.campagne)
      } catch {
        return []
      }
    })).then(results => { if (!cancelled) registerCampagnes(results.flat()) })
    return () => { cancelled = true }
  }, [registerCampagnes])

  const campagnesListe = [...knownCampagnes].sort().reverse()

  return (
    <CampagneContext.Provider value={{ campagneActive, setCampagneActive, campagnesListe, registerCampagnes }}>
      {children}
    </CampagneContext.Provider>
  )
}

export function useCampagne() {
  return useContext(CampagneContext)
}
