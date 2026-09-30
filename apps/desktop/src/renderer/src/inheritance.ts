import {
  findEndpoint,
  foldLayers,
  isHeaderEnabled,
  mergeHeaders,
  requestLayers,
  SETTINGS_DEFAULTS,
  type Collection,
  type Headers,
  type HttpMethod,
  type LayerKind,
  type LayerParts,
  type Settings
} from '@schwabyio/gravity-core/model'
import type { EndpointView, LibraryFileView } from '@shared/ipc.js'

/**
 * What a step inherits, layer by layer, as the request editor shows it (SPEC.md
 * §2.6): built by core's `requestLayers`, as a run builds them, so what the
 * editor shows a step inheriting is what a run sends.
 */

/** A layer a step inherits: everything outside the step, outermost first. */
export interface InheritedLayer extends LayerParts {
  kind: Exclude<LayerKind, 'set' | 'step'>
  /** What kind of layer it is, for "From the endpoints file", "the base collection’s". */
  title: string
  /** Which one: `users.yml`, `GET /users/{id}`, `auth`. Null for the collection. */
  name: string | null
  /** From the global project. */
  shared: boolean
  /** False for an endpoint base's layers when the step says `base: false`. */
  used: boolean
  /** The endpoint base, for an endpoint layer; the base collection's file, for the base. */
  endpoint?: EndpointView
  path?: string
}

const GLOBAL = 'global:'

/**
 * The base collection an `extends:` names, found as a run finds it (SPEC.md
 * §2.7): the project's, else its global project's; `global:name` only the
 * global project's.
 */
export function findBase(
  bases: LibraryFileView[],
  reference: string | undefined
): LibraryFileView | null {
  if (!reference) return null
  const onlyGlobal = reference.startsWith(GLOBAL)
  const name = onlyGlobal ? reference.slice(GLOBAL.length) : reference
  const named = (source: LibraryFileView['source']) =>
    bases.find((base) => base.source === source && base.name === name)
  return (onlyGlobal ? named('global') : (named('project') ?? named('global'))) ?? null
}

/** The layers a step's request inherits, outermost first. */
export function inheritedLayers(input: {
  method: HttpMethod
  url: string
  /** False when the step says `base: false`. */
  useBase: boolean
  endpoints: EndpointView[]
  bases: LibraryFileView[]
  collection: Pick<Collection, 'headers' | 'settings' | 'before' | 'tests' | 'extends'>
}): InheritedLayer[] {
  const endpoint = findEndpoint(input.method, input.url, input.endpoints)
  const base = findBase(input.bases, input.collection.extends)
  const layers = requestLayers({
    endpoint: endpoint ? { file: endpoint.file, step: endpoint.step } : null,
    base: base?.layer ?? null,
    collection: input.collection,
    step: {}
  })
  return layers.flatMap((layer): InheritedLayer[] => {
    const { kind, ...parts } = layer
    switch (kind) {
      case 'endpoint-file':
      case 'endpoint':
        return [
          {
            ...parts,
            kind,
            title: kind === 'endpoint' ? 'endpoint' : 'endpoints file',
            name:
              kind === 'endpoint'
                ? `${endpoint!.method} ${endpoint!.path}`
                : `${endpoint!.fileName}.yml`,
            shared: endpoint!.source === 'global',
            used: input.useBase,
            endpoint: endpoint!
          }
        ]
      case 'base':
        return [
          {
            ...parts,
            kind,
            title: 'base collection',
            name: base!.name,
            shared: base!.source === 'global',
            used: true,
            path: base!.path
          }
        ]
      case 'collection':
        return [{ ...parts, kind, title: 'collection', name: null, shared: false, used: true }]
      default:
        return []
    }
  })
}

/** What the step sends: the layers it uses, folded, with its own headers over them. */
export function sentHeaders(layers: InheritedLayer[], own: Headers | undefined): Headers {
  return mergeHeaders(foldLayers(layers.filter((layer) => layer.used)).headers, own)
}

/** How many headers go out: a repeated one once for each value, one that is off not at all. */
export function headerCount(headers: Headers): number {
  return Object.values(headers).reduce(
    (count, value) =>
      count + (Array.isArray(value) ? value.length : isHeaderEnabled(value) ? 1 : 0),
    0
  )
}

const sends = (headers: Headers | undefined, name: string): boolean =>
  Object.entries(headers ?? {}).some(
    ([other, value]) => other.toLowerCase() === name.toLowerCase() && isHeaderEnabled(value)
  )

/**
 * What replaces a layer's header: the nearest that also sends one of that
 * name — the step, or a layer nearer it — or null when this one is sent.
 * Names compare ignoring case, as HTTP's do.
 */
export function replacedBy(
  layers: InheritedLayer[],
  index: number,
  name: string,
  own: Headers | undefined
): string | null {
  if (sends(own, name)) return 'this step'
  for (let nearer = layers.length - 1; nearer > index; nearer--) {
    const layer = layers[nearer]!
    if (layer.used && sends(layer.headers, name)) return `the ${layer.title}`
  }
  return null
}

/**
 * A setting as the step inherits it: from the nearest layer that sets it, or
 * undefined when none does and the default applies.
 */
export function inheritedSetting<K extends keyof Settings>(
  layers: InheritedLayer[],
  key: K
): { value: NonNullable<Settings[K]>; from: string } | undefined {
  for (let nearer = layers.length - 1; nearer >= 0; nearer--) {
    const layer = layers[nearer]!
    const value = layer.settings?.[key]
    if (layer.used && value !== undefined) return { value: value!, from: layer.title }
  }
  return undefined
}

/** Each setting a step inherits, and the layer it comes from. */
export type InheritedSettings = {
  [K in keyof Settings]?: { value: NonNullable<Settings[K]>; from: string }
}

/** Every setting a step inherits from its layers; one none sets is the default. */
export function inheritedSettings(layers: InheritedLayer[]): InheritedSettings {
  const settings: Record<string, unknown> = {}
  for (const key of Object.keys(SETTINGS_DEFAULTS) as Array<keyof Settings>) {
    const found = inheritedSetting(layers, key)
    if (found) settings[key] = found
  }
  return settings as InheritedSettings
}
