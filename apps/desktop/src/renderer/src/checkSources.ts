import type { ScriptOwner, ScriptSource } from '@schwabyio/gravity-core/model'
import type { InheritedLayer } from './inheritance.js'

/**
 * Where a check came from, as a result says it: nothing for the step's own
 * tests, else the layer around the step whose tests made it — `collection`,
 * `endpoint GET /users/{id}`, `base collection auth` — and the check file
 * that made it, when one did. Pure, so the results and their tests agree.
 */
export function sourceTags(
  source: ScriptSource | undefined,
  own: ScriptOwner,
  layers: readonly InheritedLayer[]
): string[] {
  if (!source) return []
  const tags: string[] = []
  if (source.script !== own) {
    const layer = layers.find((candidate) => candidate.kind === source.script)
    tags.push(
      layer
        ? [layer.title, layer.name].filter(Boolean).join(' ')
        : source.script === 'set'
          ? 'reusable requests'
          : source.script
    )
  }
  if (source.check) tags.push(checkFileName(source.check.file))
  return tags
}

/**
 * A check file named from its `checks/` folder on, as it is known in either
 * project: a global project's `../shared/checks/money.js` is `checks/money.js`.
 */
export function checkFileName(file: string): string {
  const at = file.lastIndexOf('checks/')
  return at >= 0 ? file.slice(at) : file
}

/** The check files a script calls, by `checks.<name>`, in the order it first does. */
export function calledChecks(code: string): string[] {
  const names: string[] = []
  for (const [, name] of code.matchAll(/\bchecks\.([A-Za-z_$][\w$]*)/g)) {
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
