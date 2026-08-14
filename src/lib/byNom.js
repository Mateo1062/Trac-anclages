// Tri alphabétique français des dossiers agriculteurs (partagé avec Plants PDT)
export const byNom = (a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr', { sensitivity: 'base', numeric: true })
