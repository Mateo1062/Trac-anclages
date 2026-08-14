import { useState, Fragment } from 'react'
import useIsMobile from '../lib/useIsMobile'

export default function DataTable({ columns, rows, onRowClick, emptyMessage = 'Aucune donnée', selectable, selectedIds, onToggleSelect, onToggleSelectAll, rowSelectable = () => true }) {
  // Sur écran étroit (tablette), les colonnes secondaires marquées hideOnNarrow
  // sortent du tableau (pour éviter le défilement horizontal) mais restent
  // consultables via une ligne de détail dépliable — jamais perdues.
  const isNarrow = useIsMobile(1100)
  const [expanded, setExpanded] = useState(() => new Set())
  const extraCols = isNarrow ? columns.filter(c => c.hideOnNarrow) : []
  const visibleCols = columns.filter(c => !(c.hideOnNarrow && isNarrow))
  columns = visibleCols
  const toggleExpand = (id, e) => {
    e.stopPropagation()
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  if (!rows.length) {
    return (
      <div className="tbl-wrap" style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        {emptyMessage}
      </div>
    )
  }
  // Ne compte que les lignes réellement sélectionnables (voir rowSelectable) —
  // sinon une seule ligne exclue (ex. ligne fusionnée en lecture seule)
  // empêcherait "tout cocher" de jamais s'afficher coché.
  const selectableRows = selectable ? rows.filter(rowSelectable) : []
  const allSelected = selectable && selectableRows.length > 0 && selectableRows.every(r => selectedIds?.has(r.id))
  return (
    <div style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <table style={{ width: '100%', minWidth: 480, fontSize: '.85rem', borderCollapse: 'collapse' }}>
        <thead style={{ background: 'var(--cream)' }}>
          <tr>
            {selectable && (
              <th style={{ padding: '.7rem .6rem', borderBottom: '1px solid var(--border)', width: 34 }}>
                <input type="checkbox" checked={allSelected} onChange={onToggleSelectAll} onClick={e => e.stopPropagation()} />
              </th>
            )}
            {columns.map(col => (
              <th key={col.key} style={{ padding: '.7rem 1rem', textAlign: 'left', fontSize: '.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>
                {col.label}
              </th>
            ))}
            <th style={{ borderBottom: '1px solid var(--border)' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowId = row.id || i
            const isOpen = expanded.has(rowId)
            return (
            <Fragment key={rowId}>
              <tr style={{ cursor: onRowClick ? 'pointer' : 'default' }} onClick={() => onRowClick?.(row)}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--green-pale)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}>
                {selectable && (
                  <td style={{ padding: '.7rem .6rem', borderBottom: '1px solid var(--border)' }} onClick={e => e.stopPropagation()}>
                    {rowSelectable(row) && (
                      <input type="checkbox" checked={selectedIds?.has(row.id) || false} onChange={() => onToggleSelect(row.id)} />
                    )}
                  </td>
                )}
                {columns.map(col => (
                  <td key={col.key} style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)' }}>
                    {col.render ? col.render(row) : (row[col.key] ?? '–')}
                  </td>
                ))}
                <td style={{ padding: '.7rem 1rem', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {extraCols.length > 0 && (
                    <button type="button" onClick={e => toggleExpand(rowId, e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.85rem', color: 'var(--green-accent)', padding: '.2rem .4rem' }}>
                      {isOpen ? '▾' : '▸'}
                    </button>
                  )}
                  {onRowClick && <span style={{ fontSize: '.78rem', color: 'var(--green-accent)' }}>✏️</span>}
                </td>
              </tr>
              {isOpen && extraCols.length > 0 && (
                <tr>
                  <td colSpan={columns.length + (selectable ? 2 : 1)} style={{ padding: '.6rem 1.2rem .9rem', borderBottom: '1px solid var(--border)', background: 'var(--cream)' }} onClick={e => e.stopPropagation()}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '.35rem' }}>
                      {extraCols.map(col => (
                        <div key={col.key} style={{ display: 'flex', gap: '.5rem', fontSize: '.82rem' }}>
                          <span style={{ fontWeight: 700, color: 'var(--text-muted)', minWidth: 130 }}>{col.label} :</span>
                          <span>{col.render ? col.render(row) : (row[col.key] ?? '–')}</span>
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
