import { validator } from '@nhtio/validation'
import { passesSchema } from '../utils/validation'
import type { SpooledArtifact } from '../classes/spooled_artifact'

/**
 * Constructor signature for any {@link @nhtio/adk!SpooledArtifact} (the class itself or a subclass).
 *
 * @remarks
 * Re-declared here at the contract level so consumers — and the `Tool.artifactConstructor`
 * resolver validator in particular — can talk about the constructor shape without value-importing
 * the {@link @nhtio/adk!SpooledArtifact} class (which would close the `tool.ts` ↔ `spooled_artifact.ts` ↔
 * `artifact_tool.ts` module cycle at load time and TDZ-crash `ArtifactTool extends Tool`).
 *
 * @typeParam A - The {@link @nhtio/adk!SpooledArtifact} subtype the constructor produces.
 */
export type SpooledArtifactConstructorLike<A extends SpooledArtifact = SpooledArtifact> = new (
  ...args: any[]
) => A

const ARTIFACT_METHODS = [
  'head',
  'tail',
  'grep',
  'cat',
  'byteLength',
  'lineCount',
  'estimateTokens',
] as const

/**
 * Validator schema used to validate a {@link SpooledArtifactConstructorLike} value.
 *
 * @remarks
 * Because the validator is invoked at validate-time (not at module-load), it is safe to inspect
 * the constructor's prototype here. The check is duck-typed: the value must be a function whose
 * `prototype` carries every canonical artifact instance method (`head`, `tail`, `grep`, `cat`,
 * `byteLength`, `lineCount`, `estimateTokens`). This mirrors {@link spoolReaderSchema}'s
 * cross-realm-safe duck-type pattern — `instanceof SpooledArtifact` would be tighter but would
 * force a value-import of the class and reopen the module cycle.
 */
export const spooledArtifactConstructorSchema = validator
  .any()
  .required()
  .custom((value, helpers) => {
    if (typeof value !== 'function') return helpers.error('any.invalid')
    const proto = (value as { prototype?: unknown }).prototype
    if (proto === undefined || proto === null) return helpers.error('any.invalid')
    if (
      ARTIFACT_METHODS.every((m) => typeof (proto as Record<string, unknown>)[m] === 'function')
    ) {
      return value
    }
    return helpers.error('any.invalid')
  })

/**
 * Returns `true` if `value` is a constructor whose prototype carries every canonical
 * {@link @nhtio/adk!SpooledArtifact} instance method.
 *
 * @remarks
 * Duck-typed; does not use `instanceof SpooledArtifact`. Used by the `Tool.artifactConstructor`
 * resolver validator and any other site that needs to recognise a `SpooledArtifact`-like
 * constructor without pulling the class into its module-load graph.
 *
 * @param value - The value to test.
 * @returns `true` when `value` is a `SpooledArtifact`-shaped constructor.
 */
export const implementsSpooledArtifactConstructor = (
  value: unknown
): value is SpooledArtifactConstructorLike => {
  return passesSchema(spooledArtifactConstructorSchema, value)
}

/**
 * Creates the validator fragment for a resolver returning a spooled-artifact constructor.
 *
 * The resolver is invoked during validation, then its result is checked with the canonical
 * cross-realm-safe constructor guard. Keeping this fragment here makes `Tool` and `Retrievable`
 * share exactly the same validation behaviour.
 */
export const artifactConstructorResolverSchema = () =>
  // eslint-disable-next-line adk/require-validator-any-required -- disposition is set by the caller's .optional()/.required() appended to this returned schema
  validator.any().custom((value, helpers) => {
    if (typeof value !== 'function') return helpers.error('any.invalid')
    let resolved: unknown
    try {
      resolved = (value as () => unknown)()
    } catch {
      return helpers.error('any.invalid')
    }
    return implementsSpooledArtifactConstructor(resolved) ? value : helpers.error('any.invalid')
  })
