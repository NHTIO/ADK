/**
 * Battery-scoped exceptions for the XML artifact battery.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/artifacts/xml` entry — re-exported from the battery's
 * own barrel per the battery-scoped-exceptions rule. These are the typed errors the
 * implementor-facing API throws; the agent-facing forge catches them and renders readable
 * failure strings the model can act on.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the fast-xml-parser optional peer is not installed or fails to load.
 *
 * @remarks
 * The message template includes the package name, a description of its purpose, the underlying
 * error, and the exact install command, so the consumer sees a complete, actionable message
 * regardless of call site.
 */
export const E_XML_PARSER_PEER_MISSING = createException<[string]>(
  'E_XML_PARSER_PEER_MISSING',
  'the XML battery could not load its peer dependency "fast-xml-parser" (needed for XML format artifact queries): %s — install it (pnpm add fast-xml-parser)',
  'E_XML_PARSER_PEER_MISSING',
  500,
  true
)

/**
 * Thrown when XML parsing fails due to malformed markup.
 *
 * @remarks
 * Printf args: `[errorDetail]` — includes the parser's own reason for the failure.
 */
export const E_XML_PARSE_FAILED = createException<[string]>(
  'E_XML_PARSE_FAILED',
  'XML parse failed: %s',
  'E_XML_PARSE_FAILED',
  422,
  false
)
