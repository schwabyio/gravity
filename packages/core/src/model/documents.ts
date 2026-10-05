import { z } from 'zod'

/** See SPEC.md for the authored form of every document in this file. */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]
export const HttpMethodSchema = z.enum(HTTP_METHODS)

/* ---------------------------------------------------------------- headers -- */

export const HeaderValueSchema = z.union([
  z.string(),
  /** A repeated header. */
  z.array(z.string()),
  z.strictObject({
    value: z.string(),
    enabled: z.boolean().optional(),
    description: z.string().optional()
  })
])
export type HeaderValue = z.infer<typeof HeaderValueSchema>

export const HeadersSchema = z.record(z.string(), HeaderValueSchema)
export type Headers = z.infer<typeof HeadersSchema>

/** A header that is sent: anything but an object with `enabled: false`. */
export const isHeaderEnabled = (value: HeaderValue): boolean =>
  typeof value === 'string' || Array.isArray(value) || value.enabled !== false

/**
 * The collection's headers with the step's over them (SPEC.md §2).
 *
 * Names compare case-insensitively, as HTTP's do: a step's `accept` replaces the
 * collection's `Accept`. A disabled step header is not sent and replaces nothing,
 * so switching one off brings back the collection's.
 */
export function mergeHeaders(collection: Headers | undefined, step: Headers | undefined): Headers {
  const own = Object.entries(step ?? {}).filter(([, value]) => isHeaderEnabled(value))
  const byName = new Map(own.map(([name, value]) => [name.toLowerCase(), [name, value] as const]))
  const merged: Headers = {}
  // A replaced header keeps the collection's place in the order.
  for (const [name, value] of Object.entries(collection ?? {})) {
    const mine = byName.get(name.toLowerCase())
    if (mine) merged[mine[0]] = mine[1]
    else merged[name] = value
  }
  for (const [name, value] of own) merged[name] = value
  return merged
}

/* ------------------------------------------------------------------- body -- */

/**
 * A path written in a file — `uses`, `tls.ca`, a file to upload: relative, so
 * it works on every machine; `/` or `\` both read.
 */
const relativePath = (key: string) =>
  z
    .string()
    .min(1)
    .refine((value) => !/^([\\/]|[A-Za-z]:)/.test(value), {
      message: `${key} must be a relative path, so it works on every machine`
    })

/**
 * One part of a multipart body (SPEC.md §2.2): text; text with its own
 * `contentType`, such as a JSON part; or a file from the project folder.
 */
export const MultipartPartSchema = z.union(
  [
    z.string(),
    z.strictObject({ value: z.string(), contentType: z.string().min(1).optional() }),
    z.strictObject({
      file: relativePath('a multipart file'),
      /** Absent: from the file's extension, else application/octet-stream. */
      contentType: z.string().min(1).optional(),
      /** The name sent for it; absent, the file's own. `''`, as a browser sends no file chosen. */
      filename: z.string().optional()
    })
  ],
  {
    error:
      "a multipart field is text, { value, contentType }, { file, contentType, filename } or a list of them; quote a number: '3'"
  }
)
export type MultipartPart = z.infer<typeof MultipartPartSchema>

/** A field of a multipart body: one part, or a list for a name sent more than once. */
export const MultipartFieldSchema = z.union([
  MultipartPartSchema,
  z.array(MultipartPartSchema).min(1)
])
export type MultipartField = z.infer<typeof MultipartFieldSchema>

export const BodySchema = z
  .strictObject({
    json: z.string().optional(),
    xml: z.string().optional(),
    text: z.string().optional(),
    form: z.record(z.string(), z.string()).optional(),
    /** multipart/form-data, by field name, in order (SPEC.md §2.2). */
    multipart: z.record(z.string(), MultipartFieldSchema).optional(),
    graphql: z
      .strictObject({
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional()
      })
      .optional(),
    /** A file sent as the whole body, from the project folder. */
    file: relativePath('body.file').optional()
  })
  .refine((body) => Object.values(body).filter((v) => v !== undefined).length === 1, {
    message:
      'request.body must declare exactly one of json, xml, text, form, multipart, graphql, file'
  })
