// Aperçu rapide des photos jointes à une intervention — sans passer par la
// fenêtre de modification complète. Utilisé depuis Outils agricoles et les
// deux tableaux de bord.
export default function PhotoLightbox({ photos, onClose }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()} style={{ zIndex: 9500 }}>
      <div style={{ background: 'white', borderRadius: 12, padding: '1rem', maxWidth: '92vw', maxHeight: '92vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '.8rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <strong style={{ fontSize: '.9rem' }}>📸 Photo{photos.length > 1 ? `s (${photos.length})` : ''}</strong>
          <button onClick={onClose} className="btn-sm">✕ Fermer</button>
        </div>
        <div style={{ display: 'flex', gap: '.8rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          {photos.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer">
              <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 8, display: 'block' }} />
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
