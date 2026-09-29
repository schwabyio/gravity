import type { VariablePreviews } from '@schwabyio/gravity-core/model'
import type { HeaderRow } from '../requestState.js'
import { newRow } from '../requestState.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

interface Props {
  rows: HeaderRow[]
  onChange: (rows: HeaderRow[]) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  nameLabel?: string
  valueLabel?: string
}

/** Editable name/value table with an always-present blank row at the bottom. */
export default function KeyValueEditor({
  rows,
  onChange,
  previews,
  onCopyVariable,
  nameLabel = 'Name',
  valueLabel = 'Value'
}: Props) {
  const update = (id: string, patch: Partial<HeaderRow>) => {
    const next = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    const last = next[next.length - 1]
    if (last && (last.name !== '' || last.value !== '')) next.push(newRow())
    onChange(next)
  }

  const remove = (id: string) => {
    const next = rows.filter((row) => row.id !== id)
    onChange(next.length > 0 ? next : [newRow()])
  }

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="kv-check" />
          <th>{nameLabel}</th>
          <th>{valueLabel}</th>
          <th className="kv-action" />
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="kv-check">
              <Tooltip text={row.enabled ? 'Sent with the request' : 'Not sent; kept in the file'}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => update(row.id, { enabled: e.target.checked })}
                  aria-label={`Enable ${row.name || 'row'}`}
                />
              </Tooltip>
            </td>
            <td>
              <input
                value={row.name}
                placeholder={nameLabel}
                onChange={(e) => update(row.id, { name: e.target.value })}
              />
            </td>
            <td>
              <VariableInput
                value={row.value}
                onChange={(value) => update(row.id, { value })}
                previews={previews}
                onCopy={onCopyVariable}
                placeholder={valueLabel}
                ariaLabel={`Value for ${row.name || 'new header'}`}
              />
            </td>
            <td className="kv-action">
              <Tooltip text="Remove this header">
                <button type="button" onClick={() => remove(row.id)} aria-label="Remove row">
                  &times;
                </button>
              </Tooltip>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
