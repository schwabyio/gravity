import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { BodySchema } from '../model/documents.js'
import {
  contentTypeFor,
  encodeMultipart,
  fileMarker,
  multipartHeaders,
  partsOf
} from './multipart.js'

describe('body.multipart', () => {
  it('takes text, typed text, files and lists, by field name', () => {
    const body = BodySchema.parse({
      multipart: {
        description: 'A photo',
        metadata: { value: '{"a":1}', contentType: 'application/json' },
        avatar: { file: 'files/avatar.png', contentType: 'image/png', filename: 'me.png' },
        tags: ['red', 'blue']
      }
    })
    expect(partsOf(body.multipart!)).toEqual([
      ['description', 'A photo'],
      ['metadata', { value: '{"a":1}', contentType: 'application/json' }],
      ['avatar', { file: 'files/avatar.png', contentType: 'image/png', filename: 'me.png' }],
      ['tags', 'red'],
      ['tags', 'blue']
    ])
  })

  it('refuses what it cannot send, saying what it takes', () => {
    expect(() => BodySchema.parse({ multipart: { count: 3 } })).toThrow(
      'a multipart field is text, { value, contentType }, { file, contentType, filename }'
    )
    expect(() => BodySchema.parse({ multipart: { a: { file: '/etc/passwd' } } })).toThrow()
    expect(() => BodySchema.parse({ multipart: { a: { value: 'x', file: 'y' } } })).toThrow()
    expect(() => BodySchema.parse({ multipart: { tags: [] } })).toThrow()
    expect(() => BodySchema.parse({ file: 'C:\\uploads\\a.bin' })).toThrow(
      'body.file must be a relative path'
    )
    expect(() => BodySchema.parse({ multipart: { a: 'x' }, text: 'y' })).toThrow(
      'exactly one of json, xml, text, form, multipart, graphql, file'
    )
  })
})

describe('encodeMultipart', () => {
  it('encodes each part as RFC 7578 says, showing a file by its marker', () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x00, 0xff])
    const { bytes: sent, text } = encodeMultipart(
      [
        { name: 'description', value: 'A photo' },
        { name: 'meta', value: '{}', contentType: 'application/json' },
        {
          name: 'avatar',
          value: bytes,
          filename: 'me.png',
          contentType: 'image/png',
          shown: fileMarker('files/me.png', 4)
        }
      ],
      'XyZ'
    )
    const head = (disposition: string, type?: string) =>
      `--XyZ\r\nContent-Disposition: form-data; ${disposition}\r\n${type ? `Content-Type: ${type}\r\n` : ''}\r\n`
    const before =
      head('name="description"') +
      'A photo\r\n' +
      head('name="meta"', 'application/json') +
      '{}\r\n' +
      head('name="avatar"; filename="me.png"', 'image/png')
    expect(sent).toEqual(
      Buffer.concat([Buffer.from(before), Buffer.from(bytes), Buffer.from('\r\n--XyZ--\r\n')])
    )
    expect(text).toBe(`${before}‹file files/me.png, 4 bytes›\r\n--XyZ--\r\n`)
  })

  it('escapes quotes and line breaks in names as browsers do', () => {
    const { text } = encodeMultipart(
      [{ name: 'a"b\r\nc', value: '', filename: 'x".txt', shown: '' }],
      'B'
    )
    expect(text).toContain('name="a%22b%0D%0Ac"; filename="x%22.txt"')
  })
})

describe('multipartHeaders', () => {
  it('implies multipart/form-data with a boundary of its own', () => {
    const { headers, boundary } = multipartHeaders([{ name: 'Accept', value: '*/*' }])
    expect(boundary).toMatch(/^----GravityBoundary[0-9a-f]{24}$/)
    expect(headers).toEqual([
      { name: 'Accept', value: '*/*' },
      { name: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` }
    ])
  })

  it('adds a boundary to a declared multipart type that has none', () => {
    const { headers, boundary } = multipartHeaders([
      { name: 'content-type', value: 'multipart/mixed' }
    ])
    expect(headers).toEqual([
      { name: 'content-type', value: `multipart/mixed; boundary=${boundary}` }
    ])
  })

  it('uses a declared boundary, quoted or not', () => {
    const declared = [{ name: 'Content-Type', value: 'multipart/form-data; boundary="abc 1"' }]
    expect(multipartHeaders(declared)).toEqual({ headers: declared, boundary: 'abc 1' })
    expect(
      multipartHeaders([{ name: 'Content-Type', value: 'multipart/form-data;boundary=zz' }])
        .boundary
    ).toBe('zz')
  })

  it('leaves any other declared type as written', () => {
    const declared = [{ name: 'Content-Type', value: 'application/octet-stream' }]
    expect(multipartHeaders(declared).headers).toBe(declared)
  })
})

describe('contentTypeFor', () => {
  it('knows common extensions, whatever their case, and falls back to octet-stream', () => {
    expect(contentTypeFor('files/avatar.PNG')).toBe('image/png')
    expect(contentTypeFor('orders/order.json')).toBe('application/json')
    expect(contentTypeFor('files.d/README')).toBe('application/octet-stream')
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream')
  })
})
