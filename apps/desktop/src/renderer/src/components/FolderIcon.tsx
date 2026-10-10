/** A folder, or with `open`, an open one. Sized by the caller. */
export default function FolderIcon({ size = 14, open = false }: { size?: number; open?: boolean }) {
  return (
    <svg
      className="folder-icon"
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
      {open ? (
        <>
          <path d="M2 12V4.5a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7" />
          <path d="M2 12l1.8-4.3a1 1 0 0 1 .9-.7h9.2a.6.6 0 0 1 .55.83l-1.75 4.4a1.2 1.2 0 0 1-1.1.77H2.9A.9.9 0 0 1 2 12z" />
        </>
      ) : (
        <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
      )}
    </svg>
  )
}
