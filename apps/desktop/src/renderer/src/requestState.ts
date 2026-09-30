// Model only: importing the package root would pull undici and node:child_process
// into the sandboxed renderer bundle.
import {
  HTTP_METHODS as CORE_METHODS,
  isUseStep,
  readRequestLine,
  type Body,
  type FlagConditions,
  type Headers,
  type HttpMethod,
  type MultipartField,
  type MultipartPart,
  type Settings,
  type Step,
  type VarValue
} from '@schwabyio/gravity-core/model'

export interface HeaderRow {
  id: string
  name: string
  value: string
  enabled: boolean
}

export type BodyMode = 'none' | 'json' | 'xml' | 'text' | 'form' | 'multipart' | 'file'

/** One part of a multipart body, as the editor shows it: a row per value. */
export interface PartRow {
  id: string
  name: string
  kind: 'text' | 'file'
  /** The text, or a file's path from the project folder. */
  value: string
  /** Blank: none for text, and for a file, from its extension. */
  contentType: string
  /** A file's name as sent, when not its own: kept as read, with no editor. */
  filename?: string
}

/** The part of a step the editor shows and can change. */
export interface EditorState {
  name: string
  method: HttpMethod
  url: string
  headers: HeaderRow[]
  bodyMode: BodyMode
  bodyText: string
  /** For a multipart body; a blank row at the end to type into. */
  bodyParts: PartRow[]
  /** For a file body: its path from the project folder. */
  bodyFile: string
  /** The step's `before.script`: JavaScript run before the request. */
  preRequest: string
  /** The step's `tests`: JavaScript run after the response. */
  tests: string
  /** The step's own tags; only used when the collection has `stepTags: true`. */
  tags: string[]
  /** Feature flags the step needs to run (SPEC.md §2.9); empty for none. */
  flags: FlagConditions
  /**
   * A list to send the request once per item of, as `{{item}}` (SPEC.md §2.1):
   * `{{roots}}`, or a JSON array. Empty for none; a use step never has one.
   */
  forEach: string
  /**
   * In a request set: the use step's own tests check this step's response
   * rather than the set's last (SPEC.md §2.5).
   */
  useTests: boolean
  /** The step's own settings; anything absent is inherited from the collection. */
  settings: Settings
  /**
   * For a use step: the request set it runs, and the values it passes. Null
   * for a request of the step's own — then `method`, `url` and the rest apply.
   */
  use: string | null
  with: Record<string, VarValue>
  /** Whether the step uses its endpoint's base (SPEC.md §2.6); only `false` is written. */
  base: boolean
}

export const HTTP_METHODS: readonly HttpMethod[] = CORE_METHODS

export const BODY_MODES: Array<{ value: BodyMode; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'text', label: 'Text' },
  { value: 'form', label: 'Form URL Encoded' },
  { value: 'multipart', label: 'Multipart Form' },
  { value: 'file', label: 'File' }
]

let rowCounter = 0
export const newRow = (): HeaderRow => ({
  id: `row-${++rowCounter}`,
  name: '',
  value: '',
  enabled: true
})

export const newPart = (): PartRow => ({
  id: `part-${++rowCounter}`,
  name: '',
  kind: 'text',
  value: '',
  contentType: ''
})

export const emptyRequest = (): EditorState => ({
  name: 'Untitled request',
  method: 'GET',
  url: '',
  headers: [newRow()],
  bodyMode: 'none',
  bodyText: '',
  bodyParts: [newPart()],
  bodyFile: '',
  preRequest: '',
  tests: '',
  tags: [],
  flags: {},
  forEach: '',
  useTests: false,
  settings: {},
  use: null,
  with: {},
  base: true
})

/** A query parameter as read out of the URL; the URL stays the source of truth. */
export interface QueryParam {
  name: string
  value: string
}

export function readQueryParams(url: string): QueryParam[] {
  const start = url.indexOf('?')
  if (start === -1) return []
  return [...new URLSearchParams(url.slice(start + 1))].map(([name, value]) => ({ name, value }))
}

/** Rewrite a URL's query string from an edited parameter table. */
export function writeQueryParams(url: string, params: QueryParam[]): string {
  const start = url.indexOf('?')
  const base = start === -1 ? url : url.slice(0, start)
  const kept = params.filter((p) => p.name.trim() !== '' || p.value.trim() !== '')
  if (kept.length === 0) return base
  const search = kept
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
    .join('&')
  return `${base}?${search}`
}

/**
 * Header rows back to the authored map. Rows sharing a name become a repeated
 * header (a list); a header written in the long form — with a `description` —
 * keeps that form and its description, given the map it was read from.
 */
