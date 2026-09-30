import fs from 'node:fs/promises'
import path from 'node:path'
import { SETTINGS_FILE, TagSchema } from '@schwabyio/gravity-core'
import { parse } from 'yaml'
import { z } from 'zod'

/**
 * A project's `settings.yml`: how `gta` runs it (xrun's `settings.json`).
 *
 * It sits beside `project.yml`, and is committed. `project.yml` says what the
 * project *is* — its name, its global project, its variables — and is shared
 * with the desktop app; `settings.yml` says how a CLI run goes, and CI
 * overrides it per job.
 *
 * Lowest precedence first: default → the global project's `settings.yml` →
 * the project's → `GTA_*` environment variables → `--key value` on the
 * command line.
 */
export { SETTINGS_FILE }

type Kind = 'string' | 'integer' | 'boolean' | 'list'

interface KeyInfo {
  kind: Kind
  doc: string
}

/** Every setting, in the order `gta` shows them. */
export const SETTING_KEYS = {
  environmentType: {
    kind: 'string',
    doc: 'The environment to run against, by name: environments/<name>.yml (the global project’s too). Unset: no environment.'
  },
  limitConcurrency: {
    kind: 'integer',
    doc: 'How many collections run at once. Steps within a collection always run in order.'
  },
  timeoutCollection: {
    kind: 'integer',
    doc: 'Milliseconds a collection may take before it is stopped and reported failed.'
  },
  bail: {
    kind: 'boolean',
    doc: 'Stop a collection at its first failing step; the rest are reported skipped.'
  },
  tags: {
    kind: 'list',
    doc: 'Run only what has one of these tags (SPEC.md §2.4). Empty: everything.'
  },
  notTags: {
    kind: 'list',
    doc: 'Leave out what has one of these tags: a collection tagged so, or a step where steps carry tags.'
  },
  generateJUnitResults: {
    kind: 'boolean',
    doc: 'Write a JUnit XML report of the run to <testResultsBasePath>/junit/junit.xml, for CI.'
  },
  generateJsonResults: {
    kind: 'boolean',
    doc: 'Write the run as JSON to <testResultsBasePath>/json/results.json, for tools and agents.'
  },
  generateHtmlResults: {
    kind: 'boolean',
    doc: 'Write an HTML report of the run: <testResultsBasePath>/html/summary.html and a page per collection.'
  },
  autoOpenTestResultHtml: {
    kind: 'boolean',
    doc: 'Write the HTML report and open its summary in the browser when the run ends.'
  },
  testResultsBasePath: {
    kind: 'string',
    doc: 'Where reports are written: relative to the project folder, or absolute.'
  }
} as const satisfies Record<string, KeyInfo>

export type SettingKey = keyof typeof SETTING_KEYS
const KEYS = Object.keys(SETTING_KEYS) as SettingKey[]

const positiveInteger = z.number().int().min(1)

