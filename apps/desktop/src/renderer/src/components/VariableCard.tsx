import type { CSSProperties } from 'react'
import type { VariablePreview } from '@schwabyio/gravity-core/model'
import CopyButton from './CopyButton.js'

/**
 * What a hovered `{{variable}}` resolves to: its value — or why there is none
 * to show — where it came from, and a copy icon for a value there is. The
 * same card over a field and over the request body.
 */
export default function VariableCard(props: {
  name: string
  preview: VariablePreview | undefined
  /** Copies its value; main resolves it so secrets stay out of here. None: no copy icon. */
  onCopy?: ((name: string) => Promise<boolean>) | undefined
  style?: CSSProperties
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const { name, preview, onCopy } = props
  return (
    <div
      className="var-card"
      role="tooltip"
      style={props.style}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <div className="var-card-name">{name}</div>

      {/* The copy icon beside the value it copies, not beside where it came from. */}
      <div className="var-card-value-row">
        {preview === undefined ? (
          <div className="var-card-value unresolved">Not defined in this environment</div>
        ) : preview.kind === 'dynamic' ? (
          <div className="var-card-value muted">Generated for each request</div>
        ) : preview.kind === 'runtime' ? (
          <div className="var-card-value muted">Not set until that step runs</div>
        ) : preview.kind === 'secret' ? (
          <div className="var-card-value muted">Secret — hidden here, but it can be copied</div>
        ) : (
          <div className="var-card-value">{preview.value === '' ? '(empty)' : preview.value}</div>
        )}
        {onCopy &&
          preview !== undefined &&
          preview.kind !== 'dynamic' &&
          preview.kind !== 'runtime' && (
            <CopyButton
              // Another variable's card starts with the copy icon, not a tick.
              key={name}
              what={`the value of ${name}`}
              onCopy={() => onCopy(name)}
            />
          )}
      </div>

      <div className="var-card-foot">
        <span className="var-card-origin">{preview?.origin ?? 'unresolved'}</span>
      </div>
    </div>
  )
}
