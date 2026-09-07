/**
 * Manual mock for the optional peer `typescript`, used ONLY by test files that opt in with an
 * explicit `vi.mock('typescript')`. Nothing is mocked automatically — every other spec keeps
 * loading the real package.
 *
 * See `__mocks__/@toon-format/toon.ts` for why a throwing module beats a throwing `vi.mock`
 * factory here (the browser provider cannot enumerate exports of a factory that throws).
 *
 * @see tests/unit/batteries/artifacts/peer_missing.cross.spec.ts
 */
throw new Error('SIMULATED_TYPESCRIPT_RESOLUTION_FAILURE')
