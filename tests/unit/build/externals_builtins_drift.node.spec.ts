import { builtinModules } from 'node:module'
import { describe, expect, it } from 'vitest'
import { externals } from '../../../vite.config.mts'

/**
 * Regression pin for issue #12: `node:os`/`node:crypto` fell through vite's default resolution to
 * the browser-external stub (`module.exports = {}`) because the hand-maintained externals list
 * didn't have them, silently turning `os.tmpdir()` into `undefined` in the published bundle. The
 * fix generates `externals` from `node:module`'s own builtin list instead of enumerating by hand —
 * this test proves that generation actually covers every builtin, in both its bare and
 * `node:`-prefixed forms, so a future edit that reintroduces a hand-maintained subset gets caught
 * here instead of shipping silently. Runs against `vite.config.mts`'s own computed Set directly, not
 * a rebuild of `dist/` — `pnpm run test:node` executes before `Build Library` ever produces `dist/`
 * in CI, so a dist-inspection test would not be exercised by the gate that actually blocks an MR.
 */
describe('vite.config.mts externals — node builtin coverage', () => {
  it.each(builtinModules)('includes both "%s" and its node: alias', (name) => {
    expect(externals.has(name)).toBe(true)
    expect(externals.has(`node:${name}`)).toBe(true)
  })

  it('includes the non-builtin externals this build also requires', () => {
    expect(externals.has('knex')).toBe(true)
  })
})
