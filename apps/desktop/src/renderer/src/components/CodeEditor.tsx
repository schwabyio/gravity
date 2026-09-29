import { useEffect, useRef } from 'react'
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult
} from '@codemirror/autocomplete'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  placeholder as placeholderText,
  tooltips,
  type DecorationSet
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import {
  ASSERT_API,
  GTA_API,
  REQ_API,
  RES_API,
  SPECIAL_HANDLING,
  type ApiEntry,
  type ScriptKind
} from '../scriptApi.js'

interface Props {
  value: string
  onChange: (value: string) => void
  kind: ScriptKind
  ariaLabel: string
  placeholder?: string
  /** A line to mark as where the last run's script failed, 1-based. */
  errorLine?: number | undefined
}

/**
 * A JavaScript editor for a step's `tests` and `before.script`.
 *
 * CodeMirror, themed from the app's own colour tokens so it follows light and
 * dark with everything else, and completing the `gta` API as you type.
 * Controlled from outside: switching steps replaces the document, while typing
 * reports each change up without the editor being rebuilt.
 */
export default function CodeEditor({
  value,
  onChange,
  kind,
  ariaLabel,
  placeholder,
  errorLine
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const completions = useRef(new Compartment())

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          javascript(),
          completions.current.of([completionsFor(kind), lintFor(kind)]),
          lintGutter(),
          // Mounted on the body so a diagnostic or completion is never clipped by the pane.
          tooltips({ parent: document.body }),
          syntaxHighlighting(highlight),
          theme,
          errorLineField,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          ...(placeholder ? [placeholderText(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    view.current = editor
    return () => editor.destroy()
    // Built once; value, kind and the error line are synchronised below.
  }, [])

  // Replace the document only when it changed from outside, not while typing.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: completions.current.reconfigure([completionsFor(kind), lintFor(kind)])
    })
  }, [kind])

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(errorLine ?? null) })
  }, [errorLine, value])

  return <div className="code-editor" ref={host} />
}

/* ----------------------------------------------------------- completions -- */