export type Body = z.infer<typeof BodySchema>

/* --------------------------------------------------------------- settings -- */

export const SettingsSchema = z.strictObject({
  /** Milliseconds; 0 means no limit. For an event stream, until its headers arrive. */
  timeout: z.number().nonnegative().optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  encodeUrl: z.boolean().optional(),
  /** Stop reading an event stream after this many events; 0 means no limit. */
  maxEvents: z.number().int().nonnegative().optional(),
  /** Stop reading an event stream this many milliseconds after its headers; 0 means no limit. */
  streamTimeout: z.number().nonnegative().optional(),
  /** Stop reading an event stream after the first event of this name: its `event:` line. */
  untilEvent: z.string().min(1).optional()
})
export type Settings = z.infer<typeof SettingsSchema>

export const SETTINGS_DEFAULTS = {
  timeout: 0,
  followRedirects: true,
  maxRedirects: 5,
  encodeUrl: true,
  maxEvents: 0,
  streamTimeout: 0,
  /** None: a name is never empty. */
  untilEvent: ''
} as const satisfies Required<Settings>

/* -------------------------------------------------------------- variables -- */

/**
 * Variables keep their YAML type: `true` is a boolean, never the string "true".
 * They are plain values; anything computed is set in `before.script` with `gta`.
 */
export const VarValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()], {
  error:
    'a variable is a string, number, boolean or null; compute values in before.script with gta.set, gta.date or gta.uuid'
})
export type VarValue = z.infer<typeof VarValueSchema>

export const VarsSchema = z.record(z.string(), VarValueSchema)
export type Vars = z.infer<typeof VarsSchema>

/* ------------------------------------------------------------------ tags -- */

/**
 * A tag: letters, digits and `- _ . :`, no spaces. Case matters. Used to pick
 * groups of steps to run; a feature flag is not a tag.
 */
/** A feature flag's name: letters, digits and `- _ .`, as flag services name them. */
export const FLAG_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** A feature flag's value: what a flag service serves, in JSON. */
export const FlagValueSchema = z.union([z.string(), z.number(), z.boolean()], {
  error: 'a feature flag value is a string, number or boolean'
})
export type FlagValue = z.infer<typeof FlagValueSchema>

/**
 * What a collection or step needs to run (SPEC.md §2.9): each flag named with
 * the value it must have — `{ newCheckout: true }`. All must hold.
 */
export const FlagConditionsSchema = z.record(
  z.string().regex(FLAG_NAME_PATTERN, 'a feature flag name is letters, digits and - _ .'),
  FlagValueSchema
)
export type FlagConditions = z.infer<typeof FlagConditionsSchema>

/** A connection's name (SPEC.md §2.11): letters, digits and `- _ .`. */
export const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

export const TAG_PATTERN = /^[A-Za-z0-9._:-]+$/
export const TagSchema = z
  .string()
  .regex(TAG_PATTERN, 'a tag is letters, digits and - _ . : with no spaces')
export const TagsSchema = z.array(TagSchema)

/* ---------------------------------------------------------------- before -- */

/**
 * What happens before the request: `script`, pre-request JavaScript that sets
 * the variables the request uses with `gta.set`. See SPEC.md §5.
 */
export const BeforeSchema = z
  .looseObject({
    /** Pre-request JavaScript, run in the sandbox with `gta` and `req`. */
    script: z.string().optional()
  })
  .superRefine((before, ctx) => {
    for (const key of Object.keys(before)) {
      if (key === 'script') continue
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message:
          key === 'set'
            ? 'before.set is not supported; set variables in before.script with gta.set(name, value) (SPEC.md §5)'
            : `unknown key "${key}"; before holds only script`
      })
    }
  })
export type Before = z.infer<typeof BeforeSchema>

/* ------------------------------------------------------------------ step -- */

/**
 * One request in a collection.
 *
 * Carries exactly one method key whose value is the URL. Modelled loosely here,
 * then narrowed by `readRequestLine`.
 */
