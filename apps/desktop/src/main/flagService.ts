import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import {
  environmentFlags,
  FLAG_COMMAND_TIMEOUT_MS,
  FlagValueSchema,
  runFlagCommand,
  type EnvironmentDoc,
  type FlagSource,
  type FlagValue
} from '@schwabyio/gravity-core'
import type { FlagsView } from '../shared/ipc.js'
import { terminalPath } from './bundledGit.js'

/**
 * A project's feature flags for its chosen environment (SPEC.md §2.9), as the
 * app runs with them: the environment file's fixed values, what its
 * `flags.command` printed, and the overrides made in the app — the same order
 * `gta` resolves them in.
 *
 * The command runs when an environment is first needed and again on Refresh,
 * not on every run: it may call a flag service over the network. Its output
 * is kept per project and environment until then, and re-run when the
 * command itself is edited. A command that fails leaves the fixed values and
 * overrides in force, and the error is shown rather than hidden.
 */

type FlagValues = Record<string, FlagValue>

/** Overrides, per project folder and environment, in `flag-overrides.json` beside the settings. */
const OverridesFileSchema = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), FlagValueSchema))
)
type OverridesFile = z.infer<typeof OverridesFileSchema>

interface CommandRun {
  command: string
  values: FlagValues | null
  error: string | null
  at: number
}

class FlagService {
  private overrides: OverridesFile | null = null
  private readonly runs = new Map<string, CommandRun>()
  private readonly running = new Map<string, Promise<CommandRun>>()

  private get file(): string {
    return path.join(app.getPath('userData'), 'flag-overrides.json')
  }

  /**
   * The flags for `root`'s `environment`. `refresh` runs the command again;
   * `environments` are environment files as edited, saved or not.
   */
  async view(
    root: string,
    environment: string | null,
    options: { refresh?: boolean; environments?: Array<{ path: string; doc: EnvironmentDoc }> } = {}
  ): Promise<FlagsView> {
    const values: FlagValues = {}
    const sources: Record<string, FlagSource> = {}
    const take = (from: FlagValues, source: FlagSource) => {
      for (const [name, value] of Object.entries(from)) {
        values[name] = value
        sources[name] = source
      }
    }

    let command: FlagsView['command'] = null
    let error: string | null = null
    if (environment) {
      try {
        const setup = await environmentFlags(root, environment, options.environments)
        take(setup.values, 'environment')
        if (setup.command) {
          const run = await this.runCommand(root, environment, setup.command, options.refresh)
          command = { command: setup.command.command, ranAt: run.at }
          if (run.values) take(run.values, 'command')
          error = run.error
        }
      } catch (cause) {
        error = (cause as Error).message
      }
    }
    const overrides = (await this.readOverrides())[root]?.[environment ?? ''] ?? {}
    take(overrides, 'override')
    return { environment, values, sources, overrides, command, error }
  }

  /** Just the values a run uses. */
  async values(
    root: string,
    environment: string | null,
    environments?: Array<{ path: string; doc: EnvironmentDoc }>
  ): Promise<FlagValues> {
    return (await this.view(root, environment, { environments })).values
  }

  /** Set a flag's override, or clear it with null. */
  async setOverride(
    root: string,
    environment: string | null,
    name: string,
    value: FlagValue | null
  ): Promise<void> {
    const all = await this.readOverrides()
    const forRoot = { ...all[root] }
    const forEnvironment = { ...forRoot[environment ?? ''] }
    if (value === null) delete forEnvironment[name]
    else forEnvironment[name] = value
    forRoot[environment ?? ''] = forEnvironment
    all[root] = forRoot
    this.overrides = all
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, `${JSON.stringify(all, null, 2)}\n`)
  }

  private async runCommand(
    root: string,
    environment: string,
    setup: { command: string; cwd: string },
    refresh = false
  ): Promise<CommandRun> {
    const key = `${root}\0${environment}`
    // Two views asking at once share one run of the command. A run under way is
    // newer than the one kept, so even a view that is not refreshing waits for it.
    const inFlight = this.running.get(key)
    if (inFlight) return inFlight
    const kept = this.runs.get(key)
    if (kept && kept.command === setup.command && !refresh) return kept
    const run = (async (): Promise<CommandRun> => {
      try {
        // Opened from the Dock, the app has a bare PATH: `node` would not be found.
        const PATH = await terminalPath()
        const values = await runFlagCommand(setup.command, {
          cwd: setup.cwd,
          env: PATH === process.env['PATH'] ? process.env : { ...process.env, PATH },
          timeoutMs: FLAG_COMMAND_TIMEOUT_MS
        })
        return { command: setup.command, values, error: null, at: Date.now() }
      } catch (cause) {
        return {
          command: setup.command,
          values: null,
          error: (cause as Error).message,
          at: Date.now()
        }
      }
    })()
    this.running.set(key, run)
    try {
      const done = await run
      this.runs.set(key, done)
      return done
    } finally {
      this.running.delete(key)
    }
  }

  private async readOverrides(): Promise<OverridesFile> {
    if (this.overrides) return this.overrides
    try {
      const parsed = OverridesFileSchema.safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')))
      this.overrides = parsed.success ? parsed.data : {}
    } catch {
      this.overrides = {}
    }
    return this.overrides
  }
}

export const flagService = new FlagService()
