import { useState } from 'react'
import { CHECKS, runAllChecks } from '../lib/diagnosticChecks'
import { requestGoToSection } from '../lib/diagnosticNav'

// Vérifie automatiquement des règles de cohérence connues à travers toute
// l'appli (campagne manquante, fiches/lignes orphelines, contrats dépassés…) et
// permet de sauter directement à la section concernée plutôt que de chercher
// à l'œil pendant des heures. Volontairement extensible : chaque nouvelle
// anomalie détectable se rajoute comme un check dans lib/diagnosticChecks.js,
// sans toucher à cette page.
const SEVERITY_STYLE = {
  error: { bg: '#fdf0ef', border: 'var(--red)', color: 'var(--red)', icon: '❌' },
  warn:  { bg: 'var(--amber-pale, #fdf6e9)', border: 'var(--amber)', color: 'var(--amber)', icon: '⚠️' },
}

export default function Diagnostic() {
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [progressId, setProgressId] = useState(null)
  const [issues, setIssues] = useState([])
  const [copiedFor, setCopiedFor] = useState(null)

  async function run() {
    setRunning(true)
    setDone(false)
    setIssues([])
    const results = await runAllChecks(id => setProgressId(id))
    setIssues(results)
    setRunning(false)
    setDone(true)
  }

  function localiser(issue) {
    if (!issue.section) return
    requestGoToSection(issue.section, issue.hint)
    if (issue.hint) {
      setCopiedFor(issue.title)
      setTimeout(() => setCopiedFor(cur => cur === issue.title ? null : cur), 3000)
    }
  }

  const errors = issues.filter(i => i.severity === 'error')
  const warns = issues.filter(i => i.severity === 'warn')

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '1.5rem 1.8rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '.8rem', marginBottom: '.5rem' }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>🩺 Diagnostic données</h2>
          <p style={{ fontSize: '.82rem', color: 'var(--text-muted)', marginTop: '.2rem' }}>
            Lance une série de vérifications de cohérence à travers l'appli — {CHECKS.length} vérification{CHECKS.length > 1 ? 's' : ''} disponible{CHECKS.length > 1 ? 's' : ''} pour l'instant, d'autres s'ajouteront avec le temps.
          </p>
        </div>
        <button className="btn btn-primary" onClick={run} disabled={running}>
          {running ? `⏳ Vérification en cours… (${progressId || ''})` : '🔍 Lancer la vérification'}
        </button>
      </div>

      {done && issues.length === 0 && (
        <div style={{ marginTop: '1.5rem', textAlign: 'center', padding: '2.5rem', background: 'white', border: '1px solid var(--border)', borderRadius: 12, color: 'var(--green-mid)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>✅</div>
          <strong>Aucune anomalie détectée.</strong>
        </div>
      )}

      {done && issues.length > 0 && (
        <div style={{ marginTop: '1.2rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '.6rem 1rem' }}>
            <div style={{ fontSize: '.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Anomalies</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 800 }}>{issues.length}</div>
          </div>
          {errors.length > 0 && (
            <div style={{ background: '#fdf0ef', border: '1px solid var(--red)', borderRadius: 10, padding: '.6rem 1rem' }}>
              <div style={{ fontSize: '.65rem', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.04em' }}>À corriger</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--red)' }}>{errors.length}</div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '1.2rem', display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
        {[...errors, ...warns].map((issue, i) => {
          const st = SEVERITY_STYLE[issue.severity] || SEVERITY_STYLE.warn
          return (
            <div key={i} style={{ background: st.bg, border: `1px solid ${st.border}`, borderRadius: 12, padding: '.85rem 1.1rem', display: 'flex', gap: '.8rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{st.icon}</span>
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ fontWeight: 700, fontSize: '.88rem', color: st.color }}>{issue.title}</div>
                {issue.detail && <div style={{ fontSize: '.8rem', color: 'var(--text-muted)', marginTop: '.25rem' }}>{issue.detail}</div>}
              </div>
              {issue.section && (
                <button className="btn-sm" onClick={() => localiser(issue)} style={{ flexShrink: 0 }}>
                  {copiedFor === issue.title ? '📋 Copié — colle dans la recherche' : '🔍 Localiser'}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
