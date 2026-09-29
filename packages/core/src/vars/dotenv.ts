/**
 * Minimal `.env` reader.
 *
 * Only what the format actually needs — `KEY=value`, comments, blank lines and
 * quoted values — so that secrets can come from a file without pulling in a
 * dependency for thirty lines of parsing.
 */
export function parseDotEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue

    const equals = line.indexOf('=')
    if (equals === -1) continue

    const key = line
      .slice(0, equals)
      .trim()
      .replace(/^export\s+/, '')
    if (key === '') continue

    let value = line.slice(equals + 1).trim()

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quote = value[0]
      value = value.slice(1, -1)
      // Escapes are only meaningful inside double quotes, matching every other
      // .env reader.
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      // An unquoted value ends at an inline comment.
      const comment = value.indexOf(' #')
      if (comment !== -1) value = value.slice(0, comment).trim()
    }

    values[key] = value
  }

  return values
}
