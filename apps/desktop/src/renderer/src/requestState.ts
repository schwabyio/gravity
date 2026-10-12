// Model only: importing the package root would pull undici and node:child_process
// into the sandboxed renderer bundle.
import {
  HTTP_METHODS as CORE_METHODS,
  headerItems,
  isReadStep,
  isUseStep,
  isWaitStep,
  readRequestLine,
  waitProblem,
  type Body,
  type FlagConditions,
  type HeaderValue,
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
  /** The step's `docs`: markdown about it; empty for none. */
  docs: string
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
  /**
   * For a request: the connection its event stream stays open as, for later
   * steps to read (SPEC.md §2.11); empty for none.
   */
  connection: string
  /**
   * For a step reading a connection: its name. Null for a request of the
   * step's own; a reading step sends nothing, so it has no method, URL,
   * headers or body.
   */
  reads: string | null
  /**
   * For a wait step (SPEC.md §2.1): how long it waits, as typed — milliseconds,
   * or a `{{variable}}` holding them. Null for any other step; a wait step sends
   * nothing and has no scripts.
   */
  wait: string | null
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
  docs: '',
  tags: [],
  flags: {},
  forEach: '',
  useTests: false,
  settings: {},
  use: null,
  with: {},
  base: true,
  connection: '',
  reads: null,
  wait: null
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

/** A header value in the long form: `{ value, enabled?, description? }`. */
type HeaderLongForm = Extract<HeaderValue, { value: string }>

/**
 * Header rows back to the authored map. Rows whose names match, ignoring case as
 * HTTP does, are one repeated header (a list), named as the first is written; a
 * row switched off in one is kept, in the long form, rather than dropped. A value
 * written in the long form — with a `description` — keeps that form and its
 * description, given the map it was read from.
 */
export function toHeaders(rows: HeaderRow[], original?: Headers): Headers | undefined {
  const named = rows.filter((row) => row.name.trim() !== '')
  if (named.length === 0) return undefined
  const groups = new Map<string, HeaderRow[]>()
  for (const row of named) {
    const key = row.name.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const headers: Headers = {}
  for (const [key, group] of groups) {
    // What each row was written as: the values of every key of this name, in order.
    const before = Object.entries(original ?? {})
      .filter(([name]) => name.toLowerCase() === key)
      .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    const written = group.map((row, i) => headerItemOf(row, before[i]))
    headers[group[0]!.name] = written.length === 1 ? written[0]! : written
  }
  return headers
}

/** One row as a value: plain when it is on with nothing else to keep, the long form otherwise. */
function headerItemOf(row: HeaderRow, before: string | HeaderLongForm | undefined) {
  if (before !== undefined && typeof before === 'object') {
    const { enabled: _enabled, ...rest } = before
    return {
      ...rest,
      value: row.value,
      ...(row.enabled ? ('enabled' in before ? { enabled: true } : {}) : { enabled: false })
    }
  }
  return row.enabled ? row.value : { value: row.value, enabled: false }
}

/** The authored map as editor rows, one per value, with a blank row to type in. */
export function headerRows(headers: Headers | undefined): HeaderRow[] {
  const rows: HeaderRow[] = []
  for (const [name, value] of Object.entries(headers ?? {})) {
    for (const item of headerItems(value)) {
      rows.push({ ...newRow(), name, value: item.value, enabled: item.enabled })
    }
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
  if (isWaitStep(step)) {
    return {
      ...emptyRequest(),
      name: step.name ?? '',
      docs: step.docs ?? '',
      tags: step.tags ?? [],
      flags: step.flags ?? {},
      wait: String(step.wait)
    }
  }
  if (isUseStep(step)) {
    return {
      ...emptyRequest(),
      name: step.name ?? '',
      url: '',
      headers: [newRow()],
      tests: step.tests ?? '',
      docs: step.docs ?? '',
      tags: step.tags ?? [],
      flags: step.flags ?? {},
      use: step.use,
      with: step.with ?? {}
    }
  }
  if (isReadStep(step)) {
    return {
      ...emptyRequest(),
      name: step.name ?? '',
      preRequest: step.before?.script ?? '',
      tests: step.tests ?? '',
      docs: step.docs ?? '',
      tags: step.tags ?? [],
      flags: step.flags ?? {},
      useTests: step.useTests === true,
      settings: step.settings ?? {},
      reads: step.connection
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
    docs: step.docs ?? '',
    tags: step.tags ?? [],
    flags: step.flags ?? {},
    forEach: step.forEach ?? '',
    useTests: step.useTests === true,
    settings: step.settings ?? {},
    use: null,
    with: {},
    base: step.base !== false,
    connection: step.connection ?? '',
    reads: null,
    wait: null
  }
}

/**
 * A use step: its set, the values it passes, its docs and its own tests. It
 * has no request of its own, so nothing else is carried over.
 */
function mergeIntoUseStep(_original: Step, edited: EditorState): Step {
  const next: Record<string, unknown> = {}
  if (edited.name.trim() !== '') next['name'] = edited.name
  next['use'] = edited.use
  if (Object.keys(edited.with).length > 0) next['with'] = edited.with
  if (edited.tags.length > 0) next['tags'] = edited.tags
  if (Object.keys(edited.flags).length > 0) next['flags'] = edited.flags
  if (edited.docs.trim() !== '') next['docs'] = edited.docs
  if (edited.tests.trim() !== '') next['tests'] = edited.tests
  return next as Step
}

/**
 * A step reading a connection (SPEC.md §2.11): the connection, and what it
 * checks and waits for. It sends nothing, so it has no request to carry over.
 */
function mergeIntoReadStep(_original: Step, edited: EditorState): Step {
  const next: Record<string, unknown> = {}
  if (edited.name.trim() !== '') next['name'] = edited.name
  next['connection'] = edited.reads
  if (edited.tags.length > 0) next['tags'] = edited.tags
  if (Object.keys(edited.flags).length > 0) next['flags'] = edited.flags
  if (edited.useTests) next['useTests'] = true
  if (edited.docs.trim() !== '') next['docs'] = edited.docs
  const settings = Object.fromEntries(
    Object.entries(edited.settings).filter(([, value]) => value !== undefined)
  )
  if (Object.keys(settings).length > 0) next['settings'] = settings
  if (edited.preRequest.trim() !== '') next['before'] = { script: edited.preRequest }
  if (edited.tests.trim() !== '') next['tests'] = edited.tests
  return next as Step
}

/**
 * A wait step (SPEC.md §2.1): how long, and its name, docs, flags and tags.
 * Milliseconds typed as digits are written as a number, and a `{{variable}}` as
 * typed. What is no wait yet — `2s`, or nothing — leaves the step's wait as it
 * was, so the file is never written with one, while the editor says what is wrong.
 */
function mergeIntoWaitStep(original: Step, edited: EditorState): Step {
  const next: Record<string, unknown> = {}
  if (edited.name.trim() !== '') next['name'] = edited.name
  const typed = waitValue(edited.wait ?? '')
  next['wait'] = typed !== '' && waitProblem(typed) === null ? typed : (original.wait ?? typed)
  if (edited.tags.length > 0) next['tags'] = edited.tags
  if (Object.keys(edited.flags).length > 0) next['flags'] = edited.flags
  if (edited.docs.trim() !== '') next['docs'] = edited.docs
  return next as Step
}

/** A wait as typed, as the step holds it: a number for digits, the text otherwise. */
export const waitValue = (typed: string): number | string =>
  /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : typed.trim()

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
 * Crucially this MERGES rather than rebuilds: a key with no editor — a graphql
 * body, `before.set` — would otherwise be silently deleted on the first save.
 */
export function mergeIntoStep(original: Step, edited: EditorState): Step {
  if (edited.wait !== null) return mergeIntoWaitStep(original, edited)
  if (edited.use !== null) return mergeIntoUseStep(original, edited)
  if (edited.reads !== null) return mergeIntoReadStep(original, edited)
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

  if (edited.docs.trim() === '') delete next['docs']
  else next['docs'] = edited.docs

  if (edited.base) delete next['base']
  else next['base'] = false

  if (edited.connection.trim() === '') delete next['connection']
  else next['connection'] = edited.connection.trim()

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
