import CopyIcon from './CopyIcon.js'
import FolderIcon from './FolderIcon.js'
import OpenExternalIcon from './OpenExternalIcon.js'
import PencilIcon from './PencilIcon.js'

/** What a menu item does, as the icon at its start shows it. */
export type MenuIconName =
  | 'new'
  | 'new-folder'
  | 'rename'
  | 'copy'
  | 'open'
  | 'folder'
  | 'move-to-folder'
  | 'move-to-project'
  | 'settings'
  | 'commit'
  | 'history'
  | 'up'
  | 'down'
  | 'delete'

/**
 * The icon at the start of a menu item: the app's own where it has one, the
 * rest drawn in the same line.
 */
export default function MenuIcon({ name }: { name: MenuIconName }) {
  switch (name) {
    case 'rename':
      return <PencilIcon />
    case 'copy':
      return <CopyIcon />
    case 'open':
      return <OpenExternalIcon />
    case 'folder':
      return <FolderIcon />
    default:
      return (
        <svg
          viewBox="0 0 16 16"
          width={14}
          height={14}
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {DRAWN[name]}
        </svg>
      )
  }
}

/** FolderIcon's, closed: what a folder icon here adds its mark to. */
const FOLDER = 'M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z'

/** Eight teeth round a ring, in outline like the rest; GearIcon is a filled one. */
const GEAR =
  'M6.73 3.27L6.98 1.58A6.5 6.5 0 0 1 9.02 1.58L9.27 3.27A4.9 4.9 0 0 1 10.45 3.76L11.82 2.74A6.5 6.5 0 0 1 13.26 4.18L12.24 5.55A4.9 4.9 0 0 1 12.73 6.73L14.42 6.98A6.5 6.5 0 0 1 14.42 9.02L12.73 9.27A4.9 4.9 0 0 1 12.24 10.45L13.26 11.82A6.5 6.5 0 0 1 11.82 13.26L10.45 12.24A4.9 4.9 0 0 1 9.27 12.73L9.02 14.42A6.5 6.5 0 0 1 6.98 14.42L6.73 12.73A4.9 4.9 0 0 1 5.55 12.24L4.18 13.26A6.5 6.5 0 0 1 2.74 11.82L3.76 10.45A4.9 4.9 0 0 1 3.27 9.27L1.58 9.02A6.5 6.5 0 0 1 1.58 6.98L3.27 6.73A4.9 4.9 0 0 1 3.76 5.55L2.74 4.18A6.5 6.5 0 0 1 4.18 2.74L5.55 3.76A4.9 4.9 0 0 1 6.73 3.27Z'

const DRAWN: Record<
  Exclude<MenuIconName, 'rename' | 'copy' | 'open' | 'folder'>,
  React.ReactNode
> = {
  new: <path d="M8 3v10M3 8h10" />,
  'new-folder': (
    <>
      <path d={FOLDER} />
      <path d="M8 7v4M6 9h4" />
    </>
  ),
  'move-to-folder': (
    <>
      <path d={FOLDER} />
      <path d="M5.5 9h4.5M8.5 7.5 10 9l-1.5 1.5" />
    </>
  ),
  // An arrow into a box.
  'move-to-project': (
    <>
      <path d="M9.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3" />
      <path d="M2.5 8h7M7 5.5 9.5 8 7 10.5" />
    </>
  ),
  settings: (
    <>
      <path d={GEAR} />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  // A commit on a line of them, as git tools draw one.
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.5 8h4M10.5 8h4" />
    </>
  ),
  history: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  delete: (
    <>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />
    </>
  )
}
