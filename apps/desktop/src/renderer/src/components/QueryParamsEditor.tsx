import type { VariablePreviews } from '@schwabyio/gravity-core/model'
import { readQueryParams, writeQueryParams } from '../requestState.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

interface Props {
  url: string
  onUrlChange: (url: string) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}

/**
 * Query parameters are a view over the URL rather than separate state.
 *
 * The format keeps the URL authoritative when a request is sent, so editing the
 * table rewrites the URL and the two can never drift apart.
 */
export default function QueryParamsEditor({ url, onUrlChange, previews, onCopyVariable }: Props) {
  const params = [...readQueryParams(url), { name: '', value: '' }]

  const update = (index: number, patch: { name?: string; value?: string }) => {
    const next = params.map((p, i) => (i === index ? { ...p, ...patch } : p))
    onUrlChange(writeQueryParams(url, next))
  }

  const remove = (index: number) => {
    onUrlChange(
      writeQueryParams(
        url,
        params.filter((_, i) => i !== index)
      )
    )
  }

  return (
    <>
      <p className="hint">
        Query parameters mirror the URL — editing either one updates the other.
      </p>
      <table className="kv">
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th className="kv-action" />
          </tr>
        </thead>
        <tbody>
          {params.map((param, index) => (
            <tr key={index}>
              <td>
                <input
                  value={param.name}
                  placeholder="Name"
                  onChange={(e) => update(index, { name: e.target.value })}
                />
              </td>
              <td>
                <VariableInput
                  value={param.value}
                  onChange={(value) => update(index, { value })}
                  previews={previews}
                  onCopy={onCopyVariable}
                  placeholder="Value"
                  ariaLabel={`Value for ${param.name || 'new parameter'}`}
                />
              </td>
              <td className="kv-action">
                {index < params.length - 1 && (
                  <Tooltip text="Remove this parameter from the URL">
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      aria-label="Remove parameter"
                    >
                      &times;
                    </button>
                  </Tooltip>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
