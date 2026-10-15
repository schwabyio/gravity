import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
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
import VariableCard from './VariableCard.js'
import { variableState } from './VariableInput.js'

interface Props {
  /** The body's type: JSON and XML are coloured as such, text and form plainly. */
  mode: string
  value: string
  onChange: (text: string) => void
  /** What each `{{variable}}` resolves to now: one that resolves to nothing is shown so. */
  previews: VariablePreviews
  /** Copies a variable's value from its card; main resolves it so secrets stay out of here. */
  onCopy?: (name: string) => Promise<boolean>
  placeholder: string
  ariaLabel: string
  /** The editor, for Beautify to edit the body as typing does. */
  view: MutableRefObject<EditorView | null>
  /** ⇧⌥F, or Shift+Alt+F: Beautify, for a type that has one. */
  onBeautify: (() => void) | null
  /** Shown, not edited: a request of a reusable requests file, seen from a use step. Fixed when built. */
  readOnly?: boolean
}

/**
 * A request body's text, in CodeMirror: JSON and XML coloured, `{{variables}}`
 * marked as the URL marks them and explained on hover by the same card, ⌘F
 * (Ctrl+F) to find and replace in it, and the code editor's lines, folding and
 * brackets. Controlled from outside as the scripts' editor is: switching steps
 * replaces the text, typing reports it up.
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
  /** The variable under the pointer, and where in the window its card goes. */
  const [hovered, setHovered] = useState<CardPlace | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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
          ...(props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
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

  /* A variable's card: open while the pointer is on the variable or the card, and a
     moment after, to travel from one to the other; gone as the body is edited or
     anything scrolls, which would leave it beside nothing. */
  const scheduleClose = () => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setHovered(null), 200)
  }
  useEffect(() => () => clearTimeout(closeTimer.current), [])
  useEffect(() => setHovered(null), [props.value])
  useEffect(() => {
    if (!hovered) return
    const close = () => setHovered(null)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [hovered !== null])

  /** Over a variable, its card; anywhere else, none, a moment later. Not while selecting. */
  const hoverAt = (event: React.MouseEvent) => {
    if (event.buttons !== 0) return
    const mark = (event.target as HTMLElement).closest<HTMLElement>('.cm-var')
    const name = mark?.dataset.name
    if (!mark || !name) return scheduleClose()
    clearTimeout(closeTimer.current)
    const place = cardPlace(name, mark.getBoundingClientRect())
    if (
      hovered?.name !== place.name ||
      hovered.left !== place.left ||
      hovered.top !== place.top ||
      hovered.bottom !== place.bottom
    ) {
      setHovered(place)
    }
  }

  return (
    <>
      <div
        className="code-editor body-code"
        ref={host}
        onMouseMove={hoverAt}
        onMouseLeave={scheduleClose}
      />
      {hovered &&
        createPortal(
          <VariableCard
            name={hovered.name}
            preview={props.previews[hovered.name]}
            onCopy={props.onCopy}
            style={{
              position: 'fixed',
              left: hovered.left,
              top: hovered.top ?? 'auto',
              bottom: hovered.bottom ?? 'auto'
            }}
            onMouseEnter={() => clearTimeout(closeTimer.current)}
            onMouseLeave={scheduleClose}
          />,
          document.body
        )}
    </>
  )
}

/** Where a variable's card goes in the window: under the variable, or over it near the bottom. */
interface CardPlace {
  name: string
  left: number
  top?: number
  bottom?: number
}

/** The card's widest (styles.css), and the room it is given below a variable before it goes above. */
const CARD_WIDTH = 420
const CARD_ROOM = 140
const CARD_GAP = 6

function cardPlace(name: string, box: DOMRect): CardPlace {
  const left = Math.max(8, Math.min(box.left, window.innerWidth - CARD_WIDTH - 8))
  return box.bottom + CARD_GAP + CARD_ROOM <= window.innerHeight
    ? { name, left, top: box.bottom + CARD_GAP }
    : { name, left, bottom: window.innerHeight - box.top + CARD_GAP }
}

/* ------------------------------------------------------------- variables -- */

const refreshVariables = StateEffect.define<null>()

/** Each `{{name}}`, marked resolved or not with the values runs use now. */
function variables(previews: () => VariablePreviews) {
  const matcher = new MatchDecorator({
    regexp: /\{\{\s*([^{}\s]+)\s*\}\}/g,
    decoration: (match) =>
      Decoration.mark({
        class: `cm-var ${variableState(previews()[match[1]!])}`,
        // Which variable, for its card on hover.
        attributes: { 'data-name': match[1]! }
      })
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
