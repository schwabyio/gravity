/**
 * An arrow pointing on: go to where this is written, here in the app — the
 * file it opens shows a ← back. Beside OpenExternalIcon, whose arrow leaves a
 * box for another app. Sized by the caller.
 */
export default function GoToIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 8h10.5" />
      <path d="M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  )
}
