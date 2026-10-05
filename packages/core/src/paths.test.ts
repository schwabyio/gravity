import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  foldName,
  isInside,
  nameProblem,
  relativePosix,
  renameWithRetry,
  resolveRelative,
  samePath,
  spellingOnDisk,
  spellingProblem,
  toPosix
} from './paths.js'
import { parseCollection, serialize, editCollection } from './format/index.js'
import { toLf } from './model/text.js'
import { defaultCloneName } from './git/repo.js'

const win = path.win32

describe('containment and sameness', () => {
  it('is case-insensitive and separator-agnostic on Windows', () => {
    expect(isInside('C:\\Repos\\Shop', 'c:/repos/shop/collections/a.yml', win)).toBe(true)
    expect(isInside('C:\\Repos\\Shop', 'C:\\Repos\\Shopping\\a.yml', win)).toBe(false)
    expect(isInside('C:\\Repos\\Shop', 'D:\\Repos\\Shop', win)).toBe(false)
    expect(samePath('C:\\Repos\\Shop\\', 'c:\\repos\\shop', win)).toBe(true)
  })

  it('is exact on POSIX, and never fooled by a shared prefix', () => {
    expect(isInside('/r/shop', '/r/shop/collections/a.yml', path.posix)).toBe(true)
    expect(isInside('/r/shop', '/r/shopping/a.yml', path.posix)).toBe(false)
    expect(isInside('/r/shop', '/r/shop', path.posix)).toBe(true)
  })

  it('counts a name starting with .. as inside', () => {
    expect(isInside('/r/shop', '/r/shop/..data/a.yml', path.posix)).toBe(true)
    expect(isInside('C:\\r\\shop', 'C:\\r\\shop\\..data\\a.yml', win)).toBe(true)
    expect(isInside('/r/shop', '/r/other', path.posix)).toBe(false)
    expect(isInside('/r/shop', '/r', path.posix)).toBe(false)
  })
})

describe('spelling on disk', () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-spelling-')))
    await fs.mkdir(path.join(tmp, 'shop', 'requests', 'auth'), { recursive: true })
    await fs.writeFile(path.join(tmp, 'shop', 'requests', 'auth', 'login.yml'), '')
    await fs.mkdir(path.join(tmp, 'shared'))
  })
  afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

  it('gives a path as it is spelled on disk, or null when it is not there', async () => {
    const shop = path.join(tmp, 'shop')
    expect(await spellingOnDisk(shop, 'requests/auth/login.yml')).toBe('requests/auth/login.yml')
    expect(await spellingOnDisk(shop, 'Requests\\Auth\\LOGIN.yml')).toBe('requests/auth/login.yml')
    expect(await spellingOnDisk(shop, '../Shared')).toBe('../shared')
    expect(await spellingOnDisk(shop, 'requests/auth/logout.yml')).toBeNull()
  })

  it('says why a name that only this disk finds would fail on Linux', async () => {
    const shop = path.join(tmp, 'shop')
    expect(await spellingProblem(shop, 'requests/auth/login.yml')).toBeNull()
    expect(await spellingProblem(shop, './requests//auth/login.yml')).toBeNull()
    expect(await spellingProblem(shop, 'requests/nope.yml')).toBeNull()
    expect(await spellingProblem(shop, 'requests/Auth/login.yml')).toBe(
      'requests/Auth/login.yml is spelled in a different case on disk, as requests/auth/login.yml: names must match exactly, as they do on Linux (SPEC.md §1.2)'
    )
  })

  it('compares accented letters however they are encoded', () => {
    expect(foldName('Caf\u0065\u0301')).toBe(foldName('café'))
  })
})

describe('relative paths written in files', () => {
  it('resolves / or \\ the same way, on either platform', () => {
    expect(resolveRelative('C:\\repos\\shop', '../shared', win)).toBe('C:\\repos\\shared')
    expect(resolveRelative('C:\\repos\\shop', '..\\shared', win)).toBe('C:\\repos\\shared')
    expect(resolveRelative('/repos/shop', '..\\shared', path.posix)).toBe('/repos/shared')
  })

  it('refuses an absolute path, however it is written', () => {
    for (const absolute of ['/opt/shared', 'C:\\shared', 'c:/shared', '\\\\server\\share']) {
      expect(() => resolveRelative('/repos/shop', absolute, path.posix)).toThrow(
        'must be a relative path, so it works on every machine'
      )
    }
  })

  it('writes relative paths with /', () => {
    expect(toPosix('checkout\\sessions.yml')).toBe('checkout/sessions.yml')
    expect(relativePosix('C:\\repos\\shop', 'C:\\repos\\shared', win)).toBe('../shared')
    expect(relativePosix('/a', '/a', path.posix)).toBe('.')
  })
})

describe('names', () => {
  it('refuses what Windows refuses', () => {
    expect(nameProblem('checkout')).toBeNull()
    expect(nameProblem('Staging EU')).toBeNull()
    expect(nameProblem('a:b')).toMatch(/cannot contain/)
    expect(nameProblem('a/b')).toMatch(/cannot contain/)
    expect(nameProblem('trailing.')).toMatch(/end with a dot/)
    expect(nameProblem('CON')).toBe('"CON" is reserved on Windows')
    expect(nameProblem('nul.yml')).toMatch(/reserved/)
    expect(nameProblem('CONIN$')).toMatch(/reserved/)
    expect(nameProblem('conout$.yml')).toMatch(/reserved/)
    expect(nameProblem('  ')).toBe('A name is needed')
  })
})

describe('renames', () => {
  const failing = (code: string) => Object.assign(new Error(code), { code })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retry while Windows holds what is moved for a moment', async () => {
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(failing('EPERM'))
      .mockRejectedValueOnce(failing('EBUSY'))
      .mockResolvedValueOnce(undefined)
    await renameWithRetry('a', 'b')
    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('give up after the last attempt, with its error', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(failing('EACCES'))
    await expect(renameWithRetry('a', 'b', 3)).rejects.toThrow('EACCES')
    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('fail at once when waiting would not help', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(failing('ENOENT'))
    await expect(renameWithRetry('a', 'b')).rejects.toThrow('ENOENT')
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('line endings', () => {
  it('are LF as the tools write them', () => {
    expect(toLf('a\r\nb\nc\r\n')).toBe('a\nb\nc\n')
  })

  it('an edit to a CRLF file is written with LF on every line', () => {
    const source = '# comment\r\nid: shop\r\nsteps:\r\n  - GET: "http://x"\r\n'
    const edited = serialize(editCollection(parseCollection(source), ['tags'], ['smoke']))
    expect(edited).toBe('# comment\nid: shop\nsteps:\n  - GET: "http://x"\ntags:\n  - smoke\n')
  })

  it('a CRLF file the app did not change is left as it is', () => {
    const source = 'id: shop\r\nsteps:\r\n  - GET: "http://x"\r\n'
    expect(serialize(parseCollection(source))).toBe(source)
  })
})

describe('git', () => {
  it('names a clone from a Windows path too', () => {
    expect(defaultCloneName('C:\\repos\\payments')).toBe('payments')
    expect(defaultCloneName('git@github.com:org/payments.git')).toBe('payments')
  })
})
