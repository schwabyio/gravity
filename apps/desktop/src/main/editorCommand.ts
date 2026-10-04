/**
 * The pure part of opening a file in an editor: the links and command lines,
 * so they can be checked without starting anything.
 */

/**
 * A command line split into words as a shell would, without a shell: spaces
 * separate, quotes keep a word with spaces together, and nothing else is
 * interpreted — no variables, globs or pipes.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = []
  let word = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || word) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (started || word) words.push(word)
  return words
}

/**
 * A custom command's words with `{file}` and `{line}` filled in — the line 1
 * when there is none to go to — and the file added last when no word names it.
 */
export function fillCommand(words: string[], file: string, line: number | undefined): string[] {
  const filled = words.map((word) =>
    word.replaceAll('{file}', file).replaceAll('{line}', String(line ?? 1))
  )
  return words.some((word) => word.includes('{file}')) ? filled : [...filled, file]
}

/** A path as a link writes it: `/` between parts, each part escaped, a Windows drive kept as it is. */
function linkPath(file: string): string {
  const parts = file.replaceAll('\\', '/').split('/')
  const escaped = parts.map((part) => (/^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
  const joined = escaped.join('/')
  return joined.startsWith('/') ? joined : `/${joined}`
}

/** The link that opens a file, at a line, in VS Code or Cursor: `vscode://file/…:12:1`. */
export function fileUrl(scheme: 'vscode' | 'cursor', file: string, line?: number): string {
  return `${scheme}://file${linkPath(file)}${line ? `:${line}:1` : ''}`
}

/** The link a JetBrains IDE opens a file at a line from: `idea://open?file=…&line=12`. */
export function jetbrainsUrl(product: 'idea' | 'webstorm', file: string, line?: number): string {
  return `${product}://open?file=${encodeURIComponent(file)}${line ? `&line=${line}` : ''}`
}
