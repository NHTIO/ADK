import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when YAML parsing fails due to invalid syntax.
 *
 * @remarks
 * The exception message includes the parser's original error reason and line/mark information
 * when available, which enables the model to self-correct malformed YAML.
 */
export const E_YAML_PARSE_ERROR = createException<[string]>(
  'E_YAML_PARSE_ERROR',
  'YAML parse error: %s',
  'E_YAML_PARSE_ERROR',
  422
)

/**
 * Thrown when the js-yaml peer dependency is missing or fails to load.
 *
 * @remarks
 * This occurs when the battery's consumer has not installed the optional js-yaml peer
 * dependency. The message template includes the package name, a description of its purpose,
 * the underlying error, and the exact install command, so the consumer sees a complete,
 * actionable message regardless of call site.
 */
export const E_YAML_PEER_MISSING = createException<[string]>(
  'E_YAML_PEER_MISSING',
  'the yaml battery could not load its peer dependency "js-yaml" (needed for YAML format artifact queries): %s — install it (pnpm add js-yaml)',
  'E_YAML_PEER_MISSING',
  500
)
