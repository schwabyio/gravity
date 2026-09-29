/** git's answers about attributes and stored line endings. */

/**
 * `git check-attr -z <attrs…> --stdin`: `path\0attribute\0value\0` triples.
 * A value is `set`, `unset`, `unspecified` or the attribute's value.
 */
export function parseCheckAttr(stdout: string): Map<string, Record<string, string>> {
  const fields = stdout.split('\0')
  const result = new Map<string, Record<string, string>>()
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [file, attribute, value] = [fields[i]!, fields[i + 1]!, fields[i + 2]!]
    result.set(file, { ...result.get(file), [attribute]: value })
  }
  return result
}

export interface StoredEol {
  path: string
  /** How the file is stored in the index: `lf`, `crlf`, `mixed`, `none`, `-text` or ''. */
  index: string
  /** How it is on disk. */
  worktree: string
}

/**
 * `git ls-files --eol -z`: `i/lf    w/crlf  attr/text=auto eol=lf \tpath\0`.
 */
export function parseLsFilesEol(stdout: string): StoredEol[] {
  return stdout
    .split('\0')
    .filter((record) => record !== '')
    .flatMap((record) => {
      const tab = record.indexOf('\t')
      if (tab === -1) return []
      const info = record.slice(0, tab)
      const index = /\bi\/(\S*)/.exec(info)?.[1] ?? ''
      const worktree = /\bw\/(\S*)/.exec(info)?.[1] ?? ''
      return [{ path: record.slice(tab + 1), index, worktree }]
    })
}
