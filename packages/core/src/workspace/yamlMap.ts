import fs from 'node:fs/promises'
import { parse } from 'yaml'

/**
 * A project file that is one map of keys, such as `settings.yml` and
 * `rules.yml`, each of which a global project can have too, lying under the
 * project's (SPEC.md §1.3, §1.4).
 */

/** Why such a file cannot be used. Its message names the file as `label`. */
export class YamlMapError extends Error {
  override name = 'YamlMapError'
}

/**
 * The file's map, or null when there is no such file. `label` is how messages
 * name it — `settings.yml`, or `../shared/settings.yml` as `uses:` reaches it —
 * and `example` a line of what it should hold.
 */
export async function readYamlMap(
  file: string,
  label: string,
  example: string
): Promise<Record<string, unknown> | null> {
  let source: string
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new YamlMapError(`${label} cannot be read: ${(cause as Error).message}`)
  }

  let fromFile: unknown
  try {
    fromFile = parse(source) ?? {}
  } catch (cause) {
    throw new YamlMapError(`${label} will not parse: ${(cause as Error).message}`)
  }
  if (typeof fromFile !== 'object' || fromFile === null || Array.isArray(fromFile)) {
    throw new YamlMapError(`${label} must be a map, such as ${example}`)
  }
  return fromFile as Record<string, unknown>
}
