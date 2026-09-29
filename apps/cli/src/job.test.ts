import { describe, expect, it } from 'vitest'
import { redact } from './job.js'

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

  it('leaves a result alone when there are no secrets', () => {
    const result = { a: 'b' }
    expect(redact(result, [])).toBe(result)
  })
})
