/**
 * Battery-scoped exception constructors for the SearXNG search tool.
 *
 * @remarks
 * Battery-scoped exception classes owned by the SearXNG tool battery (not the ADK core). Minted
 * via `createException` from `@nhtio/adk/factories` and re-exported from the battery's barrel
 * (`@nhtio/adk/batteries/tools/searxng`). This file intentionally carries **no** `@module` tag:
 * it is an internal sibling relative-imported by `index.ts`, so it does not mint its own
 * `…/searxng/exceptions` entrypoint (whose `exceptions` leaf basename would collide with sibling
 * batteries under the `vite-plugin-dts` rolled-up `.d.ts` rule).
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when {@link createSearxngSearchTool} receives invalid configuration.
 *
 * @remarks
 * Fatal: config bugs (missing or unparseable `instanceUrl`) fail loud at factory-call time
 * rather than at the first search.
 */
export const E_INVALID_SEARXNG_CONFIG = createException<[string]>(
  'E_INVALID_SEARXNG_CONFIG',
  'Invalid SearXNG tool config: %s',
  'E_INVALID_SEARXNG_CONFIG',
  529,
  true
)
