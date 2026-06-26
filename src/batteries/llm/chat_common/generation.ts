/**
 * The portable, battery-agnostic GENERATION contract shared by the on-device LLM batteries.
 *
 * @remarks
 * INTERNAL to the bundled LLM batteries — intentionally NOT `@module`-tagged, so it stays private and
 * is inlined into each consumer by the bundler (the same convention as `chat_common/helpers.ts`).
 *
 * **Why this exists.** transformers.js and LiteRT-LM express the same generation concepts with different
 * option names and shapes — `maxNewTokens` vs `maxOutputTokens`, a flat `doSample`+`temperature`/`topK`/
 * `topP` vs a nested `samplerParams:{type,k,p,…}`, one `multimodal:{image,audio}` object vs two
 * `visionModalityEnabled`/`audioModalityEnabled` booleans. Swapping batteries therefore meant rewriting
 * the config. This module defines ONE canonical surface ({@link ChatGenerationOptions}) that both
 * batteries accept; each adapter maps it onto its native API via {@link resolveGenerationOptions}.
 *
 * **Contract.** The canonical fields are additive — every native field a battery already exposed
 * remains a working escape hatch. When BOTH a canonical field and its native equivalent are set, the
 * **canonical value wins** (it is the portable intent; the native field is the low-level override that
 * the resolver only consults when the canonical one is absent). All values carry the same
 * deterministic-friendly defaults across batteries (greedy, temp 0.7, top-k 40, top-p 0.95, max 1024).
 */

/**
 * The portable sampler strategy. Maps to each battery's native mechanism:
 * - `'greedy'` — deterministic argmax. transformers.js `do_sample:false`; LiteRT `SamplerType.GREEDY`
 *   (which is top-1, so `k` is forced to 1).
 * - `'top-k'` — sample from the top-`k` logits. transformers.js `do_sample:true`+`top_k`; LiteRT
 *   `SamplerType.TOP_K`+`k`.
 * - `'top-p'` — nucleus sampling. transformers.js `do_sample:true`+`top_p`; LiteRT `SamplerType.TOP_P`+`p`.
 */
export type ChatSampler = 'greedy' | 'top-k' | 'top-p'

/** The canonical generation options both on-device batteries accept. Every field optional + defaulted. */
export interface ChatGenerationOptions {
  /**
   * Maximum tokens to GENERATE this turn. The portable spelling of transformers.js `maxNewTokens` /
   * LiteRT `maxOutputTokens`. Default `1024`.
   */
  maxTokens?: number
  /** Sampler strategy (default `'greedy'` — deterministic). See {@link ChatSampler}. */
  sampler?: ChatSampler
  /** Sampling temperature, used when `sampler` is `'top-k'`/`'top-p'`. Always pinned. Default `0.7`. */
  temperature?: number
  /** Top-K cutoff, used when `sampler` is `'top-k'`. Default `40`. */
  topK?: number
  /** Top-P (nucleus) cutoff, used when `sampler` is `'top-p'`. Default `0.95`. */
  topP?: number
  /** RNG seed for reproducible sampling (best-effort; only honoured by batteries that expose it). */
  seed?: number
  /**
   * Whether to enable the model's "thinking"/reasoning mode, passed EXPLICITLY to the chat template.
   * Default `false` — many reasoning templates default thinking ON and burn the budget. Already shared
   * by both batteries under this exact name; restated here so the whole generation contract is in one place.
   */
  enableThinking?: boolean
  /**
   * Enable multimodal input by kind. The portable spelling of transformers.js `multimodal:{image,audio}`
   * / LiteRT `visionModalityEnabled`+`audioModalityEnabled`.
   */
  multimodal?: { image?: boolean; audio?: boolean }
}

/** The resolved, fully-defaulted generation config the adapters consume. */
export interface ResolvedGenerationOptions {
  /** Max tokens to generate this turn. */
  maxTokens: number
  /** The resolved sampler strategy. */
  sampler: ChatSampler
  /** Sampling temperature (used by `'top-k'`/`'top-p'`). */
  temperature: number
  /** Top-K cutoff (used by `'top-k'`). */
  topK: number
  /** Top-P (nucleus) cutoff (used by `'top-p'`). */
  topP: number
  /** RNG seed, when provided. */
  seed?: number
  /** Whether thinking/reasoning mode is enabled. */
  enableThinking: boolean
  /** Resolved multimodal-input flags by kind. */
  multimodal: { image: boolean; audio: boolean }
}

/** Deterministic-friendly defaults, identical across batteries. */
export const GENERATION_DEFAULTS: ResolvedGenerationOptions = {
  maxTokens: 1024,
  sampler: 'greedy',
  temperature: 0.7,
  topK: 40,
  topP: 0.95,
  enableThinking: false,
  multimodal: { image: false, audio: false },
}

/** Pick the first defined value (canonical-wins precedence is encoded by argument order at call sites). */
const firstDefined = <T>(...values: Array<T | undefined>): T | undefined => {
  for (const v of values) if (v !== undefined) return v
  return undefined
}

/**
 * Resolve the canonical {@link ChatGenerationOptions} (already merged across option layers) into a
 * fully-defaulted {@link ResolvedGenerationOptions}. Native per-battery fallbacks are passed via
 * `nativeFallbacks` and consulted ONLY when the canonical field is absent (canonical wins). The adapter
 * then maps the resolved shape onto its runtime API.
 *
 * @param canonical - The canonical fields from the merged adapter options.
 * @param nativeFallbacks - Battery-native equivalents to fall back to when a canonical field is unset
 *   (e.g. transformers.js `maxNewTokens`, LiteRT `maxOutputTokens`). Each is consulted second.
 */
export const resolveGenerationOptions = (
  canonical: ChatGenerationOptions,
  nativeFallbacks: {
    maxTokens?: number
    sampler?: ChatSampler
    temperature?: number
    topK?: number
    topP?: number
    seed?: number
    enableThinking?: boolean
    multimodal?: { image?: boolean; audio?: boolean }
  } = {}
): ResolvedGenerationOptions => {
  const mm = firstDefined(canonical.multimodal, nativeFallbacks.multimodal) ?? {}
  return {
    maxTokens:
      firstDefined(canonical.maxTokens, nativeFallbacks.maxTokens) ?? GENERATION_DEFAULTS.maxTokens,
    sampler:
      firstDefined(canonical.sampler, nativeFallbacks.sampler) ?? GENERATION_DEFAULTS.sampler,
    temperature:
      firstDefined(canonical.temperature, nativeFallbacks.temperature) ??
      GENERATION_DEFAULTS.temperature,
    topK: firstDefined(canonical.topK, nativeFallbacks.topK) ?? GENERATION_DEFAULTS.topK,
    topP: firstDefined(canonical.topP, nativeFallbacks.topP) ?? GENERATION_DEFAULTS.topP,
    seed: firstDefined(canonical.seed, nativeFallbacks.seed),
    enableThinking:
      firstDefined(canonical.enableThinking, nativeFallbacks.enableThinking) ??
      GENERATION_DEFAULTS.enableThinking,
    multimodal: {
      image: mm.image ?? GENERATION_DEFAULTS.multimodal.image,
      audio: mm.audio ?? GENERATION_DEFAULTS.multimodal.audio,
    },
  }
}

/** Default {@link resolveGenerationOptions}. */
export const defaultResolveGenerationOptions = resolveGenerationOptions
