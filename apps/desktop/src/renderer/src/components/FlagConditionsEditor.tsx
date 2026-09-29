import { useEffect, useState } from 'react'
import { parseFlagValue, type FlagConditions, type FlagValue } from '@schwabyio/gravity-core/model'
import { conditionsState, showFlagValue } from '../flagState.js'
import Tooltip from './Tooltip.js'

interface Row {
  id: string
  name: string
  value: string
}

let rowCounter = 0
const newRow = (name = '', value = ''): Row => ({ id: `flag-${++rowCounter}`, name, value })

const rowsOf = (conditions: Record<string, FlagValue> | undefined): Row[] =>
  Object.entries(conditions ?? {}).map(([name, value]) => newRow(name, showFlagValue(value)))

/** The rows with a name, as the map they save as — typed like the CLI: `true`, `2`, `v2`. */
const toConditions = (rows: Row[]): Record<string, FlagValue> | undefined => {
  const named = rows.filter((row) => row.name.trim() !== '')
  if (named.length === 0) return undefined
  return Object.fromEntries(named.map((row) => [row.name.trim(), parseFlagValue(row.value)]))
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/**
 * Feature flag conditions (SPEC.md §2.9), or an environment's fixed flag
 * values: rows of a flag name and the value it must have. Each condition shows
 * whether it holds with the flags the app is running with. An empty editor
 * saves as no `flags` at all.
 */
export default function FlagConditionsEditor(props: {
  conditions: Record<string, FlagValue> | undefined
  onChange: (conditions: Record<string, FlagValue> | undefined) => void
  /** The current flag values, to mark each condition; omit for plain values. */
  values?: Record<string, FlagValue> | null
  /** For the rows' accessible names: `collection`, `step`, `environment`. */
  owner: string
  addLabel?: string
}) {
  const { conditions, onChange } = props
  const [rows, setRows] = useState<Row[]>(() => rowsOf(conditions))

  // A change from outside — a reload, another step selected — resets the rows.
  useEffect(() => {
    setRows((current) => (same(toConditions(current), conditions) ? current : rowsOf(conditions)))
  }, [conditions])

  const change = (next: Row[]) => {
    setRows(next)
    onChange(toConditions(next) as FlagConditions | undefined)
  }

  return (
    <div className="flag-conditions" role="group" aria-label={`${props.owner} feature flags`}>
      {rows.length > 0 && (
        <table className="kv">
          <thead>
            <tr>
              <th>Flag</th>
              <th>Value</th>
              <th className="kv-action" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state =
                props.values !== undefined && row.name.trim() !== ''
                  ? conditionsState({ [row.name.trim()]: parseFlagValue(row.value) }, props.values)
                  : undefined
              return (
                <tr key={row.id}>
                  <td>
                    <input
                      value={row.name}
                      placeholder="newCheckout"
                      aria-label={`${props.owner} flag name`}
                      onChange={(e) =>
                        change(
                          rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r))
                        )
                      }
                    />
                  </td>
                  <td>
                    <div className="flag-value-cell">
                      <input
                        value={row.value}
                        placeholder="true"
                        aria-label={`${props.owner} flag ${row.name || 'new'} value`}
                        onChange={(e) =>
                          change(
                            rows.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r))
                          )
                        }
                      />
                      {state !== undefined && (
                        <Tooltip
                          text={
                            state === null
                              ? 'Holds with the current flags'
                              : state.kind === 'skip'
                                ? `Does not hold: ${state.reason}`
                                : state.message
                          }
                        >
                          <span
                            className={`flag-holds ${state === null ? 'yes' : state.kind}`}
                            aria-label={
                              state === null
                                ? 'holds'
                                : state.kind === 'skip'
                                  ? 'does not hold'
                                  : 'unknown flag'
                            }
                          >
                            {state === null ? '✓' : state.kind === 'skip' ? '✗' : '?'}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </td>
                  <td className="kv-action">
                    <Tooltip text="Remove this flag">
                      <button
                        type="button"
                        onClick={() => change(rows.filter((r) => r.id !== row.id))}
                        aria-label={`Remove ${props.owner} flag ${row.name}`}
                      >
                        &times;
                      </button>
                    </Tooltip>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <button type="button" className="add-flag" onClick={() => setRows([...rows, newRow()])}>
        {props.addLabel ?? '+ Add flag'}
      </button>
    </div>
  )
}
