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
}

export function getPerms(role) {
  return ROLE_PERMISSIONS[role] || EMPTY_PERMS
}
