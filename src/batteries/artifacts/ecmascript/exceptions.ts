/**
 * Battery-scoped exceptions for the EcmaScript artifact battery.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/artifacts/ecmascript` entry — re-exported from
 * the battery's own barrel per the battery-scoped-exceptions rule. These are the typed errors the
 * battery throws when loading or configuring its TypeScript compiler peer dependency.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the TypeScript peer dependency fails to load.
 *
 * @remarks
 * The battery requires typescript as an optional peer. This exception surfaces when the
 * dynamic import fails, typically because the package is not installed or cannot be resolved.
 * The message template includes the package name, a description of its purpose, the underlying
 * error, and the exact install command, so the consumer sees a complete, actionable message
 * regardless of call site.
 */
export const E_TYPESCRIPT_PEER_MISSING = createException<[string]>(
  'E_TYPESCRIPT_PEER_MISSING',
  'the ecmascript battery could not load its peer dependency "typescript" (needed for EcmaScript artifact queries): %s — install it (pnpm add typescript)',
  'E_TYPESCRIPT_PEER_MISSING',
  500
)
