import { useState } from 'react'
import { useAuth } from '../lib/AuthContext'
import useIsMobile from '../lib/useIsMobile'

export default function Login() {
  const { login } = useAuth()
  const isMobile = useIsMobile()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!email || !password) {
      setError('Veuillez remplir tous les champs.')
      return
    }
    setLoading(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err.message.includes('Invalid') ? 'Email ou mot de passe incorrect.' : err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
      {/* Left panel — hidden on mobile to give the form full width */}
      {!isMobile && <div style={{
        background: 'var(--green-deep)', display: 'flex', flexDirection: 'column',
        justifyContent: 'space-between', padding: '3rem', position: 'relative', overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse 80% 60% at 20% 80%, rgba(46,102,144,0.25) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 20%, rgba(32,56,79,0.4) 0%, transparent 55%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, overflow: 'hidden' }}>
              <svg viewBox="0 0 100 100" style={{ width: 44, height: 44, display: 'block' }}>
                <defs>
                  <linearGradient id="loginLogoGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#20384F"/>
                    <stop offset="1" stopColor="#17293D"/>
                  </linearGradient>
                </defs>
                <rect width="100" height="100" fill="url(#loginLogoGrad)"/>
                <line x1="50" y1="30" x2="50" y2="76" stroke="#E0A84C" strokeWidth="4" strokeLinecap="round"/>
                <path d="M50,30 L58,20 L50,24 L42,20 Z" fill="#F1C77A"/>
                <path d="M50,40 L64,32 L60,42 L50,46 Z" fill="#E0A84C"/>
                <path d="M50,40 L36,32 L40,42 L50,46 Z" fill="#E0A84C"/>
                <path d="M50,54 L63,47 L59,56 L50,60 Z" fill="#E0A84C"/>
                <path d="M50,54 L37,47 L41,56 L50,60 Z" fill="#E0A84C"/>
                <path d="M50,68 L61,62 L58,70 L50,74 Z" fill="#E0A84C"/>
                <path d="M50,68 L39,62 L42,70 L50,74 Z" fill="#E0A84C"/>
              </svg>
            </div>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.9rem', color: 'white' }}>Traç'Anclages</span>
          </div>
        </div>
        <div style={{ position: 'relative', zIndex: 1 }}>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: '2.4rem', color: 'white', lineHeight: 1.2, marginBottom: '.8rem' }}>
            La traçabilité,<br /><em style={{ color: 'var(--green-light)' }}>simplifiée</em>
          </h2>
          <p style={{ color: 'rgba(255,255,255,.5)', fontSize: '.9rem', maxWidth: 300 }}>
            Gérez vos productions agricoles en toute transparence.
          </p>
        </div>
        <div />
      </div>}

      {/* Right panel */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', paddingTop: 'calc(2rem + env(safe-area-inset-top))', paddingBottom: 'calc(2rem + env(safe-area-inset-bottom))' }}>
        <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: 380 }}>
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.9rem', marginBottom: '.2rem' }}>Connexion</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '.88rem', marginBottom: '2rem' }}>Accédez à votre espace Traç'Anclages</p>

          {error && (
            <div style={{ background: '#fdf0ef', border: '1px solid #f5c6c2', borderRadius: 8, padding: '.65rem .9rem', fontSize: '.83rem', color: 'var(--red)', marginBottom: '1rem' }}>
              {error}
            </div>
          )}

          <div className="form-group" style={{ marginBottom: '1.2rem' }}>
            <label>Email</label>
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="ex. jean@tracagri.fr" autoComplete="email" />
          </div>

          <div className="form-group" style={{ marginBottom: '1.5rem', position: 'relative' }}>
            <label>Mot de passe</label>
            <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
            <button type="button" onClick={() => setShowPw(!showPw)} style={{ position: 'absolute', right: '.8rem', top: '2.1rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '.8rem' }}>
              {showPw ? 'Masquer' : 'Afficher'}
            </button>
          </div>

          <button type="submit" className="btn-sm primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '.85rem', fontSize: '.92rem' }}>
            {loading ? <span className="spinner" /> : 'Se connecter'}
          </button>
        </form>
      </div>
    </div>
  )
}
