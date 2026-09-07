/**
 * Battery-scoped exceptions for the TOON artifact battery.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/artifacts/toon` entry — re-exported from the
 * battery's own barrel per the battery-scoped-exceptions rule. These are the typed errors the
 * implementor-facing API throws; the agent-facing forge catches them and renders readable
 * failure strings the model can act on.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the TOON peer dependency cannot be loaded.
 *
 * @remarks
 * The @toon-format/toon package is an optional peer. If it is not installed, methods requiring
 * it throw this exception with installation instructions. The message template includes the package
 * name, a description of its purpose, the underlying error, and the exact install command, so the
 * consumer sees a complete, actionable message regardless of call site.
 */
export const E_TOON_PEER_MISSING = createException<[string]>(
  'E_TOON_PEER_MISSING',
  'the toon battery could not load its peer dependency "@toon-format/toon" (needed for TOON format artifact queries): %s — install it (pnpm add @toon-format/toon)',
  'E_TOON_PEER_MISSING',
  500
)

/**
 * Thrown when TOON decoding fails.
 *
 * @remarks
 * Wraps the underlying `ToonDecodeError` from the `@toon-format/toon` package, surfacing its
 * `line` and `source` properties so the model can self-correct.
 */
export const E_TOON_DECODE_FAILED = createException<[string]>(
  'E_TOON_DECODE_FAILED',
  'TOON decode error: %s',
  'E_TOON_DECODE_FAILED',
  422
)
