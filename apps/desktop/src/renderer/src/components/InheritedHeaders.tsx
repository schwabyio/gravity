import type { Headers } from '@schwabyio/gravity-core/model'
import { isHeaderEnabled } from '@schwabyio/gravity-core/model'
import type { HeaderRow } from '../requestState.js'

interface Props {
  /** The collection's headers. */
  headers: Headers
  /** The step's own rows, to show which of the collection's they replace. */
  rows: HeaderRow[]
  onEdit: () => void
}

/**
 * The collection's headers under a step's own, read-only: what the step sends
 * without saying so, and which of them its own headers replace.
 */
export default function InheritedHeaders({ headers, rows, onEdit }: Props) {
  const mine = new Set(
    rows.filter((row) => row.enabled && row.name.trim() !== '').map((row) => row.name.toLowerCase())
  )
  const entries = Object.entries(headers).flatMap(([name, value]) =>
    typeof value === 'string'
      ? [{ name, value, on: true }]
      : Array.isArray(value)
        ? value.map((item) => ({ name, value: item, on: true }))
        : [{ name, value: value.value, on: isHeaderEnabled(value) }]
  )

  return (
    <section className="inherited-headers" aria-label="Headers from the collection">
      <div className="inherited-head">
        <span>From the collection</span>
        <button
          type="button"
          className="link"
          onClick={onEdit}
          aria-label="Edit the collection’s headers"
        >
          Edit
        </button>
      </div>
      <table className="kv readonly">
        <tbody>
          {entries.map(({ name, value, on }, index) => {
            const replaced = mine.has(name.toLowerCase())
            const note = replaced ? 'replaced by this step' : on ? '' : 'off'
            return (
              <tr key={`${name}-${index}`} className={replaced || !on ? 'unused' : ''}>
                <td className="header-name">{name}</td>
                <td className="wrap">{value}</td>
                <td className="inherited-note">{note}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
