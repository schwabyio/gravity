import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema } from '../model/documents.js'
import { resultName, type RunResult } from '../model/run.js'
import { baseProblem, endpointProblem } from '../workspace/library.js'
import { runRequest } from './runRequest.js'
import { runSuite, type SuiteRow } from './runSuite.js'

let tmp: string
let collectionPath: string
let server: http.Server
let origin: string
let seen: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const status = req.url?.startsWith('/fail') ? 500 : 200
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'tok-1', roots: ['r1', 'r2'], url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-suite-')))
  await fs.mkdir(path.join(tmp, 'collections'))
  collectionPath = path.join(tmp, 'collections', 'seed.yml')
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmp, { recursive: true, force: true })
})

const rows = (...values: Array<Record<string, string>>): SuiteRow[] =>
  values.map((vars, i) => ({ source: `seed.csv row ${i + 1}`, vars, label: null }))

async function suite(
  doc: Record<string, unknown>,
  options: { rows?: SuiteRow[]; bail?: boolean; signal?: AbortSignal } = {}
) {
  seen = []
  const collection = CollectionSchema.parse({ id: 'seed', ...doc })
  const reported: Array<{ index: number; result: RunResult; row: number | undefined }> = []
  const summary = await runSuite({
    collection,
    collectionPath,
    // As the app runs one: the collection's variables as given, not from a file.
    context: { collectionPath, env: {}, dataRow: null, collectionVars: collection.vars ?? null },
    rows: options.rows ?? null,
    bail: options.bail ?? false,
    ...(options.signal ? { signal: options.signal } : {}),
    onResult: (index, result, iteration) => reported.push({ index, result, row: iteration?.index })
  })
  return { summary, reported, names: summary.results.map(resultName) }
}

