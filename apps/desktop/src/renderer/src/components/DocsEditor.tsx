import { useEffect, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { xmlLanguage } from '@codemirror/lang-xml'
import { HighlightStyle, syntaxHighlighting, syntaxTree, type Language } from '@codemirror/language'
import { EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  placeholder as placeholderText,
  ViewPlugin,
  type Command,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { jsonLanguage } from '../bodyLanguage.js'
import { formatMarkdown, type MarkdownFormat } from '../markdownFormat.js'
import Markdown from './Markdown.js'
import Tooltip from './Tooltip.js'

interface Props {
  value: string
  onChange: (docs: string) => void
  /** For screen readers and tests: `Step docs`, `Collection docs`. */
  label: string
  placeholder: string
  /** Leave editing for the rendered docs; Escape does the same. */
  onDone?: () => void
}

const MAC = navigator.userAgent.includes('Mac')

/** The formatting tools, in the toolbar's order; three with a key of their own. */
const TOOLS: Array<{ format: MarkdownFormat; name: string; key?: string; icon: React.ReactNode }> =
  [
    { format: 'bold', name: 'Bold', key: 'B', icon: <b>B</b> },
    { format: 'italic', name: 'Italic', key: 'I', icon: <i className="serif">I</i> },
    { format: 'heading', name: 'Heading', icon: <b>H</b> },
    {
      format: 'bullets',
      name: 'Bulleted list',
      icon: (
        <ToolIcon>
          <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
          <circle cx="3" cy="4" r=".6" fill="currentColor" />
          <circle cx="3" cy="8" r=".6" fill="currentColor" />
          <circle cx="3" cy="12" r=".6" fill="currentColor" />
        </ToolIcon>
      )
    },
    {
      format: 'numbers',
      name: 'Numbered list',
      icon: (
        <ToolIcon>
          <path d="M7 4h6.5M7 8h6.5M7 12h6.5" />
          <path d="M2.5 2.8 3.5 2.2v3.6" strokeWidth="1.1" />
          <path d="M2.3 9.4c.2-.7 1.9-.8 1.9.2 0 .8-1.9 1.4-1.9 2.6h2" strokeWidth="1.1" />
        </ToolIcon>
      )
    },
    {
      format: 'code',
      name: 'Code',
      icon: (
        <ToolIcon>
          <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
        </ToolIcon>
      )
    },
    {
      format: 'quote',
      name: 'Quote',
      icon: (
        <ToolIcon>
          <path d="M3 3.5v9" strokeWidth="1.8" />
          <path d="M6.5 5h7M6.5 8h7M6.5 11h4.5" />
        </ToolIcon>
      )
    },
    {
      format: 'link',
      name: 'Link',
      key: 'K',
      icon: (
        <ToolIcon>
          <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2.5-2.5a2.5 2.5 0 0 0-3.5-3.5l-.75.75" />
          <path d="M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2.5 2.5a2.5 2.5 0 0 0 3.5 3.5l.75-.75" />
        </ToolIcon>
      )
    }
  ]

/**
 * Docs written in place, as markdown: CodeMirror, as the scripts are, with the
 * markup coloured as it reads and the formatting tools above it, and Preview to
 * see them rendered as they will be. Saved as the file's `docs:` as it is
 * typed, with the rest of the edits, and always exactly as typed. Focused as it
 * opens, so asking to edit means typing straight away.
 */
export default function DocsEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const onChangeRef = useRef(props.onChange)
  onChangeRef.current = props.onChange
  const onDoneRef = useRef(props.onDone)
  onDoneRef.current = props.onDone

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          drawSelection(),
          EditorView.lineWrapping,
          markdown({ completeHTMLTags: false, codeLanguages: fenceLanguage }),
          syntaxHighlighting(highlight),
          fencedLines,
          theme,
          // Over the default keys: ⌘I there selects the syntax around the cursor.
          Prec.high(
            keymap.of(
              TOOLS.flatMap((tool) =>
                tool.key
                  ? [{ key: `Mod-${tool.key.toLowerCase()}`, run: formatting(tool.format) }]
                  : []
              )
            )
          ),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            {
              key: 'Escape',
              stopPropagation: true,
              run: () => {
                if (!onDoneRef.current) return false
                onDoneRef.current()
                return true
              }
            }
          ]),
          EditorView.contentAttributes.of({ 'aria-label': props.label, spellcheck: 'true' }),
          placeholderText(props.placeholder),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          })
        ]
      })
    })
    view.current = editor
    editor.focus()
    return () => editor.destroy()
    // Built once; the text is synchronised below.
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

  const write = () => {
    setPreviewing(false)
    // Once it is shown again: hidden, it cannot take focus.
    requestAnimationFrame(() => view.current?.focus())
  }

  return (
    <div className="docs-editor">
      <div className="docs-editor-bar">
        <div className="docs-editor-modes">
          <button type="button" aria-pressed={!previewing} onClick={write}>
            Write
          </button>
          <button type="button" aria-pressed={previewing} onClick={() => setPreviewing(true)}>
            Preview
          </button>
        </div>
        {!previewing && (
          <div className="docs-editor-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map((tool) => (
              <Tooltip
                key={tool.format}
                text={tool.key ? `${tool.name} (${MAC ? '⌘' : 'Ctrl+'}${tool.key})` : tool.name}
              >
                <button
                  type="button"
                  aria-label={tool.name}
                  // The text keeps its focus and selection, for the tool to act on.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const editor = view.current
                    if (!editor) return
                    formatting(tool.format)(editor)
                    editor.focus()
                  }}
                >
                  {tool.icon}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {/* Kept while previewing, hidden, so Write comes back to the same undo history and place. */}
      <div
        className="docs-editor-text"
        ref={host}
        style={previewing ? { display: 'none' } : undefined}
      />
      {previewing && (
        <div className="docs-preview" role="region" aria-label="Preview">
          {props.value.trim() === '' ? (
            <p className="hint">Nothing to preview yet.</p>
          ) : (
            <Markdown source={props.value} />
          )}
        </div>
      )}
    </div>
  )
}

