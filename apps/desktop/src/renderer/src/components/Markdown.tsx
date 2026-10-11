import type { ReactNode } from 'react'
import {
  CALLOUTS,
  markInlineCode,
  markText,
  parseMarkdown,
  type CalloutKind,
  type MdBlock,
  type MdInline,
  type MdListItem,
  type TextMark
} from '@schwabyio/gravity-core/model'
import { docCodeMarks } from '../docCode.js'

/**
 * Collection and step docs, rendered.
 *
 * The parsing is core's `parseMarkdown`, which `gta`'s HTML report uses too, so
 * a doc reads the same in the app and in a report. This only turns its tree
 * into React elements — no `dangerouslySetInnerHTML`, and so no injection
 * surface: docs come from files in someone's repository, which is not the same
 * as trusting them.
 *
 * Coloured as core's `markdownMarks` marks it, as a report colours it: fenced
 * code token by token, `{{variables}}` as the URL bar marks them, and a method
 * or status code in inline code in its colour; callouts in theirs.
 */
export default function Markdown({ source }: { source: string }) {
  return <div className="md">{parseMarkdown(source).map(renderBlock)}</div>
}

function renderBlock(block: MdBlock, key: number): ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre key={key} className="md-code" data-language={block.language ?? undefined}>
          <code>
            {docCodeMarks(block.text, block.language).map((piece, i) => {
              const className = [piece.kind && `tok-${piece.kind}`, piece.variable && 'md-var']
                .filter(Boolean)
                .join(' ')
              return className ? (
                <span key={i} className={className}>
                  {piece.text}
                </span>
              ) : (
                piece.text
              )
            })}
          </code>
        </pre>
      )
    case 'heading': {
      const Tag = `h${Math.min(block.level + 2, 6)}` as 'h3'
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.content)}
        </Tag>
      )
    }
    case 'rule':
      return <hr key={key} className="md-hr" />
    case 'table':
      return (
        <table key={key} className="md-table">
          <thead>
            <tr>
              {block.header.map((cell, i) => (
                <th key={i}>{renderInline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {block.blocks.map(renderBlock)}
        </blockquote>
      )
    case 'callout':
      return (
        <div key={key} className={`md-callout md-callout-${block.kind}`} role="note">
          <p className="md-callout-title">
            <CalloutIcon kind={block.kind} />
            {CALLOUTS[block.kind].label}
          </p>
          {block.blocks.map(renderBlock)}
        </div>
      )
    case 'list':
      return renderList(block.ordered, block.items, key)
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInline(block.content)}
        </p>
      )
  }
}

function renderList(ordered: boolean, items: MdListItem[], key: number): ReactNode {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag key={key} className="md-list">
      {items.map((item, i) => (
        <li key={i}>
          {renderInline(item.content)}
          {item.children?.type === 'list' &&
            renderList(item.children.ordered, item.children.items, 0)}
        </li>
      ))}
    </Tag>
  )
}

function renderInline(nodes: MdInline[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <span key={i}>{markText(node.text).map(renderMark)}</span>
      case 'code':
        return (
          <code key={i} className="md-inline-code">
            {markInlineCode(node.text).map(renderMark)}
          </code>
        )
      case 'strong':
        return <strong key={i}>{renderInline(node.children)}</strong>
      case 'em':
        return <em key={i}>{renderInline(node.children)}</em>
      case 'link':
        return (
          // target=_blank routes through main's window-open handler, which hands the
          // URL to the real browser rather than opening anything in the app.
          <a key={i} href={node.href} target="_blank" rel="noreferrer noopener" title={node.href}>
            {node.label}
          </a>
        )
    }
  })
}

function renderMark(piece: TextMark, key: number): ReactNode {
  switch (piece.mark) {
    case null:
      return piece.text
    case 'variable':
      return (
        <span key={key} className="md-var">
          {piece.text}
        </span>
      )
    case 'method':
      return (
        <span key={key} className={`md-method m-${piece.method.toLowerCase()}`}>
          {piece.text}
        </span>
      )
    case 'status':
      return (
        <span key={key} className={`md-status md-status-${piece.status}`}>
          {piece.text}
        </span>
      )
  }
}

function CalloutIcon({ kind }: { kind: CalloutKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={CALLOUTS[kind].icon} />
    </svg>
  )
}
