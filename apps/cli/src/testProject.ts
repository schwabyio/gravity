import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** A local API for runs to hit: /ok answers 200, /fail 500, /slow after three seconds. */
export async function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => res.end('late'), 3_000).unref()
      return
    }
    const status = req.url?.startsWith('/fail') ? 500 : 200
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, ok: status === 200 }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** Write a project into a fresh temporary folder: `{ 'collections/a.yml': '…' }`. */
export async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-project-'))
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), text)
  }
  return root
}

/** A collection whose steps GET each path from `{{baseUrl}}` and expect a 200; `id` is its file name. */
export const collection = (id: string, paths: string[], extra = ''): string =>
  [
    `id: ${id}`,
    extra,
    'steps:',
    ...paths.flatMap((p) => [
      `  - name: get ${p}`,
      `    GET: '{{baseUrl}}${p}'`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)'
    ])
  ]
    .filter(Boolean)
    .join('\n')
