import { Buffer } from 'node:buffer'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  baseCertificates,
  isUntrustedCertificate,
  readCertificates,
  secureContextFor,
  summarizeCertificate,
  trustedCertificates
} from './trust.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TLS = path.resolve(here, '../../test-fixtures/tls')
const fixture = (name: string) => fs.readFileSync(path.join(TLS, name))

describe('readCertificates', () => {
  it('reads a PEM certificate', () => {
    const [ca, ...rest] = readCertificates(fixture('ca.pem'))
    expect(rest).toEqual([])
    expect(summarizeCertificate(ca!)).toEqual({
      subject: 'Gravity Test CA',
      expires: expect.stringMatching(/^2126-/)
    })
  })

  it('reads every certificate in a PEM bundle', () => {
    const bundle = Buffer.concat([fixture('server.pem'), fixture('ca.pem')])
    expect(readCertificates(bundle).map((c) => summarizeCertificate(c).subject)).toEqual([
      'localhost',
      'Gravity Test CA'
    ])
  })

  it('reads a DER certificate, as a Windows export writes a .cer', () => {
    const der = new X509Certificate(fixture('ca.pem')).raw
    const [ca] = readCertificates(der)
    expect(ca!.toString().trim()).toBe(fixture('ca.pem').toString().trim())
  })

  it('says what is wrong with a file that holds no certificate', () => {
    expect(() => readCertificates(fixture('server-key.pem'))).toThrow(
      /holds no certificate: a PEM file needs a -----BEGIN CERTIFICATE----- block/
    )
    expect(() => readCertificates(Buffer.from('not a certificate'))).toThrow(
      'is not a certificate: PEM or DER expected'
    )
    expect(() =>
      readCertificates(Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'))
    ).toThrow('holds a certificate that will not parse')
  })
})

describe('trust', () => {
  it('trusts Node’s bundled roots, whatever else it adds', () => {
    const base = new Set(baseCertificates())
    for (const root of tls.rootCertificates.slice(0, 5)) expect(base.has(root.trim())).toBe(true)
  })

  it('adds extra certificates on top, once each', () => {
    const ca = fixture('ca.pem').toString()
    const trusted = trustedCertificates([ca, ca])
    expect(trusted.length).toBe(baseCertificates().length + 1)
    expect(trusted).toContain(ca.trim())
  })

  it('builds one TLS context per set of certificates', () => {
    const ca = fixture('ca.pem').toString()
    expect(secureContextFor([ca])).toBe(secureContextFor([ca]))
    expect(secureContextFor([ca])).not.toBe(secureContextFor([]))
  })

  it('knows the errors a trusted CA would fix', () => {
    expect(isUntrustedCertificate('UNABLE_TO_VERIFY_LEAF_SIGNATURE')).toBe(true)
    expect(isUntrustedCertificate('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe(true)
    expect(isUntrustedCertificate('CERT_HAS_EXPIRED')).toBe(false)
    expect(isUntrustedCertificate('ERR_TLS_CERT_ALTNAME_INVALID')).toBe(false)
    expect(isUntrustedCertificate(undefined)).toBe(false)
  })
})
