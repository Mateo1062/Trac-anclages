import { useState } from 'react'

/* ─────────────────────────────────────────────────────────
   Composants visuels communs à TOUS les tableaux de bord (Export, Agricole,
   Tableau de bord salarié restreint) — une seule et même interface pour tout
   le monde, seuls les éléments affichés changent selon les restrictions de
   chacun. Cartes compactes : chaque ligne est cliquable et ouvre le détail
   complet dans une fenêtre, plutôt que d'afficher tout en permanence.
───────────────────────────────────────────────────────── */

export const num = v => (v == null || isNaN(v)) ? 0 : +v
export const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '—'
export const fmtDateFull = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('fr-FR') : '—'
export const fmtEur = v => num(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €'

export const gridStyle = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '.7rem', alignItems: 'start' }

/* Carte compacte avec bandeau coloré + liste défilante — cliquer sur la flèche
   de l'en-tête bascule la carte en PLEIN ÉCRAN (tout le contenu, sans le petit
   ascenseur interne) pour un visuel global, ex. toutes les interventions d'un
   coup ; recliquer (✕) revient au format compact normal. */
export function Card({ icon, title, accent = 'var(--green-mid)', alert = false, children, count }) {
  const [fullscreen, setFullscreen] = useState(false)

  const header = (
    <div onClick={() => setFullscreen(f => !f)} title={fullscreen ? 'Réduire' : 'Plein écran'} style={{
      display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.5rem .8rem', cursor: 'pointer', userSelect: 'none',
      background: alert ? 'var(--amber-pale)' : 'var(--cream)', borderBottom: `2px solid ${alert ? 'var(--amber)' : accent}`, flexShrink: 0,
    }}>
      <span style={{ fontSize: '.95rem' }}>{icon}</span>
      <span style={{ fontSize: '.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.05em', color: alert ? 'var(--amber)' : 'var(--green-deep)', flex: 1 }}>{title}</span>
      {count != null && <span style={{ fontSize: '.66rem', fontWeight: 700, background: 'white', border: '1px solid var(--border)', borderRadius: 50, padding: '.06rem .5rem', color: 'var(--text-muted)' }}>{count}</span>}
      <span style={{ fontSize: '.85rem', color: alert ? 'var(--amber)' : 'var(--text-muted)' }}>{fullscreen ? '✕' : '⛶'}</span>
    </div>
  )

  if (fullscreen) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 3000, background: 'white',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ paddingTop: 'env(safe-area-inset-top)', flexShrink: 0 }}>{header}</div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '.6rem .9rem' }}>
          {children}
        </div>
      </div>
    )
  }

  return (
    <div style={{
      background: 'white', border: '1px solid var(--border)', borderRadius: 14,
      overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0,
      boxShadow: '0 1px 4px rgba(0,0,0,.05)',
    }}>
      {header}
      <div style={{ padding: '.35rem .5rem', overflowY: 'auto', maxHeight: 218 }}>
        {children}
      </div>
    </div>
  )
}

/* Bouton "Actualiser" — recharge les données sans changer de page, pour voir
   tout de suite ce qu'on vient d'ajouter ailleurs dans l'appli. */
export function RefreshButton({ onClick, loading }) {
  return (
    <button type="button" className="btn-sm" onClick={onClick} disabled={loading}
      style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginLeft: 'auto' }}>
      <span style={{ display: 'inline-block', animation: loading ? 'spin .8s linear infinite' : 'none' }}>🔄</span>
      {loading ? 'Actualisation…' : 'Actualiser'}
    </button>
  )
}

export function Empty({ children }) {
  return <div style={{ fontSize: '.74rem', color: 'var(--text-muted)', fontStyle: 'italic', padding: '.5rem .3rem' }}>{children}</div>
}

/* Lignes ultra-compactes, cliquables → détail (une seule ligne par intervention ;
   le détail complet ne s'affiche qu'au clic, dans une fenêtre à part). */
