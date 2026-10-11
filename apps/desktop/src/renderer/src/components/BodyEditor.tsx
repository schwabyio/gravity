import { useEffect, useRef, type MutableRefObject } from 'react'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, Prec, StateEffect } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  MatchDecorator,
  placeholder as placeholderText,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import type { VariablePreviews } from '@schwabyio/gravity-core/model'
import { bodyLanguage } from '../bodyLanguage.js'
import { codeTheme } from './CodeEditor.js'
import { variableState } from './VariableInput.js'

interface Props {
  /** The body's type: JSON and XML are coloured as such, text and form plainly. */
  mode: string
  value: string
  onChange: (text: string) => void
  /** What each `{{variable}}` resolves to now: one that resolves to nothing is shown so. */
  previews: VariablePreviews
  placeholder: string
  ariaLabel: string
  /** The editor, for Beautify to edit the body as typing does. */
  view: MutableRefObject<EditorView | null>
  /** ⇧⌥F, or Shift+Alt+F: Beautify, for a type that has one. */
  onBeautify: (() => void) | null
}

/**
 * A request body's text, in CodeMirror: JSON and XML coloured, `{{variables}}`
 * marked as the URL marks them, ⌘F (Ctrl+F) to find and replace in it, and the
 * code editor's lines, folding and brackets. Controlled from outside as the
 * scripts' editor is: switching steps replaces the text, typing reports it up.
 */
export default function BodyEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const { view } = props
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const onBeautifyRef = useRef(props.onBeautify)
  onBeautifyRef.current = props.onBeautify
  const previewsRef = useRef(props.previews)
  previewsRef.current = props.previews
  const language = useRef(new Compartment())
  const hint = useRef(new Compartment())

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          EditorView.lineWrapping,
          language.current.of(bodyLanguage(props.mode)),
          syntaxHighlighting(highlight),
          variables(() => previewsRef.current),
          codeTheme,
          theme,
          // By the key's place, not its character: Option+Shift+F types Ï on a Mac.
          Prec.high(
            EditorView.domEventHandlers({
              keydown: (event) => {
                if (event.code !== 'KeyF' || !event.shiftKey || !event.altKey) return false
                if (event.metaKey || event.ctrlKey || !onBeautifyRef.current) return false
                event.preventDefault()
                onBeautifyRef.current()
                return true
              }
            })
          ),
          hint.current.of(placeholderText(props.placeholder)),
          EditorView.contentAttributes.of({ 'aria-label': props.ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    view.current = editor
    return () => {
      view.current = null
      editor.destroy()
    }
    // Built once; the text, type, hint and variables are synchronised below.
  }, [])

  // Replace the document only when it changed from outside, not while typing.
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== props.value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: props.value } })
    }
  }, [props.value])

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        language.current.reconfigure(bodyLanguage(props.mode)),
        hint.current.reconfigure(placeholderText(props.placeholder))
      ]
    })
  }, [props.mode, props.placeholder])

  // Another environment: the same variables may resolve now, or no longer.
  useEffect(() => {
    view.current?.dispatch({ effects: refreshVariables.of(null) })
  }, [props.previews])

  return <div className="code-editor body-code" ref={host} />
}

/* ------------------------------------------------------------- variables -- */

const refreshVariables = StateEffect.define<null>()

/** Each `{{name}}`, marked resolved or not with the values runs use now. */
function variables(previews: () => VariablePreviews) {
  const matcher = new MatchDecorator({
    regexp: /\{\{\s*([^{}\s]+)\s*\}\}/g,
    decoration: (match) =>
      Decoration.mark({ class: `cm-var ${variableState(previews()[match[1]!])}` })
  })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate) {
        const refreshed = update.transactions.some((tr) =>
          tr.effects.some((effect) => effect.is(refreshVariables))
        )
        this.decorations = refreshed
          ? matcher.createDeco(update.view)
          : matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}

/* ----------------------------------------------------------------- theme -- */

// A variable as the URL shows one, over whatever colour the JSON or XML around it has.
const theme = EditorView.theme({
  '.cm-var': { borderRadius: '3px' },
  '.cm-var.resolved, .cm-var.secret': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 12%, transparent)'
  },
  '.cm-var.resolved, .cm-var.resolved span, .cm-var.secret, .cm-var.secret span': {
    color: 'var(--accent)'
  },
  '.cm-var.unresolved': {
    backgroundColor: 'color-mix(in srgb, var(--text-dim) 12%, transparent)',
    textDecoration: 'underline dotted',
    textUnderlineOffset: '3px'
  },
  '.cm-var.unresolved, .cm-var.unresolved span': { color: 'var(--text-dim)' }
})

// Names (JSON's keys, XML's tags) in one colour, values in another as the scripts have
// them — strings green, numbers and true/false/null amber — and the punctuation quiet.
const highlight = HighlightStyle.define([
  { tag: [tags.propertyName, tags.tagName], color: 'var(--server)' },
  { tag: tags.attributeName, color: 'var(--redirect)' },
  { tag: [tags.string, tags.special(tags.string), tags.attributeValue], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--redirect)' },
  { tag: [tags.comment, tags.blockComment], color: 'var(--text-dim)', fontStyle: 'italic' },
  {
    tag: [
      tags.processingInstruction,
      tags.documentMeta,
      tags.angleBracket,
      tags.brace,
      tags.squareBracket,
      tags.separator,
      tags.punctuation
    ],
    color: 'var(--text-dim)'
  }
])