describe('setup and teardown', () => {
  it('run once around every row, setup first and teardown last', async () => {
    const { summary, names, reported } = await suite(
      {
        setup: [{ name: 'grant', POST: `${origin}/grant` }],
        steps: [{ name: 'write', PUT: `${origin}/write/{{who}}` }],
        teardown: [{ name: 'revoke', DELETE: `${origin}/grant` }]
      },
      { rows: rows({ who: 'a' }, { who: 'b' }) }
    )
    expect(seen).toEqual(['POST /grant', 'PUT /write/a', 'PUT /write/b', 'DELETE /grant'])
    expect(names).toEqual(['setup › grant', 'write', 'write', 'teardown › revoke'])
    expect(reported.map(({ index, result, row }) => [index, result.stage, row])).toEqual([
      [0, 'setup', undefined],
      [0, undefined, 1],
      [0, undefined, 2],
      [0, 'teardown', undefined]
    ])
    expect(summary).toMatchObject({ total: 4, passed: 4 })
  })

  it('run around the steps of a collection with no data file too', async () => {
    await suite({
      setup: [{ POST: `${origin}/grant` }],
      steps: [{ GET: `${origin}/read` }],
      teardown: [{ DELETE: `${origin}/grant` }]
    })
    expect(seen).toEqual(['POST /grant', 'GET /read', 'DELETE /grant'])
  })

  it('give every row what setup set or captured, and teardown too', async () => {
    const { summary } = await suite(
      {
        setup: [
          {
            POST: `${origin}/login`,
            before: { script: "gta.set('admin', 'seed-admin')" },
            tests:
              "gta.expectResponseBodyToHaveProperty('token', 'token', 'setAsCollectionVariable')"
          }
        ],
        steps: [{ GET: `${origin}/as/{{admin}}/{{token}}/{{who}}` }],
        teardown: [{ DELETE: `${origin}/as/{{admin}}/{{token}}` }]
      },
      { rows: rows({ who: 'a' }, { who: 'b' }) }
    )
    expect(seen.slice(1)).toEqual([
      'GET /as/seed-admin/tok-1/a',
      'GET /as/seed-admin/tok-1/b',
      'DELETE /as/seed-admin/tok-1'
    ])
    expect(summary.errored).toBe(0)
  })

  it('stop the rows when setup fails, and still run teardown', async () => {
    const { summary, names } = await suite(
      {
        setup: [
          { name: 'grant', POST: `${origin}/fail`, tests: 'gta.expectResponseStatusCodeToBe(200)' }
        ],
        steps: [{ GET: `${origin}/one` }, { GET: `${origin}/two` }],
        teardown: [{ name: 'revoke', DELETE: `${origin}/grant` }]
      },
      { rows: rows({}, {}) }
    )
    expect(seen).toEqual(['POST /fail', 'DELETE /grant'])
    expect(names).toEqual(['setup › grant', 'teardown › revoke'])
    // Two steps in each of two rows, never begun.
    expect(summary).toMatchObject({ total: 6, passed: 1, failed: 1, skipped: 4 })
  })

  it('still run teardown, every step of it, after a failure and a bail', async () => {
    const failing = { GET: `${origin}/fail`, tests: 'gta.expectResponseStatusCodeToBe(200)' }
    const { summary } = await suite(
      {
        steps: [failing, { GET: `${origin}/after` }],
        teardown: [failing, { DELETE: `${origin}/grant` }]
      },
      { rows: rows({}, {}), bail: true }
    )
    expect(seen).toEqual(['GET /fail', 'GET /fail', 'DELETE /grant'])
    // The second step of row 1, and both of row 2, never begun.
    expect(summary).toMatchObject({ total: 6, failed: 2, passed: 1, skipped: 3 })
  })

  it('stop where they are on a cancel, teardown included', async () => {
    const controller = new AbortController()
    controller.abort()
    await suite(
      { steps: [{ GET: `${origin}/one` }], teardown: [{ DELETE: `${origin}/grant` }] },
      { signal: controller.signal }
    )
    expect(seen).toEqual([])
  })

  it('are refused where they cannot run: in a request set, a base or endpoints, and with tags', () => {
    expect(() =>
      CollectionSchema.parse({ params: {}, setup: [{ GET: '/x' }], steps: [{ GET: '/y' }] })
    ).toThrow('a request set runs inside another collection, so it has no setup')
    expect(() =>
      CollectionSchema.parse({ setup: [{ GET: '/x', tags: ['smoke'] }], steps: [] })
    ).toThrow('a setup step runs whenever its collection does, so it has no tags')
    expect(baseProblem(CollectionSchema.parse({ teardown: [{ GET: '/x' }] }))).toBe(
      'a base collection has no setup or teardown'
    )
    expect(endpointProblem(CollectionSchema.parse({ setup: [{ GET: '/x' }] }))).toBe(
      'an endpoints file has no setup or teardown'
    )
  })
})

describe('values that last the run', () => {
  it('carry a value set with { scope: "run" } into the rows after it, and nothing else', async () => {
    const { summary } = await suite(
      {
        steps: [
          {
            GET: `${origin}/row/{{who}}`,
            before: {
              script: [
                "const before = gta.get('lasting') ?? 'none'",
                "const plain = gta.get('plain') ?? 'none'",
                "gta.set('lasting', gta.get('who'), { scope: 'run' })",
                "gta.set('plain', gta.get('who'))",
                "gta.set('path', before + '-' + plain)"
              ].join('\n')
            }
          },
          { GET: `${origin}/saw/{{path}}/{{lasting}}` }
        ],
        teardown: [{ DELETE: `${origin}/last/{{lasting}}` }]
      },
      { rows: rows({ who: 'a' }, { who: 'b' }) }
    )
    expect(seen).toEqual([
      'GET /row/a',
      'GET /saw/none-none/a',
      'GET /row/b',
      'GET /saw/a-none/b',
      'DELETE /last/b'
    ])
    expect(summary.errored).toBe(0)
  })

  it('refuses a scope it does not know', async () => {
    const { summary } = await suite({
      steps: [{ GET: `${origin}/x`, before: { script: "gta.set('a', 1, { scope: 'row' })" } }]
    })
    expect(summary.results[0]?.error?.message).toMatch(/scope is 'run' or left out, got "row"/)
    expect(seen).toEqual([])
  })
})

