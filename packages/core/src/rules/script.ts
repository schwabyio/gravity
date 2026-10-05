import {
  parse,
  type CallExpression,
  type Expression,
  type Node,
  type SpreadElement,
  type Statement
} from 'acorn'
import { allowedText, type TestsAllowance } from './model.js'

/**
 * `tests.only` (SPEC.md §1.4): what a `tests` script may call.
 *
 * - `gta`: the `gta.*` functions, but not `gta.test`, which runs code of its own.
 * - `gta.test`: named checks of your own, any code inside.
 * - `checks`: the project's check files, `checks.<file>.<function>()`.
 * - `console`: `console.log()` and the rest.
 *
 * Checked on the script's syntax, not its text: every statement must be one of
 * those calls, and each argument a value. Only shapes known to be allowed pass,
 * so no alias (`const c = checks`) or nested function gets code past it.
 */

/** What a script does that `tests.only` does not allow: a line of the script, and why. */
export interface ScriptFinding {
  /** 1-based, in the script. */
  line: number
  /** Where in the script, as offsets: what an editor underlines. */
  from: number
  to: number
  message: string
}

/** Globals an argument may read: the response, the request and the step's inputs. */
const READABLE = new Set(['res', 'req', 'params', 'endpoint', 'item'])
const CONSTANTS = new Set(['undefined', 'NaN', 'Infinity'])

/** `gta.expect…` → `['gta', 'expect…']`; null when the callee is not a plain dotted name. */
function dottedName(callee: Node): string[] | null {
  if (callee.type === 'Identifier') return [(callee as Node & { name: string }).name]
  if (callee.type !== 'MemberExpression') return null
  const member = callee as Node & { object: Node; property: Node; computed: boolean }
  if (member.computed || member.property.type !== 'Identifier') return null
  const object = dottedName(member.object)
  return object ? [...object, (member.property as Node & { name: string }).name] : null
}

/** Which allowance a call needs, or null when none covers it. */
function allowanceFor(call: CallExpression): TestsAllowance | null {
  const name = dottedName(call.callee)
  if (!name) return null
  const [root] = name
  if (root === 'gta' && name.length === 2) return name[1] === 'test' ? 'gta.test' : 'gta'
  if (root === 'checks' && name.length === 3) return 'checks'
  if (root === 'console' && name.length === 2) return 'console'
  return null
}

/**
 * Whether an argument is a value: written out — a literal, a template string,
 * a list or object of values, `new RegExp(…)` — or read: from `res`, `req`,
 * `params`, `endpoint` or `item`, by a `gta.*` call such as `gta.get('id')`,
 * or with `JSON.parse`, since `gta.set` keeps a list or object as JSON text.
 */
function isValue(node: Expression | SpreadElement | null): boolean {
  if (node === null) return true // a hole in a list: [1, , 3]
  switch (node.type) {
    case 'Literal':
      return true
    case 'Identifier':
      return READABLE.has(node.name) || CONSTANTS.has(node.name)
    case 'TemplateLiteral':
      return node.expressions.every(isValue)
    case 'ArrayExpression':
      return node.elements.every(isValue)
    case 'ObjectExpression':
      return node.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.method &&
          (!property.computed || isValue(property.key as Expression)) &&
          isValue(property.value as Expression)
      )
    case 'UnaryExpression':
      return (node.operator === '-' || node.operator === '+') && isValue(node.argument)
    case 'ChainExpression':
      return isValue(node.expression)
    case 'MemberExpression':
      return isRead(node)
    case 'CallExpression': {
      // `gta.get('id')`, `gta.uuid()`, `res.header('etag')`: reading, not checking.
      const name = node.optional ? null : dottedName(node.callee)?.join('.')
      const reads = allowanceFor(node) === 'gta' || name === 'res.header' || name === 'JSON.parse'
      return reads && node.arguments.every(isValue)
    }
    case 'NewExpression':
      return dottedName(node.callee)?.join('.') === 'RegExp' && node.arguments.every(isValue)
    default:
      return false
  }
}

/**
 * Whether an `if` tests feature flags only — `gta.flag('newCheckout') === true`,
 * with `!`, `&&` and `||` — and so picks what the response should be, rather
 * than checking it.
 */
function isFlagCondition(node: Expression): boolean {
  switch (node.type) {
    case 'Literal':
      return true
    case 'CallExpression':
      return dottedName(node.callee)?.join('.') === 'gta.flag' && node.arguments.every(isValue)
    case 'UnaryExpression':
      return node.operator === '!' && isFlagCondition(node.argument)
    case 'BinaryExpression':
      return (
        ['===', '!==', '==', '!='].includes(node.operator) &&
        isFlagCondition(node.left as Expression) &&
        isFlagCondition(node.right)
      )
    case 'LogicalExpression':
      return node.operator !== '??' && isFlagCondition(node.left) && isFlagCondition(node.right)
    default:
      return false
  }
}

/** `res.body.items[0].id`: a read starting at a global a script may read. */
function isRead(node: Node): boolean {
  if (node.type === 'Identifier') return READABLE.has((node as Node & { name: string }).name)
  if (node.type !== 'MemberExpression') return false
  const member = node as Node & { object: Node; property: Expression; computed: boolean }
  return (!member.computed || isValue(member.property)) && isRead(member.object)
}

