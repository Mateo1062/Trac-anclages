import { supabase } from './supabase'

// Journal des congés — une ligne par création/suppression, saisie depuis le Planning
// ou depuis Global GAP, pour garder une trace de qui a posé quoi et quand.
export async function logCongeHistorique({ conge_id, salarie_id, action, type, date_debut, date_fin, source }) {
  await supabase.from('conges_historique').insert({ conge_id, salarie_id, action, type, date_debut, date_fin, source })
}
