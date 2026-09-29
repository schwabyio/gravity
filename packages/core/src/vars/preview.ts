import fs from 'node:fs/promises'
import { parseCollection } from '../format/index.js'
import type { Step } from '../model/documents.js'
import type { VariablePreviews } from '../model/variables.js'

export type { VariableKind, VariablePreview, VariablePreviews } from '../model/variables.js'
import { interpolate } from './interpolate.js'
import { BUILT_INS, InterpolationError, VariableScope } from './scope.js'
import { buildScope, type ScopeContext } from './resolve.js'

/** Every `{{name}}` referenced anywhere in a step. */
export function referencedVariables(step: Step): string[] {
  const found = new Set<string>()
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)) {
        if (match[1]) found.add(match[1])
      }
      return
    }
    if (Array.isArray(value)) return value.forEach(scan)
    if (value !== null && typeof value === 'object') Object.values(value).forEach(scan)
  }
  scan(step)
  return [...found].sort()
}

/**
 * Resolve the variables a request can see, for display rather than for sending.
 *
 * A preview never runs code and never reports a failure: an unresolvable name is
 * simply absent from the result, which is what lets the editor grey it out
 * instead of interrupting with an error while you type. A variable a
 * pre-request script sets is known to exist, but its value only once it runs.
 */
export async function previewVariables(
  step: Step,
  context: ScopeContext | null,
  /** The collection's `before.script` as edited; absent, it is read from the file. */
  collectionScript?: string | null
): Promise<VariablePreviews> {
  const previews: VariablePreviews = {}

  for (const name of Object.keys(BUILT_INS)) {
    previews[name] = { value: null, origin: 'built-in', kind: 'dynamic' }
  }

  if (!context) return previews

  let scope: VariableScope
  const secrets = new Set<string>()
  try {
    scope = await buildScope(context)
  } catch (cause) {
    // A missing secret must not blank out every other variable in the editor;
    // resolve what we can and mark the one that failed.
    if (cause instanceof InterpolationError && cause.variable) {
      secrets.add(cause.variable)
      previews[cause.variable] = {
        value: null,
        origin: 'secret with no value',
        kind: 'secret'
      }
    }
    scope = await buildScope({ ...context, environmentName: null }).catch(() => new VariableScope())
  }

  for (const name of scope.names()) {
    const secret = scope.isSecret(name)
    previews[name] = {
      // A secret resolves — the run will use it — but its value is never put in
      // the preview: a tooltip that reveals a token on hover is one screenshare
      // away from leaking it. Copying is still offered, being a deliberate act.
      value: secret ? null : renderValue(scope.get(name), scope),
      origin: scope.originOf(name) ?? 'unknown',
      kind: secret ? 'secret' : 'static'
    }
  }

  const shared =
    collectionScript !== undefined
      ? (collectionScript ?? undefined)
      : await readCollectionScript(context.collectionPath)
  for (const script of [shared, step.before?.script]) {
    for (const name of setBy(script)) {
      previews[name] = { value: null, origin: 'pre-request script', kind: 'dynamic' }
    }
  }
  return previews
}

/** Names a script sets with a literal `gta.set('name', …)`. */
export function setBy(script: string | undefined): string[] {
  if (!script) return []
  return [...script.matchAll(/\bgta\.set\(\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]!)
}

async function readCollectionScript(file: string): Promise<string | undefined> {
  try {
    return parseCollection(await fs.readFile(file, 'utf8')).data.before?.script
  } catch {
    return undefined
  }
}

function renderValue(raw: unknown, scope: VariableScope): string | null {
  if (raw === null || raw === undefined) return ''
  if (typeof raw !== 'string') return String(raw)
  return safeInterpolate(raw, scope)
}

/** A variable whose own value fails to resolve previews as unresolved, not as a crash. */
function safeInterpolate(text: string, scope: VariableScope): string | null {
  try {
    const result = interpolate(text, scope)
    return result === null || result === undefined ? '' : String(result)
  } catch {
    return null
  }
}
