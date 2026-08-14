import { useState } from 'react'

/**
 * Editable list of free-form key/value pairs (stored as jsonb).
 * value: { [label]: text }
 * onChange: (newValue) => void
 */
export default function DynamicFields({ value, onChange }) {
  const entries = Object.entries(value || {})
  const [newKey, setNewKey] = useState('')

  function updateValue(key, val) {
    onChange({ ...value, [key]: val })
  }
  function removeField(key) {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }
  function addField() {
    const key = newKey.trim()
    if (!key) return
    if (value && value[key] !== undefined) { alert('Ce champ existe déjà.'); return }
    onChange({ ...(value || {}), [key]: '' })
    setNewKey('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
      {entries.map(([key, val]) => (
        <div key={key} style={{ display: 'flex', alignItems: 'flex-end', gap: '.5rem' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label>{key}</label>
            <input type="text" value={val} onChange={e => updateValue(key, e.target.value)} />
          </div>
          <button
            onClick={() => removeField(key)}
            title="Supprimer ce champ"
            style={{ background: 'var(--red-pale)', color: 'var(--red)', border: 'none', borderRadius: 8, padding: '.6rem .7rem', cursor: 'pointer', flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: '.5rem', marginTop: entries.length ? '.4rem' : 0 }}>
        <input
          type="text" placeholder="Nom du nouveau champ (ex. SIRET, Téléphone…)"
          value={newKey} onChange={e => setNewKey(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addField() } }}
          style={{ flex: 1, padding: '.55rem .8rem', border: '1.5px dashed var(--border)', borderRadius: 8, fontSize: '.85rem', outline: 'none' }}
        />
        <button className="btn-sm" onClick={addField}>+ Ajouter un champ</button>
      </div>
    </div>
  )
}
