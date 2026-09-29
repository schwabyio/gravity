import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema } from '../model/documents.js'
import { runCollection } from '../run/runCollection.js'
import { buildScope } from '../vars/resolve.js'
import { checkFlags, flagsNamedIn, parseFlagValue, UnknownFlagError } from './flags.js'
import { flagOverrides, resolveFlags, runFlagCommand, splitCommand } from './resolve.js'

describe('checkFlags', () => {
  const values = { newCheckout: true, pricing: 'v2', limit: 5 }

  it('holds when every flag named has its value, compared as text', () => {
    expect(checkFlags(undefined, values)).toEqual({ run: true })
    expect(checkFlags({ newCheckout: true, pricing: 'v2' }, values)).toEqual({ run: true })
    expect(checkFlags({ newCheckout: 'true', limit: '5' }, values)).toEqual({ run: true })
  })

  it('says why not', () => {
    expect(checkFlags({ newCheckout: false }, values)).toEqual({
      run: false,
      reason: 'feature flag newCheckout is on'
    })
    expect(checkFlags({ pricing: 'v1' }, values)).toEqual({
      run: false,
      reason: 'feature flag pricing is v2, not v1'
    })
  })

  it('refuses a flag the run does not know', () => {
    expect(() => checkFlags({ newChekout: true }, values)).toThrow(UnknownFlagError)
    expect(() => checkFlags({ a: true, b: true }, null)).toThrow('feature flags a, b are not known')
  })

  it('reads typed values from text, and lists the flags a collection names', () => {
    expect([
      parseFlagValue('true'),
      parseFlagValue('false'),
      parseFlagValue('2'),
      parseFlagValue('v2')
    ]).toEqual([true, false, 2, 'v2'])
    expect(flagsNamedIn({ flags: { b: true }, steps: [{ flags: { a: 1 } }, {}] })).toEqual([
      'a',
      'b'
    ])
  })

  it('takes overrides from GTA_FLAG_ variables and --flag, the command line winning', () => {
    expect(
      flagOverrides(['a=false', 'c=v2'], { GTA_FLAG_a: 'true', GTA_FLAG_b: '3', OTHER: 'x' })
    ).toEqual({
      a: false,
      b: 3,
      c: 'v2'
    })
    expect(() => flagOverrides(['nope'], {})).toThrow('write it as name=value')
  })
})

describe('splitCommand', () => {
  it('splits a command into words the same way on every platform', () => {
    expect(splitCommand('node scripts/flags.mjs  staging')).toEqual([
      'node',
      'scripts/flags.mjs',
      'staging'
    ])
    expect(splitCommand(`node -e 'a b' "c \\"d\\" \\\\ e" --x="y z"`)).toEqual([
      'node',
      '-e',
      'a b',
      'c "d" \\ e',
      '--x=y z'
    ])
    expect(splitCommand("node ''")).toEqual(['node', ''])
  })

  it('keeps a Windows path as written, and quotes a space', () => {
    expect(splitCommand('C:\\tools\\flags.exe staging')).toEqual([
      'C:\\tools\\flags.exe',
      'staging'
    ])
    expect(splitCommand('"C:\\Program Files\\nodejs\\node.exe" flags.mjs')).toEqual([
      'C:\\Program Files\\nodejs\\node.exe',
      'flags.mjs'
    ])
  })

  it('refuses a quote left open, or nothing at all', () => {
    expect(() => splitCommand('node "flags.mjs')).toThrow('has a " with no closing "')
    expect(() => splitCommand('   ')).toThrow('feature flag command is empty')
  })
})

