/** Two chevrons meeting — collapse — or, with `expand`, parting. Sized by the caller. */
export default function CollapseIcon({
  size = 14,
  expand = false
}: {
  size?: number
  expand?: boolean
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {expand ? (
        <>
          <path d="M4.5 6 8 2.5 11.5 6" />
          <path d="M4.5 10 8 13.5 11.5 10" />
        </>
      ) : (
        <>
          <path d="M4.5 2.5 8 6 11.5 2.5" />
          <path d="M4.5 13.5 8 10 11.5 13.5" />
        </>
      )}
    </svg>
  )
}
