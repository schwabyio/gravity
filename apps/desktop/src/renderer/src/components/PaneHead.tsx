import type { ReactNode } from 'react'
import InfoTip from './InfoTip.js'
import Tooltip from './Tooltip.js'

interface Props {
  /** What the pane is: `Request`, `Response`, `Scripts`. */
  title: string
  /** Its Hide button: what it says, its name for screen readers, and what hiding gives. */
  hide: { text: string; label: string; tooltip: string; onClick: () => void }
  /** What the tab shown is for, behind an ⓘ beside the pane's name; none, no ⓘ. */
  info?: ReactNode
}

/**
 * A pane's name, with its Hide above its tabs rather than at their end, where
 * a narrow pane would scroll it out of sight — and beside its name an ⓘ saying
 * what the tab shown below is for, where it has anything to say.
 */
export default function PaneHead({ title, hide, info }: Props) {
  return (
    <div className="pane-head">
      <span className="pane-name">
        <span className="pane-title">{title}</span>
        {info && <InfoTip about={`the ${title.toLowerCase()} pane`} text={info} />}
      </span>
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
