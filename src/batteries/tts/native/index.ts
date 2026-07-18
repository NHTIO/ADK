/**
 * OS-native TTS (text-to-speech) battery — shells out to the OS's own speech binary.
 *
 * @module @nhtio/adk/batteries/tts/native
 *
 * @remarks
 * **Node-only.** This subpath barrel imports node builtins (`node:child_process`, `node:fs/promises`,
 * `node:os`, `node:crypto`, `node:path`) — lazily, inside adapter methods — and will NOT load in a
 * browser or Web Worker bundle. Deliberately, unlike the environment-neutral
 * `@nhtio/adk/batteries/tts/transformers_js` barrel (which stays browser-loadable), this engine is
 * model-less and shells out to the platform's own speech binary (`say` / `espeak-ng` / PowerShell
 * `System.Speech`), reading back the WAV it writes. Import this subpath only from node-only entry
 * points (a server process, a build script, a node-targeted worker) — never from code that might
 * also run in a browser.
 *
 * Re-exports the adapter class, the validation schema + bare `validateOptions` wrapper, the pure
 * invocation builders (`buildNativeTtsInvocation` + `psSingleQuotedLiteral`), every option/seam type
 * alias, and the four battery-scoped exceptions.
 */

export { NativeTtsAdapter } from './adapter'

export { nativeTtsOptionsSchema, validateOptions } from './validation'

export { buildNativeTtsInvocation, psSingleQuotedLiteral } from './helpers'

export type {
  NativeTtsAdapterOptions,
  NativeSynthesizeOptions,
  TtsBinaryExecutor,
  TtsBinaryExecutorResult,
  TtsFsLike,
  NativeTtsPlatform,
  BaseTtsAdapterOptions,
  SynthesizeOptions,
  GeneratedMediaOutput,
  TtsSynthesisResult,
} from './types'

export {
  E_INVALID_NATIVE_TTS_OPTIONS,
  E_NATIVE_TTS_UNSUPPORTED_PLATFORM,
  E_NATIVE_TTS_ENGINE_ERROR,
  E_NATIVE_TTS_TIMEOUT,
} from './exceptions'
