import { useEffect, useState } from 'react'
import CopyIcon from './CopyIcon.js'
import Tooltip from './Tooltip.js'

interface Props {
  /** What it copies, for its name and tooltip: `the request`. */
  what: string
  /** Copies it; `false` when there was nothing to copy, which leaves the icon alone. */
  onCopy: () => boolean | void | Promise<boolean | void>
  /** Words beside the icon, when the icon alone cannot say what it copies. */
  label?: string
}

/** How long the tick shows once something is copied. */
const COPIED_MS = 1500

/**
 * A copy icon that says, for a moment, that it copied: the icon turns to a
 * tick. An icon alone, or with a `label`.
 */
export default function CopyButton({ what, onCopy, label }: Props) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <Tooltip text={copied ? 'Copied' : `Copy ${what}`}>
      <button
        type="button"
        className={`copy-button${copied ? ' copied' : ''}${label ? '' : ' icon-only'}`}
        aria-label={copied ? 'Copied' : `Copy ${what}`}
        onClick={async () => {
          if ((await onCopy()) !== false) setCopied(true)
        }}
      >
        <CopyIcon copied={copied} />
        {label}
      </button>
    </Tooltip>
  )
}
