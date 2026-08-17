import { useState, useRef, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import useIsMobile from '../lib/useIsMobile'

/* ─── Assistant IA flottant (Gemini) ───────────────────────────────
   Bulle de chat disponible partout dans l'app une fois connecté.
   Aide générale, rédaction de notes d'intervention, questions sur
   l'usage de l'appli — pas d'accès direct aux données de l'exploitation
   (voir prompt système côté serveur, api/chat.js). */
export default function ChatAssistant() {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const listRef = useRef(null)

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, open])

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setError('')
    const next = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ messages: next }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erreur assistant')
      setMessages(m => [...m, { role: 'assistant', content: data.reply || '(réponse vide)' }])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="Assistant IA"
        style={{
          position: 'fixed', right: '1rem',
          bottom: `calc(1rem + env(safe-area-inset-bottom) + ${isMobile ? 58 : 0}px)`,
          zIndex: 900, width: 52, height: 52, borderRadius: '50%',
          background: 'var(--green-deep)', color: 'white', border: 'none',
          boxShadow: '0 4px 16px rgba(0,0,0,.3)', fontSize: '1.4rem', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >{open ? '✕' : '💬'}</button>

      {open && (
        <div style={{
          position: 'fixed', zIndex: 899,
          right: isMobile ? '.5rem' : '1rem', left: isMobile ? '.5rem' : 'auto',
          bottom: `calc(1rem + env(safe-area-inset-bottom) + ${isMobile ? 116 : 68}px)`,
          width: isMobile ? 'auto' : 360, maxHeight: isMobile ? '65vh' : 480,
          background: 'white', borderRadius: 14, border: '1px solid var(--border)',
          boxShadow: '0 8px 28px rgba(0,0,0,.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{ background: 'var(--green-deep)', color: 'white', padding: '.7rem 1rem', fontWeight: 700, fontSize: '.9rem' }}>
            🤖 Assistant Traç'Anclages
          </div>

          <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '.8rem', display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
            {messages.length === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: '.82rem', textAlign: 'center', padding: '1rem' }}>
                Posez une question, ou demandez de l'aide pour rédiger une note d'intervention.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%', padding: '.5rem .75rem', borderRadius: 10, fontSize: '.85rem', whiteSpace: 'pre-wrap',
                background: m.role === 'user' ? 'var(--green-pale)' : 'var(--cream)',
                color: 'var(--ink)',
              }}>{m.content}</div>
            ))}
            {loading && (
              <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: '.82rem' }}>… réflexion en cours</div>
            )}
            {error && (
              <div style={{ color: 'var(--red, #c0392b)', fontSize: '.78rem' }}>{error}</div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', padding: '.6rem', display: 'flex', gap: '.5rem' }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Votre question…"
              rows={1}
              style={{ flex: 1, resize: 'none', border: '1.5px solid var(--border)', borderRadius: 8, padding: '.5rem .7rem', fontSize: '.85rem', outline: 'none', fontFamily: 'inherit' }}
            />
            <button onClick={send} disabled={loading || !input.trim()} className="btn-sm primary" style={{ flexShrink: 0 }}>Envoyer</button>
          </div>
        </div>
      )}
    </>
  )
}
