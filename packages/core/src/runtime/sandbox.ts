import vm from 'node:vm'
import { inspect } from 'node:util'
import type { LogEntry, RunError } from '../model/run.js'

/**
 * Run user JavaScript — a step's `before.script` or `tests` — in its own V8
 * context.
 *
 * What the code can reach is exactly what `globals` hands it, plus the
 * language's own built-ins: no `require`, no `process`, no filesystem, no
 * network. That keeps a collection portable between the app and `gta`, and
 * means a script cannot quietly depend on the machine it ran on.
 *
 * `vm` is isolation, not a security boundary. The boundary is the process: the
 * desktop app runs this in its run worker, which Cancel kills outright, and a
 * script that never yields is stopped by `timeoutMs`.
 */
export interface ScriptOptions {
  phase: LogEntry['phase']
  /** Shown in stack traces and used to find the failing line. */
  filename: string
  /**
   * What the script can reach. A function receives `adopt`, which copies plain
   * data into the script's own realm — see `adopt` below for why that matters.
   */
  globals: Record<string, unknown> | ((adopt: Adopt) => Record<string, unknown>)
  /** Where `console` output goes. */
  logs: LogEntry[]
  /** Wall-clock budget, synchronous and asynchronous together. */
  timeoutMs?: number
  /** Promises the script started but did not await, such as `gta.test` bodies. */
  pending?: () => Promise<unknown>[]
  /**
   * Check files, loaded into the script's own context first and reachable as
   * `checks.<name>` — so their functions call this script's `gta`.
   */
  checks?: ReadonlyArray<{ name: string; filename: string; code: string }>
}

export const SCRIPT_TIMEOUT_MS = 10_000

/**
 * The web-standard globals a script can reasonably expect, which a bare V8
 * context lacks because they belong to the host, not the language. `fetch` is
 * deliberately absent: a request belongs in a step, where it is recorded.
 */
const WEB_GLOBALS = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  crypto: globalThis.crypto
}

/**
 * Copy JSON-shaped data into the script's realm.
 *
 * Objects made out here have this realm's `Array` and `Object` prototypes. To
 * the script they look fine until a strict deep-equality check compares one
 * with a literal it wrote — `assert.deepEqual(res.body.roles, ['admin'])` — and
 * fails on the prototypes alone. Data the script will compare is adopted.
 */
export type Adopt = <T>(value: T) => T

/** Resolves to `null` when the script ran to the end, or the error that stopped it. */
export async function runScript(code: string, options: ScriptOptions): Promise<RunError | null> {
  const { phase, filename, logs, timeoutMs = SCRIPT_TIMEOUT_MS } = options

  const context = vm.createContext(
    { ...WEB_GLOBALS, console: captureConsole(logs, phase) },
    { name: filename, codeGeneration: { strings: true, wasm: false } }
  )
  const parse = vm.runInContext('(text) => JSON.parse(text)', context) as (text: string) => unknown
  const adopt: Adopt = (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return value
    return parse(JSON.stringify(value)) as typeof value
  }
  Object.assign(
    context,
    typeof options.globals === 'function' ? options.globals(adopt) : options.globals
  )

  if (options.checks && options.checks.length > 0) {
    const checks = vm.runInContext('({})', context) as Record<string, unknown>
    for (const file of options.checks) {
      try {
        const module = new vm.Script(
          `(() => { const __exports = {};\n${exportsOf(file.code)}\nreturn __exports })()`,
          { filename: file.filename, lineOffset: -1 }
        )
        checks[file.name] = module.runInContext(context, { timeout: timeoutMs })
      } catch (cause) {
        const error = toRunError(cause, phase, file.filename)
        return { ...error, message: `${file.filename}: ${error.message}` }
      }
    }
    Object.assign(context, { checks })
  }

  let timer: NodeJS.Timeout | undefined
  try {
    // An async wrapper, so `await` works at the top level of a script. The
    // wrapper's opening line is not the author's, hence `lineOffset: -1`.
    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename,
      lineOffset: -1
    })
    const run = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ScriptTimeout(`Timed out after ${timeoutMs / 1000}s`)),
        timeoutMs
      )
    })
    await Promise.race([run, timeout])
    // Unawaited work the script started still counts towards the result.
    await Promise.race([Promise.all(options.pending?.() ?? []), timeout])
    return null
  } catch (cause) {
    return toRunError(cause, phase, filename)
  } finally {
    clearTimeout(timer)
  }
}

class ScriptTimeout extends Error {}

/**
 * A check file's `export`s, as properties of `__exports`. Only the two forms
 * SPEC.md §5 names — `export function name` (or `export async function`) and
 * `export const name =` — each rewritten on its own line, so line numbers in
 * a stack trace are still the file's.
 */
