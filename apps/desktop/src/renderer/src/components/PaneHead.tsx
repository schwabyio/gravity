import Tooltip from './Tooltip.js'

interface Props {
  /** What the pane is: `Request`, `Response`, `Scripts`. */
  title: string
  /** Its Hide button: what it says, its name for screen readers, and what hiding gives. */
  hide: { text: string; label: string; tooltip: string; onClick: () => void }
}

/**
 * A pane's name, with its Hide above its tabs rather than at their end, where
 * a narrow pane would scroll it out of sight.
 */
export default function PaneHead({ title, hide }: Props) {
  return (
    <div className="pane-head">
      <span className="pane-title">{title}</span>
      <Tooltip text={hide.tooltip}>
        <button
          type="button"
          className="pane-toggle"
          onClick={hide.onClick}
          aria-label={hide.label}
        >
          {hide.text}
        </button>
      </Tooltip>
    </div>
  )
}