describe('flag commands', () => {
  let root: string
  const node = JSON.stringify(process.execPath)
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-flags-'))
    await fs.mkdir(path.join(root, 'environments'))
    await fs.mkdir(path.join(root, 'collections'))
  })
  afterAll(() => fs.rm(root, { recursive: true, force: true }))

  const run = (script: string, timeoutMs = 10_000) =>
    runFlagCommand(`${node} -e ${JSON.stringify(script)}`, {
      cwd: root,
      env: process.env,
      timeoutMs
    })

  it('reads the JSON object a command prints', async () => {
    expect(await run('console.log(JSON.stringify({ a: true, b: "v2" }))')).toEqual({
      a: true,
      b: 'v2'
    })
  })

  it('stops, saying why, when a command fails or prints the wrong thing', async () => {
    await expect(run('console.error("no API key"); process.exit(3)')).rejects.toThrow(
      /exited with code 3:\nno API key/
    )
    await expect(run('console.log("hello")')).rejects.toThrow('did not print JSON')
    await expect(run('console.log("[1]")')).rejects.toThrow('must print a JSON object')
    await expect(run('console.log(JSON.stringify({ a: null }))')).rejects.toThrow('flag a is null')
    await expect(run('setTimeout(() => {}, 5000)', 200)).rejects.toThrow(
      'did not finish within 0.2s'
    )
  })

  it('runs the program itself, with no shell to read $VAR, && or quotes differently', async () => {
    const printArgs = 'console.log(JSON.stringify({ args: process.argv.slice(1).join(\\" \\") }))'
    const values = await runFlagCommand(`${node} -e "${printArgs}" $HOME && %PATH% '|'`, {
      cwd: root,
      env: process.env,
      timeoutMs: 10_000
    })
    expect(values).toEqual({ args: '$HOME && %PATH% |' })
  })

  it('says how to name a program it cannot start', async () => {
    await expect(
      runFlagCommand('gta-no-such-program flags', {
        cwd: root,
        env: process.env,
        timeoutMs: 10_000
      })
    ).rejects.toThrow(
      /could not start: gta-no-such-program was not found\. The first word is a program on the PATH/
    )
  })

  it('stops what the command started when it times out', async () => {
    const pidFile = path.join(root, 'grandchild.pid')
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`
    const child = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit' }); setTimeout(() => {}, 30000)`
    await expect(run(child, 2_000)).rejects.toThrow('did not finish within 2s')

    const pid = Number(await fs.readFile(pidFile, 'utf8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let waited = 0; alive() && waited < 5_000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(alive()).toBe(false)
  })

  it('layers fixed values, then the command, then overrides', async () => {
    // The command runs in the project folder, so a script there is found by its relative path.
    await fs.writeFile(
      path.join(root, 'flags.cjs'),
      "console.log(JSON.stringify({ b: 'command', c: 'command' }))"
    )
    await fs.writeFile(
      path.join(root, 'environments', 'staging.yml'),
      [
        'name: staging',
        'flags:',
        `  command: '${node} flags.cjs'`,
        '  values:',
        '    a: fixed',
        '    b: fixed',
        ''
      ].join('\n')
    )
    const resolved = await resolveFlags({
      root,
      environmentName: 'staging',
      overrides: { c: 'override' }
    })
    expect(resolved.values).toEqual({ a: 'fixed', b: 'command', c: 'override' })
    expect(resolved.sources).toEqual({ a: 'environment', b: 'command', c: 'override' })
    expect(resolved.command?.cwd).toBe(root)

    const fixedOnly = await resolveFlags({ root, environmentName: 'staging', runCommand: false })
    expect(fixedOnly.values).toEqual({ a: 'fixed', b: 'fixed' })
    // A scope built without flags given takes the fixed values, never running the command.
    await fs.writeFile(path.join(root, 'collections', 'x.yml'), 'id: x\nsteps: []\n')
    const scope = await buildScope({
      collectionPath: path.join(root, 'collections', 'x.yml'),
      environmentName: 'staging',
      env: {}
    })
    expect(scope.flags).toEqual({ a: 'fixed', b: 'fixed' })
  })
})

describe('flags in a run', () => {
  let server: http.Server
  let origin: string
  let seen: string[] = []
  let root: string
  let file: string
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.url ?? '')
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-flag-run-'))
    await fs.mkdir(path.join(root, 'collections'))
    file = path.join(root, 'collections', 'c.yml')
    await fs.writeFile(file, 'id: c\nsteps: []\n')
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  })

  const run = (doc: unknown, flags: Record<string, string | number | boolean> | null) => {
    seen = []
    return runCollection({
      collection: CollectionSchema.parse(doc),
      collectionPath: file,
      context: { collectionPath: file, env: {}, flags }
    })
  }

  it('skips a step whose flags do not hold, saying which, and runs the rest', async () => {
    const summary = await run(
      {
        id: 'c',
        steps: [
          { name: 'new', GET: `${origin}/new`, flags: { newCheckout: true } },
          { name: 'old', GET: `${origin}/old`, flags: { newCheckout: false } },
          { name: 'always', GET: `${origin}/always` }
        ]
      },
      { newCheckout: false }
    )
    expect(seen).toEqual(['/old', '/always'])
    expect(summary).toMatchObject({ total: 3, passed: 2, skipped: 1 })
    expect(summary.results[0]).toMatchObject({
      status: 'skipped',
      skipped: { reason: 'feature flag newCheckout is off' },
      request: { method: 'GET' }
    })
  })

  it('skips every step when the collection’s flags do not hold', async () => {
    const summary = await run(
      {
        id: 'c',
        flags: { pricing: 'v2' },
        steps: [{ GET: `${origin}/a` }, { GET: `${origin}/b` }]
      },
      { pricing: 'v1' }
    )
    expect(seen).toEqual([])
    expect(summary).toMatchObject({ total: 2, passed: 0, skipped: 2, errored: 0 })
  })

  it('reports a flag the run does not know as an error on the step', async () => {
    const summary = await run(
      { id: 'c', steps: [{ GET: `${origin}/a`, flags: { typo: true } }] },
      {}
    )
    expect(seen).toEqual([])
    expect(summary.results[0]).toMatchObject({
      status: 'error',
      error: { phase: 'flags', message: expect.stringContaining('feature flag typo is not known') }
    })
  })

  it('gives code the flag’s value with gta.flag, and refuses an unknown one', async () => {
    const summary = await run(
      {
        id: 'c',
        steps: [
          {
            GET: `${origin}/a`,
            tests: "gta.test('on', () => assert.equal(gta.flag('pricing'), 'v2'))"
          },
          { GET: `${origin}/b`, tests: "gta.flag('nope')" }
        ]
      },
      { pricing: 'v2' }
    )
    expect(summary.results[0]?.status).toBe('pass')
    expect(summary.results[1]).toMatchObject({
      status: 'error',
      error: { phase: 'tests', message: expect.stringContaining('feature flag nope is not known') }
    })
  })
})