describe('gta.skip and gta.skipRest', () => {
  it('skip a step from before.script, with the reason, sending nothing', async () => {
    const { summary } = await suite({
      steps: [
        {
          name: 'approve',
          PUT: `${origin}/approve`,
          before: { script: "gta.skip('no domains to add for this row')\ngta.set('ran', 'yes')" }
        },
        { name: 'no reason', GET: `${origin}/quiet`, before: { script: 'gta.skip()' } },
        { name: 'after', GET: `${origin}/after/{{ran}}` }
      ]
    })
    expect(seen).toEqual(['GET /after/yes'])
    expect(summary.results.map((r) => [r.status, r.skipped?.reason])).toEqual([
      ['skipped', 'no domains to add for this row'],
      ['skipped', 'gta.skip() in before.script'],
      ['pass', undefined]
    ])
    expect(summary).toMatchObject({ total: 3, passed: 1, skipped: 2 })
  })

  it('never stop a bailing run, since a skip is not a failure', async () => {
    const { summary } = await suite(
      {
        steps: [
          { GET: `${origin}/quiet`, before: { script: "gta.skip('not needed')" } },
          { GET: `${origin}/after` }
        ]
      },
      { bail: true }
    )
    expect(seen).toEqual(['GET /after'])
    expect(summary).toMatchObject({ total: 2, passed: 1, skipped: 1 })
  })

  it('skip from the collection’s before.script, for each step it runs before', async () => {
    const { summary } = await suite({
      before: { script: "if (gta.get('blocked') === 'yes') gta.skip('blocked here')" },
      steps: [{ GET: `${origin}/one` }]
    })
    expect(summary.results[0]?.status).toBe('pass')
    const blocked = await suite(
      {
        before: { script: "if (gta.get('blocked') === 'yes') gta.skip('blocked here')" },
        steps: [{ GET: `${origin}/one` }]
      },
      { rows: rows({ blocked: 'yes' }) }
    )
    expect(blocked.summary.results[0]?.skipped?.reason).toBe('blocked here')
  })

  it('refuse gta.skip in tests, where the request has been sent', async () => {
    const { summary } = await suite({ steps: [{ GET: `${origin}/x`, tests: 'gta.skip()' }] })
    expect(summary.results[0]?.error).toMatchObject({
      phase: 'tests',
      message: expect.stringMatching(/belongs in before\.script/)
    })
  })

  it('skip the rest of a row from before.script, this step included, and go on to the next row', async () => {
    const { summary, names } = await suite(
      {
        steps: [
          {
            name: 'check',
            GET: `${origin}/check/{{who}}`,
            before: {
              script: "if (gta.get('who') === 'blocked') gta.skipRest('blocked in staging')"
            }
          },
          { name: 'write', PUT: `${origin}/write/{{who}}` }
        ],
        teardown: [{ name: 'revoke', DELETE: `${origin}/grant` }]
      },
      { rows: rows({ who: 'blocked' }, { who: 'b' }) }
    )
    expect(seen).toEqual(['GET /check/b', 'PUT /write/b', 'DELETE /grant'])
    expect(summary.results.map((r) => [resultName(r), r.status, r.skipped?.reason])).toEqual([
      ['check', 'skipped', 'blocked in staging'],
      ['write', 'skipped', 'blocked in staging'],
      ['check', 'pass', undefined],
      ['write', 'pass', undefined],
      ['teardown › revoke', 'pass', undefined]
    ])
    expect(names).toHaveLength(5)
  })

  it('skip the rest after a step from its tests, the step itself having run', async () => {
    const { summary } = await suite({
      steps: [
        { GET: `${origin}/check`, tests: "gta.skipRest('nothing to repair')" },
        { PUT: `${origin}/repair` }
      ]
    })
    expect(seen).toEqual(['GET /check'])
    expect(summary.results.map((r) => [r.status, r.skipped?.reason])).toEqual([
      ['pass', undefined],
      ['skipped', 'nothing to repair']
    ])
  })

  it('skip a single step run on its own', async () => {
    seen = []
    const collection = CollectionSchema.parse({ steps: [] })
    const result = await runRequest({
      step: CollectionSchema.parse({
        steps: [{ GET: `${origin}/x`, before: { script: "gta.skip('not today')" } }]
      }).steps[0]!,
      collection
    })
    expect(result).toMatchObject({ status: 'skipped', skipped: { reason: 'not today' } })
    expect(seen).toEqual([])
  })
})