export function toHeaders(rows: HeaderRow[], original?: Headers): Headers | undefined {
  const named = rows.filter((row) => row.name.trim() !== '')
  if (named.length === 0) return undefined
  const headers: Headers = {}
  for (const name of new Set(named.map((row) => row.name))) {
    const all = named.filter((row) => row.name === name)
    const on = all.filter((row) => row.enabled)
    if (on.length > 1) {
      headers[name] = on.map((row) => row.value)
      continue
    }
    const row = on[0] ?? all[0]!
    const before = original?.[name]
    if (before !== undefined && typeof before === 'object' && !Array.isArray(before)) {
      const { enabled: _enabled, ...rest } = before
      headers[name] = {
        ...rest,
        value: row.value,
        ...(row.enabled ? ('enabled' in before ? { enabled: true } : {}) : { enabled: false })
      }
    } else {
      headers[name] = row.enabled ? row.value : { value: row.value, enabled: false }
    }
  }
  return headers
}

/** The authored map as editor rows, one per value, with a blank row to type in. */
export function headerRows(headers: Headers | undefined): HeaderRow[] {
  const rows: HeaderRow[] = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === 'string') rows.push({ ...newRow(), name, value, enabled: true })
    else if (Array.isArray(value))
      for (const item of value) rows.push({ ...newRow(), name, value: item, enabled: true })
    else rows.push({ ...newRow(), name, value: value.value, enabled: value.enabled !== false })
  }
  rows.push(newRow())
  return rows
}

/**
 * Part rows back to the authored map. Rows sharing a name become a list, in
 * the order the name first appears; a file row with no file yet is left out.
 */
export function toMultipart(rows: PartRow[]): Record<string, MultipartField> {
  const kept = rows.filter(
    (row) => row.name.trim() !== '' && (row.kind === 'text' || row.value.trim() !== '')
  )
  const byName = new Map<string, MultipartPart[]>()
  for (const row of kept) {
    const contentType = row.contentType.trim()
    const part: MultipartPart =
      row.kind === 'file'
        ? {
            file: row.value.trim(),
            ...(contentType ? { contentType } : {}),
            ...(row.filename !== undefined ? { filename: row.filename } : {})
          }
        : contentType
          ? { value: row.value, contentType }
          : row.value
    byName.set(row.name, [...(byName.get(row.name) ?? []), part])
  }
  return Object.fromEntries(
    [...byName].map(([name, parts]) => [name, parts.length === 1 ? parts[0]! : parts])
  )
}

/** The authored map as part rows, one per value, with a blank row to type in. */
export function partRows(multipart: Record<string, MultipartField> | undefined): PartRow[] {
  const rows: PartRow[] = []
  for (const [name, field] of Object.entries(multipart ?? {})) {
    for (const part of Array.isArray(field) ? field : [field]) {
      if (typeof part === 'string') rows.push({ ...newPart(), name, value: part })
      else if ('file' in part) {
        rows.push({
          ...newPart(),
          name,
          kind: 'file',
          value: part.file,
          contentType: part.contentType ?? '',
          ...(part.filename !== undefined ? { filename: part.filename } : {})
        })
      } else
        rows.push({ ...newPart(), name, value: part.value, contentType: part.contentType ?? '' })
    }
  }
  rows.push(newPart())
  return rows
}

export function toBody(
  edited: Pick<EditorState, 'bodyMode' | 'bodyText' | 'bodyParts' | 'bodyFile'>
): Step['body'] {
  const text = edited.bodyText
  switch (edited.bodyMode) {
    case 'multipart':
      return { multipart: toMultipart(edited.bodyParts) }
    case 'file':
      // Nothing to send until a file is named.
      return edited.bodyFile.trim() === '' ? undefined : { file: edited.bodyFile.trim() }
    case 'none':
      return undefined
    case 'json':
      return { json: text }
    case 'xml':
      return { xml: text }
    case 'text':
      return { text }
    case 'form':
      return {
        form: Object.fromEntries(
          text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
            .map((line) => {
              const eq = line.indexOf('=')
              return eq === -1
                ? ([line, ''] as const)
                : ([line.slice(0, eq), line.slice(eq + 1)] as const)
            })
        )
      }
  }
}

