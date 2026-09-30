import {
  mergeHeaders,
  type Collection,
  type Headers,
  type Settings,
  type Step
} from './documents.js'

/**
 * What a request is made of, layer by layer (SPEC.md §2.6): pure, so a run
 * and the app build the same layers — what the app shows a step inheriting
 * is what a run sends.
 */

/** Where a layer comes from, outermost first. */
export type LayerKind = 'endpoint-file' | 'endpoint' | 'base' | 'collection' | 'set' | 'step'

/** The parts of a document a layer takes. */
export type LayerParts = Pick<Collection, 'headers' | 'settings' | 'before' | 'tests'>

/** One layer of a request: its headers and settings, and the scripts that run around it. */
export interface RequestLayer extends LayerParts {
  kind: LayerKind
}

export interface LayerSources {
  /** The endpoint base the request is under: its file's own parts, and the endpoint's. */
  endpoint?: { file: LayerParts; step: LayerParts } | null | undefined
  /** The base collection the collection `extends:` (§2.7). */
  base?: LayerParts | null | undefined
  collection?: LayerParts | undefined
  /** The request set, for one of its steps run by a use step (§2.5). */
  set?: LayerParts | null | undefined
  /** The step's scripts. Its own headers and settings go on top as the request is built. */
  step: Pick<Step, 'before' | 'tests'>
}

const partsOf = (doc: LayerParts | undefined): LayerParts => ({
  headers: doc?.headers,
  settings: doc?.settings,
  before: doc?.before,
  tests: doc?.tests
})

/**
 * A request's layers, outermost first: the endpoints file's own, the
 * endpoint's, the base collection's, the collection's, the request set's and
 * the step's. Scripts run in this order, and nearer headers and settings win.
 */
export function requestLayers(sources: LayerSources): RequestLayer[] {
  const layers: RequestLayer[] = []
  if (sources.endpoint) {
    layers.push({ kind: 'endpoint-file', ...partsOf(sources.endpoint.file) })
    layers.push({ kind: 'endpoint', ...partsOf(sources.endpoint.step) })
  }
  if (sources.base) layers.push({ kind: 'base', ...partsOf(sources.base) })
  layers.push({ kind: 'collection', ...partsOf(sources.collection) })
  if (sources.set) layers.push({ kind: 'set', ...partsOf(sources.set) })
  layers.push({ kind: 'step', before: sources.step.before, tests: sources.step.tests })
  return layers
}

/**
 * The headers and settings of layers, folded outermost first so each nearer
 * one wins: what the step's own go on top of.
 */
export function foldLayers(layers: ReadonlyArray<LayerParts>): {
  headers: Headers | undefined
  settings: Settings
} {
  let headers: Headers | undefined
  let settings: Settings = {}
  for (const layer of layers) {
    if (layer.headers) headers = mergeHeaders(headers, layer.headers)
    settings = { ...settings, ...layer.settings }
  }
  return { headers, settings }
}
