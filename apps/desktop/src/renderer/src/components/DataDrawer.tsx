import { useEffect, useRef, useState } from 'react'
import type { VarValue } from '@schwabyio/gravity-core/model'
import {
  addColumn,
  addRow,
  cellText,
  moveRow,
  removeColumn,
  removeRow,
  renameColumn,
  setCell,
  type DataGrid
} from '../dataGrid.js'
import type { useDataFileEditor } from '../hooks/useDataFileEditor.js'
import SaveStatus from './SaveStatus.js'

interface Props {
  data: ReturnType<typeof useDataFileEditor>
  autoSave: boolean
  onClose: () => void
}

/**
 * A collection's data file (SPEC.md §2.8), over the right of the window: as a
 * grid — one row per run, one column per variable, edited in place — or as
 * its raw text, saved exactly as typed. Either way it saves like any other
 * file — auto save or ⌘S — and nothing with a problem (text that is not a
 * table, a column without a name or named twice, no rows) is written.
 */
export default function DataDrawer({ data, autoSave, onClose }: Props) {
  const panel = useRef<HTMLElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'grid' | 'raw'>(() => {
    try {
      return localStorage.getItem('data.view') === 'raw' ? 'raw' : 'grid'
    } catch {
      return 'grid'
    }
  })
  const show = (next: 'grid' | 'raw') => {
    setView(next)
    try {
      localStorage.setItem('data.view', next)
    } catch {
      // Remembering the view is a convenience; without storage it starts as the grid.
    }
  }
  const { grid } = data

  useEffect(() => panel.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const remove = async () => {
    if (!data.fileName) return
    if (!window.confirm(`Delete the data file ${data.fileName}? The collection then runs once.`))
      return
    try {
      await data.remove()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** A column name no other column has: `column3`. */
  const freshColumn = (current: DataGrid) => {
    let n = current.columns.length + 1
    while (current.columns.includes(`column${n}`)) n++
    return `column${n}`
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        ref={panel}
        className="drawer data-drawer"
        role="dialog"
        aria-label="Data file"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>
            Data file <span className="data-file-name">{data.fileName}</span>
          </h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="data-toolbar">
          {data.status && (
            <SaveStatus
              status={data.status}
              autoSave={autoSave}
              onSave={() => void data.flush()}
              onReload={data.reload}
              onKeepMine={data.keepMine}
            />
          )}
          <div className="tabs data-view-tabs" role="group" aria-label="Data file view">
            {(['grid', 'raw'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={view === option ? 'active' : ''}
                aria-pressed={view === option}
                onClick={() => show(option)}
              >
                {option === 'grid' ? 'Grid' : 'Raw'}
              </button>
            ))}
          </div>
          {grid && view === 'grid' && (
            <>
              <button type="button" onClick={() => data.edit((g) => addRow(g))}>
                + Row
              </button>
              <button type="button" onClick={() => data.edit((g) => addColumn(g, freshColumn(g)))}>
                + Column
              </button>
            </>
          )}
          <button type="button" className="danger data-delete" onClick={() => void remove()}>
            Delete data file
          </button>
        </div>

        <div className="drawer-body data-body">
          <p className="hint">
            gta runs the collection once per row, each column a variable for that run. An{' '}
            <code>iterationLabel</code> column names the row in reports.
            {grid?.kind === 'json' &&
              ' In a JSON file, true, false, null and numbers are stored as themselves.'}
          </p>
          {(error || data.problem) && (
            <p className="data-problem" role="alert">
              {error ?? data.problem}
            </p>
          )}
          {data.problems.length > 0 && (
            <ul className="data-problems" role="alert" aria-label="Data file problems">
              {data.problems.map((problem) => (
                <li key={problem}>{problem} — not saved until fixed</li>
              ))}
            </ul>
          )}
          {view === 'raw' && (
            <textarea
              className="data-raw"
              aria-label="Data file text"
              spellCheck={false}
              value={data.rawText}
              onChange={(e) => data.editRaw(e.target.value)}
            />
          )}
          {view === 'grid' && !grid && data.problem && (
            <p className="hint">The file is not a table the grid can show: fix it in Raw.</p>
          )}
          {view === 'grid' && grid && (
            <table className="data-grid">
              <thead>
                <tr>
                  <th className="row-index">#</th>
                  {grid.columns.map((column, c) => (
                    <th key={c}>
                      <span className="column-head">
                        <input
                          value={column}
                          aria-label={`Column ${c + 1} name`}
                          spellCheck={false}
                          onChange={(e) => data.edit((g) => renameColumn(g, c, e.target.value))}
                        />
                        <button
                          type="button"
                          className="icon"
                          aria-label={`Remove column ${column || c + 1}`}
                          onClick={() => data.edit((g) => removeColumn(g, c))}
                        >
                          ×
                        </button>
                      </span>
                    </th>
                  ))}
                  <th className="row-actions" />
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((cells, r) => (
                  <tr key={r}>
                    <td className="row-index">{r + 1}</td>
                    {grid.columns.map((column, c) => (
                      <td key={c}>
                        <Cell
                          value={cells[c]}
                          label={`Row ${r + 1} ${column || `column ${c + 1}`}`}
                          // JSON reads what is typed as a value: take it when typing is done.
                          commitOnBlur={grid.kind === 'json'}
                          onChange={(text) => data.edit((g) => setCell(g, r, c, text))}
                        />
                      </td>
                    ))}
                    <td className="row-actions">
                      <button
                        type="button"
                        className="icon"
                        aria-label={`Move row ${r + 1} up`}
                        disabled={r === 0}
                        onClick={() => data.edit((g) => moveRow(g, r, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="icon"
                        aria-label={`Move row ${r + 1} down`}
                        disabled={r === grid.rows.length - 1}
                        onClick={() => data.edit((g) => moveRow(g, r, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="icon"
                        aria-label={`Remove row ${r + 1}`}
                        onClick={() => data.edit((g) => removeRow(g, r))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </aside>
    </>
  )
}

/**
 * One cell. Its text is held while typed, so a JSON cell can pass through
 * `1.` on its way to `1.5` without being read as the number 1.
 */
function Cell(props: {
  value: VarValue | undefined
  label: string
  commitOnBlur: boolean
  onChange: (text: string) => void
}) {
  const [text, setText] = useState(cellText(props.value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(cellText(props.value))
  }, [props.value, focused])
  return (
    <input
      value={text}
      aria-label={props.label}
      spellCheck={false}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        setText(e.target.value)
        if (!props.commitOnBlur) props.onChange(e.target.value)
      }}
      onBlur={() => {
        setFocused(false)
        if (props.commitOnBlur && text !== cellText(props.value)) props.onChange(text)
      }}
    />
  )
}
