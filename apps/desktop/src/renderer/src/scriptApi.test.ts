import { describe, expect, it } from 'vitest'
// The engine, only here: the renderer itself must never import it.
import {
  preRequestGta,
  SPECIAL_HANDLING as RUNTIME_SPECIAL_HANDLING,
  testsGta,
  VariableScope
} from '@schwabyio/gravity-core'
import { ASSERT_API, GTA_API, REQ_API, RES_API, SPECIAL_HANDLING } from './scriptApi.js'

/** What the editor offers after `gta.` in a script of this kind. */
const offered = (kind: 'tests' | 'pre-request') =>
  GTA_API.filter((entry) => !entry.only || entry.only === kind)
    .map((entry) => entry.name)
    .sort()

/** Response checks: on the pre-request gta only to say they belong in tests. */
const RESPONSE_ONLY = GTA_API.filter((entry) => entry.only === 'tests').map((entry) => entry.name)

describe('the completions the code editor offers', () => {
  it('are the gta functions each script really has', () => {
    const tests = Object.keys(
      testsGta({ session: {} as never, scope: new VariableScope(), pending: [] })
    )
    // gta.skip is there in tests only to say it belongs in before.script.
    expect(offered('tests')).toEqual(tests.filter((name) => name !== 'skip').sort())
    const before = Object.keys(preRequestGta(new VariableScope()))
    expect(offered('pre-request')).toEqual(
      before.filter((name) => !RESPONSE_ONLY.includes(name)).sort()
    )
  })

  it('offer each special handling the engine knows, its <X> filled in as an example', () => {
    expect(SPECIAL_HANDLING).toEqual(
      RUNTIME_SPECIAL_HANDLING.map((name) =>
        name.replace('<X>Sec', '1Sec').replace('Within<X>', 'Within1')
      )
    )
  })

  it('say what each entry is, once each, with a signature for each function', () => {
    for (const list of [GTA_API, RES_API, REQ_API, ASSERT_API]) {
      const names = list.map((entry) => entry.name)
      expect(new Set(names).size, names.join(', ')).toBe(names.length)
      for (const entry of list) {
        expect(entry.info, entry.name).not.toBe('')
        // A property is read, not called: only a function has a signature.
        expect(entry.signature === '', entry.name).toBe(entry.type === 'property')
      }
    }
  })
})
