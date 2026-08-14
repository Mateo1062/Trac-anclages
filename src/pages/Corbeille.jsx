import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useToast } from '../lib/useToast'
import { fmtDate } from '../lib/formatDate'

// Corbeille : chaque suppression sur une table sensible (voir
// migration_A_EXECUTER_80.sql — trigger archiver_avant_suppression) est
// archivée ici avant d'être effacée pour de bon. Toutes les lignes d'un même
// DELETE (même transaction) partagent exactement le même supprime_le — on les
// regroupe donc en "lots" restaurables d'un coup, plutôt que ligne par ligne.
const TABLE_LABELS = {
  interventions_phyto: '🧪 Interventions phyto/travaux',
  cereales_contrats: '🌾 Céréales — Contrats',
  cereales_livraisons: '🌾 Céréales — Livraisons',
  cr_fiches: '📊 Coût de revient — Fiches',
  cr_lignes: '📊 Coût de revient — Lignes',
  db_phyto: '🧪 Base de données — Phyto',
  db_intrants: '🌱 Base de données — Intrants',
  parcelles: '🗺️ Parcelles',
}

export default function Corbeille() {
  const { showToast, ToastEl } = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('corbeille').select('*').order('supprime_le', { ascending: false }).limit(5000)
    if (error && /relation .corbeille. does not exist|does not exist/i.test(error.message)) {
      setRows(null) // migration pas encore exécutée
    } else {
      setRows(data || [])
    }
    setLoading(false)
  }

  // Regroupe par (table_nom, supprime_le exact) = un seul DELETE d'origine.
  const groups = rows ? (() => {
    const map = new Map()
    for (const r of rows) {
      const key = `${r.table_nom}|${r.supprime_le}`
      if (!map.has(key)) map.set(key, { table_nom: r.table_nom, supprime_le: r.supprime_le, items: [] })
      map.get(key).items.push(r)
    }
    return [...map.values()].sort((a, b) => (b.supprime_le || '').localeCompare(a.supprime_le || ''))
  })() : []

  async function restoreBatch(g) {
    const key = `${g.table_nom}|${g.supprime_le}`
    if (!confirm(`Restaurer ${g.items.length} ligne(s) dans "${TABLE_LABELS[g.table_nom] || g.table_nom}" ?`)) return
    setBusyKey(key)
    try {
      const rowsData = g.items.map(it => it.row_data)
      // Par lots de 500 pour éviter une requête trop grosse (idem migrations précédentes).
      for (let i = 0; i < rowsData.length; i += 500) {
        const chunk = rowsData.slice(i, i + 500)
        let { error } = await supabase.from(g.table_nom).insert(chunk)
        // produit_id (interventions_phyto) peut référencer un produit supprimé depuis
        // l'archivage — on retente sans le lien plutôt que de bloquer toute la restauration.
        if (error && g.table_nom === 'interventions_phyto' && /produit_id|foreign key|fkey/i.test(error.message)) {
          ;({ error } = await supabase.from(g.table_nom).insert(chunk.map(r => ({ ...r, produit_id: null }))))
        }
        if (error) throw error
      }
      const ids = g.items.map(it => it.id)
      await supabase.from('corbeille').delete().in('id', ids)
      setRows(prev => prev.filter(r => !ids.includes(r.id)))
      showToast(`♻️ ${g.items.length} ligne(s) restaurée(s)`)
    } catch (e) {
      alert("Échec de la restauration : " + e.message + "\n\nSi l'erreur mentionne une colonne ou une clé déjà existante, une partie a peut-être déjà été restaurée manuellement.")
    } finally {
      setBusyKey(null)
    }
  }

  async function restoreOne(r) {
    if (!confirm('Restaurer cette ligne ?')) return
    setBusyKey(r.id)
    try {
      let { error } = await supabase.from(r.table_nom).insert(r.row_data)
      if (error && r.table_nom === 'interventions_phyto' && /produit_id|foreign key|fkey/i.test(error.message)) {
        ;({ error } = await supabase.from(r.table_nom).insert({ ...r.row_data, produit_id: null }))
      }
      if (error) throw error
      await supabase.from('corbeille').delete().eq('id', r.id)
      setRows(prev => prev.filter(x => x.id !== r.id))
      showToast('♻️ Ligne restaurée')
    } catch (e) {
      alert('Échec de la restauration : ' + e.message)
    } finally {
      setBusyKey(null)
    }
  }

  async function purgeBatch(g) {
    if (!confirm(`Supprimer définitivement ${g.items.length} ligne(s) de la corbeille (irréversible) ?`)) return
    const ids = g.items.map(it => it.id)
    await supabase.from('corbeille').delete().in('id', ids)
    setRows(prev => prev.filter(r => !ids.includes(r.id)))
    showToast('🗑️ Lot purgé définitivement')
  }

  function toggle(key) {
    setExpanded(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  function summarize(row_data) {
    const parts = []
    if (row_data.date) parts.push(fmtDate(row_data.date))
    if (row_data.nom) parts.push(row_data.nom)
    if (row_data.parcelle) parts.push(row_data.parcelle)
    if (row_data.produit_nom) parts.push(row_data.produit_nom)
    if (row_data.observation) parts.push(row_data.observation)
    if (row_data.tiers_nom) parts.push(row_data.tiers_nom)
    return parts.filter(Boolean).join(' · ') || `id ${row_data.id?.slice(0, 8) || '?'}`
  }

  if (loading) return <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)' }}>Chargement…</div>

  if (rows === null) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem 1.8rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '.8rem' }}>🗑️ Corbeille</h2>
        <div style={{ background: '#fff8e8', border: '1px solid var(--amber)', borderRadius: 12, padding: '1rem 1.2rem', fontSize: '.85rem', color: 'var(--amber)' }}>
          ⚠️ La table de corbeille n'existe pas encore — exécute <code>migration_A_EXECUTER_80.sql</code> dans l'éditeur SQL de Supabase pour l'activer. Une fois exécutée, toute suppression future sur les tables sensibles (interventions, contrats céréales, coût de revient, base de données, parcelles) sera automatiquement archivée ici avant d'être effacée pour de bon.
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem 1.8rem' }}>
      {ToastEl}
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>🗑️ Corbeille</h2>
        <p style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginTop: '.2rem' }}>
          Chaque suppression sur les tables sensibles est archivée ici avant d'être effacée — restaurable en un clic. Les lignes supprimées en une seule fois (ex. un DELETE en masse) sont regroupées en un seul lot.
        </p>
      </div>

      {groups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2.5rem', background: 'white', borderRadius: 12, border: '2px dashed var(--border)', color: 'var(--text-muted)' }}>
          Corbeille vide — aucune suppression récente.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
          {groups.map(g => {
            const key = `${g.table_nom}|${g.supprime_le}`
            const isOpen = expanded.has(key)
            const busy = busyKey === key
            return (
              <div key={key} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '.8rem 1rem', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 220px' }}>
                    <div style={{ fontWeight: 700, fontSize: '.88rem' }}>{TABLE_LABELS[g.table_nom] || g.table_nom}</div>
                    <div style={{ fontSize: '.76rem', color: 'var(--text-muted)' }}>
                      {g.items.length} ligne{g.items.length > 1 ? 's' : ''} · supprimé le {new Date(g.supprime_le).toLocaleString('fr-FR')}
                    </div>
                  </div>
                  <button className="btn-sm" onClick={() => toggle(key)}>{isOpen ? '▾ Détail' : '▸ Détail'}</button>
                  <button className="btn-sm primary" onClick={() => restoreBatch(g)} disabled={busy}>
                    {busy ? '⏳…' : `♻️ Tout restaurer (${g.items.length})`}
                  </button>
                  <button className="btn-sm danger" onClick={() => purgeBatch(g)} disabled={busy}>🗑️ Purger</button>
                </div>
                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', background: 'var(--cream)', maxHeight: 300, overflowY: 'auto' }}>
                    {g.items.map(it => (
                      <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.5rem .9rem', borderBottom: '1px solid var(--border)', fontSize: '.8rem' }}>
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summarize(it.row_data)}</span>
                        <button className="btn-sm" onClick={() => restoreOne(it)} disabled={busyKey === it.id}>
                          {busyKey === it.id ? '⏳' : '♻️ Restaurer'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