/** The start of a piece of code, on one line, for a message to quote. */
function snippet(code: string, node: Node): string {
  const text = code.slice(node.start, node.end).replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** Why a call is not allowed, in words: what it is, then what is. */
function notAllowed(kind: TestsAllowance | null, allowed: readonly TestsAllowance[]): string {
  const only = `tests here call only ${allowedText(allowed)}`
  switch (kind) {
    case 'gta.test':
      return `gta.test runs a check of your own; ${only}`
    case 'checks':
      return `check files are not used here; ${only}`
    default:
      return only
  }
}

/**
 * What a `tests` script does that `allowed` does not cover, statement by
 * statement. A script that will not parse is one finding, saying so: the run
 * would report it too.
 */
export function testsScriptFindings(
  code: string,
  allowed: readonly TestsAllowance[]
): ScriptFinding[] {
  let program
  try {
    // As the sandbox runs it: inside an async function, so `await` and `return` parse.
    program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true
    })
  } catch (cause) {
    const line = (cause as { loc?: { line: number } }).loc?.line ?? 1
    const at = (cause as { pos?: number }).pos ?? 0
    const reason = (cause as Error).message.replace(/\s*\(\d+:\d+\)$/, '')
    return [
      {
        line,
        from: at,
        to: at,
        message: `will not parse, so what it calls cannot be checked: ${reason}`
      }
    ]
  }

  const findings: ScriptFinding[] = []
  const report = (node: Node, message: string) =>
    findings.push({ line: node.loc?.start.line ?? 1, from: node.start, to: node.end, message })

  const check = (statements: readonly Statement[]) => {
    for (const statement of statements) checkStatement(statement)
  }
  const checkStatement = (statement: Statement): void => {
    if (statement.type === 'EmptyStatement') return
    if (statement.type === 'BlockStatement') return check(statement.body)
    // Which response is right can depend on a feature flag (SPEC.md §2.9).
    if (statement.type === 'IfStatement') {
      if (!isFlagCondition(statement.test)) {
        report(
          statement,
          `${snippet(code, statement)}: an if here tests feature flags only, with gta.flag(); ${notAllowed(null, allowed)}`
        )
        return
      }
      checkStatement(statement.consequent)
      if (statement.alternate) checkStatement(statement.alternate)
      return
    }
    let expression = statement.type === 'ExpressionStatement' ? statement.expression : null
    if (expression?.type === 'AwaitExpression') expression = expression.argument
    const call = expression?.type === 'CallExpression' && !expression.optional ? expression : null
    const kind = call ? allowanceFor(call) : null
    if (!call || !kind || !allowed.includes(kind)) {
      report(statement, `${snippet(code, statement)}: ${notAllowed(kind, allowed)}`)
      return
    }
    // gta.test's function is a check of its own: what it does is up to it.
    const values = kind === 'gta.test' ? call.arguments.slice(0, 1) : call.arguments
    for (const argument of values) {
      if (isValue(argument)) continue
      report(
        argument,
        `${snippet(code, argument)}, given to ${snippet(code, call.callee)}(): an argument here is a value, written out or read from res, req, params, endpoint, item or gta.get()`
      )
    }
  }
  // Parsed as a script, so it holds no import or export.
  check(program.body as Statement[])
  return findings
}

/* ------------------------------------------------- the status code check -- */

/** The call that checks a response's status code. */
const STATUS_CHECK = 'gta.expectResponseStatusCodeToBe'

/** Every node under `node`, itself included. */
function* nodesIn(node: unknown): Generator<Node> {
  if (typeof node !== 'object' || node === null) return
  if (Array.isArray(node)) {
    for (const item of node) yield* nodesIn(item)
    return
  }
  if (typeof (node as { type?: unknown }).type !== 'string') return
  yield node as Node
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc' && typeof value === 'object') yield* nodesIn(value)
  }
}

/** Whether code calls the status check, or a check function in `statusChecks` (`file.function`). */
function callsStatusCheck(body: unknown, statusChecks: ReadonlySet<string>): boolean {
  for (const node of nodesIn(body)) {
    if (node.type !== 'CallExpression') continue
    const name = dottedName((node as CallExpression).callee)
    if (!name) continue
    if (name.join('.') === STATUS_CHECK) return true
    if (name[0] === 'checks' && name.length === 3 && statusChecks.has(`${name[1]}.${name[2]}`)) {
      return true
    }
  }
  return false
}

/**
 * Whether a tests script checks the status code (`tests.statusCode`): calls
 * `gta.expectResponseStatusCodeToBe` anywhere in it, or a check function
 * that does. A script that will not parse checks nothing.
 */
export function checksStatusCode(code: string, statusChecks: ReadonlySet<string>): boolean {
  try {
    return callsStatusCheck(
      parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true
      }),
      statusChecks
    )
  } catch {
    return false
  }
}

/**
 * The check functions that check the status code themselves, as
 * `file.function`: `common.expectJson` for an `expectJson` exported from
 * `checks/common.js` whose body calls `gta.expectResponseStatusCodeToBe`.
 */
export function statusCheckFunctions(
  files: ReadonlyArray<{ name: string; code: string }>
): Set<string> {
  const found = new Set<string>()
  for (const file of files) {
    let program
    try {
      program = parse(file.code, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch {
      continue
    }
    for (const statement of program.body) {
      if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) continue
      const declaration = statement.declaration
      const functions: Array<[string, unknown]> =
        declaration.type === 'FunctionDeclaration'
          ? [[declaration.id.name, declaration.body]]
          : declaration.type === 'VariableDeclaration'
            ? declaration.declarations.flatMap((each) =>
                each.id.type === 'Identifier' &&
                (each.init?.type === 'ArrowFunctionExpression' ||
                  each.init?.type === 'FunctionExpression')
                  ? [[each.id.name, each.init.body] as [string, unknown]]
                  : []
              )
            : []
      for (const [name, body] of functions) {
        if (callsStatusCheck(body, new Set())) found.add(`${file.name}.${name}`)
      }
    }
  }
  return found
}
