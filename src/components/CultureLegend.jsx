import { useState, useMemo } from 'react'
import { rpgLabel } from '../lib/rpgCodes'
import { cultureColor } from '../lib/cultureCodes'

// Petite légende repliable qui traduit les codes culture RPG (ex. "MIS", "ORH")
// visibles dans la liste/carte en libellés français complets, avec la couleur
// utilisée pour cette culture sur la carte (ParcellesMap.jsx utilise la même
// fonction cultureColor) — sans toucher aux données elles-mêmes. Ne montre que
// les codes réellement utilisés dans `codes`.
export default function CultureLegend({ codes, corner = 'bottom-right' }) {
  const [open, setOpen] = useState(false)
  const known = useMemo(() => {
    const uniq = [...new Set((codes || []).filter(Boolean))]
    return uniq
      .map(c => ({ code: c, label: rpgLabel(c), color: cultureColor(c) }))
      .sort((a, b) => a.code.localeCompare(b.code))
  }, [codes])

  if (known.length === 0) return null

  const pos = {
    'bottom-right': { bottom: 12, right: 12 },
    'bottom-left':  { bottom: 12, left: 12 },
    'top-right':    { top: 12, right: 12 },
  }[corner] || { bottom: 12, right: 12 }

  return (
    <div style={{ position: 'absolute', ...pos, zIndex: 500 }}>
      {open ? (
        <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-md)', padding: '.6rem .8rem', maxWidth: 240, fontSize: '.76rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.4rem' }}>
            <strong style={{ fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)' }}>Légende cultures</strong>
            <button onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.9rem', lineHeight: 1, padding: 0 }}>✕</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
            {known.map(({ code, label, color }) => (
              <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: color, flexShrink: 0, border: '1px solid rgba(0,0,0,.15)' }} />
                <span style={{ fontWeight: 700, color: 'var(--green-mid)', minWidth: 34 }}>{code}</span>
                <span style={{ color: 'var(--text-main)' }}>{label || code}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} title="Légende des codes culture"
          style={{
            width: 30, height: 30, borderRadius: '50%', border: '1px solid var(--border)', background: 'white',
            boxShadow: 'var(--shadow-md)', cursor: 'pointer', fontSize: '.85rem', fontWeight: 700, color: 'var(--green-mid)',
          }}>ℹ️</button>
      )}
    </div>
  )
}