export function exportsOf(code: string): string {
  return code
    .replace(
      /^([ \t]*)export\s+(async\s+)?function(\s*\*?\s*)([A-Za-z_$][\w$]*)/gm,
      (_whole, indent: string, isAsync: string | undefined, star: string, name: string) =>
        `${indent}__exports.${name} = ${name}; ${isAsync ?? ''}function${star}${name}`
    )
    .replace(
      /^([ \t]*)export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
      (_whole, indent: string, kind: string, name: string) =>
        `${indent}${kind} ${name} = __exports.${name} =`
    )
}

/**
 * Errors thrown inside the context come from that context's `Error`, so
 * `instanceof Error` is false for them; read them by shape instead.
 */
function toRunError(cause: unknown, phase: RunError['phase'], filename: string): RunError {
  const shaped = cause as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown }
  const name = typeof shaped?.name === 'string' ? shaped.name : 'Error'
  const message =
    typeof shaped?.message === 'string'
      ? shaped.message
      : typeof cause === 'string'
        ? cause
        : inspect(cause)
  const stack = typeof shaped?.stack === 'string' ? shaped.stack : undefined
  const timedOut =
    cause instanceof ScriptTimeout ||
    (typeof shaped?.code === 'string' && shaped.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
  const line = stack ? lineIn(stack, filename) : undefined

  return {
    phase,
    message: timedOut
      ? `${phase === 'tests' ? 'Tests' : 'Pre-request script'} timed out: ${message}`
      : name === 'Error'
        ? message
        : `${name}: ${message}`,
    ...(timedOut ? { code: 'SCRIPT_TIMEOUT' } : {}),
    ...(stack ? { stack } : {}),
    ...(line !== undefined ? { line } : {})
  }
}

/** The first line of the author's own file named in a stack. */
function lineIn(stack: string, filename: string): number | undefined {
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}:(\\d+)`).exec(stack)
  return match ? Number(match[1]) : undefined
}

const LOG_LIMIT = 500
const MESSAGE_LIMIT = 10_000

function captureConsole(logs: LogEntry[], phase: LogEntry['phase']) {
  const write =
    (level: LogEntry['level']) =>
    (...args: unknown[]) => {
      if (logs.length >= LOG_LIMIT) return
      const message = args
        .map((arg) =>
          typeof arg === 'string' ? arg : inspect(arg, { depth: 6, breakLength: 100 })
        )
        .join(' ')
      logs.push({
        level,
        phase,
        message:
          message.length > MESSAGE_LIMIT
            ? `${message.slice(0, MESSAGE_LIMIT)}… (truncated)`
            : message
      })
    }
  return { log: write('log'), info: write('info'), warn: write('warn'), error: write('error') }
}

/* ---------------------------------------------------------------- syntax -- */

/** Where a script stops parsing, 1-based line and column. */
export interface SyntaxProblem {
  line: number
  column: number
  /** How many characters V8 underlined; at least 1. */
  length: number
  message: string
}

/**
 * Parse a script without running it, with V8 — the parser that will run it —
 * so the editor reports exactly the errors a run would.
 *
 * Compiled as a plain function body first, because that reports positions in
 * the author's own lines. A body using top-level `await` is not valid there, so
 * that one case is re-checked inside the same async wrapper `runScript` uses.
 */
export function checkScriptSyntax(code: string): SyntaxProblem | null {
  try {
    vm.compileFunction(code, [], { filename: 'script' })
    return null
  } catch (cause) {
    const plain = syntaxProblem(cause, code)
    if (!plain || !/\bawait\b/.test(plain.message)) return plain
  }
  try {
    new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'script', lineOffset: -1 })
    return null
  } catch (cause) {
    return syntaxProblem(cause, code)
  }
}

function syntaxProblem(cause: unknown, code: string): SyntaxProblem | null {
  const shaped = cause as { name?: unknown; message?: unknown; stack?: unknown }
  if (shaped?.name !== 'SyntaxError' || typeof shaped.stack !== 'string') return null
  const message = String(shaped.message)
  const lines = code.split('\n')
  // V8 puts the position first: "script:LINE", the source line, then a caret line.
  const [head = '', , carets = ''] = shaped.stack.split('\n')
  let line = Number(/:(\d+)$/.exec(head)?.[1] ?? lines.length)
  let column = carets.indexOf('^') + 1
  let length = (/\^+/.exec(carets)?.[0].length ?? 1) || 1

  // Past the author's last line — the wrapper's own closing — means the script
  // ended while something was still open. Point at where it ended.
  if (line > lines.length || column === 0) {
    line = Math.min(line, lines.length)
    column = (lines[line - 1]?.length ?? 0) + 1
    length = 1
  }
  return { line, column, length, message: `SyntaxError: ${message}` }
}
