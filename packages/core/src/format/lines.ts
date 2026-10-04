import YAML, { LineCounter } from 'yaml'
import type { StepList } from '../model/documents.js'

/** Where in a collection-shaped file to point: a step, its script or the file's own, and a line of that script. */
export interface SourcePlace {
  /** A step of a list; without it, the file's own `tests` or `before.script`. */
  step?: { list: StepList; index: number }
  script?: 'tests' | 'pre-request'
  /** A line of that script, 1-based: where its error was, say. */
  scriptLine?: number
}

/**
 * The line of a collection, request set, endpoints file or base collection a
 * place is on, 1-based, for an editor to open at: a step's first line; a
 * script's first line — the one under `tests: |`, or `tests:` itself for a
 * one-line script — moved down to `scriptLine`. A script that is not there
 * falls back to its step, and a step that is not there to nothing.
 */
export function sourceLine(source: string, place: SourcePlace): number | undefined {
  const lineCounter = new LineCounter()
  const document = YAML.parseDocument(source, { lineCounter })
  const lineAt = (offset: number) => lineCounter.linePos(offset).line
  const owner: Array<string | number> = place.step ? [place.step.list, place.step.index] : []
  const step = place.step ? document.getIn(owner, true) : null
  const stepLine =
    YAML.isNode(step) && step.range ? lineAt(step.range[0]) : place.step ? undefined : 1

  if (!place.script) return stepLine
  const script = document.getIn(
    place.script === 'tests' ? [...owner, 'tests'] : [...owner, 'before', 'script'],
    true
  )
  if (!YAML.isScalar(script) || !script.range) return stepLine
  // A block scalar's text starts on the line after its `|`.
  const block = script.type === 'BLOCK_LITERAL' || script.type === 'BLOCK_FOLDED'
  const first = lineAt(script.range[0]) + (block ? 1 : 0)
  return first + Math.max(0, (place.scriptLine ?? 1) - 1)
}
