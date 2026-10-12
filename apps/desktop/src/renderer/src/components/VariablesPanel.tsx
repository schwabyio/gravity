import { useMemo, useState, type ReactNode } from 'react'
import type { RuntimeVariablesView } from '@shared/ipc.js'
import type { PaneWidth } from '../hooks/usePaneWidth.js'
import { filterVariables, runtimeSummary, setByLabel } from '../runtimeVars.js'
import CopyButton from './CopyButton.js'
import InfoTip from './InfoTip.js'
import Resizer from './Resizer.js'

export interface RuntimeVariablesProps {
  /** What the open collection's Sends and runs set; null for nothing yet. */
  view: RuntimeVariablesView | null
  /** Whether a collection is open: with none, there is nothing to show. */
  collectionOpen: boolean
  /** Forget them: the collection's next Send starts from nothing. */
  onClear: () => void
  /** Copies a value; main resolves it, so a secret's stays out of here. */
  onCopy: (name: string) => Promise<boolean>
}

interface Props extends RuntimeVariablesProps {
  /** Its height, which its top edge drags. */
  pane: PaneWidth
  /** The bottom panel's tabs, where its heading would be. */
  tabs: ReactNode
  onClose: () => void
}

/**
 * The Variables tab: what the open collection's Sends and runs set with
 * `gta.set` and captures, each with the step that set it last — the values
 * its next Sends start from.
 */
export default function VariablesPanel({
  view,
  collectionOpen,
  onClear,
  onCopy,
  pane,
  tabs,
  onClose
}: Props) {
  const [query, setQuery] = useState('')
  const variables = view?.variables ?? []
  const shown = useMemo(() => filterVariables(variables, query), [variables, query])

  return (
    <section className="console-panel" aria-label="Variables" style={{ height: pane.width }}>
      <Resizer pane={pane} label="Resize the variables" edge="top" />
      <div className="console-head">
        {tabs}
        <InfoTip
          about="variables"
          text={
            <>
              What this collection&apos;s Sends and runs set with <code>gta.set</code> and checks
              capture. Each Send starts from them, as the steps of a run share theirs; Run all
              starts from nothing, and what it sets is kept after it. Clear, or another environment,
              forgets them.
            </>
          }
        />
        {view && <span className="variables-summary">{runtimeSummary(view)}</span>}
        <span className="spacer" />
        <input
          type="search"
          className="console-filter"
          placeholder="Filter"
          aria-label="Filter the variables"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
        />
        <button type="button" onClick={onClear} disabled={!view}>
          Clear
        </button>
        <button
          type="button"
          className="console-close"
          aria-label="Close the variables"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="variables-body">
        {!collectionOpen ? (
          <p className="console-note">Open a collection to see what its Sends and runs set.</p>
        ) : variables.length === 0 ? (
          <p className="console-note">
            Nothing set yet: what a step&apos;s scripts set and its checks capture shows here after
            a Send or Run all.
          </p>
        ) : shown.length === 0 ? (
          <p className="console-note">Nothing here matches the filter.</p>
        ) : (
          <table className="variables-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">Set by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((variable) => (
                <tr key={variable.name}>
                  <th scope="row" className="variables-name">
                    {variable.name}
                  </th>
                  <td>
                    <div className="variables-value-row">
                      {variable.value === null ? (
                        <span className="variables-value hidden">Secret — hidden</span>
                      ) : (
                        <span className="variables-value" title={variable.value}>
                          {variable.value === '' ? '(empty)' : variable.value}
                        </span>
                      )}
                      <CopyButton
                        what={`the value of ${variable.name}`}
                        onCopy={() => onCopy(variable.name)}
                      />
                    </div>
                  </td>
                  <td className="variables-setter">{setByLabel(variable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
