import { useEffect, useState } from 'react'
import { SETTINGS_DEFAULTS, type Settings } from '@schwabyio/gravity-core/model'
import type { InheritedSettings } from '../inheritance.js'

interface Props {
  /** Where these settings live: a step's own, or the whole collection's. */
  level: 'step' | 'collection'
  /** The settings set at this level; what is absent is inherited. */
  own: Settings
  /**
   * For a step, what it inherits: each setting from the nearest layer that
   * sets it — the collection, its base, the endpoint base. What none sets is
   * the default.
   */
  inherited?: InheritedSettings
  onChange: (settings: Settings) => void
}

type Key = keyof Settings

const ROWS: Array<{
  key: Key
  label: string
  help: string
  kind: 'number' | 'boolean'
  /** Whole numbers only. */
  integer?: boolean
  unit?: string
}> = [
  {
    key: 'timeout',
    label: 'Timeout',
    help: 'How long to wait for the whole response. 0 waits for ever.',
    kind: 'number',
    unit: 'ms'
  },
  {
    key: 'followRedirects',
    label: 'Follow redirects',
    help: 'Follow a 3xx response to where it points.',
    kind: 'boolean'
  },
  {
    key: 'maxRedirects',
    label: 'Max redirects',
    help: 'How many redirects in a row to follow before giving up.',
    kind: 'number',
    integer: true
  },
  {
    key: 'encodeUrl',
    label: 'Encode URL',
    help: 'Percent-encode characters in the URL that need it before sending.',
    kind: 'boolean'
  }
]

const show = (value: unknown): string =>
  typeof value === 'boolean' ? (value ? 'On' : 'Off') : String(value)

/** Settings in their documented order, dropping any left to inherit. */
function tidy(settings: Settings): Settings {
  const out: Record<string, unknown> = {}
  for (const { key } of ROWS) if (settings[key] !== undefined) out[key] = settings[key]
  return out as Settings
}

/**
 * The request settings at one level, and what they come to.
 *
 * A step's settings override those it inherits, which override the defaults.
 * Beside each name is what a run will actually use and where that value came
 * from. Nothing here is a copy: clearing a field means "inherit".
 */
export default function SettingsTab({ level, own, inherited = {}, onChange }: Props) {
  const forStep = level === 'step'
  return (
    <div className="settings-tab">
      <p className="hint">
        {forStep
          ? 'A setting left empty comes from the nearest that sets it — the collection’s settings (⚙ beside its name), its base collection’s, its endpoint base’s — or else the default.'
          : 'A setting left empty is the default. A step can still set its own.'}
      </p>
      <div className="settings-list">
        {ROWS.map((row) => {
          const from = forStep ? inherited[row.key] : undefined
          const fallback = from?.value ?? SETTINGS_DEFAULTS[row.key]
          const used = own[row.key] ?? fallback
          const set = own[row.key] !== undefined
          const source = set ? level : (from?.from ?? 'default')
          return (
            <section key={row.key} className="setting-card" aria-label={row.label}>
              <div className="setting-head">
                <span className="setting-name">{row.label}</span>
                <span className="setting-used" title="What a run will use">
                  <strong>
                    {show(used)}
                    {row.unit && typeof used === 'number' ? ` ${row.unit}` : ''}
                  </strong>
                  <span
                    className={`setting-source ${set ? level : from ? 'inherited' : 'default'}`}
                  >
                    {source}
                  </span>
                </span>
              </div>
              <p className="setting-help">{row.help}</p>
              <div className="setting-fields">
                <SettingField
                  row={row}
                  value={own[row.key]}
                  inherited={fallback}
                  label={`${row.label} for ${forStep ? 'this step' : 'the whole collection'}`}
                  onChange={(value) => onChange(tidy({ ...own, [row.key]: value }))}
                />
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function SettingField(props: {
  row: (typeof ROWS)[number]
  value: number | boolean | undefined
  inherited: number | boolean
  label: string
  onChange: (value: number | boolean | undefined) => void
}) {
  const { row, value, inherited, label } = props

  if (row.kind === 'boolean') {
    return (
      <select
        aria-label={label}
        className={value === undefined ? 'inherits' : ''}
        value={value === undefined ? '' : value ? 'on' : 'off'}
        onChange={(e) =>
          props.onChange(e.target.value === '' ? undefined : e.target.value === 'on')
        }
      >
        <option value="">Inherit ({show(inherited)})</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    )
  }
  return (
    <NumberField
      label={label}
      value={value as number | undefined}
      inherited={inherited as number}
      integer={row.integer === true}
      unit={row.unit}
      onChange={props.onChange}
    />
  )
}

/**
 * A number, or empty to inherit. What is typed stays as typed until it is a
 * valid value, so a half-finished entry is never written — or thrown away.
 */
function NumberField(props: {
  label: string
  value: number | undefined
  inherited: number
  integer: boolean
  unit: string | undefined
  onChange: (value: number | undefined) => void
}) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value))
  // Follow a change from outside (another step, a reload), but not the echo of
  // what is being typed — "5." must not be rewritten to "5" mid-keystroke.
  useEffect(() => {
    setText((current) => {
      const typed = current.trim() === '' ? undefined : Number(current)
      return typed === props.value ? current : props.value === undefined ? '' : String(props.value)
    })
  }, [props.value])

  const parsed = text.trim() === '' ? undefined : Number(text)
  const invalid =
    parsed !== undefined &&
    (!Number.isFinite(parsed) || parsed < 0 || (props.integer && !Number.isInteger(parsed)))

  return (
    <span className="setting-number">
      <input
        type="text"
        inputMode="numeric"
        aria-label={props.label}
        aria-invalid={invalid}
        className={invalid ? 'invalid' : ''}
        placeholder={`Inherit (${props.inherited})`}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          const next = e.target.value.trim() === '' ? undefined : Number(e.target.value)
          const ok =
            next === undefined ||
            (Number.isFinite(next) && next >= 0 && (!props.integer || Number.isInteger(next)))
          if (ok) props.onChange(next)
        }}
      />
      {props.unit && <span className="unit">{props.unit}</span>}
      {invalid && (
        <span className="setting-invalid" role="alert">
          {props.integer ? 'A whole number, 0 or more' : 'A number, 0 or more'}
        </span>
      )}
    </span>
  )
}
