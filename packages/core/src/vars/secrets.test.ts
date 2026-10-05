import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { redact } from './secrets.js'

describe('redact', () => {
  it('replaces every secret value in every string, longest first', () => {
    const result = {
      request: { headers: [{ name: 'Authorization', value: 'Bearer abc123-long' }] },
      logs: ['token abc123-long', 'short abc'],
      durationMs: 5,
      error: null
    }
    const secrets: Array<[string, string]> = [
      ['token', 'abc123-long'],
      ['pin', 'abc']
    ]
    expect(redact(result, secrets)).toEqual({
      request: { headers: [{ name: 'Authorization', value: 'Bearer [secret: token]' }] },
      logs: ['token [secret: token]', 'short [secret: pin]'],
      durationMs: 5,
      error: null
    })
  })

  it('reads a base64 body as text when its bytes hold a secret, so the secret is hidden', () => {
    const secrets: Array<[string, string]> = [['token', 'abc123']]
    const response = (bytes: Buffer) => ({
      headers: [{ name: 'x-echo', value: 'abc123' }],
      body: bytes.toString('base64'),
      bodyKind: 'binary',
      bodyEncoding: 'base64'
    })
    const holding = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG abc123')])
    expect(redact(response(holding), secrets)).toEqual({
      headers: [{ name: 'x-echo', value: '[secret: token]' }],
      body: '\ufffdPNG [secret: token]',
      bodyKind: 'binary'
    })

    // One that holds none stays base64, the rest of the response redacted as ever.
    const clean = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    expect(redact(response(clean), secrets)).toEqual({
      ...response(clean),
      headers: [{ name: 'x-echo', value: '[secret: token]' }]
    })
  })

  it('leaves a result alone when there are no secrets', () => {
    const result = { a: 'b' }
    expect(redact(result, [])).toBe(result)
  })
})
