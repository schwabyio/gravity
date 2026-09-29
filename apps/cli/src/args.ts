/**
 * `gta <command> [--settingsKey value]...`, xrun's shape.
 *
 * Deliberately not `util.parseArgs`: every setting is also a flag, and a flag
 * it does not know should be reported with the list of settings, which the
 * settings layer does — so this only splits the words.
 */
export interface ParsedArgs {
  /** `get`, `all`, a comma list of collections, or null for none. */
  command: string | null
  /** `--key value` / `--key=value`; a bare `--key` is `true`. */
  overrides: Record<string, string | true>
  help: boolean
  version: boolean
  /** `--json`: print the results as JSON on stdout, instead of the table. */
  json: boolean
  /** `--flag name=value`, any number: feature flag overrides (SPEC.md §2.9). */
  flags: string[]
}

export class UsageError extends Error {
  override name = 'UsageError'
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    overrides: {},
    help: false,
    version: false,
    json: false,
    flags: []
  }

  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '-h' || word === '--help') {
      parsed.help = true
    } else if (word === '-v' || word === '--version') {
      parsed.version = true
    } else if (word === '--json') {
      parsed.json = true
    } else if (word === '--flag' || word.startsWith('--flag=')) {
      const value = word === '--flag' ? argv[++i] : word.slice('--flag='.length)
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('--flag needs name=value, such as --flag newCheckout=true')
      }
      parsed.flags.push(value)
    } else if (word.startsWith('--')) {
      const body = word.slice(2)
      const equals = body.indexOf('=')
      if (equals > 0) {
        parsed.overrides[body.slice(0, equals)] = body.slice(equals + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          parsed.overrides[body] = next
          i++
        } else {
          parsed.overrides[body] = true
        }
      }
    } else if (word.startsWith('-') && word.length > 1) {
      throw new UsageError(`Unknown option ${word}. Settings are given as --settingsKey value.`)
    } else if (parsed.command === null) {
      parsed.command = word
    } else {
      throw new UsageError(
        `Unexpected "${word}". To run several collections, separate them with commas: gta ${parsed.command},${word}`
      )
    }
  }
  return parsed
}
