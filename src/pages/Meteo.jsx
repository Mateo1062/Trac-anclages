import { useState, useEffect, useRef } from 'react'
import L from 'leaflet'

// Coordonnées Salon (10700, Aube) — siège de l'exploitation.
const SALON_LAT = 48.64
const SALON_LNG = 4.01

// Meteociel et Météo-France interdisent explicitement le scraping/l'intégration
// de leurs données radar sans abonnement payant — on ne fait donc QUE un lien
// externe vers leur site, jamais d'iframe ni de récupération de leurs données.
// Le radar et les prévisions affichés ici viennent de sources libres et gratuites
// (RainViewer, Open-Meteo) qui autorisent explicitement cet usage.
const METEOCIEL_URL = 'https://www.meteociel.fr/prevville.php'

const WEATHER_ICON = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️',
  56: '🌧️', 57: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '🌨️', 77: '🌨️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  85: '🌨️', 86: '🌨️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
}
const WEATHER_LABEL = {
  0: 'Ciel dégagé', 1: 'Peu nuageux', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine légère', 53: 'Bruine', 55: 'Bruine forte',
  56: 'Bruine verglaçante', 57: 'Bruine verglaçante forte',
  61: 'Pluie faible', 63: 'Pluie', 65: 'Pluie forte',
  66: 'Pluie verglaçante', 67: 'Pluie verglaçante forte',
  71: 'Neige faible', 73: 'Neige', 75: 'Neige forte', 77: 'Grains de neige',
  80: 'Averses faibles', 81: 'Averses', 82: 'Averses violentes',
  85: 'Averses de neige', 86: 'Averses de neige fortes',
  95: 'Orage', 96: 'Orage avec grêle', 99: 'Orage violent',
}
function iconFor(code) { return WEATHER_ICON[code] ?? '🌡️' }
function labelFor(code) { return WEATHER_LABEL[code] ?? '—' }
function jourLabel(iso, i) {
  if (i === 0) return "Aujourd'hui"
  if (i === 1) return 'Demain'
  return new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
}

