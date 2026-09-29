import type { ReactNode } from 'react'
import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
  type MdListItem
} from '@schwabyio/gravity-core/model'

/**
 * Collection and step docs, rendered.
 *
 * The parsing is core's `parseMarkdown`, which `gta`'s HTML report uses too, so
 * a doc reads the same in the app and in a report. This only turns its tree
 * into React elements — no `dangerouslySetInnerHTML`, and so no injection
 * surface: docs come from files in someone's repository, which is not the same
 * as trusting them.
 */
export default function Markdown({ source }: { source: string }) {
  return <div className="md">{parseMarkdown(source).map(renderBlock)}</div>
}

function renderBlock(block: MdBlock, key: number): ReactNode {
  switch (block.type) {
    case 'code':
      return (
        <pre key={key} className="md-code" data-language={block.language ?? undefined}>
          <code>{block.text}</code>
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
        return <span key={i}>{node.text}</span>
      case 'code':
        return (
          <code key={i} className="md-inline-code">
            {node.text}
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
