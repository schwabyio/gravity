/**
 * A disclosure chevron: pointing right, or with `open`, turned down to what it
 * opened. Sized by the caller.
 */
export default function ChevronIcon({
  size = 12,
  open = false
}: {
  size?: number
  open?: boolean
}) {
  return (
    <svg
      className={`chevron-icon${open ? ' open' : ''}`}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  )
}