export const StepSchema = z
  .looseObject({
    name: z.string().optional(),
    /**
     * A request set to run here instead of a request of its own (SPEC.md §2.5):
     * `login`, `auth/login`, or `global:login` for the global project's only.
     */
    use: z.string().min(1).optional(),
    /** Values for the set's `params`; a string may hold `{{variables}}`. */
    with: z.record(z.string(), VarValueSchema).optional(),
    /**
     * `false`: this step does not use its endpoint's base (SPEC.md §2.6). Only
     * `false` is written; using the base is the default.
     */
    base: z.literal(false).optional(),
    /** This step's own tags; only with `stepTags: true` on the collection. */
    tags: TagsSchema.optional(),
    /** Feature flags this step needs; unmet, it is skipped (SPEC.md §2.9). */
    flags: FlagConditionsSchema.optional(),
    /**
     * Send the request once for each item of a list, read as `{{item}}` and
     * `item` in code: `'{{roots}}'`, a variable holding a JSON array (SPEC.md §2.1).
     */
    forEach: z.string().min(1).optional(),
    /**
     * In a request set: the use step's own `tests` check this step's response,
     * rather than the set's last (SPEC.md §2.5). At most one step has it.
     */
    useTests: z.literal(true).optional(),
    docs: z.string().optional(),
    headers: HeadersSchema.optional(),
    body: BodySchema.optional(),
    settings: SettingsSchema.optional(),
    before: BeforeSchema.optional(),
    /** Post-response JavaScript: xtest assertions on `gta`, and any other code. */
    tests: z.string().optional(),
    /**
     * A connection (SPEC.md §2.11). With a method key, the event stream the
     * request opens stays open under this name for later steps; on its own, the
     * step sends nothing and reads the events that connection holds.
     */
    connection: z
      .string()
      .regex(CONNECTION_NAME_PATTERN, 'a connection name is letters, digits and - _ .')
      .optional()
  })
  .superRefine((step, ctx) => {
    // The object is loose only because the method key varies. Any other key is
    // checked here: a misspelt `heders:` must fail, not be ignored in silence.
    for (const key of Object.keys(step)) {
      if (STEP_KEYS.has(key) || (HTTP_METHODS as readonly string[]).includes(key)) continue
      const method = HTTP_METHODS.find((m) => m === key.toUpperCase())
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message:
          key === 'expect'
            ? 'expect: blocks are not supported; write the checks in tests with gta.expect… (SPEC.md §5)'
            : method
              ? `${key}: a method key is written in capitals, ${method} (SPEC.md §2.1)`
              : `unknown key "${key}" on a step; a step holds a method (${HTTP_METHODS.join(', ')}) or use and with, and ${[...STEP_KEYS].filter((k) => k !== 'use' && k !== 'with').join(', ')} (SPEC.md §2.1)`
      })
    }
    const methods = HTTP_METHODS.filter((m) => m in step)
    if ('use' in step) {
      if ('forEach' in step) {
        ctx.addIssue({
          code: 'custom',
          path: ['forEach'],
          message: 'forEach repeats one request, so a use: step cannot have it (SPEC.md §2.1)'
        })
      }
      // A use step runs the set's requests, so it has none of its own.
      const own = [
        ...methods,
        ...[...USE_FORBIDDEN, 'connection' as const].filter((key) => key in step)
      ]
      for (const key of own) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `a use: step runs a request set, so it cannot have ${key} of its own (SPEC.md §2.5)`
        })
      }
      return
    }
    if ('with' in step) {
      ctx.addIssue({
        code: 'custom',
        path: ['with'],
        message: 'with: goes with use: (SPEC.md §2.5)'
      })
    }
    if (methods.length === 0) {
      // A method written in lower case has been reported already, more usefully.
      if (Object.keys(step).some((key) => HTTP_METHODS.find((m) => m === key.toUpperCase()))) return
      // A step reading a connection sends nothing, so it has no request of its own.
      if ('connection' in step) {
        for (const key of READ_FORBIDDEN.filter((key) => key in step)) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `a step that reads a connection sends nothing, so it cannot have ${key} (SPEC.md §2.11)`
          })
        }
        return
      }
      ctx.addIssue({
        code: 'custom',
        message: `step must declare one method key (${HTTP_METHODS.join(', ')}), or read a connection with connection: alone`
      })
      return
    }
    if (methods.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `step declares more than one method: ${methods.join(', ')}`
      })
      return
    }
    const method = methods[0] as HttpMethod
    if (typeof step[method] !== 'string') {
      ctx.addIssue({ code: 'custom', message: `step.${method} must be the URL, as a string` })
    }
    if ('connection' in step && 'forEach' in step) {
      ctx.addIssue({
        code: 'custom',
        path: ['forEach'],
        message:
          'forEach sends the request once for each item, so a step opening a connection cannot have it (SPEC.md §2.11)'
      })
    }
  })
