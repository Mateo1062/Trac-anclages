/* Vue "dossiers" par parcelle — même esprit que les dossiers agriculteurs :
   liste des parcelles à gauche (un dossier = une parcelle), détail à droite
   avec les saisies liées et leurs statistiques. Utilisée par Récolte PDT
   (pesées) et Céréales (entrées de moisson). */
export default function DossiersParcelles({
  parcelles, entries, entryParcelleId,
  dossierId, setDossierId, search, setSearch,
  renderStats, onAdd, addLabel, rowHeaders, renderRow, onRowClick,
  isMobile, emptyHint, headerExtra, beforeRows,
}) {
  const norm = s => (s || '').toLowerCase()
  const filtered = parcelles
    .filter(p => norm(`${p.nom} ${p.entite || ''}`).includes(norm(search)))
    .sort((a, b) => (a.nom || '').localeCompare(b.nom || '', 'fr', { numeric: true }))
  const active = parcelles.find(p => p.id === dossierId) || null
  const rowsFor = parc => entries.filter(e => entryParcelleId(e) === parc.id)

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      {/* Liste des dossiers */}
      {(!isMobile || !active) && (
        <div style={{ width: isMobile ? '100%' : 300, flexShrink: 0, borderRight: isMobile ? 'none' : '1px solid var(--border)', background: 'white', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: '.8rem', borderBottom: '1px solid var(--border)' }}>
            <input type="text" placeholder="🔍 Parcelle, entité…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', padding: '.5rem .8rem', border: '1.5px solid var(--border)', borderRadius: 8, fontSize: '.84rem', outline: 'none' }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '.82rem' }}>{emptyHint}</div>
            )}
            {filtered.map(p => {
              const rows = rowsFor(p)
              const isActive = p.id === dossierId
              return (
                <div key={p.id} onClick={() => setDossierId(p.id)}
                  style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: isActive ? 'var(--green-pale)' : 'white', borderLeft: isActive ? '4px solid var(--green-mid)' : '4px solid transparent' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.5rem' }}>
                    <div style={{ fontWeight: 700, fontSize: '.88rem' }}>📁 {p.nom}</div>
                    {rows.length > 0 && (
                      <span style={{ fontSize: '.68rem', fontWeight: 700, background: 'var(--green-mid)', color: 'white', padding: '.1rem .5rem', borderRadius: 50, flexShrink: 0 }}>{rows.length}</span>
                    )}
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-muted)', marginTop: 2 }}>
                    {p.surface ? `${p.surface} ha` : ''}{p.surface && p.entite ? ' · ' : ''}{p.entite || ''}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Détail du dossier */}
      {(!isMobile || active) && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!active ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>
              <div>
                <div style={{ fontSize: '2.2rem', marginBottom: '.5rem' }}>📁</div>
                <p style={{ fontSize: '.88rem' }}>Sélectionnez une parcelle dans la liste</p>
              </div>
            </div>
          ) : (() => {
            const rows = rowsFor(active)
            const stats = renderStats(active, rows)
            return (
              <>
                <div style={{ background: 'var(--green-deep)', padding: '.9rem 1.3rem', display: 'flex', alignItems: 'center', gap: '.8rem', flexWrap: 'wrap' }}>
                  {isMobile && (
                    <button onClick={() => setDossierId(null)} className="btn-sm"
                      style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.3)' }}>← Retour</button>
                  )}
                  <div style={{ flex: 1, minWidth: 140 }}>
                    <h2 style={{ color: 'white', fontSize: '1.1rem', fontWeight: 700 }}>📁 {active.nom}</h2>
                    <div style={{ fontSize: '.75rem', color: 'rgba(255,255,255,.7)' }}>
                      {active.surface ? `${active.surface} ha` : ''}{active.surface && active.entite ? ' · ' : ''}{active.entite || ''}
                      {active.culture_actuelle ? ` · ${active.culture_actuelle}` : ''}
                    </div>
                  </div>
                  {headerExtra && headerExtra(active)}
                  <button className="btn-sm" onClick={() => onAdd(active)}
                    style={{ background: 'var(--green-accent)', color: 'white', borderColor: 'var(--green-light)', fontWeight: 700 }}>{addLabel}</button>
                </div>

                {/* Stats */}
                <div style={{ display: 'flex', gap: '.6rem', padding: '.8rem 1.3rem', background: 'white', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
                  {stats.map(s => (
                    <div key={s.label} style={{ background: s.accent ? 'var(--green-pale)' : 'var(--cream)', borderRadius: 9, padding: '.4rem .8rem', minWidth: 86 }}>
                      <div style={{ fontSize: '.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{s.label}</div>
                      <div style={{ fontSize: '.95rem', fontWeight: 700, color: s.accent ? 'var(--green-mid)' : 'var(--ink)' }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Saisies du dossier */}
                <div style={{ flex: 1, overflow: 'auto', padding: '1rem 1.3rem' }}>
                  {beforeRows && beforeRows(active, rows)}
                  {rows.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-muted)', background: 'white', borderRadius: 12, border: '1px solid var(--border)', fontSize: '.86rem' }}>
                      Aucune saisie pour cette parcelle — cliquez "{addLabel}".
                    </div>
                  ) : (
                    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                      <table style={{ width: '100%', minWidth: 520, fontSize: '.82rem', borderCollapse: 'collapse' }}>
                        <thead style={{ background: 'var(--cream)' }}>
                          <tr>
                            {rowHeaders.map(h => (
                              <th key={h} style={{ padding: '.5rem .75rem', textAlign: 'left', fontSize: '.68rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(r => (
                            <tr key={r.id} onClick={() => onRowClick(r)} style={{ cursor: 'pointer' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                              onMouseLeave={e => e.currentTarget.style.background = ''}>
                              {renderRow(r).map((cell, i) => (
                                <td key={i} style={{ padding: '.55rem .75rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontWeight: i === 0 ? 400 : undefined }}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}
