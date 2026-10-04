import { useEffect, useRef, useState } from 'react'
import type { EnvironmentRef, VariablePreviews } from '@schwabyio/gravity-core/model'
import type { useEnvironmentEditor } from '../hooks/useEnvironmentEditor.js'
import SaveStatus from './SaveStatus.js'
import VariablesEditor from './VariablesEditor.js'
import FlagConditionsEditor from './FlagConditionsEditor.js'
import OpenInEditor from './OpenInEditor.js'

interface Props {
  /** The environments the open collection can choose from. */
  environments: EnvironmentRef[]
  /** The collection they belong to; a new environment is made for it. */
  collectionPath: string
  /** The environment chosen for runs, opened first. */
  selected: string | null
  editor: ReturnType<typeof useEnvironmentEditor>
  autoSave: boolean
  /** An environment was created or deleted; `name` is the one to choose, if any. */
  onCreated: (name: string) => void
  onDeleted: (name: string) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  onClose: () => void
}

/**
 * The environment files beside the open collection, in a drawer: pick one on
 * the left, edit its name and variables on the right, add or delete one.
 * Edits save like a collection's; a secret is declared here and never holds a
 * value — that comes from the process environment or `.env`.
 */
export default function EnvironmentsDrawer(props: Props) {
  const { environments, editor, onClose } = props
  const { open } = editor
  const panel = useRef<HTMLElement>(null)
  const byName = (name: string | null) => environments.find((env) => env.name === name)?.path
  const [current, setCurrent] = useState<string | null>(
    byName(props.selected) ?? environments[0]?.path ?? null
  )
  const [adding, setAdding] = useState(environments.length === 0)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // A file just created, until the rescan lists it.
  const [created, setCreated] = useState<string | null>(null)

  // Follow the list: a file deleted — here or on disk — falls back to the first.
  useEffect(() => {
    if (current && environments.some((env) => env.path === current)) {
      if (current === created) setCreated(null)
      return
    }
    if (current && current === created) return
    setCurrent(environments[0]?.path ?? null)
  }, [environments, current, created])

  useEffect(() => {
    if (current) void open(current).catch((cause: Error) => setError(cause.message))
  }, [current, open])

  // Focus the drawer once, on opening — never again on a re-render, or typing
  // would lose its field whenever a save lands.
  useEffect(() => panel.current?.focus(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const doc = current ? editor.docFor(current) : null
  const status = current ? editor.status(current) : null
  const ref = environments.find((env) => env.path === current)
  const fileName = current?.split(/[\\/]/).pop() ?? ''

  const create = async () => {
    const name = newName.trim()
    if (name === '') return
    try {
      const path = await editor.create(props.collectionPath, name)
      setAdding(false)
      setNewName('')
      setError(null)
      setCreated(path)
      setCurrent(path)
      props.onCreated(name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const remove = async () => {
    if (!current || !ref) return
    const shared = ref.source === 'global' ? ' It is shared: every project using it loses it.' : ''
    if (!window.confirm(`Delete the environment “${ref.name}”? This deletes ${fileName}.${shared}`))
      return
    try {
      await editor.remove(current)
      props.onDeleted(ref.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        ref={panel}
        className="drawer environments-drawer"
        role="dialog"
        aria-label="Environments"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>Environments</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="env-layout">
          <nav className="env-list" aria-label="Environment files">
            {environments.map((env) => (
              <button
                key={env.path}
                type="button"
                className={env.path === current ? 'active' : ''}
                aria-current={env.path === current ? 'true' : undefined}
                onClick={() => setCurrent(env.path)}
              >
                {editor.docFor(env.path)?.name ?? env.name}
                {env.source === 'global' && <span className="shared-tag">shared</span>}
                {editor.hasPending(env.path) && (
                  <span className="step-dirty" title="Unsaved changes">
                    •
                  </span>
                )}
              </button>
            ))}
            {adding ? (
              <form
                className="env-new"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <input
                  autoFocus
                  value={newName}
                  placeholder="Name, e.g. staging"
                  aria-label="New environment name"
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && environments.length > 0) {
                      e.stopPropagation()
                      setAdding(false)
                    }
                  }}
                />
                <button type="submit" disabled={newName.trim() === ''}>
                  Create
                </button>
              </form>
            ) : (
              <button type="button" className="env-add" onClick={() => setAdding(true)}>
                + New environment
              </button>
            )}
          </nav>

          <div className="drawer-body env-detail">
            {error && (
              <p className="setting-error" role="alert">
                {error}
              </p>
            )}
            {!current && (
              <p className="hint">
                No environments yet. An environment holds the variables that differ between places
                you run against — a base URL, an account — in{' '}
                <code>environments/&lt;name&gt;.yml</code>.
              </p>
            )}
            {current && doc && (
              <>
                <div className="env-head">
                  <label className="env-name">
                    <span className="field-label">Name</span>
                    <input
                      value={doc.name ?? ''}
                      placeholder={fileName.replace(/\.yml$/, '')}
                      aria-label="Environment name"
                      onChange={(e) => editor.setName(current, e.target.value)}
                    />
                  </label>
                  {status && (
                    <SaveStatus
                      status={status}
                      autoSave={props.autoSave}
                      onSave={() => void editor.flush(current)}
                      onReload={() => editor.reload(current)}
                      onKeepMine={() => editor.keepMine(current)}
                    />
                  )}
                  <button type="button" className="danger env-delete" onClick={() => void remove()}>
                    Delete
                  </button>
                </div>
                {ref?.source === 'global' && (
                  <p className="shared-note" role="note">
                    Shared from the global project: a change here applies to every project that uses
                    it. A project’s own environment of the same name overrides it, key by key.
                  </p>
                )}
                <p className="hint">
                  <code>environments/{fileName}</code>
                  {/* The chosen environment's file, beside its name. */}
                  <OpenInEditor what={fileName} target={{ path: current }} /> · its variables
                  override the collection’s. A <strong>Secret</strong> is never written here: its
                  value comes from a variable of the same name in the process environment or{' '}
                  <code>.env</code>.
                </p>
                <VariablesEditor
                  vars={doc.vars}
                  onChange={(vars) => editor.setVars(current, vars)}
                  allowSecrets
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
                <section className="env-flags" aria-labelledby="env-flags-title">
                  <h3 id="env-flags-title">Feature flags</h3>
                  <p className="hint">
                    A <strong>command</strong> fetches fresh values before a run — from a flag
                    service, say — printing a JSON object such as{' '}
                    <code>{'{"newCheckout": true}'}</code>. It runs in the project folder; its
                    values win over the fixed ones here.
                  </p>
                  <label className="env-flag-command">
                    <span className="field-label">Command</span>
                    <input
                      value={doc.flags?.command ?? ''}
                      placeholder="node scripts/flags.mjs staging"
                      aria-label="Feature flag command"
                      spellCheck={false}
                      onChange={(e) =>
                        editor.setFlags(current, { ...doc.flags, command: e.target.value })
                      }
                    />
                  </label>
                  <FlagConditionsEditor
                    owner="environment"
                    conditions={doc.flags?.values}
                    onChange={(values) =>
                      editor.setFlags(current, {
                        ...doc.flags,
                        ...(values ? { values } : { values: undefined })
                      })
                    }
                    addLabel="+ Add a fixed flag value"
                  />
                </section>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  )
}
