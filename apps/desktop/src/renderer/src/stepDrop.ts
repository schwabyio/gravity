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
