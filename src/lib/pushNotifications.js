import { supabase } from './supabase'

// Clé publique VAPID — publique par nature (contrepartie de la clé privée
// gardée côté serveur, dans les variables d'environnement Vercel), sûre à
// exposer ici. Générée une fois pour ce projet (web-push.generateVAPIDKeys()).
const VAPID_PUBLIC_KEY = 'BJANkhtcUxwopSJhavtD0LBHZDI-CfDDDaTrgo7X0nqZ8qRAZfxWCHsi3t-XqW0rs5fqg_xP9gU5tALYqyS5UVc'

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)))
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

export async function getPushSubscriptionState() {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'not-subscribed'
}

// Demande la permission puis crée l'abonnement push de CET appareil (téléphone
// ou ordinateur — chacun a son propre abonnement, on peut donc en avoir
// plusieurs par personne) et l'enregistre en base pour que le serveur puisse
// lui envoyer des rappels.
export async function subscribeToPush(userId) {
  if (!pushSupported()) throw new Error('Notifications non supportées sur cet appareil/navigateur.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Permission refusée.')
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    })
  }
  const json = sub.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert({
    user_id: userId, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
  }, { onConflict: 'endpoint' })
  if (error) throw error
  return sub
}

export async function unsubscribeFromPush() {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}