export type Step = z.infer<typeof StepSchema>

/** Every key a step may hold besides its method key (SPEC.md §2.1). */
const STEP_KEYS: ReadonlySet<string> = new Set([
  'name',
  'use',
  'with',
  'headers',
  'body',
  'settings',
  'before',
  'tests',
  'tags',
  'flags',
  'forEach',
  'useTests',
  'base',
  'docs',
  'connection'
])

/** What a use step may not have: those belong to the set's own requests. */
const USE_FORBIDDEN = ['headers', 'body', 'settings', 'before'] as const

/** What a step reading a connection may not have: it sends no request. */
const READ_FORBIDDEN = ['headers', 'body', 'base', 'forEach'] as const

/** A step that runs a request set: `use:` and the values it passes `with:`. */
export type UseStep = Step & { use: string }

export const isUseStep = (step: Step): step is UseStep => typeof step.use === 'string'

/** A step that reads a connection's events (SPEC.md §2.11): `connection:` and no method key. */
export type ReadStep = Step & { connection: string }

export const isReadStep = (step: Step): step is ReadStep =>
  typeof step.connection === 'string' &&
  !isUseStep(step) &&
  !HTTP_METHODS.some((method) => method in step)

/**
 * One input of a request set: a plain default, or `{ required, default,
 * description }`. A required one has no default; the caller must give it.
 */
export const ParamSpecSchema = z.union([
  VarValueSchema,
  z.strictObject({
    required: z.literal(true).optional(),
    default: VarValueSchema.optional(),
    description: z.string().optional()
  })
])
export type ParamSpec = z.infer<typeof ParamSpecSchema>

/** A param's declaration, however it was written. */
export function readParam(spec: ParamSpec): {
  required: boolean
  default: VarValue | undefined
  description: string | undefined
} {
  if (spec !== null && typeof spec === 'object') {
    return {
      required: spec.required === true,
      default: spec.default,
      description: spec.description
    }
  }
  return { required: false, default: spec, description: undefined }
}

/**
 * Which steps a tag selection runs (SPEC.md §2.4).
 *
 * A collection whose own tags match `selected` runs in full. Otherwise, if it
 * allows step tags, the steps whose tags match run, in order. Otherwise none
 * do. An empty selection runs everything.
 *
 * `left` leaves out: a collection whose own tags match it runs nothing, and
 * with step tags, a step whose tags match it is dropped from what `selected`
 * picked.
 */
export function stepsForTags(
  collection: Pick<Collection, 'tags' | 'stepTags' | 'steps'>,
  selected: readonly string[],
  left: readonly string[] = []
): number[] {
  const all = collection.steps.map((_, index) => index)
  const matches = (tags: string[] | undefined, wanted: readonly string[]) =>
    (tags ?? []).some((t) => wanted.includes(t))
  if (matches(collection.tags, left)) return []
  const picked =
    selected.length === 0 || matches(collection.tags, selected)
      ? all
      : collection.stepTags
        ? all.filter((index) => matches(collection.steps[index]?.tags, selected))
        : []
  if (!collection.stepTags || left.length === 0) return picked
  return picked.filter((index) => !matches(collection.steps[index]?.tags, left))
}

