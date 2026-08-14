// Reconnaissance des familles de culture à partir du code RPG/Telepac
// (culture_actuelle des parcelles) ou d'un libellé libre.

const PDT_CODES = new Set(['PTC', 'PPH', 'PTF'])
// Uniquement les blés et les orges (l'escourgeon est une orge d'hiver).
const CEREAL_CODES = new Set([
  'BTH', 'BTP', 'BDH', 'BDP', // blé tendre / dur, hiver / printemps
  'ORH', 'ORP', 'ESC',        // orge hiver / printemps, escourgeon
])

export function isPdtCulture(culture) {
  const t = (culture || '').trim().toUpperCase()
  if (PDT_CODES.has(t)) return true
  return /pomme.*terre|\bpdt\b/i.test(culture || '')
}

export function isCerealCulture(culture) {
  const t = (culture || '').trim().toUpperCase()
  if (CEREAL_CODES.has(t)) return true
  return /bl[ée]|orge|escourgeon/i.test(culture || '')
}

// Cultures pour lesquelles on saisit des produits phyto + doses/ha (Commande
// Phyto) : blé, orge (dont orge d'hiver/escourgeon), maïs, betteraves, PDT.
// Les cultures créées depuis les parcelles portent leur CODE (ex. "BTH"), pas
// leur nom en toutes lettres — il faut donc reconnaître les codes eux-mêmes,
// pas seulement un texte libre "Blé tendre".
const DOSABLE_CODES = new Set([...CEREAL_CODES, 'MIS', 'MIE', 'MID', 'BTN', ...PDT_CODES])
export function isDosableCulture(culture) {
  const t = (culture || '').trim().toUpperCase()
  if (DOSABLE_CODES.has(t)) return true
  return /bl[ée]|orge|escourgeon|ma[iï]s|betterave|pomme.*terre|\bpdt\b/i.test(culture || '')
}

// Une parcelle correspond-elle au libellé de culture choisi (ex. "Blé tendre",
// "Orge d'hiver") ? Compare le libellé aux codes RPG de la parcelle ET à son
// texte libre — utilisé pour filtrer les parcelles dans la saisie moisson.
const CULTURE_LABEL_RULES = [
  { test: /escourgeon/i,               codes: ['ESC'],                     regex: /escourgeon/i },
  { test: /orge.*hiver/i,              codes: ['ORH', 'ESC'],              regex: /orge.*hiver|escourgeon/i },
  { test: /orge.*print/i,              codes: ['ORP'],                     regex: /orge.*print/i },
  { test: /orge/i,                     codes: ['ORH', 'ORP', 'ESC'],       regex: /orge|escourgeon/i },
  { test: /bl[ée].*dur/i,              codes: ['BDH', 'BDP'],              regex: /bl[ée].*dur/i },
  { test: /bl[ée]/i,                   codes: ['BTH', 'BTP', 'BDH', 'BDP'], regex: /bl[ée]/i },
  { test: /ma[iï]s/i,                  codes: ['MIS', 'MIE', 'MID'],       regex: /ma[iï]s/i },
  { test: /colza/i,                    codes: ['CZH', 'CZP'],              regex: /colza/i },
  { test: /tournesol/i,                codes: ['TRN'],                     regex: /tournesol/i },
  { test: /betterave/i,               codes: ['BTN'],                     regex: /betterave/i },
  { test: /pomme.*terre|\bpdt\b/i,     codes: ['PTC', 'PPH', 'PTF'],       regex: /pomme.*terre|\bpdt\b/i },
  { test: /luzerne/i,                  codes: ['LUZ'],                     regex: /luzerne/i },
  { test: /pois/i,                     codes: ['PPR', 'PHI'],              regex: /pois/i },
  { test: /f[ée]verole/i,              codes: ['FVL', 'FVR'],              regex: /f[ée]verole/i },
  { test: /avoine/i,                   codes: ['AVH', 'AVP'],              regex: /avoine/i },
  { test: /seigle/i,                   codes: ['SGH', 'SGP'],              regex: /seigle/i },
  { test: /triticale/i,                codes: ['TTH', 'TTP'],              regex: /triticale/i },
]
// Icône représentative d'une culture (popup carte, listes…) — évite d'afficher
// 🥔 pour tout le monde quel que soit la culture réelle de la parcelle.
const CULTURE_ICON_RULES = [
  { codes: ['PTC', 'PPH', 'PTF'],                                      test: /pomme.*terre|\bpdt\b/i,        icon: '🥔' },
  { codes: ['BTH', 'BTP', 'BDH', 'BDP', 'ORH', 'ORP', 'ESC', 'AVH', 'AVP', 'SGH', 'SGP', 'TTH', 'TTP'],
                                                                        test: /bl[ée]|orge|escourgeon|avoine|seigle|triticale/i, icon: '🌾' },
  { codes: ['MIS', 'MIE', 'MID'],                                      test: /ma[iï]s/i,                     icon: '🌽' },
  { codes: ['BTN'],                                                    test: /betterave/i,                   icon: '🟤' },
  { codes: ['CZH', 'CZP'],                                             test: /colza/i,                       icon: '🌼' },
  { codes: ['TRN'],                                                    test: /tournesol/i,                   icon: '🌻' },
  { codes: ['OIG'],                                                    test: /oignon|[ée]chalote/i,          icon: '🧅' },
  { codes: ['LUZ'],                                                    test: /luzerne/i,                     icon: '🍀' },
  { codes: ['JAC'],                                                    test: /jach[eè]re/i,                  icon: '🟫' },
  { codes: ['PPR', 'PHI'],                                             test: /pois/i,                        icon: '🟢' },
  { codes: ['FVL', 'FVR'],                                             test: /f[ée]verole/i,                 icon: '🟢' },
]
export function cultureIcon(culture) {
  const t = (culture || '').trim().toUpperCase()
  if (!t) return null
  const rule = CULTURE_ICON_RULES.find(r => r.codes.includes(t) || r.test.test(culture || ''))
  return rule?.icon || '🌱'
}

