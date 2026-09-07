/* eslint-disable @unicorn/filename-case -- the filename IS the resolution key: vitest maps `vi.mock('fast-xml-parser')` to `__mocks__/<package name>`, so snake_casing it would silently stop the redirect from matching */
/**
 * Manual mock for the optional peer `fast-xml-parser`, used ONLY by test files that opt in with an
 * explicit `vi.mock('fast-xml-parser')`. Nothing is mocked automatically — every other spec keeps
 * loading the real package.
 *
 * See `__mocks__/@toon-format/toon.ts` for why a throwing module beats a throwing `vi.mock`
 * factory here (the browser provider cannot enumerate exports of a factory that throws).
 *
 * @see tests/unit/batteries/artifacts/peer_missing.cross.spec.ts
 */
throw new Error('SIMULATED_FAST_XML_PARSER_RESOLUTION_FAILURE')
