/** Variables: `{x}`, sized by the caller. */
export default function VariablesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4.5 2.5c-1.5 0-2 .6-2 1.8v1.9c0 .9-.5 1.5-1.3 1.8.8.3 1.3.9 1.3 1.8v1.9c0 1.2.5 1.8 2 1.8" />
        <path d="M11.5 2.5c1.5 0 2 .6 2 1.8v1.9c0 .9.5 1.5 1.3 1.8-.8.3-1.3.9-1.3 1.8v1.9c0 1.2-.5 1.8-2 1.8" />
        <path d="M6 6l4 4M10 6l-4 4" />
      </g>
    </svg>
  )
}
