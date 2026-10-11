import { useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { beautifierFor } from '../bodyFormat.js'

/** Beautify's keys, as VS Code has them: ⇧⌥F, or Shift+Alt+F off a Mac. */
export const BEAUTIFY_KEYS = navigator.userAgent.includes('Mac') ? '⇧⌥F' : 'Shift+Alt+F'

/**
 * Beautify for a request body's text, when its type has one (JSON, XML): the
 * editor it edits, its action, and what is wrong with a body that could not be
 * beautified, until it is edited.
 */
export function useBeautify(mode: string, text: string) {
  const view = useRef<EditorView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // What was wrong was with the body as it was: an edit, or another type, clears it.
  useEffect(() => setProblem(null), [mode, text])

  const beautifier = beautifierFor(mode)
  const beautify = () => {
    const editor = view.current
    if (!beautifier || !editor) return
    const current = editor.state.doc.toString()
    if (current.trim() === '') return
    const result = beautifier(current)
    if (!result.ok) return setProblem(result.message)
    if (result.text !== current) {
      // An edit as typing is: Undo puts the body back as it was.
      editor.dispatch({
        changes: { from: 0, to: current.length, insert: result.text },
        userEvent: 'input.format'
      })
    }
    editor.focus()
  }

  return { view, problem, beautify: beautifier ? beautify : null }
}
