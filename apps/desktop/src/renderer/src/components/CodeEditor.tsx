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
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
  type Transaction
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  placeholder as placeholderText,
  tooltips,
  WidgetType,
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
import type { CheckLine } from '../checkLines.js'
import { useTestsRule, type TestsRule } from '../testsRule.js'

interface Props {
  value: string
  onChange: (value: string) => void
  kind: ScriptKind
  ariaLabel: string
  placeholder?: string
  /** A line to mark as where the last run's script failed, 1-based. */
  errorLine?: number | undefined
  /**
   * The lines the last run's checks were made on, to mark ✓ or ✕ in a gutter
   * of their own, a failure's message under its line. Given at all, even
   * empty, and the gutter keeps its room, so marks arriving move nothing.
   */
  checks?: CheckLine[] | undefined
  /**
   * Shown, not edited: a script that lives elsewhere — a collection's, a check
   * file's — sized to its lines rather than to the pane.
   */
  readOnly?: boolean
  /** A check file (SPEC.md §5): its syntax is checked as a run loads one, `export` and all. */
  checkFile?: boolean
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
  errorLine,
  checks,
  readOnly = false,
  checkFile = false
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const completions = useRef(new Compartment())
  const checksRef = useRef(checks)
  checksRef.current = checks
  // The project's tests.only, for a Tests script of its own: what is shown is not checked.
  const contextRule = useTestsRule()
  const rule = kind === 'tests' && !readOnly ? contextRule : null
  const ruleKey = rule ? `${rule.allowed.join(',')}|${rule.source}` : ''

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          javascript(),
          completions.current.of([completionsFor(kind, rule), lintFor(kind, rule, checkFile)]),
          lintGutter(),
          // Mounted on the body so a diagnostic or completion is never clipped by the pane.
          tooltips({ parent: document.body }),
          syntaxHighlighting(highlight),
          theme,
          errorLineField,
          ...(checks !== undefined ? [checkField, checkGutter] : []),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
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
      // A document from outside has the marks by line again, not where its old text went.
      if (checksRef.current) editor.dispatch({ effects: setChecks.of(checksRef.current) })
    }
  }, [value])

  useEffect(() => {
    view.current?.dispatch({
      effects: completions.current.reconfigure([
        completionsFor(kind, rule),
        lintFor(kind, rule, checkFile)
      ])
    })
    // The rule by what it says, not by which object holds it.
  }, [kind, ruleKey, checkFile])

  useEffect(() => {
    view.current?.dispatch({ effects: setErrorLine.of(errorLine ?? null) })
  }, [errorLine, value])

  // Only a new run's checks: typing moves the marks with their lines instead.
  useEffect(() => {
    if (checks) view.current?.dispatch({ effects: setChecks.of(checks) })
  }, [checks])

  return <div className={`code-editor${readOnly ? ' read-only' : ''}`} ref={host} />
}

/* ----------------------------------------------------------- completions -- */

