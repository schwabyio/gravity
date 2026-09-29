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
 * Lowest precedence first: default → `settings.yml` → `GTA_*` environment
 * variables → `--key value` on the command line.
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
  /** From the command line, as typed: a string, or `true` for a bare `--flag`. */
  overrides?: Record<string, string | true>
  env?: Record<string, string | undefined>
}

/** Read, layer and check a project's settings. Throws `SettingsError` saying what to fix. */
export async function loadSettings(options: LoadSettingsOptions): Promise<Settings> {
  const { root, overrides = {}, env = process.env } = options
  const file = path.join(root, SETTINGS_FILE)

  let source: string
  try {
    source = await fs.readFile(file, 'utf8')
  } catch {
    throw new SettingsError(
      `There is no ${SETTINGS_FILE} in ${root}.\n` +
        `gta runs from a project folder: the one holding collections/ and ${SETTINGS_FILE}.\n` +
        `A minimal ${SETTINGS_FILE}:\n\n  environmentType: demo\n  limitConcurrency: 4\n`
    )
  }

  let fromFile: unknown
  try {
    fromFile = parse(source) ?? {}
  } catch (cause) {
    throw new SettingsError(`${SETTINGS_FILE} will not parse: ${(cause as Error).message}`)
  }
  if (typeof fromFile !== 'object' || fromFile === null || Array.isArray(fromFile)) {
    throw new SettingsError(
      `${SETTINGS_FILE} must be a map of settings, such as limitConcurrency: 4`
    )
  }

  /** Where each value came from, so an error names the place to fix it. */
  const origin = new Map<string, string>()
  const merged: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(fromFile)) {
    checkKey(key, SETTINGS_FILE)
    merged[key] = value
    origin.set(key, SETTINGS_FILE)
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
  return result.data
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
