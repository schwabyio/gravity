/**
 * What the code editor offers as completions: the `gta` API, `res`, `req` and
 * `assert`, with a signature and one line of help each.
 *
 * Kept beside the editor rather than generated from core, because the renderer
 * must not import the engine. SPEC.md §5 is the reference these follow.
 */

export type ScriptKind = 'tests' | 'pre-request'

export interface ApiEntry {
  name: string
  signature: string
  info: string
  /** Where it is available. Omitted: everywhere. */
  only?: ScriptKind
  type?: 'function' | 'property'
}

export const GTA_API: ApiEntry[] = [
  {
    name: 'expectResponseStatusCodeToBe',
    signature: '(expectedValue, specialHandling?)',
    info: 'The status code is this number, or matches this RegExp.',
    only: 'tests'
  },
  {
    name: 'expectResponseToHaveHeader',
    signature: '(name, expectedValue?, specialHandling?)',
    info: 'The header exists; with a value, it equals it or matches the RegExp. Names ignore case.',
    only: 'tests'
  },
  {
    name: 'expectResponseBodyToHaveProperty',
    signature: '(jsonPathToProperty, expectedValue?, specialHandling?)',
    info: 'The body property exists; with a value, it equals it (type included) or matches the RegExp.',
    only: 'tests'
  },
  {
    name: 'expectResponseBodyToHaveUnorderedArray',
    signature: '(jsonPathToArray, validationList)',
    info: 'The array holds these items in any order. Objects list { pathToProperty, expectedValue, specialHandling? }.',
    only: 'tests'
  },
  {
    name: 'expectResponseBodyToHaveUnorderedArrayNotThisItem',
    signature: '(jsonPathToArray, validationList)',
    info: 'The array holds none of these items. Objects list { pathToProperty, compareValue }.',
    only: 'tests'
  },
  {
    name: 'ignoreResponseBodyProperty',
    signature: '(jsonPathToProperty)',
    info: 'Strict validation: count this property (and everything under it) as checked.',
    only: 'tests'
  },
  {
    name: 'ignoreResponseBodyArrayObjectProperty',
    signature: '(jsonPathToArray, jsonPathOfObjectProperty)',
    info: 'Strict validation: count this property of every array item as checked.',
    only: 'tests'
  },
  {
    name: 'sortResponseBodyArrays',
    signature: '(propertyName)',
    info: 'Sort every array of objects holding this property before the checks after it.',
    only: 'tests'
  },
  {
    name: 'useStrictValidation',
    signature: '(enabled = true)',
    info: 'Fail unless every body property is checked, ignored or captured.',
    only: 'tests'
  },
  {
    name: 'test',
    signature: '(name, fn)',
    info: 'A named check of your own: passes unless fn throws or rejects. fn may be async.',
    only: 'tests'
  },
  { name: 'get', signature: '(name)', info: "A variable's current value, from any layer." },
  { name: 'uuid', signature: '()', info: 'A random (version 4) UUID.' },
  {
    name: 'uuidv7',
    signature: '()',
    info: 'A time-ordered (version 7) UUID: unique, and sorts by when it was made.'
  },
  {
    name: 'randomInt',
    signature: '(min, max)',
    info: 'A whole number from min to max, both included.'
  },
  {
    name: 'set',
    signature: "(name, value, { scope: 'run' }?)",
    info: "Set a variable for the rest of this run. With { scope: 'run' } it lasts past this data row, into every row after it and teardown."
  },
  {
    name: 'skip',
    signature: '(reason?)',
    info: 'Send nothing for this step, and report it skipped with the reason.',
    only: 'pre-request'
  },
  {
    name: 'skipRest',
    signature: '(reason?)',
    info: 'Run none of the steps after this one in this row (in before.script, this one either). The next row, and teardown, still run.'
  },
  {
    name: 'flag',
    signature: '(name)',
    info: "A feature flag's value in this run — to check something different when it is on. A flag the environment does not declare is an error."
  },
  {
    name: 'date',
    signature: "(format, secondsOffset = 0, timeZone = 'local')",
    info: "strftime date, offset in seconds from now. timeZone: 'local', 'utc', an IANA zone, or an xtest letter."
  },
  { name: 'assert', signature: '', info: "Node's strict assert (also a global).", type: 'property' }
]

export const RES_API: ApiEntry[] = [
  { name: 'status', signature: '', info: 'Status code, a number.', type: 'property' },
  { name: 'statusText', signature: '', info: 'Reason phrase.', type: 'property' },
  { name: 'headers', signature: '', info: 'Headers by lower-cased name.', type: 'property' },
  { name: 'header', signature: '(name)', info: 'One header, any case.' },
  {
    name: 'body',
    signature: '',
    info: 'Parsed body: JSON as itself, XML converted as the checks see it, text as a string.',
    type: 'property'
  },
  { name: 'text', signature: '', info: 'The body exactly as received.', type: 'property' },
  { name: 'time', signature: '', info: 'Total time, in milliseconds.', type: 'property' },
  { name: 'size', signature: '', info: 'Body size, in bytes.', type: 'property' }
]

export const REQ_API: ApiEntry[] = [
  { name: 'method', signature: '', info: 'HTTP method.', type: 'property' },
  {
    name: 'url',
    signature: '',
    info: 'URL: as sent in tests, as written in before.script.',
    type: 'property'
  },
  {
    name: 'headers',
    signature: '',
    info: 'Headers by name. In before.script, change them to change what is sent.',
    type: 'property'
  },
  {
    name: 'body',
    signature: '',
    info: 'Body text, or null. In before.script, set a json, xml, text or graphql body’s text to change what is sent.',
    type: 'property'
  }
]

export const ASSERT_API: ApiEntry[] = [
  'ok',
  'equal',
  'notEqual',
  'deepEqual',
  'notDeepEqual',
  'match',
  'doesNotMatch',
  'throws',
  'rejects',
  'fail'
].map((name) => ({ name, signature: '(…)', info: `node:assert/strict ${name}` }))

/** xtest's `specialHandling` strings, offered inside quotes after a gta call. */
export const SPECIAL_HANDLING = [
  'notThisExpectedKey',
  'notThisExpectedValue',
  'setAsCollectionVariable',
  'setAsEnvironmentVariable',
  'dateAsEpoch',
  'dateWithin1Sec',
  'integerWithin1',
  'isArray',
  'isArrayAndEmpty',
  'isArrayAndNotEmpty',
  'isArrayAndHasLength'
]
