import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema, type Collection } from '../model/documents.js'
import { VariableScope } from '../vars/scope.js'
import { runRequest } from './runRequest.js'

let server: http.Server
let origin: string
let received: { headers: http.IncomingHttpHeaders; raw: string[]; body: string } | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString()))
    req.on('end', () => {
      received = { headers: req.headers, raw: req.rawHeaders, body }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** Run a collection's one step, with these variables in scope. */
async function send(doc: Partial<Collection> & { steps: unknown[] }, vars = {}) {
  received = null
  const collection = CollectionSchema.parse(doc)
  return runRequest({
    step: collection.steps[0]!,
    collection,
    scope: new VariableScope([{ source: 'test', vars }])
  })
}

/** The values a header arrived with, one per time it was sent. */
const sent = (name: string): string[] =>
  (received?.raw ?? []).flatMap((entry, i, all) =>
    i % 2 === 0 && entry.toLowerCase() === name.toLowerCase() ? [all[i + 1]!] : []
  )

describe('a header sent more than once', () => {
  const step = (script: string, tests?: string) => ({
    steps: [
      {
        GET: `${origin}/forwarded`,
        headers: { 'X-Forwarded-For': ['10.0.0.1', '10.0.0.2'] },
        before: { script },
        ...(tests ? { tests } : {})
      }
    ]
  })

  it('is sent once per value, and reads as every value joined', async () => {
    const result = await send(
      step(
        "gta.set('seen', req.headers['X-Forwarded-For'])",
        [
          "gta.test('the script saw every value', () => assert.equal(gta.get('seen'), '10.0.0.1, 10.0.0.2'))",
          "gta.test('tests see every value', () => assert.equal(req.headers['X-Forwarded-For'], '10.0.0.1, 10.0.0.2'))"
        ].join('\n')
      )
    )
    expect(result.assertions.map((a) => [a.name, a.status])).toEqual([
      ['the script saw every value', 'pass'],
      ['tests see every value', 'pass']
    ])
    expect(sent('X-Forwarded-For')).toEqual(['10.0.0.1', '10.0.0.2'])
  })

  it('is left as it was when the script changes another header', async () => {
    await send(step("req.headers['X-Trace'] = 't1'"))
    expect(sent('X-Forwarded-For')).toEqual(['10.0.0.1', '10.0.0.2'])
    expect(sent('X-Trace')).toEqual(['t1'])
  })

  it('takes an array as one header per value, and a string as one header', async () => {
    await send(step("req.headers['X-Forwarded-For'] = ['10.0.0.3', '10.0.0.4', '10.0.0.5']"))
    expect(sent('X-Forwarded-For')).toEqual(['10.0.0.3', '10.0.0.4', '10.0.0.5'])
    await send(step("req.headers['X-Forwarded-For'] = '10.0.0.9'"))
    expect(sent('X-Forwarded-For')).toEqual(['10.0.0.9'])
  })
})

describe('before.script changing the request it is about to send', () => {
  it('leaves a member out of a JSON body, before its {{variables}} resolve', async () => {
    const result = await send(
      {
        steps: [
          {
            POST: `${origin}/jwt`,
            body: { json: '{ "sub": "{{accountId}}", "crm_contact_id": "{{crmContactId}}" }' },
            before: {
              script: [
                'const claims = JSON.parse(req.body)',
                "if (!gta.get('crmContactId')) delete claims.crm_contact_id",
                'req.body = JSON.stringify(claims)'
              ].join('\n')
            },
            tests:
              'gta.test(\'tests see it as sent\', () => assert.equal(req.body, \'{"sub":"u1"}\'))'
          }
        ]
      },
      { accountId: 'u1' }
    )
    expect(result.error).toBeNull()
    expect(received?.body).toBe('{"sub":"u1"}')
    expect(result.request.body).toBe('{"sub":"u1"}')
    expect(result.status).toBe('pass')
  })

  it('adds, changes and removes headers, the collection’s included', async () => {
    await send(
      {
        headers: { 'X-Debug': 'on', Accept: 'text/plain' },
        steps: [
          {
            GET: `${origin}/h`,
            before: {
              script: [
                "req.headers['X-Trace'] = '{{traceId}}'",
                "req.headers.Accept = 'application/json'",
                "delete req.headers['X-Debug']"
              ].join('\n')
            }
          }
        ]
      },
      { traceId: 't-1' }
    )
    expect(received?.headers['x-trace']).toBe('t-1')
    expect(received?.headers.accept).toBe('application/json')
    expect(received?.headers['x-debug']).toBeUndefined()
  })

  it('shows each later script what an earlier one changed', async () => {
    const result = await send({
      before: { script: "req.headers['X-Layer'] = 'collection'" },
      steps: [
        {
          POST: `${origin}/layers`,
          body: { text: 'step' },
          before: {
            script: "req.body = req.headers['X-Layer'] + ' then ' + req.body"
          }
        }
      ]
    })
    expect(result.error).toBeNull()
    expect(received?.body).toBe('collection then step')
  })

  it('refuses what cannot be sent, as a pre-request error, sending nothing', async () => {
    const refused = async (body: unknown, script: string) =>
      send({ steps: [{ POST: `${origin}/no`, ...(body ? { body } : {}), before: { script } }] })

    const number = await refused({ text: 'x' }, 'req.body = 5')
    expect(number.error).toMatchObject({
      phase: 'pre-request',
      script: 'step',
      message: "req.body is the body's text; a script set it to number"
    })
    const form = await refused({ form: { a: '1' } }, "req.body = 'a=2'")
    expect(form.error?.message).toMatch(/a form, multipart or file body is built from its parts/)
    const none = await refused(undefined, "req.body = 'x'")
    expect(none.error?.message).toMatch(/a step with no body has none to change/)
    const headers = await refused({ text: 'x' }, "req.headers = 'Accept: */*'")
    expect(headers.error?.message).toBe('req.headers is a map of header names to their values')
    expect(received).toBeNull()
  })
})
