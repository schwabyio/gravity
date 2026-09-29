import { useEffect, useState } from 'react'
import type { EnvironmentVar, VarValue, VariablePreviews } from '@schwabyio/gravity-core/model'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

type VarType = 'text' | 'number' | 'boolean' | 'null' | 'secret'

/** Variables as written: a plain value, or — in an environment — the long form. */
type VarMap = Record<string, EnvironmentVar>

interface VarRow {
  id: string
  name: string
  type: VarType
  /** The value as typed; read by `type` when saved. */
  text: string
}

interface Props {
  vars: VarMap | undefined
  onChange: (vars: VarMap | undefined) => void
  /** Offer the Secret type: an environment's, never a collection's. */
  allowSecrets?: boolean
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}

let rowCounter = 0
const blankRow = (): VarRow => ({ id: `var-${++rowCounter}`, name: '', type: 'text', text: '' })

const typeOf = (value: VarValue): VarType =>
  value === null
    ? 'null'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'boolean'
        ? 'boolean'
        : 'text'

/** The long form `{ value, secret, description }`, or null for a plain value. */
const longForm = (declared: EnvironmentVar | undefined) =>
  declared !== null && typeof declared === 'object' ? declared : null

function toRows(vars: VarMap | undefined): VarRow[] {
  const rows = Object.entries(vars ?? {}).map(([name, declared]) => {
    const long = longForm(declared)
    if (long?.secret) return { ...blankRow(), name, type: 'secret' as const, text: '' }
    const value = long ? (long.value ?? null) : (declared as VarValue)
    return { ...blankRow(), name, type: typeOf(value), text: value === null ? '' : String(value) }
  })
  return [...rows, blankRow()]
}

/** Why a row cannot be saved as it stands, or null. */
function problemWith(row: VarRow, rows: VarRow[]): string | null {
  const name = row.name.trim()
  if (name === '') return null
  if (rows.some((other) => other !== row && other.name.trim() === name)) return 'Already used'
  if (row.type === 'number' && (row.text.trim() === '' || !Number.isFinite(Number(row.text)))) {
    return 'Not a number'
  }
  return null
}

/**
 * The rows as the map they save as, or null while any of them is not valid.
 * A variable written in the long form keeps it, and its description, given
 * the map it was read from.
 */
function toVars(rows: VarRow[], original: VarMap | undefined): VarMap | null {
  const vars: VarMap = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '') continue
    if (problemWith(row, rows)) return null
    const { value: _value, secret: _secret, ...rest } = longForm(original?.[name]) ?? {}
    if (row.type === 'secret') {
      vars[name] = { secret: true, ...rest }
      continue
    }
    const value =
      row.type === 'number'
        ? Number(row.text)
        : row.type === 'boolean'
          ? row.text === 'true'
          : row.type === 'null'
            ? null
            : row.text
    vars[name] = Object.keys(rest).length > 0 ? { value, ...rest } : value
  }
  return vars
}

/** What a value's text becomes when its type changes. */
function convert(text: string, type: VarType): string {
  if (type === 'boolean') return text === 'true' ? 'true' : 'false'
  if (type === 'null' || type === 'secret') return ''
  return text
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/**
 * Variables — a collection's or an environment's: a name, a type and a value per row, with a blank
 * row to add one. The type is chosen, never guessed, so `'2'` stays a string
 * and `2` a number. A row that is not valid yet — a name used twice, a number
 * that is not one — is marked and holds back the save until it is fixed.
 */
export default function VariablesEditor({
  vars,
  onChange,
  allowSecrets = false,
  previews,
  onCopyVariable
}: Props) {
  const [rows, setRows] = useState<VarRow[]>(() => toRows(vars))
  // Follow a change from outside (a reload), but not the echo of our own.
  useEffect(() => {
    setRows((current) => {
      const mine = toVars(current, vars)
      return mine === null || same(mine, vars) ? current : toRows(vars)
    })
  }, [vars])

  const commit = (next: VarRow[]) => {
    const last = next[next.length - 1]
    if (!last || last.name !== '' || last.text !== '') next = [...next, blankRow()]
    setRows(next)
    const saved = toVars(next, vars)
    if (saved !== null) onChange(Object.keys(saved).length > 0 ? saved : undefined)
  }
  const update = (id: string, patch: Partial<VarRow>) =>
    commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const remove = (id: string) => {
    const next = rows.filter((row) => row.id !== id)
    commit(next.length > 0 ? next : [blankRow()])
  }

  return (
    <table className="kv vars">
      <thead>
        <tr>
          <th>Name</th>
          <th className="var-type">Type</th>
          <th>Value</th>
          <th className="kv-action" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const label = row.name.trim() || 'new variable'
          const problem = problemWith(row, rows)
          return (
            <tr key={row.id} className={problem ? 'invalid' : ''}>
              <td>
                <input
                  value={row.name}
                  placeholder="Name"
                  aria-label="Variable name"
                  aria-invalid={problem === 'Already used'}
                  onChange={(e) => update(row.id, { name: e.target.value })}
                />
                {problem && (
                  <span className="var-problem" role="alert">
                    {problem}
                  </span>
                )}
              </td>
              <td className="var-type">
                <select
                  value={row.type}
                  aria-label={`Type of ${label}`}
                  onChange={(e) => {
                    const type = e.target.value as VarType
                    update(row.id, { type, text: convert(row.text, type) })
                  }}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="null">Null</option>
                  {allowSecrets && <option value="secret">Secret</option>}
                </select>
              </td>
              <td>
                {row.type === 'text' ? (
                  <VariableInput
                    value={row.text}
                    onChange={(text) => update(row.id, { text })}
                    previews={previews}
                    onCopy={onCopyVariable}
                    placeholder="Value"
                    ariaLabel={`Value of ${label}`}
                  />
                ) : row.type === 'boolean' ? (
                  <select
                    value={row.text}
                    aria-label={`Value of ${label}`}
                    onChange={(e) => update(row.id, { text: e.target.value })}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : row.type === 'secret' ? (
                  <input
                    type="text"
                    disabled
                    value=""
                    className="secret-value"
                    placeholder={`From ${row.name.trim() || 'its name'} in the environment or .env`}
                    aria-label={`Value of ${label}`}
                  />
                ) : (
                  <input
                    type="text"
                    inputMode={row.type === 'number' ? 'decimal' : undefined}
                    value={row.text}
                    disabled={row.type === 'null'}
                    placeholder={row.type === 'null' ? 'null' : '0'}
                    aria-label={`Value of ${label}`}
                    aria-invalid={problem === 'Not a number'}
                    onChange={(e) => update(row.id, { text: e.target.value })}
                  />
                )}
              </td>
              <td className="kv-action">
                <Tooltip text="Remove this variable">
                  <button type="button" onClick={() => remove(row.id)} aria-label="Remove row">
                    &times;
                  </button>
                </Tooltip>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