export function Rows({ rows, onDetail, onPhotos }) {
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i}
          onClick={() => { if (r.onClick) r.onClick(); else if (r.detail) onDetail(r.detail) }}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: '.5rem', padding: '.35rem .35rem',
            borderRadius: 7, fontSize: '.73rem', cursor: (r.onClick || r.detail) ? 'pointer' : 'default',
          }}
          onMouseEnter={e => { if (r.onClick || r.detail) e.currentTarget.style.background = 'var(--green-pale)' }}
          onMouseLeave={e => { e.currentTarget.style.background = '' }}>
          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', fontSize: '.66rem', width: 34, flexShrink: 0, paddingTop: 1 }}>{r.date}</span>
          <span style={{ fontWeight: 600, whiteSpace: 'normal', wordBreak: 'break-word', flex: 1, minWidth: 0, lineHeight: 1.3 }}>{r.main}</span>
          {r.badge && <span style={{ fontSize: '.6rem', fontWeight: 700, padding: '.05rem .4rem', borderRadius: 50, background: r.badgeBg || 'var(--green-pale)', color: r.badgeColor || 'var(--green-mid)', whiteSpace: 'nowrap', flexShrink: 0, marginTop: 1 }}>{r.badge}</span>}
          {r.photos?.length > 0 && (
            <button type="button" title={`Voir ${r.photos.length} photo(s)`}
              onClick={e => { e.stopPropagation(); onPhotos(r.photos) }}
              style={{ fontSize: '.62rem', fontWeight: 700, padding: '.05rem .4rem', borderRadius: 50, background: '#3498db', color: 'white', border: 'none', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2, marginTop: 1 }}>
              📷 {r.photos.length}
            </button>
          )}
          {r.right != null && <span style={{ fontWeight: 700, whiteSpace: 'nowrap', fontSize: '.7rem', flexShrink: 0, paddingTop: 1 }}>{r.right}</span>}
        </div>
      ))}
    </div>
  )
}

/* Bandeau de chiffres clés en haut du tableau de bord */
export function KpiStrip({ kpis }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(120px, 1fr))`, gap: '.6rem', marginBottom: '.8rem' }}>
      {kpis.map((k, i) => (
        <div key={i} style={{
          background: 'linear-gradient(135deg, var(--green-deep,#1e3a22), var(--green-mid,#3d7a42))',
          borderRadius: 12, padding: '.55rem .8rem', color: 'white',
        }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 800, lineHeight: 1.15 }}>{k.value}</div>
          <div style={{ fontSize: '.62rem', opacity: .85, textTransform: 'uppercase', letterSpacing: '.04em' }}>{k.label}</div>
        </div>
      ))}
    </div>
  )
}

/* Fenêtre de détail générique : petite en-tête optionnelle (ex. type
   d'intervention "Broyage + Défanage") + liste de [label, valeur]. */
export function DetailModal({ detail, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-hdr"><h3>{detail.title}</h3><button className="modal-close" onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {detail.badge && (
            <div style={{
              display: 'inline-block', fontSize: '.72rem', fontWeight: 700, padding: '.25rem .75rem',
              borderRadius: 50, background: 'var(--green-pale)', color: 'var(--green-mid)', marginBottom: '.7rem',
            }}>{detail.badge}</div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.83rem' }}>
            <tbody>
              {detail.fields.filter(([, v]) => v != null && v !== '' && v !== '—').map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: '.4rem .6rem', fontWeight: 600, background: 'var(--cream)', border: '1px solid var(--border)', width: '42%', whiteSpace: 'nowrap' }}>{k}</td>
                  <td style={{ padding: '.4rem .6rem', border: '1px solid var(--border)' }}>{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-foot"><button className="btn-sm" onClick={onClose}>Fermer</button></div>
      </div>
    </div>
  )
}

/* Courbe des prix (SVG) */
export function Sparkline({ values, width = 240, height = 46 }) {
  const vals = values.filter(v => v != null && !isNaN(v))
  if (vals.length < 2) return null
  const min = Math.min(...vals), max = Math.max(...vals)
  const range = max - min || 1
  const pts = vals.map((v, i) => [6 + (i * (width - 12)) / (vals.length - 1), height - 8 - ((v - min) * (height - 16)) / range])
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`
  return (
    <div style={{ padding: '.2rem .35rem .1rem' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <path d={area} fill="rgba(61,122,66,.12)" />
        <path d={line} fill="none" stroke="var(--green-mid)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2" fill="var(--green-mid)" />)}
        <text x={4} y={height - 0.5} fontSize="7.5" fill="var(--text-muted)">{min.toFixed(0)}</text>
        <text x={width - 4} y={8} fontSize="7.5" fill="var(--text-muted)" textAnchor="end">{max.toFixed(0)} €/T</text>
      </svg>
    </div>
  )
}
