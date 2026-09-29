import type { PathSegment } from './path.js'

/** One line of pretty-printed JSON, and the body path it belongs to. */
export interface JsonLine {
  text: string
  /**
   * The property or item this line shows. A container's opening and closing
   * lines both carry the container's own path, so highlighting a path lights up
   * the whole block.
   */
  path: PathSegment[]
}

/**
 * Pretty-print a value exactly as `JSON.stringify(value, null, 2)` would, but
 * line by line with each line's path attached.
 *
 * This is what lets the Tests view put an assertion beside the lines of the
 * response it is about, rather than leaving the reader to find them.
 */
export function toJsonLines(value: unknown): JsonLine[] {
  const lines: JsonLine[] = []

  const visit = (
    node: unknown,
    path: PathSegment[],
    indent: string,
    prefix: string,
    suffix: string
  ) => {
    if (Array.isArray(node)) {
      if (node.length === 0) {
        lines.push({ text: `${indent}${prefix}[]${suffix}`, path })
        return
      }
      lines.push({ text: `${indent}${prefix}[`, path })
      node.forEach((item, index) => {
        visit(
          item === undefined || typeof item === 'function' ? null : item,
          [...path, { kind: 'index', index }],
          `${indent}  `,
          '',
          index < node.length - 1 ? ',' : ''
        )
      })
      lines.push({ text: `${indent}]${suffix}`, path })
      return
    }

    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node).filter(
        ([, child]) => child !== undefined && typeof child !== 'function'
      )
      if (entries.length === 0) {
        lines.push({ text: `${indent}${prefix}{}${suffix}`, path })
        return
      }
      lines.push({ text: `${indent}${prefix}{`, path })
      entries.forEach(([key, child], i) => {
        visit(
          child,
          [...path, { kind: 'key', key }],
          `${indent}  `,
          `${JSON.stringify(key)}: `,
          i < entries.length - 1 ? ',' : ''
        )
      })
      lines.push({ text: `${indent}}${suffix}`, path })
      return
    }

    lines.push({ text: `${indent}${prefix}${JSON.stringify(node) ?? 'null'}${suffix}`, path })
  }

  visit(value, [], '', '', '')
  return lines
}
