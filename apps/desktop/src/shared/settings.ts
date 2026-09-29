import { z } from 'zod'

/**
 * App settings: per-user preferences, stored by main in `settings.json`.
 *
 * Every field has a default, so a missing or older file still parses to a full
 * set, and adding a setting never needs a migration.
 */
export const AUTO_SAVE_DELAY = { min: 200, max: 60_000, default: 1000 } as const

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
    .default({ autoSave: { enabled: true, delayMs: AUTO_SAVE_DELAY.default } })
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/** A partial update, merged section by section. */
export interface SettingsPatch {
  editing?: { autoSave?: Partial<Settings['editing']['autoSave']> }
}