/** A tool, as a command on the editor's main selection: one change, one undo. */
function formatting(format: MarkdownFormat): Command {
  return (editor) => {
    const { from, to } = editor.state.selection.main
    const { edits, anchor, head } = formatMarkdown(editor.state.doc.toString(), from, to, format)
    editor.dispatch({
      changes: edits,
      selection: { anchor, head },
      scrollIntoView: true,
      userEvent: 'input.format'
    })
    return true
  }
}

/** A toolbar icon, drawn as the app's others are. */
function ToolIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={15}
      height={15}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

// Prose, in the app's own font and colours, so it follows light and dark with everything
// else; the box round the toolbar and the text is the editor's edge.
const theme = EditorView.theme({
  '&.cm-editor': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: '13px',
    lineHeight: '1.5'
  },
  '.cm-content': { padding: '8px 10px', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)'
  },
  '.cm-placeholder': { color: 'var(--text-dim)', fontStyle: 'italic' },
  '.cm-fenced': { fontFamily: 'var(--mono)', fontSize: '12px' }
})

const fencedLine = Decoration.line({ class: 'cm-fenced' })

/**
 * Fenced code's lines, fences included, in the code font: its language's tokens
 * take their colours from it, but no longer the font the fence's text had.
 */
const fencedLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = this.build(view)
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = this.build(update.view)
      }
    }
    build(view: EditorView): DecorationSet {
      const starts = new Set<number>()
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'FencedCode') return
            for (let at = node.from; at <= node.to;) {
              const line = view.state.doc.lineAt(at)
              starts.add(line.from)
              at = line.to + 1
            }
            return false
          }
        })
      }
      const builder = new RangeSetBuilder<Decoration>()
      for (const start of [...starts].sort((a, b) => a - b)) builder.add(start, start, fencedLine)
      return builder.finish()
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

/** The language a fence names, coloured in the text as it is in the docs shown. */
function fenceLanguage(info: string): Language | null {
  const name = info.trim().toLowerCase()
  if (name === 'json') return jsonLanguage
  if (name === 'xml') return xmlLanguage
  if (['js', 'javascript', 'mjs', 'cjs'].includes(name)) return javascriptLanguage
  if (name === 'ts' || name === 'typescript') return typescriptLanguage
  return null
}

// The markup as it will read: bold bold, headings strong, code in the code font, and the
// marks themselves quiet beside what they mark. Fenced code in the colours the docs show
// it in.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.monospace, fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--ok)' },
  { tag: [tags.link, tags.url], color: 'var(--accent)' },
  { tag: tags.quote, color: 'var(--text-dim)' },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.labelName],
    color: 'var(--text-dim)'
  },
  {
    tag: [tags.propertyName, tags.tagName, tags.function(tags.variableName)],
    color: 'var(--server)'
  },
  { tag: [tags.string, tags.attributeValue], color: 'var(--ok)' },
  { tag: [tags.number, tags.bool, tags.null, tags.attributeName], color: 'var(--redirect)' },
  { tag: tags.keyword, color: 'var(--accent)' },
  { tag: tags.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
  {
    tag: [tags.brace, tags.squareBracket, tags.separator, tags.angleBracket, tags.operator],
    color: 'var(--text-dim)'
  }
])
