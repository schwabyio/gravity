import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { renameWithRetry } from '@schwabyio/gravity-core'
import {
  DEFAULT_SETTINGS,
  patchSettings,
  SettingsSchema,
  type Settings,
  type SettingsPatch
} from '../shared/settings.js'

/**
 * The app's settings, in `settings.json` beside the workspace list.
 *
 * Same pattern as `WorkspaceRegistry`: a plain JSON file, zod-validated on read,
 * a corrupt or missing file meaning "defaults" rather than a failed start. The
 * path is resolved lazily for the same reason: `--user-data-dir` is not applied
 * until the app is ready.
 */
class SettingsStore {
  private current: Settings | null = null
  private listeners = new Set<(settings: Settings) => void>()
  private saving: Promise<void> = Promise.resolve()

  /** Where they are kept: the file the external editor's Test opens. */
  get file(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  async get(): Promise<Settings> {
    if (this.current) return this.current
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(await fs.readFile(this.file, 'utf8')))
      this.current = parsed.success ? parsed.data : DEFAULT_SETTINGS
    } catch {
      this.current = DEFAULT_SETTINGS
    }
    return this.current
  }

  /** Merge a partial update, validate the whole, persist, and notify. */
  async update(patch: unknown): Promise<Settings> {
    const base = await this.get()
    // Whatever arrives is checked whole below, so a bad field changes nothing.
    const next = SettingsSchema.parse(patchSettings(base, (patch ?? {}) as SettingsPatch))
    this.current = next
    await this.save()
    for (const listener of this.listeners) listener(next)
    return next
  }

  /**
   * Write the settings as they are when this save's turn comes, after every
   * save asked for before it, as `WorkspaceRegistry` does: two at once would
   * share the temporary file. A save that fails still lets the next one run.
   */
  private save(): Promise<void> {
    const turn = this.saving.then(() => this.write())
    this.saving = turn.catch(() => undefined)
    return turn
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    // Write then rename, so the file is never seen half written: not by a
    // crash mid-write, nor by anything reading it as it is written.
    const temporary = `${this.file}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify(this.current, null, 2)}\n`)
    await renameWithRetry(temporary, this.file)
  }

  onChanged(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const settingsStore = new SettingsStore()
