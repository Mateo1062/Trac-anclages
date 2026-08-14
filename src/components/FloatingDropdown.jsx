import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Menu déroulant de suggestions (produit, parcelle…) rendu en position:fixed via
// un portail dans <body>, plutôt qu'en position:absolute dans son conteneur —
// un conteneur avec overflow-y:auto (Modal, formulaire plein écran) tronque
// sinon tout menu qui dépasserait de sa zone visible actuelle. Particulièrement
// visible sur mobile, où l'écran (donc la zone visible du conteneur) est bien
// plus petit : le menu semblait "ne plus apparaître du tout".
// `anchorRef` : ref de l'input sous lequel positionner le menu.
export default function FloatingDropdown({ anchorRef, children, maxHeight = 220 }) {
  const [rect, setRect] = useState(null)

  useLayoutEffect(() => {
    function update() {
      if (!anchorRef.current) return
      setRect(anchorRef.current.getBoundingClientRect())
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  if (!rect) return null
  const spaceBelow = window.innerHeight - rect.bottom
  const openUp = spaceBelow < 160 && rect.top > spaceBelow

  return createPortal(
    <div style={{
      position: 'fixed',
      left: rect.left, width: rect.width,
      ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
      background: 'white', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow-md)',
      zIndex: 5000, maxHeight, overflowY: 'auto',
    }}>
      {children}
    </div>,
    document.body
  )
}
