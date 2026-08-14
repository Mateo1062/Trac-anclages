// Codes culture RPG (Registre Parcellaire Graphique / Télépac) rencontrés dans
// les exports Dossier PAC. On garde le code tel quel dans les données (comme
// dans le document officiel), et on affiche son libellé français à côté via
// une légende, plutôt que de réécrire les données.
export const RPG_CODE_LABELS = {
  BTH: 'Blé tendre d\'hiver',
  BTP: 'Blé tendre de printemps',
  BDH: 'Blé dur d\'hiver',
  BDP: 'Blé dur de printemps',
  ORH: 'Orge d\'hiver',
  ORP: 'Orge de printemps',
  MIS: 'Maïs (grain et ensilage)',
  BTN: 'Betterave non fourragère (sucrière)',
  PTC: 'Prairie temporaire (5 ans ou moins)',
  PPH: 'Prairie permanente — herbe prédominante',
  JAC: 'Jachère',
  OIG: 'Oignon, échalote',
  CZH: 'Colza d\'hiver',
  TRN: 'Tournesol',
  PDT: 'Pomme de terre',
}

// Ne traduit que les codes reconnus avec certitude — un code non répertorié
// est affiché tel quel plutôt que de risquer une traduction fausse.
export function rpgLabel(code) {
  return RPG_CODE_LABELS[code] || null
}