describe('forEach', () => {
  it('sends the request once per item of a list an earlier step set, as {{item}} and item', async () => {
    const { summary, names } = await suite({
      steps: [
        {
          name: 'find roots',
          GET: `${origin}/roots`,
          tests: "gta.set('roots', res.body.roots, { scope: 'run' })"
        }
      ],
      teardown: [
        {
          name: 'remove grant',
          DELETE: `${origin}/root/{{item}}`,
          forEach: '{{roots}}',
          tests: "gta.test('item in code', () => assert.match(item, /^r[12]$/))"
        }
      ]
    })
    expect(seen).toEqual(['GET /roots', 'DELETE /root/r1', 'DELETE /root/r2'])
    expect(names).toEqual([
      'find roots',
      'teardown › remove grant (item 1 of 2)',
      'teardown › remove grant (item 2 of 2)'
    ])
    expect(summary.results[2]?.forEach).toEqual({ index: 1, of: 2, item: 'r2' })
    expect(summary).toMatchObject({ total: 3, passed: 3 })
  })

  it('takes a list written in place, and an object item as its JSON', async () => {
    await suite({
      steps: [{ POST: `${origin}/each?value={{item}}`, forEach: '[1, {"a": 2}]' }]
    })
    expect(seen).toEqual(['POST /each?value=1', 'POST /each?value={%22a%22:2}'])
  })

  it('skips a step whose list is empty, and fails one whose list is not a list', async () => {
    const { summary } = await suite({
      vars: { none: '[]', word: 'roots' },
      steps: [
        { GET: `${origin}/a/{{item}}`, forEach: '{{none}}' },
        { GET: `${origin}/b/{{item}}`, forEach: '{{word}}' },
        { GET: `${origin}/c/{{item}}`, forEach: '{{missing}}' }
      ]
    })
    expect(seen).toEqual([])
    expect(summary.results.map((r) => [r.status, r.skipped?.reason ?? r.error?.message])).toEqual([
      ['skipped', 'forEach: {{none}} is an empty list'],
      [
        'error',
        'forEach: {{word}} is "roots", not a list; it needs a JSON array, such as ["a", "b"]'
      ],
      ['error', expect.stringMatching(/Variable "missing" is not defined/)]
    ])
    expect(summary.results[1]?.error?.phase).toBe('forEach')
  })

  it('stops at gta.skipRest, skipping the items after it', async () => {
    const { summary } = await suite({
      steps: [
        {
          GET: `${origin}/item/{{item}}`,
          forEach: '["a", "stop", "c"]',
          tests: "if (item === 'stop') gta.skipRest('found it')"
        },
        { GET: `${origin}/after` }
      ]
    })
    expect(seen).toEqual(['GET /item/a', 'GET /item/stop'])
    expect(summary.results.map((r) => r.status)).toEqual(['pass', 'pass', 'skipped', 'skipped'])
  })

  it('is refused on a use step, which runs a set', () => {
    expect(() => CollectionSchema.parse({ steps: [{ use: 'login', forEach: '[1]' }] })).toThrow(
      'forEach repeats one request, so a use: step cannot have it'
    )
  })
})
