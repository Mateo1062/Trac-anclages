import { createClient } from '@supabase/supabase-js'
import { createOfflineFetch } from './offlineFetch'

const SUPABASE_URL = 'https://gzyteuuttgiuyefholhj.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd6eXRldXV0dGdpdXllZmhvbGhqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2NTQxMzEsImV4cCI6MjA5NzIzMDEzMX0.qXVQCTuvGSYpkriuJ8mlM8wjytNSjp3mpNGNQJub8tU'

// Le fetch personnalisé rend le hors-ligne transparent pour tout le code
// existant : chaque `supabase.from(...)` continue de s'écrire pareil, mais
// passe désormais par une file d'attente + un cache IndexedDB quand le
// réseau est indisponible (voir src/lib/offlineFetch.js).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: createOfflineFetch() },
})
