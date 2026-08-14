// Campagne agricole française : 1er août -> 31 juillet (ex. "2026-2027" court du
// 1er août 2026 au 31 juillet 2027). Avant août on est encore dans la campagne
// commencée l'été précédent.
export function defaultCampagne() {
  const now = new Date()
  const y = now.getFullYear()
  return now.getMonth() + 1 >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`
}

// Même règle (1er août -> 31 juillet), appliquée à une date arbitraire — pour
// classer un enregistrement historique dans la bonne campagne à partir de sa
// propre date plutôt que la date du jour.
export function campagneForDate(dateStr) {
  const d = new Date(dateStr)
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  return m >= 8 ? `${y}-${y + 1}` : `${y - 1}-${y}`
}

// Construit la liste des campagnes disponibles à partir de celles déjà présentes
// dans les données + la campagne courante (toujours proposée, même sans saisie).
export function campagnesDisponibles(rows) {
  const set = new Set(rows.map(r => r.campagne).filter(Boolean))
  set.add(defaultCampagne())
  return [...set].sort().reverse()
}

// Année de départ d'une campagne ("2023-2024" -> 2023) — sert à les comparer
// chronologiquement (une campagne "2023-2024" est bien avant "2024-2025").
export function startYear(campagne) {
  return parseInt((campagne || '').split('-')[0], 10) || 0
}

// Règle globale de l'appli : en se plaçant sur une campagne passée, on ne doit
// jamais voir apparaître des données saisies dans une campagne ultérieure (ex.
// un stock cumulé ne doit pas inclure une consommation qui a eu lieu après la
// campagne consultée). À utiliser pour tout ce qui est cumulatif dans le temps
// (stocks, totaux courants) — PAS pour un historique d'événements propre à une
// seule campagne, où une simple égalité stricte suffit et est déjà correcte.
export function isAtOrBeforeCampagne(campagne, campagneActive) {
  return startYear(campagne) <= startYear(campagneActive)
}
