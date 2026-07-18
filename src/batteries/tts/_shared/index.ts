/**
 * Structural contracts shared across every TTS (text-to-speech) engine — the model-backed
 * transformers.js engine and the OS-native CLI engine both build on these.
 *
 * @module @nhtio/adk/batteries/tts/_shared
 *
 * @remarks
 * This module owns the **shared** TTS option base ({@link BaseTtsAdapterOptions}) and the shared
 * per-call shape ({@link SynthesizeOptions}), plus the audio-result contract
 * ({@link RawAudioLike}). It lives in `_shared` — NOT inside any one engine — deliberately: the
 * native engine is model-less while the transformers.js engine requires a model, so neither engine
 * "owns" the common base. A future non-transformers engine can extend this base without importing a
 * transformer-named subpath.
 *
 * `model` is intentionally **absent** from {@link BaseTtsAdapterOptions}: the OS-native engine
 * synthesizes through `say`/`espeak-ng`/PowerShell and has no model concept, so each model-backed
 * engine adds its own required `model` field rather than the base forcing one. Do not "fix" this by
 * hoisting `model` into the base — it is a deliberate divergence from the embeddings/generation
 * domains (whose bases require `model`).
 */

import type { GeneratedMediaOutput } from '../../llm/chat_common/types'

/**
 * One synthesized clip returned from `synthesize`. Re-exported type-only from the LLM Chat
 * Completions battery's shared types so TTS engines and multimodal LLM batteries describe generated
 * media identically — an `{ kind: 'audio', mimeType, bytes, filename? }` value. See
 * {@link GeneratedMediaOutput}.
 */
export type { GeneratedMediaOutput }

/**
 * The synthesized-audio result every TTS engine resolves to — an alias of the shared
 * {@link GeneratedMediaOutput} descriptor, always `kind: 'audio'` in practice.
 */
export type TtsSynthesisResult = GeneratedMediaOutput

/**
 * Options shared by **every** TTS engine, regardless of backend.
 *
 * @remarks
 * Engine-specific option interfaces extend this with their own transport/engine fields (and, for
 * model-backed engines, a required `model`). Both fields are normalized per-engine:
 *
 * - `voice` → `say -v <voice>` / `espeak-ng -v <voice>` / PowerShell `SelectVoice(<voice>)` /
 *   transformers.js `speaker_embeddings` when it is a string.
 * - `rate` is a **multiplier** where `1` is engine-normal, mapped per engine: `round(175 * rate)`
 *   words-per-minute for `say`/`espeak-ng` (clamped to a validated band), the documented `-10..10`
 *   `SpeechSynthesizer.Rate` for PowerShell, and `speed` for transformers.js.
 */
export interface BaseTtsAdapterOptions {
  /**
   * Default voice, applied when a `synthesize` call omits its own `voice`. Per-engine semantics
   * (see the module remarks). Unset → the engine/model default voice.
   */
  voice?: string
  /**
   * Default speaking-rate multiplier (`1` = engine-normal), applied when a `synthesize` call omits
   * its own `rate`. Per-engine mapping (see the module remarks). Unset → engine-normal rate.
   */
  rate?: number
}

/**
 * Per-call options accepted by every engine's `synthesize`. Engine-specific per-call option
 * interfaces extend this with their own knobs.
 *
 * @remarks
 * Both fields override the constructor-level default of the same name for this one call.
 */
export interface SynthesizeOptions {
  /** Voice for this call; overrides the constructor `voice`. */
  voice?: string
  /** Speaking-rate multiplier for this call; overrides the constructor `rate`. */
  rate?: number
}

/**
 * The minimal structural slice of transformers.js's `RawAudio` the TTS engine consumes: a single
 * `toBlob()` that encodes the synthesized samples to a WAV `Blob`.
 *
 * @remarks
 * transformers.js `RawAudio.toBlob()` calls its internal `encodeWAV()` — a pure
 * `ArrayBuffer`/`DataView`/`Blob` path with `type: 'audio/wav'` — so it works in Node (Node ≥18 has
 * a global `Blob`) as well as the browser; it is NOT the browser-only path that `RawImage.toBlob()`
 * guards. `toBlob()` is the ONLY method the engine needs (it never reads raw `audio`/`sampling_rate`),
 * so this contract carries `toBlob` alone — the fake pipeline in unit tests implements exactly this.
 */
export interface RawAudioLike {
  /** Encode the synthesized audio to a WAV `Blob` (`type: 'audio/wav'`). */
  toBlob(): Blob
}