/** Read the editable subset of a step into editor state. */
export function fromStep(step: Step): EditorState {
  if (isUseStep(step)) {
    return {
      ...emptyRequest(),
      name: step.name ?? '',
      url: '',
      headers: [newRow()],
      tests: step.tests ?? '',
      tags: step.tags ?? [],
      flags: step.flags ?? {},
      use: step.use,
      with: step.with ?? {}
    }
  }
  const { method, url } = readRequestLine(step)
  const headers = headerRows(step.headers)

  return {
    name: step.name ?? '',
    method,
    url,
    headers,
    ...readBody(step.body),
    preRequest: step.before?.script ?? '',
    tests: step.tests ?? '',
    tags: step.tags ?? [],
    flags: step.flags ?? {},
    forEach: step.forEach ?? '',
    useTests: step.useTests === true,
    settings: step.settings ?? {},
    use: null,
    with: {},
    base: step.base !== false
  }
}

/**
 * A use step: its set, the values it passes and its own tests. It has no
 * request of its own, so nothing else is carried over except `docs`.
 */
function mergeIntoUseStep(original: Step, edited: EditorState): Step {
  const next: Record<string, unknown> = {}
  if (edited.name.trim() !== '') next['name'] = edited.name
  next['use'] = edited.use
  if (Object.keys(edited.with).length > 0) next['with'] = edited.with
  if (edited.tags.length > 0) next['tags'] = edited.tags
  if (Object.keys(edited.flags).length > 0) next['flags'] = edited.flags
  if (original.docs !== undefined) next['docs'] = original.docs
  if (edited.tests.trim() !== '') next['tests'] = edited.tests
  return next as Step
}

type BodyState = Pick<EditorState, 'bodyMode' | 'bodyText' | 'bodyParts' | 'bodyFile'>

function readBody(body: Body | undefined): BodyState {
  const none: BodyState = { bodyMode: 'none', bodyText: '', bodyParts: [newPart()], bodyFile: '' }
  if (!body) return none
  if (body.json !== undefined) return { ...none, bodyMode: 'json', bodyText: body.json }
  if (body.xml !== undefined) return { ...none, bodyMode: 'xml', bodyText: body.xml }
  if (body.text !== undefined) return { ...none, bodyMode: 'text', bodyText: body.text }
  if (body.form !== undefined) {
    const lines = Object.entries(body.form).map(([name, value]) => `${name}=${value}`)
    return { ...none, bodyMode: 'form', bodyText: lines.join('\n') }
  }
  if (body.multipart !== undefined) {
    return { ...none, bodyMode: 'multipart', bodyParts: partRows(body.multipart) }
  }
  if (body.file !== undefined) return { ...none, bodyMode: 'file', bodyFile: body.file }
  // graphql bodies have no editor yet; leave them untouched on save.
  return none
}

/**
 * Overlay editor state onto the step it came from.
 *
 * Crucially this MERGES rather than rebuilds: `docs` has no editor yet, and rebuilding the step from
 * editor state alone would silently delete every one of them on the first save.
 */
export function mergeIntoStep(original: Step, edited: EditorState): Step {
  if (edited.use !== null) return mergeIntoUseStep(original, edited)
  const next: Record<string, unknown> = { ...original }
  for (const method of HTTP_METHODS) delete next[method]
  next[edited.method] = edited.url

  const headers = toHeaders(edited.headers, original.headers)
  if (headers) next['headers'] = headers
  else delete next['headers']

  const body = toBody(edited)
  if (body) next['body'] = body
  else if (isEditableBody(original.body)) delete next['body']

  if (edited.name.trim() === '') delete next['name']
  else next['name'] = edited.name

  if (edited.tags.length === 0) delete next['tags']
  else next['tags'] = edited.tags

  if (Object.keys(edited.flags).length === 0) delete next['flags']
  else next['flags'] = edited.flags

  if (edited.forEach.trim() === '') delete next['forEach']
  else next['forEach'] = edited.forEach

  if (edited.useTests) next['useTests'] = true
  else delete next['useTests']

  const settings = Object.fromEntries(
    Object.entries(edited.settings).filter(([, value]) => value !== undefined)
  )
  if (Object.keys(settings).length === 0) delete next['settings']
  else next['settings'] = settings

  if (edited.tests.trim() === '') delete next['tests']
  else next['tests'] = edited.tests

  if (edited.base) delete next['base']
  else next['base'] = false

  // `before` also holds `set`, which has no editor: change only `script`.
  const before: Record<string, unknown> = { ...original.before }
  if (edited.preRequest.trim() === '') delete before['script']
  else before['script'] = edited.preRequest
  if (Object.keys(before).length > 0) next['before'] = before
  else delete next['before']

  return next as Step
}

/** A body the editor can represent, and may therefore remove. */
const isEditableBody = (body: Body | undefined): boolean =>
  body === undefined ||
  body.json !== undefined ||
  body.xml !== undefined ||
  body.text !== undefined ||
  body.form !== undefined ||
  body.multipart !== undefined ||
  body.file !== undefined
