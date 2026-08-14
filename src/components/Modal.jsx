export default function Modal({ title, onClose, onSave, onDelete, saveLabel = 'Enregistrer', maxWidth = 480, children }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth }}>
        <div className="modal-hdr">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-foot">
          {onDelete && <button className="btn-danger" onClick={onDelete}>Supprimer</button>}
          <button className="btn-sm" onClick={onClose}>Annuler</button>
          {onSave && <button className="btn-sm primary" onClick={onSave}>{saveLabel}</button>}
        </div>
      </div>
    </div>
  )
}
