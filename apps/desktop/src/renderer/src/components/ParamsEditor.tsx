import { useEffect, useState } from 'react'
import { readParam, type ParamSpec, type VarValue } from '@schwabyio/gravity-core/model'

type Kind = 'text' | 'number' | 'boolean'

interface Row {
  id: string
  name: string
  required: boolean
  kind: Kind
  /** The default as typed; empty for none. */
  text: string
  description: string
}

type Params = Record<string, ParamSpec>

let counter = 0
const blank = (): Row => ({
  id: `param-${++counter}`,
  name: '',
  required: false,
  kind: 'text',
  text: '',
  description: ''
})

function toRows(params: Params | undefined): Row[] {
  const rows = Object.entries(params ?? {}).map(([name, spec]): Row => {
    const { required, default: fallback, description } = readParam(spec)
    return {
      ...blank(),
      name,
      required,
      kind:
        typeof fallback === 'number'
          ? 'number'
          : typeof fallback === 'boolean'
            ? 'boolean'
            : 'text',
      text: fallback === undefined || fallback === null ? '' : String(fallback),
      description: description ?? ''
    }
  })
  return [...rows, blank()]
}

const problemOf = (row: Row, rows: Row[]): string | null => {
  const name = row.name.trim()
  if (name === '') return null
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return 'Letters, digits and _ only, as params.name reads it'
  if (rows.some((other) => other !== row && other.name.trim() === name)) return 'Already used'
  if (
    !row.required &&
    row.kind === 'number' &&
    row.text.trim() !== '' &&
    !Number.isFinite(Number(row.text))
  )
    return 'Not a number'
  return null
}

/**
 * The rows as `params:` is written — as briefly as each allows: a plain
 * default; `{ required: true }`; the long form when there is a description.
 * Null while a row is not valid yet.
 */
function toParams(rows: Row[]): Params | null {
  const params: Params = {}
  for (const row of rows) {
    const name = row.name.trim()
    if (name === '') continue
    if (problemOf(row, rows)) return null
    const fallback: VarValue | undefined =
      row.required || (row.text === '' && row.kind !== 'boolean')
        ? undefined
        : row.kind === 'number'
          ? Number(row.text)
          : row.kind === 'boolean'
            ? row.text === 'true'
            : row.text
    const description = row.description.trim() === '' ? undefined : row.description
    if (row.required) params[name] = { required: true, ...(description ? { description } : {}) }
    else if (description) {
      params[name] = { ...(fallback !== undefined ? { default: fallback } : {}), description }
    } else params[name] = fallback === undefined ? {} : fallback
  }
  return params
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {})

/**
 * A request set's `params:` (SPEC.md §2.5): each input's name, whether a use
 * step must give it, its default and what it is for.
 */
export default function ParamsEditor(props: {
  params: Params | undefined
  onChange: (params: Params) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(props.params))
  useEffect(() => {
    setRows((current) => {
      const mine = toParams(current)
      return mine === null || same(mine, props.params) ? current : toRows(props.params)
    })
  }, [props.params])

  const commit = (next: Row[]) => {
    const last = next[next.length - 1]
    if (!last || last.name !== '') next = [...next, blank()]
    setRows(next)
    const params = toParams(next)
    if (params !== null) props.onChange(params)
  }
  const update = (id: string, patch: Partial<Row>) =>
    commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  return (
    <table className="kv params-table">
      <thead>
        <tr>
          <th>Name</th>
          <th className="param-required-col">Required</th>
          <th className="var-type">Type</th>
          <th>Default</th>
          <th>Description</th>
          <th className="kv-action" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const label = row.name.trim() || 'new param'
          const problem = problemOf(row, rows)
          return (
            <tr key={row.id}>
              <td>
                <input
                  value={row.name}
                  placeholder="name"
                  aria-label="Param name"
                  aria-invalid={problem !== null}
                  onChange={(e) => update(row.id, { name: e.target.value })}
                />
                {problem && (
                  <span className="var-problem" role="alert">
                    {problem}
                  </span>
                )}
              </td>
              <td className="param-required-col">
                <input
                  type="checkbox"
                  checked={row.required}
                  aria-label={`${label} is required`}
                  onChange={(e) => update(row.id, { required: e.target.checked })}
                />
              </td>
              <td className="var-type">
                <select
                  value={row.kind}
                  aria-label={`Type of ${label}`}
                  onChange={(e) => {
                    const kind = e.target.value as Kind
                    update(row.id, { kind, text: kind === 'boolean' ? 'false' : row.text })
                  }}
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                </select>
              </td>
              <td>
                {row.kind === 'boolean' && !row.required ? (
                  <select
                    value={row.text}
                    aria-label={`Default of ${label}`}
                    onChange={(e) => update(row.id, { text: e.target.value })}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    value={row.required ? '' : row.text}
                    disabled={row.required}
                    placeholder={row.required ? 'a use step gives it' : 'none'}
                    aria-label={`Default of ${label}`}
                    onChange={(e) => update(row.id, { text: e.target.value })}
                  />
                )}
              </td>
              <td>
                <input
                  value={row.description}
                  placeholder="What it is for"
                  aria-label={`Description of ${label}`}
                  onChange={(e) => update(row.id, { description: e.target.value })}
                />
              </td>
              <td className="kv-action">
                <button
                  type="button"
                  aria-label="Remove row"
                  onClick={() => {
                    const next = rows.filter((candidate) => candidate.id !== row.id)
                    commit(next.length > 0 ? next : [blank()])
                  }}
                >
                  &times;
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
