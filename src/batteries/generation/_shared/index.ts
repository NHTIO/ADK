/**
 * Structural contracts and normalization helpers shared by the media generation batteries
 * (text→image + image editing).
 *
 * @module @nhtio/adk/batteries/generation/_shared
 *
 * @remarks
 * This module imports **nothing** from `@nhtio/adk` core — not even a type-only import — per
 * CONTRIBUTING.md → Design Decisions → #13 "Battery design — no concrete core-class coupling",
 * tier 2 (locally-declared structural duck-types). A generation adapter is *handed* an image to
 * edit at runtime (the source image, an optional mask) but never constructs a `Media` itself, so
 * it has no genuine reason to import the class: {@link GenerationMediaLike} declares the exact
 * shape it reads (`mimeType` + `asBytes()`), and a real core `Media` instance satisfies it
 * automatically, with zero import edge between the generation domain and core.
 *
 * This is the structural twin of `src/batteries/specialists/_shared/index.ts` restricted to the
 * image half (specialists' audio-specific `SpecialistPcmInput` / `DecodeAudioFn` machinery has no
 * counterpart here — generation batteries only ever consume images as input, never audio).
 */

import { isInstanceOf } from '@nhtio/adk/guards'

/**
 * Structural duck-type of core `Media`: the exact shape a generation adapter reads off a media
 * value it was handed as edit input — its declared MIME type, and an async accessor for its raw
 * bytes.
 *
 * @remarks
 * A real `@nhtio/adk` `Media` instance satisfies this interface structurally (it has both a
 * `mimeType` string property and an `asBytes(): Promise<Uint8Array>` method), so callers can pass
 * a `Media` straight through without the generation domain ever importing the class. See the
 * module remarks for why this is a deliberate decoupling choice (CONTRIBUTING.md Design Decision
 * #13, tier 2).
 */
export interface GenerationMediaLike {
  /** The media's declared MIME type, e.g. `'image/png'` or `'image/jpeg'`. */
  mimeType: string
  /** Resolves the media's raw bytes. */
  asBytes(): Promise<Uint8Array>
}

/** Raw bytes plus an optional MIME type — the plain-object form of image input. */
export interface GenerationBytesInput {
  /** The raw encoded image bytes (e.g. a PNG/JPEG/WebP buffer). */
  bytes: Uint8Array
  /** The MIME type of `bytes`, when known. */
  mimeType?: string
}

/**
 * Any of the three forms a generation adapter accepts as image input (for edit calls, and for a
 * future mask parameter): a bare `Uint8Array` (MIME type unknown), a {@link GenerationBytesInput}
 * record (bytes + declared MIME), or a {@link GenerationMediaLike} (a real `Media` or any
 * duck-typed equivalent).
 */
export type GenerationImageInput = Uint8Array | GenerationBytesInput | GenerationMediaLike

/**
 * Normalizes any {@link GenerationImageInput} form to plain bytes plus an optional MIME type.
 *
 * @remarks
 * A bare `Uint8Array` passes through with `mimeType: undefined` (the caller declared no MIME). A
 * {@link GenerationBytesInput} passes its `bytes`/`mimeType` through unchanged. A
 * {@link GenerationMediaLike} is resolved by awaiting `asBytes()` and reading `mimeType` off it.
 *
 * @param input - The image input in any accepted form.
 * @returns The normalized bytes and MIME type (MIME `undefined` only for the bare-`Uint8Array` form).
 */
export const toBytes = async (
  input: GenerationImageInput
): Promise<{ bytes: Uint8Array; mimeType?: string }> => {
  if (isInstanceOf(input, 'Uint8Array', Uint8Array)) return { bytes: input, mimeType: undefined }
  if (typeof (input as GenerationMediaLike).asBytes === 'function') {
    const media = input as GenerationMediaLike
    return { bytes: await media.asBytes(), mimeType: media.mimeType }
  }
  const bytesInput = input as GenerationBytesInput
  return { bytes: bytesInput.bytes, mimeType: bytesInput.mimeType }
}
