// Sélecteur de campagne (année agricole) — repartir sur une base vierge chaque
// année tout en gardant les campagnes passées consultables. Le stock n'est
// jamais filtré par campagne (voir chaque page concernée).
export default function CampagneSelector({ campagnes, value, onChange, canCreate = true }) {
  function nouvelleCampagne() {
    const suggestion = campagnes[0] ? String(parseInt(campagnes[0]) + 1) + '-' + (parseInt(campagnes[0].split('-')[1]) + 1) : ''
    const v = window.prompt('Nouvelle campagne (ex. 2027-2028) :', suggestion)
    if (v?.trim()) onChange(v.trim())
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', flexWrap: 'wrap' }}>
      <span style={{ fontSize: '.72rem', color: 'rgba(255,255,255,.6)', textTransform: 'uppercase', letterSpacing: '.04em' }}>🗓️ Campagne</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ padding: '.35rem .6rem', borderRadius: 7, border: '1.5px solid rgba(255,255,255,.3)', background: 'rgba(255,255,255,.1)', color: 'white', fontSize: '.82rem', fontWeight: 700, outline: 'none' }}>
        {campagnes.map(c => <option key={c} value={c} style={{ color: 'black' }}>{c}</option>)}
      </select>
      {canCreate && (
        <button type="button" onClick={nouvelleCampagne} className="btn-sm"
          style={{ fontSize: '.72rem', padding: '.3rem .6rem', background: 'rgba(255,255,255,.1)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>
          + Nouvelle
        </button>
      )}
    </div>
  )
}