export const SettingsSchema = z.strictObject({
  environmentType: z.string().trim().min(1).nullable().default(null),
  limitConcurrency: positiveInteger.default(1),
  timeoutCollection: positiveInteger.default(3_600_000),
  bail: z.boolean().default(false),
  tags: z.array(TagSchema).default([]),
  notTags: z.array(TagSchema).default([]),
  generateJUnitResults: z.boolean().default(false),
  generateJsonResults: z.boolean().default(false),
  generateHtmlResults: z.boolean().default(false),
  autoOpenTestResultHtml: z.boolean().default(false),
  testResultsBasePath: z.string().trim().min(1).default('test-results')
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

export class SettingsError extends Error {
  override name = 'SettingsError'
}

/** `limitConcurrency` → `GTA_LIMIT_CONCURRENCY`. */
export const envNameOf = (key: SettingKey): string =>
  `GTA_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`

export interface LoadSettingsOptions {
  /** The project folder: where `settings.yml` is. */
  root: string
  /**
   * The global project the project `uses:`, if any. Its `settings.yml`, when it
   * has one, lies under the project's (SPEC.md §1.3).
   */
  global?: { root: string; uses: string } | null
  /** From the command line, as typed: a string, or `true` for a bare `--flag`. */
  overrides?: Record<string, string | true>
  env?: Record<string, string | undefined>
}

/** Where a setting came from when nothing set it. */
export const DEFAULT_SOURCE = 'default'

/**
 * Where each setting's value came from: `default`, `settings.yml`, the global
 * project's file as `uses:` reaches it (`../shared/settings.yml`), a `GTA_*`
 * variable or a `--key`.
 */
export type SettingSources = Record<SettingKey, string>

export interface LoadedSettings {
  settings: Settings
  sources: SettingSources
}

/** Read, layer and check a project's settings. Throws `SettingsError` saying what to fix. */
export async function loadSettings(options: LoadSettingsOptions): Promise<LoadedSettings> {
  const { root, global = null, overrides = {}, env = process.env } = options

  const own = await readSettingsFile(path.join(root, SETTINGS_FILE), SETTINGS_FILE)
  if (own === null) {
    throw new SettingsError(
      `There is no ${SETTINGS_FILE} in ${root}.\n` +
        `gta runs from a project folder: the one holding collections/ and ${SETTINGS_FILE}.\n` +
        `A minimal ${SETTINGS_FILE}:\n\n  environmentType: demo\n  limitConcurrency: 4\n`
    )
  }
  // Named as the project reaches it, so a message says which of the two files to fix.
  const sharedLabel = global ? path.posix.join(global.uses, SETTINGS_FILE) : ''
  // A global project need not have one: then nothing is shared.
  const shared = global
    ? await readSettingsFile(path.join(global.root, SETTINGS_FILE), sharedLabel)
    : null

  /** Where each value came from, so an error names the place to fix it. */
  const origin = new Map<string, string>()
  const merged: Record<string, unknown> = {}

  const files: Array<[string, Record<string, unknown> | null]> = [
    [sharedLabel, shared],
    [SETTINGS_FILE, own]
  ]
  for (const [label, fromFile] of files) {
    for (const [key, value] of Object.entries(fromFile ?? {})) {
      checkKey(key, label)
      merged[key] = value
      origin.set(key, label)
    }
  }
  for (const key of KEYS) {
    const value = env[envNameOf(key)]
    if (value === undefined || value === '') continue
    merged[key] = coerce(key, value, envNameOf(key))
    origin.set(key, envNameOf(key))
  }
  for (const [key, value] of Object.entries(overrides)) {
    checkKey(key, `--${key}`)
    merged[key] = coerce(key as SettingKey, value, `--${key}`)
    origin.set(key, `--${key}`)
  }

  const result = SettingsSchema.safeParse(merged)
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '')
      return `  ${key} (from ${origin.get(key) ?? SETTINGS_FILE}): ${issue.message}`
    })
    throw new SettingsError(`Settings are not valid:\n${lines.join('\n')}`)
  }
  const sources = Object.fromEntries(
    KEYS.map((key) => [key, origin.get(key) ?? DEFAULT_SOURCE])
  ) as SettingSources
  return { settings: result.data, sources }
}

/** A settings file's map, or null when there is no such file. `label` is how messages name it. */
async function readSettingsFile(
  file: string,
  label: string
): Promise<Record<string, unknown> | null> {
  let source: string
  try {
    source = await fs.readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new SettingsError(`${label} cannot be read: ${(cause as Error).message}`)
  }

  let fromFile: unknown
  try {
    fromFile = parse(source) ?? {}
  } catch (cause) {
    throw new SettingsError(`${label} will not parse: ${(cause as Error).message}`)
  }
  if (typeof fromFile !== 'object' || fromFile === null || Array.isArray(fromFile)) {
    throw new SettingsError(`${label} must be a map of settings, such as limitConcurrency: 4`)
  }
  return fromFile as Record<string, unknown>
}

function checkKey(key: string, where: string): asserts key is SettingKey {
  if (!Object.hasOwn(SETTING_KEYS, key)) {
    throw new SettingsError(
      `Unknown setting "${key}" (from ${where}). Settings are: ${KEYS.join(', ')}`
    )
  }
}

/** Text from the command line or the environment, as the setting's type. */
function coerce(key: SettingKey, value: string | true, where: string): unknown {
  const { kind } = SETTING_KEYS[key]
  if (value === true) {
    if (kind === 'boolean') return true
    throw new SettingsError(`${where} needs a value`)
  }
  switch (kind) {
    case 'integer':
      return /^\s*\d+\s*$/.test(value) ? Number(value) : value
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : value
    case 'list':
      return value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    case 'string':
      return value
  }
}
