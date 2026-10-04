import { z } from 'zod'

/**
 * App settings: per-user preferences, stored by main in `settings.json`.
 *
 * Every field has a default, so a missing or older file still parses to a full
 * set, and adding a setting never needs a migration.
 */
export const AUTO_SAVE_DELAY = { min: 200, max: 60_000, default: 1000 } as const

/**
 * The editors a file can be opened in, outside the app: the system's own
 * choice for the file, an editor the app knows how to open at a line, or a
 * command of the person's own.
 */
export const EDITORS = [
  { id: 'system', label: 'System default app', name: 'default app' },
  { id: 'vscode', label: 'Visual Studio Code', name: 'VS Code' },
  { id: 'cursor', label: 'Cursor', name: 'Cursor' },
  { id: 'intellij', label: 'IntelliJ IDEA', name: 'IntelliJ IDEA' },
  { id: 'webstorm', label: 'WebStorm', name: 'WebStorm' },
  { id: 'custom', label: 'Custom command', name: 'editor' }
] as const
export type EditorKind = (typeof EDITORS)[number]['id']
const EDITOR_IDS = EDITORS.map((editor) => editor.id) as [EditorKind, ...EditorKind[]]

/** What an "Open in …" link says for an editor: `Open in VS Code`. */
export const openInLabel = (kind: EditorKind): string =>
  `Open in ${EDITORS.find((editor) => editor.id === kind)?.name ?? 'editor'}`

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  editing: z
    .object({
      autoSave: z
        .object({
          /** Write edits to disk on their own, shortly after typing stops. */
          enabled: z.boolean().default(true),
          /** Milliseconds of quiet before an auto save. */
          delayMs: z
            .number()
            .int()
            .min(AUTO_SAVE_DELAY.min)
            .max(AUTO_SAVE_DELAY.max)
            .default(AUTO_SAVE_DELAY.default)
        })
        .default({ enabled: true, delayMs: AUTO_SAVE_DELAY.default })
    })
    .default({ autoSave: { enabled: true, delayMs: AUTO_SAVE_DELAY.default } }),
  editor: z
    .object({
      /** Where "Open in …" opens a file. */
      kind: z.enum(EDITOR_IDS).default('system'),
      /** For `custom`: the program and its arguments, `{file}` and `{line}` filled in. */
      command: z.string().default('')
    })
    .default({ kind: 'system', command: '' })
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** A partial update, merged section by section. */
export interface SettingsPatch {
  editing?: { autoSave?: Partial<Settings['editing']['autoSave']> }
  editor?: Partial<Settings['editor']>
}

/** A patch over settings, section by section: what main stores and the page shows at once. */
export function patchSettings(base: Settings, patch: SettingsPatch): Settings {
  return {
    ...base,
    editing: {
      ...base.editing,
      autoSave: { ...base.editing.autoSave, ...patch.editing?.autoSave }
    },
    editor: { ...base.editor, ...patch.editor }
  }
}
