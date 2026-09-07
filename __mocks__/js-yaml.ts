/* eslint-disable @unicorn/filename-case -- the filename IS the resolution key: vitest maps `vi.mock('js-yaml')` to `__mocks__/<package name>`, so snake_casing it would silently stop the redirect from matching */
/**
 * Manual mock for the optional peer `js-yaml`, used ONLY by test files that opt in with an
 * explicit `vi.mock('js-yaml')`. Nothing is mocked automatically — every other spec keeps loading
 * the real package.
 *
 * See `__mocks__/@toon-format/toon.ts` for why a throwing module beats a throwing `vi.mock`
 * factory here (the browser provider cannot enumerate exports of a factory that throws).
 *
 * @see tests/unit/batteries/artifacts/peer_missing.cross.spec.ts
 */
throw new Error('SIMULATED_JS_YAML_RESOLUTION_FAILURE')
