/** Where a dragged step would go: before or after the step under the pointer. */
export interface StepDrop {
  index: number
  after: boolean
}

/**
 * Where a step dragged from `from` ends up, dropped before or after the step at
 * `drop.index`: once it is taken out, the steps after it each move up one.
 * Dropped beside itself, it stays where it is.
 */
export function movedTo(from: number, drop: StepDrop): number {
  const at = drop.after ? drop.index + 1 : drop.index
  return from < at ? at - 1 : at
}

/** A step's row as shown, top to bottom: its index and where it starts and ends. */
export interface StepRow {
  index: number
  top: number
  bottom: number
}

/**
 * Where a drag at height `y` would put its step: before or after the row under
 * the pointer, by which half it is over. Above the first row is before it, and
 * anywhere below the last is after it, so the end of the list is easy to reach.
 */
export function dropAtHeight(rows: readonly StepRow[], y: number): StepDrop | null {
  const row = rows.find((row) => y < row.bottom) ?? rows.at(-1)
  return row ? { index: row.index, after: y > (row.top + row.bottom) / 2 } : null
}
