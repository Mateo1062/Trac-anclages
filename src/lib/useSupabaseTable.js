import { useState, useEffect, useCallback } from 'react'
import { supabase } from './supabase'

/**
 * Generic CRUD hook for a Supabase table.
 * Returns: { items, loading, reload, create, update, remove }
 */
export function useSupabaseTable(table, orderBy = 'created_at') {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from(table).select('*').order(orderBy)
    if (error) console.error(`Erreur chargement ${table}:`, error)
    setItems(data || [])
    setLoading(false)
  }, [table, orderBy])

  useEffect(() => { reload() }, [reload])

  async function create(payload) {
    const { data, error } = await supabase.from(table).insert(payload).select().single()
    if (error) throw error
    setItems(prev => [...prev, data])
    return data
  }

  async function update(id, payload) {
    const { error } = await supabase.from(table).update(payload).eq('id', id)
    if (error) throw error
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...payload } : it))
  }

  async function remove(id) {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) throw error
    setItems(prev => prev.filter(it => it.id !== id))
  }

  return { items, loading, reload, create, update, remove }
}
