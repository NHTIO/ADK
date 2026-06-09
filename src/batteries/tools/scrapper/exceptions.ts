/**
 * Battery-scoped exception constructors for the Scrapper web-extraction tool.
 *
 * @remarks
 * Battery-scoped exception classes owned by the Scrapper tool battery (not the ADK core). Minted
 * via `createException` from `@nhtio/adk/factories` and re-exported from the battery's barrel
 * (`@nhtio/adk/batteries/tools/scrapper`). This file intentionally carries **no** `@module` tag:
 * it is an internal sibling relative-imported by `index.ts`, so it does not mint its own
 * `…/scrapper/exceptions` entrypoint (whose `exceptions` leaf basename would collide with sibling
 * batteries under the `vite-plugin-dts` rolled-up `.d.ts` rule).
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when a Scrapper factory receives invalid configuration.
 *
 * @remarks
 * Fatal: config bugs (missing/unparseable `instanceUrl`, a bad `artifact` resolver, or an async
 * resolver passed to a `*Sync` factory) fail loud at factory-call time rather than at first scrape.
 */
export const E_INVALID_SCRAPPER_CONFIG = createException<[string]>(
  'E_INVALID_SCRAPPER_CONFIG',
  'Invalid Scrapper tool config: %s',
  'E_INVALID_SCRAPPER_CONFIG',
  529,
  true
)
