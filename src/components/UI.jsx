export function Fg({ label, children, span }) {
  return <div className="form-group" style={span ? { gridColumn: '1/-1' } : {}}><label>{label}</label>{children}</div>
}

export function Sec({ label, children }) {
  return (
    <div style={{ marginBottom:'1.1rem' }}>
      <div style={{ fontSize:'.72rem', fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'var(--text-muted)', borderBottom:'1px solid var(--border)', paddingBottom:'.3rem', marginBottom:'.7rem' }}>{label}</div>
      {children}
    </div>
  )
}
