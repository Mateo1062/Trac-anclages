import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getPerms } from '../lib/permissions'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) loadUser(session.user)
      else setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setUser(null)
        setProfile(null)
      } else if (session) {
        loadUser(session.user)
      }
    })

    // Re-vérifie le profil quand l'appli reprend le focus (retour d'arrière-plan,
    // changement d'onglet) — sans ça, un changement de rôle fait par un admin ne
    // prend effet qu'à la prochaine déconnexion/reconnexion.
    function onFocus() {
      supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) loadUser(session.user, { silent: true })
      })
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', () => { if (!document.hidden) onFocus() })

    return () => {
      listener.subscription.unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Abonnement temps réel : dès que l'admin modifie CE profil, la mise à jour
  // arrive immédiatement, sans attendre un changement de focus ou une reconnexion.
  useEffect(() => {
    if (!user?.id) return
    const channel = supabase
      .channel(`profile-${user.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
        (payload) => setProfile(payload.new))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user?.id])

  async function loadUser(authUser, { silent = false } = {}) {
    if (!silent) setUser(authUser)
    else setUser(u => u || authUser)
    let { data, error } = await supabase.from('profiles').select('*').eq('id', authUser.id).single()
    if (error) {
      // Retente une fois — ce fetch échoue parfois de façon transitoire au premier essai
      ;({ data, error } = await supabase.from('profiles').select('*').eq('id', authUser.id).single())
      if (error) { if (!silent) console.warn('profiles fetch failed after retry:', error.message); if (silent) return }
    }
    setProfile(prev => data || prev || { display_name: authUser.email, role: 'operateur' })
    setLoading(false)
  }

  async function login(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return data
  }

  async function logout() {
    await supabase.auth.signOut()
  }

  // Permission helpers
  const role = profile?.role || 'operateur'
  const isAdmin = role === 'admin'
  const isManager = role === 'manager' || isAdmin
  const isFrigo = role === 'frigo'
  const perms = getPerms(role)
  const canSeePlanningExterne = isManager
  const canSeePrix = isManager
  const canSeeSortiesHistorique = !isFrigo && !perms.planningHideExterne
  // Heures des salariés : confidentiel — seuls Ropamil et Sylviane peuvent
  // consulter les heures des autres (chacun voit toujours les siennes).
  const canViewAllHeures = ['Ropamil', 'Sylviane'].includes(profile?.display_name)
  // Facturation (factures à payer) : réservée à l'admin (Matéo) et Sylviane —
  // même logique restrictive que les heures des salariés.
  const canViewFacturation = isAdmin || profile?.display_name === 'Sylviane'
  // Rendement / tonnages moisson & récolte (tableau de bord) : réservés à
  // l'admin (Matéo), Sylviane et Ropamil — les autres utilisateurs voient le
  // reste du tableau de bord (interventions, alertes…) mais pas ces chiffres.
  const canViewRendement = isAdmin || ['Sylviane', 'Ropamil'].includes(profile?.display_name)
  // Coûts (interventions outils/entretien global/bâtiments, coût de revient) :
  // réservés à l'admin (Matéo), Ropamil, Sylviane et Mathis — les autres
  // utilisateurs continuent de voir/saisir le reste de l'intervention normalement,
  // seul le champ ou la colonne "Coût" leur est masqué.
  const canViewCosts = isAdmin || ['Ropamil', 'Sylviane', 'Mathis'].includes(profile?.display_name)

  return (
    <AuthContext.Provider value={{
      user, profile, loading, login, logout, isAdmin, isManager, isFrigo, canSeePlanningExterne, canSeePrix, canSeeSortiesHistorique,
      role, perms, canViewAllHeures, canViewFacturation, canViewRendement, canViewCosts,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