function completionsFor(kind: ScriptKind) {
  const available = (entries: ApiEntry[]) => entries.filter((e) => !e.only || e.only === kind)
  const objects: Record<string, ApiEntry[]> = {
    gta: available(GTA_API),
    req: REQ_API,
    assert: ASSERT_API,
    ...(kind === 'tests' ? { res: RES_API } : {})
  }

  const source = (context: CompletionContext): CompletionResult | null => {
    // `gta.exp|` → members of the object before the dot.
    const member = context.matchBefore(/\b(gta|res|req|assert)\.\w*$/)
    if (member) {
      const [object] = member.text.split('.')
      const entries = objects[object!] ?? []
      return {
        from: member.from + object!.length + 1,
        options: entries.map((entry) => ({
          label: entry.name,
          type: entry.type ?? 'function',
          detail: entry.signature,
          info: entry.info,
          ...(entry.type === 'property' ? {} : { apply: entry.name })
        })),
        validFor: /^\w*$/
      }
    }

    // Inside quotes after a gta call: xtest's specialHandling strings.
    const quoted = context.matchBefore(/(['"])\w*$/)
    if (quoted && kind === 'tests') {
      const line = context.state.doc.lineAt(context.pos)
      const before = line.text.slice(0, context.pos - line.from)
      if (
        /gta\.expect\w+\(.*,\s*(['"])\w*$/.test(before) ||
        /specialHandling:\s*(['"])\w*$/.test(before)
      ) {
        return {
          from: quoted.from + 1,
          options: SPECIAL_HANDLING.map((label) => ({ label, type: 'constant' })),
          validFor: /^\w*$/
        }
      }
    }

    // A bare identifier: the globals.
    const word = context.matchBefore(/\w+$/)
    if (!word && !context.explicit) return null
    return {
      from: word ? word.from : context.pos,
      options: Object.keys(objects).map((label) => ({ label, type: 'variable' })),
      validFor: /^\w*$/
    }
  }

  return [
    javascriptLanguage.data.of({ autocomplete: source }),
    autocompletion({ activateOnTyping: true })
  ]
}

/* ------------------------------------------------------------------ lint -- */

/**
 * Problems shown while typing, before anything runs.
 *
 * Syntax errors come from main, which parses with the same V8 that will run the
 * script, so the editor never reports something a run would accept or miss
 * something it would reject. A `gta` function that does not exist is a warning,
 * with the nearest real name.
 */
function lintFor(kind: ScriptKind) {
  const everywhere = new Set(GTA_API.map((entry) => entry.name))
  const here = new Set(GTA_API.filter((e) => !e.only || e.only === kind).map((e) => e.name))

  return linter(
    async (view) => {
      const code = view.state.doc.toString()
      const diagnostics: Diagnostic[] = []

      const problem = code.trim() === '' ? null : await window.desktop.script.check(code)
      if (problem) {
        const line = view.state.doc.line(Math.min(problem.line, view.state.doc.lines))
        const from = Math.min(line.from + problem.column - 1, line.to)
        diagnostics.push({
          from,
          to: Math.min(from + problem.length, line.to),
          severity: 'error',
          source: 'syntax',
          message: problem.message
        })
      }

      for (const match of code.matchAll(/\bgta\.(\w+)/g)) {
        const name = match[1]!
        if (here.has(name)) continue
        const from = match.index + 4
        const hint = everywhere.has(name)
          ? `gta.${name} checks a response, so it belongs in Tests, not the pre-request script.`
          : `gta has no function "${name}".${suggest(name, [...here])}`
        diagnostics.push({
          from,
          to: from + name.length,
          severity: 'warning',
          source: 'gta',
          message: hint
        })
      }
      return diagnostics
    },
    { delay: 350 }
  )
}

/** The closest real name, when a typo is close enough to guess. */
function suggest(name: string, names: string[]): string {
  let best: { name: string; distance: number } | null = null
  for (const candidate of names) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase())
    if (!best || distance < best.distance) best = { name: candidate, distance }
  }
  return best && best.distance <= Math.max(2, Math.floor(name.length / 4))
    ? ` Did you mean ${best.name}?`
    : ''
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]!
}

/* ------------------------------------------------------------ error line -- */

const setErrorLine = StateEffect.define<number | null>()
const errorLineMark = Decoration.line({ class: 'cm-error-line' })

const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setErrorLine)) continue
      const builder = new RangeSetBuilder<Decoration>()
      const line = effect.value
      if (line !== null && line >= 1 && line <= transaction.state.doc.lines) {
        const at = transaction.state.doc.line(line)
        builder.add(at.from, at.from, errorLineMark)
      }
      next = builder.finish()
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field)
})

/* ----------------------------------------------------------------- theme -- */

// Colours come from the app's tokens, so the editor follows light and dark mode.
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    fontSize: '12px',
    border: '1px solid var(--border)',
    borderRadius: '6px'
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '18px' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-alt)',
    color: 'var(--text-dim)',
    border: 'none',
    borderRight: '1px solid var(--border)'
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)'
  },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: 'none'
  },
  // An empty script must never pass for one: the example is visibly not code.
  '.cm-placeholder': {
    color: 'var(--text-dim)',
    fontFamily: 'system-ui, sans-serif',
    fontStyle: 'italic'
  },
  '.cm-error-line': { backgroundColor: 'color-mix(in srgb, var(--client) 16%, transparent)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '6px'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    color: 'var(--text)'
  },
  '.cm-completionDetail': { color: 'var(--text-dim)', fontStyle: 'normal', marginLeft: '6px' },
  '.cm-completionInfo': { maxWidth: '320px', padding: '6px 8px', fontSize: '12px' },
  '.cm-panels': { backgroundColor: 'var(--surface-alt)', color: 'var(--text)' },
  '.cm-diagnostic': { fontFamily: 'var(--mono)', fontSize: '11px', padding: '4px 8px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--client)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--redirect)' },
  '.cm-lint-marker': { width: '0.9em', height: '0.9em' }
})

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--redirect)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--text-dim)',
    fontStyle: 'italic'
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--server)'
  },
  { tag: tags.propertyName, color: 'var(--text)' },
  { tag: tags.operator, color: 'var(--text-dim)' }
])
