import { useState } from 'react'
import type { VariablePreviews } from '@schwabyio/gravity-core/model'
import { newPart, type PartRow } from '../requestState.js'
import Tooltip from './Tooltip.js'
import VariableInput from './VariableInput.js'

interface Props {
  rows: PartRow[]
  onChange: (rows: PartRow[]) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  /** Pick a file to upload, as a path from the project folder; absent outside a project. */
  onPickFile?: (() => Promise<string | null>) | undefined
}

/**
 * A multipart body (SPEC.md §2.2): a row per part, text or a file from the
 * project folder, with an always-present blank row at the bottom. A name on
 * several rows is sent once for each.
 */
export default function MultipartEditor({
  rows,
  onChange,
  previews,
  onCopyVariable,
  onPickFile
}: Props) {
  const [error, setError] = useState<string | null>(null)

  const update = (id: string, patch: Partial<PartRow>) => {
    const next = rows.map((row) => (row.id === id ? { ...row, ...patch } : row))
    const last = next[next.length - 1]
    if (last && (last.name !== '' || last.value !== '' || last.kind === 'file'))
      next.push(newPart())
    onChange(next)
  }

  const remove = (id: string) => {
    const next = rows.filter((row) => row.id !== id)
    onChange(next.length > 0 ? next : [newPart()])
  }

  const choose = async (row: PartRow) => {
    if (!onPickFile) return
    try {
      const picked = await onPickFile()
      setError(null)
      // A part picked with no name yet is named after its file.
      if (picked) update(row.id, { value: picked, name: row.name || stem(picked) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <table className="kv multipart" aria-label="Multipart parts">
        <thead>
          <tr>
            <th className="part-name">Name</th>
            <th className="part-kind">Type</th>
            <th>Value</th>
            <th className="part-type">Content type</th>
            <th className="kv-action" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = row.name || 'new part'
            return (
              <tr key={row.id}>
                <td>
                  <input
                    value={row.name}
                    placeholder="Name"
                    aria-label={`Name of ${label}`}
                    onChange={(e) => update(row.id, { name: e.target.value })}
                  />
                </td>
                <td className="part-kind">
                  <select
                    value={row.kind}
                    aria-label={`Type of ${label}`}
                    onChange={(e) => update(row.id, { kind: e.target.value as PartRow['kind'] })}
                  >
                    <option value="text">Text</option>
                    <option value="file">File</option>
                  </select>
                </td>
                <td>
                  {row.kind === 'text' ? (
                    <VariableInput
                      value={row.value}
                      onChange={(value) => update(row.id, { value })}
                      previews={previews}
                      onCopy={onCopyVariable}
                      placeholder="Value"
                      ariaLabel={`Value of ${label}`}
                    />
                  ) : (
                    <div className="part-file">
                      <input
                        value={row.value}
                        placeholder="files/avatar.png"
                        spellCheck={false}
                        aria-label={`File for ${label}`}
                        onChange={(e) => update(row.id, { value: e.target.value })}
                      />
                      {onPickFile && (
                        <Tooltip text="Choose a file in the project folder">
                          <button
                            type="button"
                            aria-label={`Choose a file for ${label}`}
                            onClick={() => void choose(row)}
                          >
                            &hellip;
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  )}
                </td>
                <td className="part-type">
                  <input
                    value={row.contentType}
                    placeholder={row.kind === 'file' ? 'Auto' : 'None'}
                    spellCheck={false}
                    aria-label={`Content type of ${label}`}
                    onChange={(e) => update(row.id, { contentType: e.target.value })}
                  />
                </td>
                <td className="kv-action">
                  <Tooltip text="Remove this part">
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
      <p className="hint">
        {onPickFile
          ? 'A file’s path is from the project folder, and can use {{variables}}.'
          : 'Save the collection in a project to send files: their paths are from its folder.'}{' '}
        A name on more than one row is sent once for each.
      </p>
      {error && (
        <p className="setting-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/** A file body (SPEC.md §2.2): one file from the project folder, sent as it is. */
export function FileBodyEditor(props: {
  value: string
  onChange: (value: string) => void
  onPickFile?: (() => Promise<string | null>) | undefined
}) {
  const { value, onChange, onPickFile } = props
  const [error, setError] = useState<string | null>(null)
  const choose = async () => {
    if (!onPickFile) return
    try {
      const picked = await onPickFile()
      setError(null)
      if (picked) onChange(picked)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <div className="body-file">
      <div className="part-file">
        <input
          value={value}
          placeholder="files/order.json"
          spellCheck={false}
          aria-label="Body file"
          onChange={(e) => onChange(e.target.value)}
        />
        {onPickFile && (
          <button type="button" onClick={() => void choose()}>
            Choose file&hellip;
          </button>
        )}
      </div>
      <p className="hint">
        Sent as it is, with a Content-Type from its extension unless a header sets one.{' '}
        {onPickFile
          ? 'The path is from the project folder, and can use {{variables}}.'
          : 'Save the collection in a project to send a file: the path is from its folder.'}
      </p>
      {error && (
        <p className="setting-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** A file's name without its folder or extension: `files/avatar.png` → `avatar`. */
const stem = (file: string) => (file.split('/').pop() ?? file).replace(/\.[^.]*$/, '')
