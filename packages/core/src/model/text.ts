/**
 * Text as the tools write it: LF line endings on every platform (SPEC.md §1.2).
 *
 * A file checked out with CRLF — git on Windows does that unless a
 * `.gitattributes` says otherwise — is read as it is and written back LF.
 */
export const toLf = (text: string): string => text.replace(/\r\n/g, '\n')

/** Text without the byte order mark some Windows editors put at the start of a UTF-8 file. */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