/**
 * Pull the single method key and its URL back out of a step. A use step and a
 * step reading a connection have neither: callers check `isUseStep` and
 * `isReadStep` first.
 */
export function readRequestLine(step: Step): { method: HttpMethod; url: string } {
  const method = HTTP_METHODS.find((m) => m in step) as HttpMethod
  return { method, url: String(step[method] ?? '') }
}

/** A step's display name, falling back to what it does. */
export function stepLabel(step: Step): string {
  if (step.name && step.name.trim() !== '') return step.name
  if (isUseStep(step)) return step.use
  if (isReadStep(step)) return `read ${step.connection}`
  const { method, url } = readRequestLine(step)
  return `${method} ${url}`
}

/* ------------------------------------------------------------ collection -- */

/**
 * A collection file.
 *
 * `steps` is both the content and the marker: a `.yml` file is a collection if,
 * and only if, it has one. List order is run order — there is no `seq`.
 */
export const CollectionSchema = z
  .strictObject({
    /**
     * The collection's id: its file name without `.yml`, unique in its home
     * (SPEC.md §2). Every file has one; `idProblem` checks it against the file,
     * since a document on its own does not know its file name.
     */
    id: z.string().min(1).optional(),
    docs: z.string().optional(),
    /**
     * A base collection whose headers, settings, variables and scripts this one
     * builds on (SPEC.md §2.7): `authenticated` is `bases/authenticated.yml`.
     */
    extends: z.string().min(1).optional(),
    /** Tags of the collection as a whole: a match runs every step (§2.4). */
    tags: TagsSchema.optional(),
    /**
     * Whether steps may carry their own tags, and so be run on their own. Off by
     * default: most collections are a sequence whose steps depend on each other.
     */
    stepTags: z.boolean().optional(),
    /**
     * Left out of group runs — `gta all`, and a directory named to `gta` — while
     * still run when named on its own (SPEC.md §2.4).
     */
    exclude: z.boolean().optional(),
    /** Feature flags the whole collection needs; unmet, every step is skipped (SPEC.md §2.9). */
    flags: FlagConditionsSchema.optional(),
    /** Merged into every step's headers; the step wins. */
    headers: HeadersSchema.optional(),
    settings: SettingsSchema.optional(),
    vars: VarsSchema.optional(),
    /** Runs before every step, ahead of the step's own `before`. */
    before: BeforeSchema.optional(),
    /** Runs after every step, ahead of the step's own `tests`. */
    tests: z.string().optional(),
    /**
     * The inputs this collection takes when another one runs it with `use:` —
     * which makes it a request set (SPEC.md §2.5). Read as `{{params.name}}`,
     * and as `params.name` in code.
     */
    params: z.record(z.string(), ParamSpecSchema).optional(),
    /**
     * Steps run once before `steps`, and before every row of a data file:
     * what they set lasts the whole run (SPEC.md §2.10).
     */
    setup: z.array(StepSchema).optional(),
    steps: z.array(StepSchema).default([]),
    /** Steps run once after the rest, even when they failed (SPEC.md §2.10). */
    teardown: z.array(StepSchema).optional()
  })
  .superRefine((collection, ctx) => {
    for (const stage of STAGES) {
      if (!collection[stage]) continue
      if (collection.params) {
        ctx.addIssue({
          code: 'custom',
          path: [stage],
          message: `a request set runs inside another collection, so it has no ${stage} (SPEC.md §2.10)`
        })
      }
      collection[stage].forEach((step, index) => {
        if (step.tags) {
          ctx.addIssue({
            code: 'custom',
            path: [stage, index, 'tags'],
            message: `a ${stage} step runs whenever its collection does, so it has no tags (SPEC.md §2.10)`
          })
        }
      })
    }
    const marked = collection.steps.flatMap((step, index) => (step.useTests ? [index] : []))
    if (marked.length > 0 && !collection.params) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', marked[0]!, 'useTests'],
        message:
          "useTests marks the request set step whose response a use step's tests check; this collection has no params, so it is not a request set (SPEC.md §2.5)"
      })
    }
    if (marked.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', marked[1]!, 'useTests'],
        message: `only one step can have useTests; step ${marked[0]! + 1} has it already (SPEC.md §2.5)`
      })
    }
    if (collection.params) {
      // A set is used, never uses: no chains, no loops. Its inputs are params.
      collection.steps.forEach((step, index) => {
        if (isUseStep(step)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', index, 'use'],
            message: 'a request set cannot use another one (SPEC.md §2.5)'
          })
        }
      })
      if (collection.vars) {
        ctx.addIssue({
          code: 'custom',
          path: ['vars'],
          message: 'a request set takes params, not vars (SPEC.md §2.5)'
        })
      }
    }
    if (collection.stepTags) return
    collection.steps.forEach((step, index) => {
      if (step.tags && step.tags.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'tags'],
          message: 'step tags need stepTags: true in the collection (SPEC.md §2.4)'
        })
      }
    })
  })
