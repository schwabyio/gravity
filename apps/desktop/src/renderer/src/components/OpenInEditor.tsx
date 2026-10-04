import type { EditorTarget } from '@shared/ipc.js'
import { useExternalEditor } from '../externalEditor.js'
import OpenExternalIcon from './OpenExternalIcon.js'
import Tooltip from './Tooltip.js'

/**
 * "Open in …" as an icon: a file — at a step or a script's line, where there
 * is one — opened in the external editor App settings name. Named in full on
 * hover and to screen readers: `Open in VS Code: users.csv`.
 */
export default function OpenInEditor(props: {
  target: EditorTarget | null
  /** What opens: `users.csv`, `the collection’s tests`. */
  what: string
  className?: string
  size?: number
}) {
  const editor = useExternalEditor()
  if (!editor || !props.target) return null
  const target = props.target
  const label = `${editor.label}: ${props.what}`
  return (
    <Tooltip text={label}>
      <button
        type="button"
        className={props.className ?? 'open-external'}
        onClick={() => editor.open(target)}
        aria-label={label}
      >
        <OpenExternalIcon size={props.size ?? 13} />
      </button>
    </Tooltip>
  )
}
