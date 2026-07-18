/**
 * Battery-scoped exception constructors for the OS-native TTS adapter.
 *
 * @module @nhtio/adk/batteries/tts/native/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the model-less, shell-out OS-native text-to-speech adapter
 * (macOS `say` / Linux `espeak-ng` / Windows PowerShell `System.Speech`), minted via `createException`
 * from `@nhtio/adk/factories`. Two categories are fatal config/contract bugs (invalid options,
 * unsupported platform — both 529); two are non-fatal runtime failures (engine error 502, timeout
 * 504) so a caller may retry with a different voice/rate or fall back to another TTS engine.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * {@link @nhtio/adk/batteries/tts/native!nativeTtsOptionsSchema} — e.g. an unknown option key, a
 * non-numeric `rate`, or a `platform` outside the supported set. Fatal: config bugs fail loud, not
 * at `synthesize` time. Printf arg: `[detail]`.
 */
export const E_INVALID_NATIVE_TTS_OPTIONS = createException<[string]>(
  'E_INVALID_NATIVE_TTS_OPTIONS',
  'Invalid native TTS adapter options: %s',
  'E_INVALID_NATIVE_TTS_OPTIONS',
  529,
  true
)

/**
 * Thrown when the resolved `platform` is not one of {@link
 * @nhtio/adk/batteries/tts/native!NativeTtsPlatform} (`darwin`/`linux`/`win32`). Fatal: there is no
 * engine binary to shell out to on any other platform, so synthesis cannot proceed. Printf arg:
 * `[platform]`.
 */
export const E_NATIVE_TTS_UNSUPPORTED_PLATFORM = createException<[string]>(
  'E_NATIVE_TTS_UNSUPPORTED_PLATFORM',
  'Native TTS is not supported on platform %s (expected darwin, linux, or win32)',
  'E_NATIVE_TTS_UNSUPPORTED_PLATFORM',
  529,
  true
)

/**
 * Thrown when the OS-native binary invocation fails (non-zero exit / spawn error / empty or missing
 * output file / a result that is not a RIFF/WAVE file). Non-fatal: the engine itself may be
 * transiently unavailable, or a particular voice/rate combination may be rejected by the binary;
 * retry or fall back to another TTS engine. Printf arg: `[detail]` (stderr on failure, otherwise a
 * structural message such as `expected a RIFF/WAVE file`).
 */
export const E_NATIVE_TTS_ENGINE_ERROR = createException<[string]>(
  'E_NATIVE_TTS_ENGINE_ERROR',
  'Native TTS engine error: %s',
  'E_NATIVE_TTS_ENGINE_ERROR',
  502,
  false
)

/**
 * Thrown when the binary invocation is aborted for exceeding
 * {@link @nhtio/adk/batteries/tts/native!NativeTtsAdapterOptions.timeoutMs}. Non-fatal: a slow
 * engine on a long text may simply need more time; the caller may raise `timeoutMs` and retry.
 * Printf arg: `[timeoutMs]`.
 */
export const E_NATIVE_TTS_TIMEOUT = createException<[number]>(
  'E_NATIVE_TTS_TIMEOUT',
  'Native TTS synthesis timed out after %d ms',
  'E_NATIVE_TTS_TIMEOUT',
  504,
  false
)
