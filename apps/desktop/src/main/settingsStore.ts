import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../shared/settings.js'

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

  private get file(): string {
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
    const incoming = (patch ?? {}) as { editing?: { autoSave?: object } }
    const next = SettingsSchema.parse({
      ...base,
      editing: {
        ...base.editing,
        autoSave: { ...base.editing.autoSave, ...incoming.editing?.autoSave }
      }
    })
    this.current = next
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`)
    for (const listener of this.listeners) listener(next)
    return next
  }

  onChanged(listener: (settings: Settings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export const settingsStore = new SettingsStore()
