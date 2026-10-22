import GoToIcon from './GoToIcon.js'
import Tooltip from './Tooltip.js'

/**
 * Open, in the app, where something shown here is written: an arrow, saying
 * on hover what it opens and where. Beside it, OpenInEditor opens the same
 * file in the external editor.
 */
export default function OpenButton(props: {
  /** What it opens and where: `Open endpoints/people.yml to edit its headers`. */
  tip: string
  onClick: () => void
  /** Its name: `Open the base collection auth`. */
  ariaLabel: string
  /** As OpenInEditor's beside it, where that one is bigger: in a bar of buttons. */
  className?: string
  size?: number
}) {
  return (
    <Tooltip text={props.tip}>
      <button
        type="button"
        className={props.className ?? 'open-here'}
        onClick={props.onClick}
        aria-label={props.ariaLabel}
      >
        <GoToIcon size={props.size ?? 13} />
      </button>
    </Tooltip>
  )
}
