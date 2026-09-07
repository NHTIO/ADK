/**
 * Manual mock for the optional peer `@toon-format/toon`, used ONLY by test files that opt in with
 * an explicit `vi.mock('@toon-format/toon')`. Nothing is mocked automatically — every other spec
 * keeps loading the real package.
 *
 * Throwing at module scope makes `import('@toon-format/toon')` REJECT, which is the shape of a
 * genuine module-resolution failure (`ERR_MODULE_NOT_FOUND`) in the runtime a consumer who never
 * installed the optional peer would see. A `vi.mock` factory that throws cannot express this: the
 * browser provider must enumerate the factory's exports to build a module shim, so a factory that
 * throws fails during route registration rather than at the import site. A `__mocks__` redirect is
 * served as a real module by both providers, so the same spec runs under node AND browser.
 *
 * @see tests/unit/batteries/artifacts/peer_missing.cross.spec.ts
 */
throw new Error('SIMULATED_TOON_RESOLUTION_FAILURE')
