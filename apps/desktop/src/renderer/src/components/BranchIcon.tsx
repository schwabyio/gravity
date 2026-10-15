/** A git branch: two commits on a line, and a third branching off it, sized by the caller. */
export default function BranchIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="4.5" cy="3.5" r="1.6" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="4.5" r="1.6" />
        <path d="M4.5 5.1v5.8" />
        <path d="M11.5 6.1c0 3.4-7 2.6-7 4.8" />
      </g>
    </svg>
  )
}
