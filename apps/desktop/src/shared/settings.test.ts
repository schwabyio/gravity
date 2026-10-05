import { describe, expect, it } from 'vitest'
import {
  AUTO_SAVE_DELAY,
  DEFAULT_SETTINGS,
  EDITORS,
  openInLabel,
  patchSettings,
  SettingsSchema
} from './settings.js'

describe('app settings', () => {
  it('fill in every default, so a missing or older file reads as a full set', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      editing: { autoSave: { enabled: true, delayMs: AUTO_SAVE_DELAY.default } },
      editor: { kind: 'system', command: '' }
    })
    expect(SettingsSchema.parse({ editing: { autoSave: { enabled: false } } })).toEqual({
      ...DEFAULT_SETTINGS,
      editing: { autoSave: { enabled: false, delayMs: AUTO_SAVE_DELAY.default } }
    })
  })

  it('refuse a delay out of range and an editor the app does not know', () => {
    for (const delayMs of [AUTO_SAVE_DELAY.min - 1, AUTO_SAVE_DELAY.max + 1, 1.5]) {
      expect(SettingsSchema.safeParse({ editing: { autoSave: { delayMs } } }).success).toBe(false)
    }
    expect(SettingsSchema.safeParse({ editor: { kind: 'sublime' } }).success).toBe(false)
  })

  it('take a patch section by section, leaving the rest as it was', () => {
    const patched = patchSettings(DEFAULT_SETTINGS, { editing: { autoSave: { delayMs: 3000 } } })
    expect(patched.editing.autoSave).toEqual({ enabled: true, delayMs: 3000 })
    expect(patched.editor).toEqual(DEFAULT_SETTINGS.editor)
    expect(patchSettings(patched, { editor: { kind: 'vscode' } })).toEqual({
      ...patched,
      editor: { kind: 'vscode', command: '' }
    })
  })

  it('name each editor in its Open in … link', () => {
    expect(openInLabel('vscode')).toBe('Open in VS Code')
    expect(openInLabel('system')).toBe('Open in default app')
    expect(openInLabel('custom')).toBe('Open in editor')
    expect(EDITORS.map((editor) => editor.id)).toEqual([
      'system',
      'vscode',
      'cursor',
      'intellij',
      'webstorm',
      'custom'
    ])
  })
})
