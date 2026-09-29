import type { Buffer } from 'node:buffer'
import { createHash, X509Certificate } from 'node:crypto'
import tls from 'node:tls'

/**
 * The CAs a request trusts (SPEC.md §1.1). There are three sources:
 *
 * - Node's bundled Mozilla roots, plus `NODE_EXTRA_CA_CERTS`.
 * - The operating system's trust store: the macOS Keychain, the Windows
 *   certificate store or the Linux CA bundle.
 * - A project's own `tls.ca` files.
 *
 * On its own, Node ignores the operating system's store. A CA that IT
 * installed, or that `mkcert -install` added, then works in the browser and
 * fails here. Reading that store too means Gravity trusts every server the
 * browser trusts.
 */

let base: string[] | null = null

/** Node's default CAs and the operating system's, read once. */
export function baseCertificates(): string[] {
  if (base) return base
  // Node 22.15 added tls.getCACertificates. Older versions have only the bundled roots.
  const get = typeof tls.getCACertificates === 'function' ? tls.getCACertificates : null
  const read = (type: 'default' | 'system'): string[] => {
    try {
      return get ? get(type) : []
    } catch {
      // A store that cannot be read must not stop requests that never needed it.
      return []
    }
  }
  base = unique([...(get ? read('default') : tls.rootCertificates), ...read('system')])
  return base
}

/** Everything a request trusts: the base set, and `extra` on top. */
export function trustedCertificates(extra: readonly string[] = []): string[] {
  return extra.length === 0 ? baseCertificates() : unique([...baseCertificates(), ...extra])
}

/** Names a set of extra certificates, so what is built from it can be cached. */
export const trustKey = (extra: readonly string[]): string =>
  extra.length === 0 ? '' : createHash('sha256').update(extra.join('\n')).digest('hex')

const contexts = new Map<string, tls.SecureContext>()

/**
 * A TLS context trusting the base set and `extra`. Parsing a few hundred
 * certificates takes milliseconds, so each set is parsed once, not per
 * connection.
 */
export function secureContextFor(extra: readonly string[] = []): tls.SecureContext {
  const key = trustKey(extra)
  let context = contexts.get(key)
  if (!context) {
    context = tls.createSecureContext({ ca: trustedCertificates(extra) })
    contexts.set(key, context)
  }
  return context
}

/** Forget cached contexts, alongside closing the connections that used them. */
export function clearSecureContexts(): void {
  contexts.clear()
}

/** One certificate in a `tls.ca` file, as a person checks they listed the right one. */
export interface CertificateSummary {
  /** The subject's common name, else its whole subject. */
  subject: string
  /** When it expires, as an ISO date-time. */
  expires: string
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/**
 * The certificates in a file. It can hold PEM blocks, whether one or a bundle,
 * or be one DER certificate. The `.cer` a Windows export writes is often DER.
 * Throws with the reason when the file holds no certificate.
 */
export function readCertificates(bytes: Buffer): X509Certificate[] {
  const text = bytes.toString('latin1')
  const blocks = text.match(PEM_BLOCK)
  try {
    if (blocks) return blocks.map((block) => new X509Certificate(block))
  } catch {
    throw new Error('holds a certificate that will not parse')
  }
  if (text.includes('-----BEGIN ')) {
    throw new Error('holds no certificate: a PEM file needs a -----BEGIN CERTIFICATE----- block')
  }
  try {
    return [new X509Certificate(bytes)]
  } catch {
    throw new Error('is not a certificate: PEM or DER expected')
  }
}

export function summarizeCertificate(certificate: X509Certificate): CertificateSummary {
  const lines = certificate.subject.split('\n')
  const common = lines.find((line) => line.startsWith('CN='))
  return {
    subject: common ? common.slice(3) : lines.join(', '),
    expires: certificate.validToDate.toISOString()
  }
}

/**
 * Error codes meaning that the server's certificate does not chain to a CA the
 * request trusts. A `tls.ca` entry can fix these. It cannot fix an expired
 * certificate or a wrong host name.
 */
const UNTRUSTED = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED'
])

export const isUntrustedCertificate = (code: string | undefined): code is string =>
  code !== undefined && UNTRUSTED.has(code)

/** What to do about an untrusted certificate, after the error itself. */
export const UNTRUSTED_HINT =
  'To trust a local CA, add its certificate to tls.ca in project.yml, or to the system’s trust store (SPEC.md §1.1)'

function unique(certificates: readonly string[]): string[] {
  return [...new Set(certificates.map((pem) => pem.trim()))]
}