// Couleur fixe par culture (carte + légende) — chaque code garde toujours la
// même couleur, pour repérer les parcelles d'un coup d'œil sans se fier à
// l'ordre d'affichage. Les codes non répertoriés reçoivent une couleur de
// repli déterministe (toujours la même pour un même code inconnu).
const CULTURE_COLOR_MAP = {
  BTH: '#d4a017', BTP: '#d4a017', BDH: '#b5890a', BDP: '#b5890a', // blé — doré
  ORH: '#8bc34a', ORP: '#558b2f', ESC: '#33691e',                  // orge — verts
  AVH: '#a1887f', AVP: '#a1887f',                                  // avoine
  SGH: '#795548', SGP: '#795548',                                  // seigle
  TTH: '#6d4c41', TTP: '#6d4c41',                                  // triticale
  MIS: '#f39c12', MIE: '#f39c12', MID: '#f39c12',                  // maïs — orange
  BTN: '#8e44ad',                                                  // betterave — violet
  PTC: '#3498db', PPH: '#2980b9', PTF: '#1f618d',                  // pomme de terre — bleus
  JAC: '#95a5a6',                                                  // jachère — gris
  OIG: '#e74c3c',                                                  // oignon — rouge
  CZH: '#f1c40f', CZP: '#f1c40f',                                  // colza — jaune vif
  TRN: '#e67e22',                                                  // tournesol — orange foncé
  LUZ: '#27ae60',                                                  // luzerne — vert soutenu
  PPR: '#2ecc71', PHI: '#2ecc71',                                  // pois
  FVL: '#16a085', FVR: '#16a085',                                  // féverole
  BOR: '#7f8c8d', SNE: '#bdc3c7', BTA: '#00838f',
}
const CULTURE_COLOR_FALLBACK = ['#3fc95c', '#3498db', '#e67e22', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#2980b9']
export function cultureColor(culture) {
  const t = (culture || '').trim().toUpperCase()
  if (!t) return CULTURE_COLOR_FALLBACK[0]
  if (CULTURE_COLOR_MAP[t]) return CULTURE_COLOR_MAP[t]
  // Hash simple et stable du code -> même couleur de repli à chaque fois pour ce code.
  let hash = 0
  for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) | 0
  return CULTURE_COLOR_FALLBACK[Math.abs(hash) % CULTURE_COLOR_FALLBACK.length]
}

export function parcelleMatchesCulture(cultureLabel, parcelleCulture) {
  const label = (cultureLabel || '').trim()
  if (!label) return true // pas de culture choisie → pas de filtre
  const code = (parcelleCulture || '').trim().toUpperCase()
  const rule = CULTURE_LABEL_RULES.find(r => r.test.test(label))
  if (rule) return rule.codes.includes(code) || rule.regex.test(parcelleCulture || '')
  // Libellé inconnu : simple correspondance texte
  return (parcelleCulture || '').toLowerCase().includes(label.toLowerCase())
}
