import { createClient } from '@supabase/supabase-js'
import { createOfflineFetch } from './offlineFetch'

const SUPABASE_URL = 'https://ofmikroavbdhquckfkkx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbWlrcm9hdmJkaHF1Y2tma2t4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2ODQwOTEsImV4cCI6MjEwMjI2MDA5MX0.8-WaHAberQZasXOOBxjpi67H-SFQYxaS35a_Lzhppu4'

// Le fetch personnalisé rend le hors-ligne transparent pour tout le code
// existant : chaque `supabase.from(...)` continue de s'écrire pareil, mais
// passe désormais par une file d'attente + un cache IndexedDB quand le
// réseau est indisponible (voir src/lib/offlineFetch.js).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: createOfflineFetch() },
})
