import { MARK_LETTER, type GitMark } from '../gitMarks.js'

/**
 * A row's mark from git, at its right: a letter — M, U or C — or for a
 * folder a dot. Drawn by CSS from `data-letter`, so it stays out of the row's
 * name and text; the row's title says it in words. Nothing when unchanged.
 */
export default function GitBadge({ mark, dot = false }: { mark: GitMark | null; dot?: boolean }) {
  if (!mark) return null
  return (
    <span
      className={`git-mark ${mark}${dot ? ' dot' : ''}`}
      data-letter={dot ? undefined : MARK_LETTER[mark]}
      aria-hidden="true"
    />
  )
}