function completionsFor(kind: ScriptKind, rule: TestsRule | null) {
  // Under tests.only, nothing it would flag is offered: gta.test, and assert that goes in it.
  const customChecks = !rule || rule.allowed.includes('gta.test')
  const available = (entries: ApiEntry[]) =>
    entries.filter((e) => (!e.only || e.only === kind) && (customChecks || e.name !== 'test'))
  const objects: Record<string, ApiEntry[]> = {
    gta: available(GTA_API),
    req: REQ_API,
    ...(customChecks ? { assert: ASSERT_API } : {}),
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
 * something it would reject — a check file parsed as a run loads one, its
 * `export`s rewritten first. A `gta` function that does not exist is a warning,
 * with the nearest real name, and so is what the project's `tests.only` rule
 * does not allow (SPEC.md §1.4), checked by main as `gta lint` checks it.
 */
function lintFor(kind: ScriptKind, rule: TestsRule | null, checkFile: boolean) {
  const everywhere = new Set(GTA_API.map((entry) => entry.name))
  const here = new Set(GTA_API.filter((e) => !e.only || e.only === kind).map((e) => e.name))

  return linter(
    async (view) => {
      const code = view.state.doc.toString()
      const diagnostics: Diagnostic[] = []

      // What the project's tests.only does not allow, as gta lint would report it.
      if (rule && code.trim() !== '') {
        const length = view.state.doc.length
        for (const finding of await window.desktop.script.rules(code, rule.allowed)) {
          const from = Math.min(finding.from, length)
          diagnostics.push({
            from,
            to: Math.max(from, Math.min(finding.to, length)),
            severity: 'warning',
            source: 'rule',
            message: `${finding.message} (tests.only in ${rule.source})`
          })
        }
      }

      const problem =
        code.trim() === '' ? null : await window.desktop.script.check(code, { checkFile })
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

/* ---------------------------------------------------------- check marks -- */

const setChecks = StateEffect.define<CheckLine[]>()

/** A line a check was made on, where it is now, with the text it had when checked. */
interface CheckMark {
  from: number
  text: string
  check: CheckLine
}

interface CheckState {
  marks: CheckMark[]
  decorations: DecorationSet
  gutter: RangeSet<GutterMarker>
}

class CheckMarker extends GutterMarker {
  constructor(readonly check: CheckLine) {
    super()
  }
  override eq(other: CheckMarker): boolean {
    return other.check.status === this.check.status && other.check.title === this.check.title
  }
  override toDOM(): Node {
    const mark = document.createElement('span')
    mark.className = `cm-check-mark ${this.check.status}`
    mark.textContent = { pass: '✓', fail: '✕', ignored: '–' }[this.check.status]
    mark.title = this.check.title
    mark.setAttribute('aria-label', this.check.title)
    return mark
  }
}

/** Holds the gutter's width before any run, so the first marks move nothing. */
class SpacerMarker extends GutterMarker {
  override toDOM(): Node {
    const space = document.createElement('span')
    space.className = 'cm-check-spacer'
    space.textContent = '✕'
    return space
  }
}

const spacer = new SpacerMarker()

/** What a line's failed checks said, under it. */
class FailureNote extends WidgetType {
  constructor(readonly failures: string[]) {
    super()
  }
  override eq(other: FailureNote): boolean {
    return other.failures.join('\n') === this.failures.join('\n')
  }
  override toDOM(): HTMLElement {
    const note = document.createElement('div')
    note.className = 'cm-check-note'
    for (const failure of this.failures) {
      const line = document.createElement('div')
      line.textContent = failure
      note.append(line)
    }
    return note
  }
  override ignoreEvent(): boolean {
    return true
  }
}

const failedLine = Decoration.line({ class: 'cm-check-failed' })

function drawn(marks: CheckMark[], doc: Text): CheckState {
  const decorations = []
  const markers = []
  for (const mark of marks) {
    const line = doc.lineAt(mark.from)
    markers.push(new CheckMarker(mark.check).range(line.from))
    if (mark.check.status === 'fail') {
      decorations.push(failedLine.range(line.from))
      if (mark.check.failures.length > 0) {
        const note = new FailureNote(mark.check.failures)
        decorations.push(Decoration.widget({ widget: note, block: true, side: 1 }).range(line.to))
      }
    }
  }
  return {
    marks,
    decorations: Decoration.set(decorations, true),
    gutter: RangeSet.of(markers, true)
  }
}

/** A run's checks placed by line, in the document as it is. */
function placed(checks: CheckLine[], doc: Text): CheckMark[] {
  return checks
    .filter((check) => check.line >= 1 && check.line <= doc.lines)
    .map((check) => {
      const line = doc.line(check.line)
      return { from: line.from, text: line.text, check }
    })
}

/**
 * Marks follow their lines through edits; a line whose text changed loses its
 * mark, since what was checked there is no longer what is written.
 */
function followed(marks: CheckMark[], transaction: Transaction): CheckMark[] {
  return marks.flatMap((mark) => {
    const line = transaction.state.doc.lineAt(transaction.changes.mapPos(mark.from, 1))
    return line.text === mark.text ? [{ ...mark, from: line.from }] : []
  })
}

const checkField = StateField.define<CheckState>({
  create: (state) => drawn([], state.doc),
  update(current, transaction) {
    let marks = transaction.docChanged ? followed(current.marks, transaction) : current.marks
    for (const effect of transaction.effects) {
      if (effect.is(setChecks)) marks = placed(effect.value, transaction.state.doc)
    }
    return marks === current.marks ? current : drawn(marks, transaction.state.doc)
  },
  provide: (field) => EditorView.decorations.from(field, (state) => state.decorations)
})

const checkGutter = gutter({
  class: 'cm-check-gutter',
  markers: (view) => view.state.field(checkField).gutter,
  initialSpacer: () => spacer
})

/* ----------------------------------------------------------------- theme -- */

// Colours come from the app's tokens, so the editor follows light and dark mode.
const theme = EditorView.theme({
  // The editor itself, not `&` alone: the tooltips' holder on the body carries the theme's
  // class too, and given the editor's full height it ran a window's height past the app,
  // which then scrolled into empty space.
  '&.cm-editor': {
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
  '.cm-check-gutter .cm-gutterElement': { padding: '0 3px', textAlign: 'center' },
  '.cm-check-mark, .cm-check-spacer': {
    fontFamily: 'system-ui, sans-serif',
    fontSize: '11px',
    fontWeight: '800'
  },
  '.cm-check-mark.pass': { color: 'var(--ok)' },
  '.cm-check-mark.fail': { color: 'var(--client)' },
  '.cm-check-mark.ignored': { color: 'var(--text-dim)' },
  '.cm-check-failed': { backgroundColor: 'color-mix(in srgb, var(--client) 10%, transparent)' },
  '.cm-check-note': {
    padding: '0 6px 2px',
    backgroundColor: 'color-mix(in srgb, var(--client) 10%, transparent)',
    color: 'var(--client)',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '11px',
    lineHeight: '16px',
    whiteSpace: 'pre-wrap'
  },
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
  '.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  // ⌘F's search panel. CodeMirror's own fields and buttons are for a light page: white,
  // and light grey, under the dark mode's light text.
  '.cm-textfield': {
    padding: '3px 8px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    fontSize: '12px'
  },
  '.cm-button': {
    padding: '3px 10px',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    backgroundColor: 'var(--surface)',
    backgroundImage: 'none',
    color: 'var(--text)',
    fontSize: '12px'
  },
  '.cm-button:hover': { borderColor: 'var(--accent)' },
  '.cm-button:active': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, var(--surface))',
    backgroundImage: 'none'
  },
  '.cm-panel.cm-search label': { color: 'var(--text)', fontSize: '12px' },
  '.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--accent)' },
  '.cm-panel.cm-search [name=close]': {
    color: 'var(--text-dim)',
    fontSize: '16px',
    cursor: 'pointer'
  },
  '.cm-panel.cm-search [name=close]:hover': { color: 'var(--text)' },
  // Matches as the response body's find marks them.
  '.cm-searchMatch': { backgroundColor: 'var(--find-hit)', borderRadius: '2px' },
  '.cm-searchMatch-selected, .cm-searchMatch-selected span': {
    backgroundColor: 'var(--find-current)',
    color: 'var(--find-current-text)'
  },
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
