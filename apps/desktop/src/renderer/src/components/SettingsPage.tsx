import { useEffect, useState } from 'react'
import {
  AUTO_SAVE_DELAY,
  EDITORS,
  type EditorKind,
  type Settings,
  type SettingsPatch
} from '@shared/settings.js'

interface Props {
  settings: Settings
  onChange: (patch: SettingsPatch) => Promise<{ ok: boolean; message?: string }>
  onClose: () => void
}

const SECTIONS = [
  { id: 'editing', label: 'Editing' },
  { id: 'editor', label: 'External editor' }
] as const

/** How each editor is opened, and whether at a line. */
const EDITOR_NOTES: Record<EditorKind, string> = {
  system: 'Opens a file with the app your system uses for it. It cannot go to a line.',
  vscode: 'Opens VS Code by its link, at the step’s or script’s line.',
  cursor: 'Opens Cursor by its link, at the step’s or script’s line.',
  intellij:
    'Opens IntelliJ IDEA by its launcher, its app or its link, whichever is installed, at the line.',
  webstorm:
    'Opens WebStorm by its launcher, its app or its link, whichever is installed, at the line.',
  custom:
    'The program and its arguments: {file} is the file and {line} its line. It runs directly, not through a shell; on Windows, give the program’s .exe.'
}

/**
 * App settings, over the workbench.
 *
 * A section list on the left and one row per setting, so each new setting is a
 * row, not a redesign. Changes apply as they are made — there is no Save here —
 * and main persists them in `settings.json`.
 */
export default function SettingsPage({ settings, onChange, onClose }: Props) {
  const { autoSave } = settings.editing
  const [delay, setDelay] = useState(String(autoSave.delayMs))
  const [delayError, setDelayError] = useState<string | null>(null)
  const [command, setCommand] = useState(settings.editor.command)
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => setDelay(String(autoSave.delayMs)), [autoSave.delayMs])
  useEffect(() => setCommand(settings.editor.command), [settings.editor.command])

  const commitCommand = async () => {
    if (command !== settings.editor.command) await onChange({ editor: { command } })
  }
  const test = async () => {
    await commitCommand()
    const result = await window.desktop.editor.test()
    setTested(
      result.ok
        ? { ok: true, message: 'Opened the app’s settings.json.' }
        : { ok: false, message: result.message }
    )
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commitDelay = async () => {
    const value = Number(delay)
    if (!Number.isInteger(value) || value < AUTO_SAVE_DELAY.min || value > AUTO_SAVE_DELAY.max) {
      setDelayError(
        `Enter a whole number of milliseconds from ${AUTO_SAVE_DELAY.min} to ${AUTO_SAVE_DELAY.max}.`
      )
      return
    }
    setDelayError(null)
    if (value !== autoSave.delayMs) await onChange({ editing: { autoSave: { delayMs: value } } })
  }

  return (
    <div className="settings-page" role="dialog" aria-modal="true" aria-label="App settings">
      <header className="settings-head">
        <h1>App Settings</h1>
        <button type="button" onClick={onClose} aria-label="Close settings">
          Done
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#settings-${section.id}`} className="active">
              {section.label}
            </a>
          ))}
        </nav>

        <div className="settings-sections">
          <section id="settings-editing" aria-labelledby="settings-editing-title">
            <h2 id="settings-editing-title">Editing</h2>

            <div className="setting-row">
              <div className="setting-text">
                <label htmlFor="setting-auto-save">Auto save</label>
                <p>
                  Write edits to disk on their own, once you stop typing. Off: nothing is written
                  until you press Save or <kbd>⌘S</kbd>.
                </p>
              </div>
              <input
                id="setting-auto-save"
                type="checkbox"
                role="switch"
                className="switch"
                checked={autoSave.enabled}
                onChange={(e) =>
                  void onChange({ editing: { autoSave: { enabled: e.target.checked } } })
                }
              />
            </div>

            <div className={`setting-row${autoSave.enabled ? '' : ' disabled'}`}>
              <div className="setting-text">
                <label htmlFor="setting-auto-save-delay">Delay before saving</label>
                <p>How long after the last keystroke an auto save happens.</p>
                {delayError && (
                  <p className="setting-error" role="alert">
                    {delayError}
                  </p>
                )}
              </div>
              <span className="setting-number">
                <input
                  id="setting-auto-save-delay"
                  type="number"
                  inputMode="numeric"
                  min={AUTO_SAVE_DELAY.min}
                  max={AUTO_SAVE_DELAY.max}
                  step={100}
                  value={delay}
                  disabled={!autoSave.enabled}
                  onChange={(e) => setDelay(e.target.value)}
                  onBlur={() => void commitDelay()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitDelay()
                  }}
                />
                ms
              </span>
            </div>
          </section>

          <section id="settings-editor" aria-labelledby="settings-editor-title">
            <h2 id="settings-editor-title">External editor</h2>

            <div className="setting-row">
              <div className="setting-text">
                <label htmlFor="setting-editor">Open files in</label>
                <p>
                  Where “Open in …” opens a collection, request set, check file, data or environment
                  file — at the step or the script’s line where there is one.{' '}
                  {EDITOR_NOTES[settings.editor.kind]}
                </p>
              </div>
              <select
                id="setting-editor"
                value={settings.editor.kind}
                onChange={(e) => {
                  setTested(null)
                  void onChange({ editor: { kind: e.target.value as EditorKind } })
                }}
              >
                {EDITORS.map((editor) => (
                  <option key={editor.id} value={editor.id}>
                    {editor.label}
                  </option>
                ))}
              </select>
            </div>

            {settings.editor.kind === 'custom' && (
              <div className="setting-row">
                <div className="setting-text">
                  <label htmlFor="setting-editor-command">Command</label>
                  <p>
                    For example{' '}
                    <code>
                      zed {'{file}'}:{'{line}'}
                    </code>{' '}
                    or{' '}
                    <code>
                      /usr/local/bin/subl {'{file}'}:{'{line}'}
                    </code>
                    .
                  </p>
                </div>
                <input
                  id="setting-editor-command"
                  className="setting-command"
                  value={command}
                  spellCheck={false}
                  placeholder="program {file}:{line}"
                  onChange={(e) => setCommand(e.target.value)}
                  onBlur={() => void commitCommand()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitCommand()
                  }}
                />
              </div>
            )}

            <div className="setting-row">
              <div className="setting-text">
                <span className="setting-label">Try it</span>
                <p>Opens the app’s own settings file in it.</p>
                {tested && (
                  <p className={tested.ok ? 'setting-ok' : 'setting-error'} role="status">
                    {tested.message}
                  </p>
                )}
              </div>
              <button type="button" onClick={() => void test()}>
                Test
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
