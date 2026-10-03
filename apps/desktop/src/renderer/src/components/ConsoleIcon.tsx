/** The console: lines of a log in a panel, sized by the caller. */
export default function ConsoleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <g fill="currentColor">
        <circle cx="4.5" cy="6" r="0.8" />
        <circle cx="4.5" cy="8.5" r="0.8" />
        <circle cx="4.5" cy="11" r="0.8" />
      </g>
      <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
        <path d="M6.75 6h5.5" />
        <path d="M6.75 8.5h3.75" />
        <path d="M6.75 11h4.75" />
      </g>
    </svg>
  )
}
