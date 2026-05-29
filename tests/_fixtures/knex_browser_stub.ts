/**
 * Empty stub for the `knex` package, aliased into the browser test build.
 *
 * @remarks
 * `@nhtio/validation` declares a database validator that uses an `await import('knex')` to
 * load knex on demand. The validator is never reached by any of our test code — it only
 * activates when a consumer registers a knex-backed schema. In the browser test runner vite
 * still tries to resolve the dynamic import target at module-graph time and fails because
 * knex isn't a runtime dependency. Aliasing the bare specifier `'knex'` to this file gives
 * vite something to resolve while keeping the runtime path dead.
 */
export default function knex(): never {
  throw new Error(
    'knex is not available in the browser test environment; this stub exists only to satisfy ' +
      "vite's module resolution for @nhtio/validation's never-reached database validator."
  )
}
