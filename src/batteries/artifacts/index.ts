/**
 * Artifacts battery: structured query tools for multiple document formats.
 *
 * @remarks
 * Exports the four artifact classes ({@link SpooledToonArtifact},
 * {@link SpooledYamlArtifact}, {@link SpooledXmlArtifact}, {@link SpooledEcmaScriptArtifact})
 * and their converters from their respective batteries. Also exports the
 * {@link registerArtifactEncodables} function for encoding support.
 *
 * Note: `decode()` on artifact instances throws until `registerArtifactEncodables()`
 * has been called. `encode()` requires no setup — the classes carry the
 * `Symbol.for('@nhtio/encoder:toEncoded')` method with zero dependency on the encoder.
 *
 * @module @nhtio/adk/batteries/artifacts
 */

export * from './toon'
export * from './yaml'
export * from './xml'
export * from './ecmascript'

/**
 * Registers the four artifact classes with the '@nhtio/encoder' decoder.
 *
 * @remarks
 * This function must be called once before decoding artifact instances that were
 * previously encoded. It is idempotent and safe to call multiple times. Consumers
 * who need both core primitives and artifacts typically call
 * `registerAdkEncodables()` (from the encoding battery) followed by this function.
 *
 * @returns A promise that resolves when registration is complete.
 * @throws If '@nhtio/encoder' is not available or registration fails.
 *
 * @example
 * ```ts
 * import { registerArtifactEncodables } from '@nhtio/adk/batteries/artifacts'
 * await registerArtifactEncodables()
 * ```
 */
export const registerArtifactEncodables = async (): Promise<void> => {
  const { registerClass } = await import('@nhtio/encoder')
  const { SpooledToonArtifact } = await import('./toon')
  const { SpooledYamlArtifact } = await import('./yaml')
  const { SpooledXmlArtifact } = await import('./xml')
  const { SpooledEcmaScriptArtifact } = await import('./ecmascript')

  for (const ctor of [
    SpooledToonArtifact,
    SpooledYamlArtifact,
    SpooledXmlArtifact,
    SpooledEcmaScriptArtifact,
  ]) {
    registerClass(ctor as unknown as Parameters<typeof registerClass>[0])
  }
}
