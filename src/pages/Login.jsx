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
          background: 'radial-gradient(ellipse 80% 60% at 20% 80%, rgba(74,144,80,0.25) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 20%, rgba(45,90,48,0.4) 0%, transparent 55%)',
          pointerEvents: 'none'
        }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, overflow: 'hidden' }}>
              <svg viewBox="0 0 100 100" style={{ width: 44, height: 44, display: 'block' }}>
                <defs>
                  <linearGradient id="loginLogoGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3fc95c"/>
                    <stop offset="1" stopColor="#1d5c2a"/>
                  </linearGradient>
                </defs>
                <rect width="100" height="100" fill="url(#loginLogoGrad)"/>
                <circle cx="50" cy="76" r="5.5" fill="#eaf9df"/>
                <path d="M50,73 C50,60 50,50 50,40" stroke="#eaf9df" strokeWidth="4" strokeLinecap="round" fill="none"/>
                <g transform="translate(50,55) rotate(-38)">
                  <path d="M0,0 C-13,-4 -18,-14 -14,-26 C-2,-24 4,-14 0,0 Z" fill="#eaf9df"/>
                </g>
                <g transform="translate(50,42) rotate(28)">
                  <path d="M0,0 C15,-3 21,-16 16,-30 C3,-27 -4,-15 0,0 Z" fill="#c8f0a9"/>
                </g>
              </svg>
            </div>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: '1.9rem', color: 'white' }}>Traç'Agri</span>
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
          <p style={{ color: 'var(--text-muted)', fontSize: '.88rem', marginBottom: '2rem' }}>Accédez à votre espace Traç'Agri</p>

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
