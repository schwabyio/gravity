import { useEffect, useRef, useState } from 'react'
import { parseFlagValue, type FlagValue } from '@schwabyio/gravity-core/model'
import type { FlagsView } from '@shared/ipc.js'
import { showFlagValue } from '../flagState.js'
import Tooltip from './Tooltip.js'

interface Props {
  view: FlagsView | null
  busy: boolean
  failure: string | null
  onRefresh: () => void
  onOverride: (name: string, value: FlagValue | null) => void
  /** Open the environments drawer, where the command and fixed values are edited. */
  onEditEnvironment: () => void
  onClose: () => void
}

const SOURCE_LABELS = {
  environment: 'environment file',
  command: 'command',
  override: 'override'
} as const

/**
 * The feature flags this project runs with in the chosen environment (SPEC.md
 * §2.9): each value and where it came from, the command that fetched them and
 * when, a Refresh that runs it again, and an override per flag — kept in the
 * app, never written to the repository — for trying a change locally.
 */
export default function FlagsDrawer(props: Props) {
  const { view, onClose } = props
  const panel = useRef<HTMLElement>(null)
  const [adding, setAdding] = useState('')

  useEffect(() => panel.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const names = Object.keys(view?.values ?? {}).sort((a, b) => a.localeCompare(b))

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside
        ref={panel}
        className="drawer flags-drawer"
        role="dialog"
        aria-label="Feature flags"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>Feature flags</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="drawer-body">
          {props.failure && (
            <p className="setting-error" role="alert">
              {props.failure}
            </p>
          )}
          {!view?.environment && (
            <p className="hint">
              Choose an environment: its file’s <code>flags</code> — fixed values, and a command
              that fetches fresh ones — are what a run uses.
            </p>
          )}
          {view?.environment && (
            <>
              <section aria-labelledby="flags-source-title">
                <h3 id="flags-source-title">Source</h3>
                {view.command ? (
                  <div className="flags-command">
                    <code>{view.command.command}</code>
                    <span className="hint">
                      ran {new Date(view.command.ranAt).toLocaleTimeString()}
                    </span>
                    <button type="button" onClick={props.onRefresh} disabled={props.busy}>
                      {props.busy ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </div>
                ) : (
                  <p className="hint">
                    No command: the values are the environment file’s <code>flags.values</code>.
                  </p>
                )}
                {view.error && (
                  <div className="flags-error" role="alert">
                    <strong>
                      The flags could not all be read, so runs use the fixed values and overrides
                      only.
                    </strong>
                    <pre>{view.error}</pre>
                  </div>
                )}
                <button type="button" className="link-button" onClick={props.onEditEnvironment}>
                  Edit the environment’s flags
                </button>
              </section>

              <section aria-labelledby="flags-values-title">
                <h3 id="flags-values-title">Values</h3>
                {names.length === 0 ? (
                  <p className="hint">No flags in {view.environment}.</p>
                ) : (
                  <table className="kv readonly flags-table">
                    <thead>
                      <tr>
                        <th>Flag</th>
                        <th>Value</th>
                        <th>From</th>
                        <th className="kv-action" />
                      </tr>
                    </thead>
                    <tbody>
                      {names.map((name) => (
                        <FlagRow
                          key={name}
                          name={name}
                          value={view.values[name]!}
                          source={view.sources[name]!}
                          overridden={name in view.overrides}
                          onOverride={(value) => props.onOverride(name, value)}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
                <form
                  className="flags-add"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const [name, ...rest] = adding.split('=')
                    if (!name?.trim()) return
                    props.onOverride(name.trim(), parseFlagValue(rest.join('=') || 'true'))
                    setAdding('')
                  }}
                >
                  <input
                    value={adding}
                    placeholder="name=value, to override a flag"
                    aria-label="Override a flag"
                    onChange={(e) => setAdding(e.target.value)}
                  />
                  <button type="submit" disabled={adding.trim() === ''}>
                    Override
                  </button>
                </form>
                <p className="hint">
                  Overrides are kept in the app for this project and environment, and never written
                  to the repository. <code>gta</code> takes them as <code>--flag name=value</code>.
                </p>
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

function FlagRow(props: {
  name: string
  value: FlagValue
  source: 'environment' | 'command' | 'override'
  overridden: boolean
  onOverride: (value: FlagValue | null) => void
}) {
  const { name, value } = props
  const [text, setText] = useState(showFlagValue(value))
  useEffect(() => setText(showFlagValue(value)), [value])
  const boolean = typeof value === 'boolean'

  return (
    <tr className={props.overridden ? 'overridden' : ''}>
      <td>
        <code>{name}</code>
      </td>
      <td>
        {boolean ? (
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={value}
            aria-label={`Flag ${name}`}
            onChange={(e) => props.onOverride(e.target.checked)}
          />
        ) : (
          <input
            className="flag-text"
            value={text}
            aria-label={`Flag ${name}`}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text !== showFlagValue(value)) props.onOverride(parseFlagValue(text))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        )}
      </td>
      <td className={`flag-source ${props.source}`}>{SOURCE_LABELS[props.source]}</td>
      <td className="kv-action">
        {props.overridden && (
          <Tooltip text="Clear the override">
            <button
              type="button"
              onClick={() => props.onOverride(null)}
              aria-label={`Clear override of ${name}`}
            >
              &times;
            </button>
          </Tooltip>
        )}
      </td>
    </tr>
  )
}
