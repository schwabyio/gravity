/**
 * Variable preview types.
 *
 * These live in the model rather than beside the resolver because the renderer
 * needs them, and the model entry point is the one it can import without
 * dragging the filesystem into a sandboxed bundle.
 */

/** How a variable's value is produced, which decides how the UI may show it. */
export type VariableKind = 'static' | 'secret' | 'dynamic'

export interface VariablePreview {
  /**
   * The resolved value as text.
   *
   * Null for a `dynamic` variable, whose value only exists during a run, and for
   * a `secret`, whose value is never sent to the renderer at all.
   */
  value: string | null
  /** Where the winning value came from, e.g. `environments/demo.yml`. */
  origin: string
  kind: VariableKind
}

export type VariablePreviews = Record<string, VariablePreview>