export default function Meteo() {
  const mapContainerRef = useRef(null)
  const mapRef = useRef(null)
  const radarLayerRef = useRef(null)
  const [radarFrames, setRadarFrames] = useState([])
  const [radarIdx, setRadarIdx] = useState(0)
  const [radarPlaying, setRadarPlaying] = useState(false)
  const [radarLoading, setRadarLoading] = useState(true)
  const [forecast, setForecast] = useState(null)
  const [loadingForecast, setLoadingForecast] = useState(true)
  const [error, setError] = useState('')

  // ── Carte Leaflet + radar RainViewer (gratuit, sans clé) ──────────────
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return
    const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([SALON_LAT, SALON_LNG], 8)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
    }).addTo(map)
    L.marker([SALON_LAT, SALON_LNG]).addTo(map).bindPopup('<strong>Salon (10700)</strong>').openPopup()
    mapRef.current = map

    // Le conteneur peut ne pas avoir sa taille finale au moment de l'init
    // (chargement des sections au-dessus, transition d'onglet mobile…) —
    // Leaflet fige alors la grille de tuiles sur une mauvaise taille et
    // l'affichage reste décalé/coupé tant qu'on ne force pas un recalcul.
    const t1 = setTimeout(() => map.invalidateSize(), 150)
    const t2 = setTimeout(() => map.invalidateSize(), 500)
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(mapContainerRef.current)
    const onResize = () => map.invalidateSize()
    window.addEventListener('resize', onResize)

    return () => {
      clearTimeout(t1); clearTimeout(t2); ro.disconnect()
      window.removeEventListener('resize', onResize)
      map.remove(); mapRef.current = null
    }
  }, [])

  const [radarRetryTick, setRadarRetryTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    async function loadRadar(attempt) {
      try {
        const res = await fetch('https://api.rainviewer.com/public/weather-maps.json')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const past = data?.radar?.past || []
        const nowcast = data?.radar?.nowcast || []
        const frames = [...past, ...nowcast]
        if (cancelled) return
        setRadarFrames(frames.map(f => ({ time: f.time, path: f.path, host: data.host, forecast: nowcast.includes(f) })))
        setRadarIdx(Math.max(0, past.length - 1))
        setError('')
        setRadarLoading(false)
      } catch (e) {
        if (cancelled) return
        // Filet de sécurité : un aléa réseau transitoire (coupure, portail captif…)
        // ne doit pas laisser l'utilisateur bloqué sans radar tant qu'il n'a pas
        // rechargé toute la page — on retente une fois automatiquement.
        if (attempt < 2) { setTimeout(() => loadRadar(attempt + 1), 2000); return }
        setError("Impossible de charger le radar RainViewer (réseau indisponible ou service momentanément hors service).")
        setRadarLoading(false)
      }
    }
    setRadarLoading(true)
    loadRadar(1)
    return () => { cancelled = true }
  }, [radarRetryTick])

  useEffect(() => {
    const map = mapRef.current
    const frame = radarFrames[radarIdx]
    if (!map || !frame) return
    if (radarLayerRef.current) map.removeLayer(radarLayerRef.current)
    const layer = L.tileLayer(`${frame.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
      opacity: 0.65, zIndex: 500, maxNativeZoom: 7,
    })
    layer.addTo(map)
    radarLayerRef.current = layer
  }, [radarFrames, radarIdx])

  // Défilement automatique des frames radar (animation pluie passée → prévue)
  useEffect(() => {
    if (!radarPlaying || radarFrames.length === 0) return
    const id = setInterval(() => setRadarIdx(i => (i + 1) % radarFrames.length), 600)
    return () => clearInterval(id)
  }, [radarPlaying, radarFrames.length])

  // ── Prévisions Open-Meteo (gratuit, sans clé) ──────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${SALON_LAT}&longitude=${SALON_LNG}` +
          `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m,weather_code` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max` +
          `&hourly=temperature_2m,precipitation_probability,weather_code` +
          `&timezone=Europe%2FParis&forecast_days=7`
        const res = await fetch(url)
        const data = await res.json()
        setForecast(data)
      } catch {
        setError(prev => prev || "Impossible de charger les prévisions Open-Meteo.")
      } finally {
        setLoadingForecast(false)
      }
    })()
  }, [])

  const frame = radarFrames[radarIdx]
  const frameTime = frame ? new Date(frame.time * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : ''
  const frameIsForecast = frame?.forecast

  const prochaines24h = (() => {
    if (!forecast?.hourly) return []
    const nowH = new Date().getHours()
    const startIdx = forecast.hourly.time.findIndex(t => new Date(t).getHours() === nowH && new Date(t) >= new Date(Date.now() - 3600_000))
    const from = Math.max(0, startIdx)
    return forecast.hourly.time.slice(from, from + 12).map((t, i) => ({
      time: t,
      temp: forecast.hourly.temperature_2m[from + i],
      pop: forecast.hourly.precipitation_probability[from + i],
      code: forecast.hourly.weather_code[from + i],
    }))
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ background: 'white', borderBottom: '1px solid var(--border)', padding: '.9rem 1.5rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: 0, color: 'var(--ink)' }}>🌦️ Météo — Salon (10700)</h2>
        <a href={METEOCIEL_URL} target="_blank" rel="noreferrer" className="btn-sm" style={{ marginLeft: 'auto', textDecoration: 'none' }}>
          🔗 Ouvrir Meteociel
        </a>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '1.4rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.4rem' }}>
        {error && (
          <div style={{ background: '#fdf0ef', border: '1px solid var(--red)', borderRadius: 10, padding: '.8rem 1.1rem', fontSize: '.85rem', color: 'var(--red)', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
            <span>⚠️ {error}</span>
            <button className="btn-sm" onClick={() => { setError(''); setRadarRetryTick(t => t + 1) }}>🔄 Réessayer</button>
          </div>
        )}

        {/* Conditions actuelles */}
        <section>
          <SectionTitle>Conditions actuelles</SectionTitle>
          {loadingForecast ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Chargement…</div>
          ) : forecast?.current ? (
            <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '1.1rem 1.3rem', display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '2.6rem', lineHeight: 1 }}>{iconFor(forecast.current.weather_code)}</div>
              <div>
                <div style={{ fontSize: '1.8rem', fontWeight: 700, color: 'var(--ink)' }}>{Math.round(forecast.current.temperature_2m)}°C</div>
                <div style={{ fontSize: '.85rem', color: 'var(--text-muted)' }}>{labelFor(forecast.current.weather_code)}</div>
              </div>
              <div style={{ display: 'flex', gap: '1.4rem', marginLeft: 'auto', flexWrap: 'wrap' }}>
                <Stat label="💧 Humidité" value={`${forecast.current.relative_humidity_2m}%`} />
                <Stat label="🌬️ Vent" value={`${Math.round(forecast.current.wind_speed_10m)} km/h`} />
                <Stat label="🌧️ Précip." value={`${forecast.current.precipitation} mm`} />
              </div>
            </div>
          ) : null}
        </section>

        {/* Prochaines heures */}
        {prochaines24h.length > 0 && (
          <section>
            <SectionTitle>Prochaines heures</SectionTitle>
            <div style={{ display: 'flex', gap: '.6rem', overflowX: 'auto', paddingBottom: '.3rem' }}>
              {prochaines24h.map((h, i) => (
                <div key={i} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.7rem .8rem', minWidth: 78, textAlign: 'center', flexShrink: 0 }}>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginBottom: '.3rem' }}>
                    {new Date(h.time).toLocaleTimeString('fr-FR', { hour: '2-digit' })}h
                  </div>
                  <div style={{ fontSize: '1.4rem' }}>{iconFor(h.code)}</div>
                  <div style={{ fontWeight: 700, fontSize: '.9rem', color: 'var(--ink)' }}>{Math.round(h.temp)}°</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--blue, #3498db)' }}>💧{h.pop}%</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Radar de pluie */}
        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '.7rem', flexWrap: 'wrap', gap: '.5rem' }}>
            <SectionTitle>Radar de pluie (RainViewer)</SectionTitle>
            {radarFrames.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', fontSize: '.8rem' }}>
                <button className="btn-sm" onClick={() => setRadarPlaying(p => !p)}>{radarPlaying ? '⏸️ Pause' : '▶️ Lecture'}</button>
                <input
                  type="range" min={0} max={radarFrames.length - 1} value={radarIdx}
                  onChange={e => { setRadarPlaying(false); setRadarIdx(Number(e.target.value)) }}
                  style={{ width: 160 }}
                />
                <span style={{ color: frameIsForecast ? 'var(--amber)' : 'var(--text-muted)', fontWeight: 600, minWidth: 90 }}>
                  {frameIsForecast ? `Prévu ${frameTime}` : frameTime}
                </span>
              </div>
            )}
          </div>
          <div style={{ position: 'relative', height: 420, borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <div ref={mapContainerRef} style={{ height: '100%', width: '100%' }} />
            {radarLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(255,255,255,.7)', fontSize: '.85rem', color: 'var(--text-muted)' }}>
                Chargement du radar…
              </div>
            )}
          </div>
          <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: '.4rem' }}>
            Données radar : <a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>
          </div>
        </section>

        {/* Prévisions 7 jours */}
        <section>
          <SectionTitle>Prévisions 7 jours</SectionTitle>
          {loadingForecast ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Chargement…</div>
          ) : forecast?.daily ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '.7rem' }}>
              {forecast.daily.time.map((t, i) => (
                <div key={t} style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '.8rem .9rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '.78rem', fontWeight: 600, color: 'var(--ink)', marginBottom: '.3rem', textTransform: 'capitalize' }}>{jourLabel(t, i)}</div>
                  <div style={{ fontSize: '1.6rem' }}>{iconFor(forecast.daily.weather_code[i])}</div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', margin: '.2rem 0' }}>{labelFor(forecast.daily.weather_code[i])}</div>
                  <div style={{ fontWeight: 700, color: 'var(--ink)' }}>
                    {Math.round(forecast.daily.temperature_2m_max[i])}° <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{Math.round(forecast.daily.temperature_2m_min[i])}°</span>
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--blue, #3498db)', marginTop: '.2rem' }}>💧 {forecast.daily.precipitation_sum[i]} mm</div>
                  <div style={{ fontSize: '.7rem', color: 'var(--text-muted)' }}>🌬️ {Math.round(forecast.daily.wind_speed_10m_max[i])} km/h</div>
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: '.4rem' }}>
            Données prévisions : <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>
          </div>
        </section>
      </div>
    </div>
  )
}

function SectionTitle({ children }) {
  return <h3 style={{ fontSize: '.85rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', margin: '0 0 .5rem' }}>{children}</h3>
}
function Stat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: '.7rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontWeight: 700, color: 'var(--ink)' }}>{value}</div>
    </div>
  )
}