export type Collection = z.infer<typeof CollectionSchema>

/** The step lists a collection may hold besides `steps`, run once around them (SPEC.md §2.10). */
export const STAGES = ['setup', 'teardown'] as const
export type Stage = (typeof STAGES)[number]

/** A collection's lists of steps, in run order. */
export const STEP_LISTS = ['setup', 'steps', 'teardown'] as const
export type StepList = (typeof STEP_LISTS)[number]

/** An `environments/<name>.yml` file. */
export const EnvironmentVarSchema = z.union([
  VarValueSchema,
  z.strictObject({
    value: VarValueSchema.optional(),
    /** Read from the process environment or `.env`; never written to disk or a report. */
    secret: z.literal(true).optional(),
    description: z.string().optional()
  })
])
export type EnvironmentVar = z.infer<typeof EnvironmentVarSchema>

/**
 * An environment's feature flags (SPEC.md §2.9): fixed `values`, and a
 * `command` gta runs before a run to fetch fresh ones from a flag service.
 */
export const EnvironmentFlagsSchema = z.strictObject({
  /** A shell command, run in the project folder, printing a JSON object of flag values. */
  command: z.string().trim().min(1).optional(),
  values: z
    .record(
      z.string().regex(FLAG_NAME_PATTERN, 'a feature flag name is letters, digits and - _ .'),
      FlagValueSchema
    )
    .optional()
})
export type EnvironmentFlags = z.infer<typeof EnvironmentFlagsSchema>

export const EnvironmentDocSchema = z.strictObject({
  name: z.string().optional(),
  vars: z.record(z.string(), EnvironmentVarSchema).default({}),
  flags: EnvironmentFlagsSchema.optional()
})
export type EnvironmentDoc = z.infer<typeof EnvironmentDocSchema>

/**
 * `project.yml`'s `tls` (SPEC.md §1.1): certificate files to trust besides
 * Node's bundled roots and the operating system's trust store — a company's
 * own CA, or a server's self-signed certificate. PEM or DER, relative to the
 * project.
 */
export const ProjectTlsSchema = z.strictObject({
  ca: z
    .array(relativePath('tls.ca'), {
      error: 'tls.ca is a list of certificate files, such as [certs/company-root.pem]'
    })
    .optional()
})
export type ProjectTls = z.infer<typeof ProjectTlsSchema>

/**
 * A project's `project.yml` (SPEC.md §1.1): its name, the global project it
 * uses, project-wide variables and the certificates it trusts. Optional — a
 * project without one is a folder with `collections/` in it.
 */
export const ProjectDocSchema = z.strictObject({
  name: z.string().optional(),
  /**
   * A global project, as a path relative to this one: shared variables,
   * shared environments and (later) reusable requests.
   */
  uses: relativePath('uses').optional(),
  vars: VarsSchema.optional(),
  tls: ProjectTlsSchema.optional()
})
export type ProjectDoc = z.infer<typeof ProjectDocSchema>
