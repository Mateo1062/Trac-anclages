// Permissions par rôle — au-delà des rôles historiques (admin, manager, operateur,
// frigo) déjà gérés dans AuthContext, ce fichier centralise les rôles à accès
// restreint attribués à des employés précis (onglets masqués, lecture seule,
// fonctionnalités cachées). Un seul et même rôle peut être réutilisé pour
// plusieurs employés ayant exactement le même profil d'accès.
export const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  operateur: 'Opérateur',
  frigo: 'Frigo (accès restreint)',
  pont_bascule: 'Pont bascule (frigos en lecture seule)',
  agricole_champ: 'Agricole — champs (Antony)',
  agricole_champ_basique: 'Agricole — champs limité (Kylian)',
  agricole_champ_arrachage: 'Agricole — champs limité + heures d\'arrachage (Victor/Jules)',
  export_lecture: 'Export — lecture restreinte (Morgan/Thierry)',
  export_lecture_dashboard: 'Export — lecture restreinte + tableau de bord (Vivien/Samuel)',
  export_fp_legumes: 'Export — Planning FP Légumes lecture seule (Xavier)',
}

export const ROLES = Object.keys(ROLE_LABELS)

const EMPTY_PERMS = {}

const ROLE_PERMISSIONS = {
  operateur: {
    outilsRestreint: true, // pas d'édition dossier/coûts, ajout d'intervention uniquement — seul le coût est restreint ici, le reste de l'accès d'operateur reste inchangé
  },
  // Même accès qu'un opérateur partout, sauf les Frigos qui restent consultables mais
  // jamais modifiables (ni les lots, ni les cases, ni la forme des frigos).
  pont_bascule: {
    frigosReadOnly: true,
  },
  agricole_champ: {
    workspaces: ['agricole'],
    hiddenSections: ['stock-interventions', 'commande-phyto', 'engrais', 'cout-revient', 'cereales', 'recolte-pdt', 'mesparcelles'],
    parcellesReadOnly: true,
    carteHeuresArrachage: true,
    plantsPdtStockOnly: true,
    outilsRestreint: true,
    databaseAgricolePhytoReadOnlyOnly: true,
    frigosNoNouveauFrigo: true, // accès au plan des frigos, mais pas au mode Modeler (ajout/suppression de cases) — réservé aux admins
  },
  agricole_champ_basique: {
    workspaces: ['agricole'],
    hiddenSections: ['stock-interventions', 'commande-phyto', 'engrais', 'cout-revient', 'cereales', 'recolte-pdt', 'plants-pdt', 'database-agricole', 'mesparcelles'],
    parcellesReadOnly: true,
    carteHeuresArrachage: false,
    outilsRestreint: true,
    frigosNoNouveauFrigo: true,
  },
  // Identique à agricole_champ_basique, mais avec l'accès aux heures d'arrachage sur la
  // carte (Victor/Jules) — rôle séparé pour ne pas l'activer aussi pour Kylian, qui
  // partage sinon exactement le même profil d'accès restreint.
  agricole_champ_arrachage: {
    workspaces: ['agricole'],
    hiddenSections: ['stock-interventions', 'commande-phyto', 'engrais', 'cout-revient', 'cereales', 'recolte-pdt', 'plants-pdt', 'database-agricole', 'mesparcelles'],
    parcellesReadOnly: true,
    carteHeuresArrachage: true,
    outilsRestreint: true,
    frigosNoNouveauFrigo: true,
  },
  export_lecture: {
    workspaces: ['export', 'agricole'],
    hiddenSections: [
      'gazage', 'meteo-export', 'sorties', 'agri-tiers', 'global-gap', 'database-export',
      'dashboard-agricole', // pas pertinent pour ce rôle — voir export_lecture_dashboard ci-dessous
      'stock-interventions', 'meteo-agricole', 'parcelle-carte',
      'cereales', 'recolte-pdt', 'commande-phyto', 'engrais', 'cout-revient', 'database-agricole', 'mesparcelles',
    ],
    planningReadOnly: true,
    // Exception au planning en lecture seule : peuvent quand même marquer un
    // chargement "préparé" (📦) et "validé" (✅) — les deux seuls boutons
    // d'action qui leur restent malgré planningReadOnly.
    planningCanPrepareValide: true,
    planningHideExterne: true, // chargements extérieurs (lieux + RDV correspondants), MC Cain, confirmations, sorties camion
    frigosNoNouveauFrigo: true, // le mode Modeler (ajout/suppression de cases) est déjà réservé aux admins
    plantsPdtStockOnly: true,
  },
  // Identique à export_lecture, mais avec accès au Tableau de bord (même interface que
  // les managers) — rôle séparé pour ne pas l'activer aussi pour Morgan/Thierry, qui
  // partagent sinon exactement le même profil restreint.
  export_lecture_dashboard: {
    workspaces: ['export', 'agricole'],
    hiddenSections: [
      'gazage', 'meteo-export', 'sorties', 'agri-tiers', 'global-gap', 'database-export',
      'stock-interventions', 'meteo-agricole', 'parcelle-carte',
      'cereales', 'recolte-pdt', 'commande-phyto', 'engrais', 'cout-revient', 'database-agricole', 'mesparcelles',
    ],
    planningReadOnly: true,
    planningCanPrepareValide: true,
    planningHideExterne: true,
    frigosNoNouveauFrigo: true,
    plantsPdtStockOnly: true,
  },
  // Accès unique : Planning, en lecture seule, limité aux chargements dont le lieu
  // de chargement est "FP Légumes" (voir planningOnlyLieuNom dans Planning.jsx) —
  // rien d'autre dans l'appli n'est accessible. Peut quand même marquer un
  // chargement préparé/validé et joindre la CMR en photo une fois effectué.
  export_fp_legumes: {
    workspaces: ['export'],
    hiddenSections: [
      'dashboard-export', 'frigos', 'gazage', 'meteo-export',
      'sorties', 'agri-tiers', 'global-gap', 'database-export', 'heures-salaries',
    ],
    planningReadOnly: true,
    planningCanPrepareValide: true,
    planningOnlyLieuNom: 'FP Légumes',
    planningCanUploadCmr: true,
  },
}

export function getPerms(role) {
  return ROLE_PERMISSIONS[role] || EMPTY_PERMS
}
