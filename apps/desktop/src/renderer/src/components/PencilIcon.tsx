/** A pencil: edit what is shown. Sized by the caller. */
export default function PencilIcon({ size = 14 }: { size?: number }) {
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
      <path d="M10.5 2.5l3 3-8 8H2.5v-3z" />
      <path d="M9 4l3 3" />
    </svg>
  )
}
