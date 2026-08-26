/**
 * Translation helpers for the transformers.js LLM adapter.
 *
 * @module @nhtio/adk/batteries/llm/transformers_js/helpers
 *
 * @remarks
 * Two layers, like the other LLM batteries:
 * 1. **Re-exported format-agnostic helpers** from `chat_common` (string/trust-envelope renderers,
 *    the joi→JSON-Schema converter, thought rendering/filtering) — reused verbatim.
 * 2. **transformers.js-native mappers** defined here — building the `{role,content}[]` message array
 *    + the `tools` definitions, and a stream accumulator that collects decoded text (parsing of tool
 *    calls / reasoning happens once after the stream drains, via the shared parser layer).
 */

import { Media } from '@nhtio/adk'
import { isError } from '@nhtio/adk/guards'
import { SpooledArtifact } from '@nhtio/adk'
import { E_UNSUPPORTED_MEDIA_MODALITY } from './exceptions'
import {
  neutraliseDeveloperRulesTag,
  sanitizeMimeType,
  sanitizeFilenameForDescription,
  defaultRenderArtifactHandleBody,
} from '../chat_common/helpers'
import {
  descriptionToChatCompletionsJsonSchema,
  renderUntrustedContent as commonRenderUntrustedContent,
  renderTrustedContent as commonRenderTrustedContent,
  renderChatCompletionsSystemPrompt,
  renderStandingInstructions,
  renderMemories,
  renderRetrievables,
  renderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  renderRetrievableHandleBody,
  renderThought,
  filterThoughts,
} from '../openai_chat_completions/helpers'
import type { Tokenizable } from '@nhtio/adk'
import type { ArtifactTool, Tool } from '@nhtio/adk'
import type { ChatCompletionsTool } from '../openai_chat_completions/types'
import type { Message, Memory, Retrievable, Thought, ToolCall, ToolRegistry } from '@nhtio/adk'
import type {
  TransformersJsMessage,
  TransformersJsBucketOrder,
  UnsupportedMediaPolicy,
  DescriptionLike,
  JsonSchema,
} from './types'

// ── Re-export the entire format-agnostic layer (reused verbatim) ──────────────────────────────────

export {
  descriptionToChatCompletionsJsonSchema,
  defaultDescriptionToChatCompletionsJsonSchema,
  renderUntrustedContent,
  defaultRenderUntrustedContent,
  renderTrustedContent,
  defaultRenderTrustedContent,
  renderStandingInstructions,
  defaultRenderStandingInstructions,
  renderMemories,
  defaultRenderMemories,
  renderRetrievables,
  defaultRenderRetrievables,
  renderRetrievableHandleBody,
  defaultRenderRetrievableHandleBody,
  renderRetrievableSafetyDirective,
  defaultRenderRetrievableSafetyDirective,
  renderFirstPartyRetrievables,
  defaultRenderFirstPartyRetrievables,
  renderThirdPartyPublicRetrievables,
  defaultRenderThirdPartyPublicRetrievables,
  renderThirdPartyPrivateRetrievables,
  defaultRenderThirdPartyPrivateRetrievables,
  renderThought,
  defaultRenderThought,
  filterThoughts,
  defaultFilterThoughts,
  renderChatCompletionsSystemPrompt,
  defaultRenderChatCompletionsSystemPrompt,
  extractReasoningFields,
} from '../openai_chat_completions/helpers'

// The shared SpooledArtifact handle-pattern machinery + its structural guard, surfaced on the barrel
// so consumers can override/compose it like any other render helper.
export {
  renderArtifactHandleBody,
  defaultRenderArtifactHandleBody,
  looksLikeSpooledArtifact,
} from '../chat_common/helpers'

// Re-export the shared parser layer so consumers import everything from this battery's barrel.
export * from '../chat_common/tool_parsers'
export * from '../chat_common/reasoning_parsers'
// Re-export the shared lifecycle/boot-progress contract (emitLifecycle + types).
export * from '../chat_common/lifecycle'
// Re-export the shared portable generation contract (ChatGenerationOptions + resolveGenerationOptions).
export * from '../chat_common/generation'
// Re-export the shared WebGPU memory observability surface (budget probe, OOM detector, live instrument).
export * from '../chat_common/gpu_budget'

// ── transformers.js-native mappers ────────────────────────────────────────────────────────────────

/** A tool definition in the transformers.js `tools` array (OpenAI-function-shaped). */
export interface TransformersJsTool {
  /** Always `'function'` — the only tool type transformers.js chat templates understand. */
  type: 'function'
  /** The function descriptor: name, optional description, and JSON-Schema parameters. */
  function: {
    name: string
    description?: string
    parameters?: JsonSchema
  }
}

/**
 * Convert ADK {@link @nhtio/adk!Tool} / {@link @nhtio/adk!ArtifactTool} instances into the
 * transformers.js `tools` array shape (OpenAI-function-shaped — what `apply_chat_template` expects).
 */
export const toolsToTransformersJsTools = (
  tools: ReadonlyArray<Tool | ArtifactTool>,
  deps: { descriptionToChatCompletionsJsonSchema: (d: DescriptionLike) => JsonSchema } = {
    descriptionToChatCompletionsJsonSchema,
  }
): TransformersJsTool[] => {
  const out: TransformersJsTool[] = []
  for (const tool of tools) {
    const described = tool.describe()
    const parameters = deps.descriptionToChatCompletionsJsonSchema(
      described.inputSchema as unknown as DescriptionLike
    )
    out.push({
      type: 'function',
      function: {
        name: described.name,
        description: described.description,
        parameters:
          parameters && Object.keys(parameters).length > 0
            ? parameters
            : { type: 'object', properties: {} },
      },
    })
  }
  return out
}

/** Default {@link toolsToTransformersJsTools}. */
export const defaultToolsToTransformersJsTools = toolsToTransformersJsTools

/** Resolve a media instance to fallback text per policy ('throw' raises; others degrade). */
const resolveMediaFallbackText = async (
  media: Media,
  policy: UnsupportedMediaPolicy,
  warn?: (msg: string) => void
): Promise<string> => {
  if (policy === 'throw') {
    throw new E_UNSUPPORTED_MEDIA_MODALITY([media.kind, media.mimeType, media.filename])
  }
  const syntheticDescription = `[media: ${sanitizeFilenameForDescription(media.filename)}, kind=${media.kind}, mime=${sanitizeMimeType(media.mimeType, media.kind === 'image' || media.kind === 'audio' ? media.kind : undefined)}]`
  if (
    policy === 'fallback-stash' ||
    (typeof policy === 'object' && policy.mode === 'fallback-stash')
  ) {
    const stashKeys =
      typeof policy === 'object'
        ? policy.stashKeys
        : ['text:transcript', 'text:caption', 'text:description']
    for (const key of stashKeys) {
      const entry = media.stash.get<{ value?: unknown } | undefined>(key)
      const value = entry && typeof entry === 'object' ? entry.value : undefined
      if (typeof value === 'string' && value.length > 0) return value
    }
    warn?.(
      `unsupportedMediaPolicy='fallback-stash' for ${media.filename} (${media.kind}): no matching stash entry — falling through to synthetic description.`
    )
    return syntheticDescription
  }
  return syntheticDescription
}

/**
 * Render a {@link @nhtio/adk!ToolCall}'s `results` into a plain-text tool message body.
 *
 * @remarks
 * transformers.js chat templates take a `tool`-role message whose `content` is a string. A
 * `SpooledArtifact` result renders as a HANDLE (metadata + the forged `artifact_*` tools to read it)
 * when its `ToolCall.inline === false` — the secure default — and inline via `asString()` only when a
 * producer opted into `inline: true`. Applies the trust envelope and degrades Media to text.
 */
export const renderTransformersJsToolResult = async (input: {
  toolCall: ToolCall
  results: Tokenizable | SpooledArtifact | SpooledArtifact[] | Media | Media[]
  tool: Tool | ArtifactTool | undefined
  unsupportedMediaPolicy: UnsupportedMediaPolicy
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  /**
   * Override for the artifact-handle body renderer (see {@link renderArtifactHandleBody}). Defaults to
   * the shared {@link defaultRenderArtifactHandleBody}. The adapter threads the consumer's
   * `helpers.renderArtifactHandleBody` here so an app can change which forged `artifact_*` reader the
   * model is steered toward first.
   */
  renderArtifactHandleBody?: typeof defaultRenderArtifactHandleBody
  warn?: (msg: string) => void
}): Promise<string> => {
  const { results, toolCall, tool } = input
  const isTrusted = tool?.trusted === true
  const renderHandle = input.renderArtifactHandleBody ?? defaultRenderArtifactHandleBody

  let body: string
  // Whether `body` is a non-inlined artifact HANDLE (vs. inlined content). Only the `kind` label on
  // the envelope changes — the trust TIER stays the producing tool's, since a handle to a third-party
  // artifact carries the same injection hazard as its inlined content would.
  let isHandle = false
  if (
    Media.isMedia(results) ||
    (Array.isArray(results) && results.every((r) => Media.isMedia(r)))
  ) {
    const mediaList = Media.isMedia(results) ? [results] : (results as Media[])
    const parts: string[] = []
    for (const m of mediaList)
      parts.push(await resolveMediaFallbackText(m, input.unsupportedMediaPolicy, input.warn))
    body = parts.join('\n\n')
  } else if (
    !Array.isArray(results) &&
    SpooledArtifact.isSpooledArtifact(results) &&
    toolCall.inline === false
  ) {
    // Handle pattern: producer marked this result non-inline → emit a directions-bearing handle
    // (metadata + the forged artifact_* tools to read it) instead of dumping the body. This is the
    // machinery that makes the spool/thrift pattern usable. Parity with OpenAI + Ollama.
    let byteLength = 0
    let lineCount = 0
    try {
      byteLength = await results.byteLength()
    } catch {
      /* best-effort metadata */
    }
    try {
      lineCount = await results.lineCount()
    } catch {
      /* best-effort metadata */
    }
    body = renderHandle({
      callId: toolCall.id,
      artifact: results,
      byteLength,
      lineCount,
    })
    isHandle = true
  } else if (Array.isArray(results)) {
    const parts: string[] = []
    for (const a of results) parts.push(await (a as SpooledArtifact).asString())
    body = parts.join('\n\n')
  } else if (SpooledArtifact.isSpooledArtifact(results)) {
    body = await results.asString()
  } else {
    body = (results as Tokenizable).toString()
  }

  return isTrusted
    ? input.renderTrustedContent(body, {
        nonce: toolCall.checksum,
        kind: isHandle ? 'trusted-artifact-handle' : 'trusted-tool-result',
        tool: toolCall.tool,
      } as never)
    : input.renderUntrustedContent(body, {
        nonce: toolCall.checksum,
        kind: isHandle ? 'artifact-handle' : 'tool-result',
        tool: toolCall.tool,
      } as never)
}

/** Default {@link renderTransformersJsToolResult}. */
export const defaultRenderTransformersJsToolResult = renderTransformersJsToolResult

/**
 * Build the transformers.js `messages` array + `tools` from the ADK dispatch context buckets.
 *
 * @remarks
 * Leading buckets (system prompt + standing instructions / memories / retrievables) render into a
 * single `system` message; the timeline (messages, surviving thoughts, tool calls — chronological)
 * renders into `user`/`assistant`/`tool` messages. Tools are returned separately for the `tools`
 * generate-kwarg. Mirrors `buildLiteRtConversationInput`.
 */
export const buildTransformersJsMessages = async (input: {
  systemPrompt: Tokenizable
  standingInstructions: Iterable<Tokenizable>
  memories: Iterable<Memory>
  retrievables: Iterable<Retrievable>
  messages: Iterable<Message>
  thoughts: Iterable<Thought>
  toolCalls: Iterable<ToolCall>
  tools: ToolRegistry
  renderedToolCallResults: Map<string, string>
  bucketOrder: TransformersJsBucketOrder
  selfIdentity: string
  thoughtSurfacing: 'all-self' | 'latest-self' | 'all'
  replayCompatibility: ReadonlyArray<string>
  toolsToTransformersJsTools: typeof toolsToTransformersJsTools
  renderThought: typeof renderThought
  filterThoughts: typeof filterThoughts
  renderUntrustedContent: typeof commonRenderUntrustedContent
  renderTrustedContent: typeof commonRenderTrustedContent
  renderChatCompletionsSystemPrompt: typeof renderChatCompletionsSystemPrompt
  renderStandingInstructions: typeof renderStandingInstructions
  renderMemories: typeof renderMemories
  renderRetrievables: typeof renderRetrievables
  renderRetrievableSafetyDirective: typeof renderRetrievableSafetyDirective
  renderFirstPartyRetrievables: typeof renderFirstPartyRetrievables
  renderThirdPartyPublicRetrievables: typeof renderThirdPartyPublicRetrievables
  renderThirdPartyPrivateRetrievables: typeof renderThirdPartyPrivateRetrievables
  renderRetrievableHandleBody?: typeof renderRetrievableHandleBody
  /**
   * Multimodal config. Absent/false → text-only (every message renders a plain string `content`, the
   * byte-for-byte original behavior). When set, a message carrying `attachments` of an enabled kind
   * renders a content-array (text + `{type:'image'|'audio'}` placeholders) and the decoded media is
   * collected into `images`/`audio` (consumed positionally by `processor(prompt, images, audio)`).
   */
  multimodal?: { image: boolean; audio: boolean }
  /** Decodes a Media instance to a transformers.js input (RawImage / audio samples). Adapter-injected. */
  decodeMedia?: (media: Media) => Promise<{ kind: 'image' | 'audio'; data: unknown }>
  unsupportedMediaPolicy?: UnsupportedMediaPolicy
  warn?: (msg: string) => void
}): Promise<{
  messages: TransformersJsMessage[]
  tools: TransformersJsTool[]
  images: unknown[]
  audio: unknown[]
}> => {
  const systemText = await input.renderChatCompletionsSystemPrompt({
    systemPrompt: input.systemPrompt,
    standingInstructions: input.standingInstructions,
    memories: input.memories,
    retrievables: input.retrievables,
    bucketOrder: input.bucketOrder,
    renderStandingInstructions: input.renderStandingInstructions,
    renderMemories: input.renderMemories,
    renderRetrievables: input.renderRetrievables,
    renderRetrievableSafetyDirective: input.renderRetrievableSafetyDirective,
    renderFirstPartyRetrievables: input.renderFirstPartyRetrievables,
    renderThirdPartyPublicRetrievables: input.renderThirdPartyPublicRetrievables,
    renderThirdPartyPrivateRetrievables: input.renderThirdPartyPrivateRetrievables,
    renderRetrievableHandleBody: input.renderRetrievableHandleBody,
    renderUntrustedContent: input.renderUntrustedContent,
  })

  const messages: TransformersJsMessage[] = []
  const images: unknown[] = []
  const audio: unknown[] = []
  const mm = input.multimodal
  if (typeof systemText === 'string' && systemText.length > 0) {
    messages.push({ role: 'system', content: systemText } as TransformersJsMessage)
  }

  const survivingThoughts = input.filterThoughts(
    input.thoughts,
    input.thoughtSurfacing,
    input.selfIdentity,
    input.replayCompatibility
  )
  type Item =
    | { kind: 'message'; at: number; value: Message }
    | { kind: 'thought'; at: number; value: Thought }
    | { kind: 'toolCall'; at: number; value: ToolCall }
  const items: Item[] = []
  for (const m of input.messages)
    items.push({ kind: 'message', at: m.createdAt.toMillis(), value: m })
  for (const t of survivingThoughts)
    items.push({ kind: 'thought', at: t.createdAt.toMillis(), value: t })
  for (const tc of input.toolCalls)
    items.push({ kind: 'toolCall', at: tc.createdAt.toMillis(), value: tc })
  items.sort((a, b) => a.at - b.at)

  for (const item of items) {
    if (item.kind === 'message') {
      const m = item.value
      const role = m.role === 'user' ? 'user' : 'assistant'
      // Neutralise a body-embedded no-nonce developer-rules tier (envelope-mimicry defense).
      const text = neutraliseDeveloperRulesTag(m.content !== undefined ? m.content.toString() : '')
      const attachments = m.attachments ?? []
      // Multimodal branch: only when enabled, the message has attachments, and we can decode them.
      if (mm && attachments.length > 0 && input.decodeMedia) {
        const parts: Array<{ type: string; text?: string }> = []
        if (text.length > 0) parts.push({ type: 'text', text })
        for (const media of attachments) {
          const enabled =
            (media.kind === 'image' && mm.image) || (media.kind === 'audio' && mm.audio)
          let decoded: { kind: 'image' | 'audio'; data: unknown } | undefined
          if (enabled) {
            // A malformed payload (zero-byte, truncated, polyglot, resolution bomb) must not throw out
            // of the turn — a decode failure becomes a policy decision, not a turn-killer. On throw we
            // fall through to the SAME unsupported-media policy path as a disabled modality.
            try {
              decoded = await input.decodeMedia(media)
            } catch (err) {
              input.warn?.(
                `decodeMedia failed for ${media.filename} (${media.kind}/${media.mimeType}): ${
                  isError(err) ? err.message : String(err)
                } — degrading via unsupportedMediaPolicy.`
              )
            }
          }
          if (decoded) {
            if (decoded.kind === 'image') {
              images.push(decoded.data)
              parts.push({ type: 'image' })
            } else {
              audio.push(decoded.data)
              parts.push({ type: 'audio' })
            }
          } else {
            // Disabled modality / video / document / decode-failure → degrade to text via the shared
            // policy ('throw' still raises here — an undecodable attachment under 'throw' is fatal by
            // design; 'synthetic-description'/'fallback-stash' degrade gracefully).
            const fallback = await resolveMediaFallbackText(
              media,
              input.unsupportedMediaPolicy ?? 'throw',
              input.warn
            )
            parts.push({ type: 'text', text: fallback })
          }
        }
        messages.push({ role, content: parts } as unknown as TransformersJsMessage)
      } else {
        messages.push({ role, content: text } as TransformersJsMessage)
      }
    } else if (item.kind === 'thought') {
      const t = item.value
      const envelope = input.renderThought(t.content.toString(), {
        nonce: t.id,
        kind: 'self-reasoning',
        from: t.identity?.identifier ?? input.selfIdentity,
      } as never)
      messages.push({ role: 'assistant', content: envelope } as TransformersJsMessage)
    } else {
      const tc = item.value
      const rendered = input.renderedToolCallResults.get(tc.id)
      messages.push({ role: 'tool', content: rendered ?? '' } as TransformersJsMessage)
    }
  }

  const tools = input.toolsToTransformersJsTools(input.tools.visible())
  return { messages, tools, images, audio }
}

/** Default {@link buildTransformersJsMessages}. */
export const defaultBuildTransformersJsMessages = buildTransformersJsMessages

/**
 * Decode an ADK {@link @nhtio/adk!Media} into a transformers.js multimodal input.
 *
 * @remarks
 * Image → `RawImage.fromBlob(...)`; audio → `Float32Array` PCM at the model's sample rate (16 kHz
 * default) via `read_audio` over a `data:` URL. Imports `@huggingface/transformers` lazily, so it's
 * only loaded on the multimodal path. (Verified against a real Gemma-4 run — see plan 0a.)
 */
export const mediaToTransformersInput = async (
  media: Media,
  opts?: { audioSampleRate?: number }
): Promise<{ kind: 'image' | 'audio'; data: unknown }> => {
  const bytes = await media.asBytes()
  if (media.kind === 'image') {
    // Sanitise the mime before it becomes a Blob type (a `;base64,`/`\r\n`-laden mime is an injection
    // vector if reflected; an invalid type degrades to the generic safe subtype).
    const tf = await import('@huggingface/transformers')
    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
      type: sanitizeMimeType(media.mimeType, 'image'),
    })
    const image = await tf.RawImage.fromBlob(blob)
    return { kind: 'image', data: image }
  }
  // audio — produce a mono Float32Array at the target rate. transformers.js's `read_audio` decodes via
  // the Web Audio API (`AudioContext`), which exists in browsers but NOT in Node (it throws
  // "AudioContext is not available in your environment" — verified). So for PCM WAV — the canonical
  // 16 kHz speech container these processors expect — we decode the RIFF ourselves: dependency-free,
  // env-neutral (Node + browser), no codec peer, AND no `@huggingface/transformers` import (a heavy ONNX/
  // wasm peer that hangs the vitest browser project on import). The PCM-WAV fast path returns BEFORE any
  // peer load. `read_audio` is the fallback only for compressed containers (mp3/flac/ogg) where a real
  // decoder is genuinely needed (browser only, by that path's nature).
  const targetRate = opts?.audioSampleRate ?? 16000
  const pcm = decodePcmWav(bytes as Uint8Array, targetRate)
  if (pcm) return { kind: 'audio', data: pcm }
  const tf = await import('@huggingface/transformers')
  const b64 = await media.asBase64()
  const samples = await tf.read_audio(
    `data:${sanitizeMimeType(media.mimeType, 'audio')};base64,${b64}`,
    targetRate
  )
  return { kind: 'audio', data: samples }
}

/**
 * Decode a PCM/IEEE-float RIFF/WAVE buffer to a mono {@link Float32Array} at `targetRate`, with **no**
 * `AudioContext` and no codec peer — so it runs in Node and the browser alike. Returns `undefined` for
 * anything that isn't a parseable uncompressed WAV (compressed containers fall back to `read_audio`).
 *
 * @remarks
 * Walks RIFF chunks to find `fmt ` + `data` (so a `LIST`/`fact`/`cue ` chunk before `data` is skipped),
 * supports 8/16/24/32-bit integer PCM (format 1) and 32/64-bit IEEE float (format 3 / 0xFFFE extensible),
 * downmixes to mono by averaging channels, then resamples to `targetRate` with linear interpolation. The
 * sample-rate match is the common path (the fixture + most speech models are 16 kHz mono) so resampling
 * is usually a no-op.
 */
const decodePcmWav = (bytes: Uint8Array, targetRate: number): Float32Array | undefined => {
  if (bytes.length < 44) return undefined
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (off: number): string =>
    String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bits = 0
  let dataOff = -1
  let dataLen = 0
  let p = 12
  while (p + 8 <= bytes.length) {
    const id = tag(p)
    const size = dv.getUint32(p + 4, true)
    const body = p + 8
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = dv.getUint16(body, true)
      channels = dv.getUint16(body + 2, true)
      sampleRate = dv.getUint32(body + 4, true)
      bits = dv.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real format is the first 2 bytes of the subformat GUID.
      if (format === 0xfffe && size >= 24 && body + 26 <= bytes.length) {
        format = dv.getUint16(body + 24, true)
      }
    } else if (id === 'data') {
      dataOff = body
      dataLen = Math.min(size, bytes.length - body)
      break
    }
    p = body + size + (size & 1) // chunks are word-aligned
  }
  if (dataOff < 0 || channels < 1 || sampleRate < 1) return undefined
  const isFloat = format === 3
  const isInt = format === 1
  if (!isFloat && !isInt) return undefined
  const bytesPerSample = bits >> 3
  if (bytesPerSample < 1) return undefined
  const frames = Math.floor(dataLen / (bytesPerSample * channels))
  if (frames < 1) return undefined
  const readSample = (off: number): number => {
    if (isFloat) return bits === 64 ? dv.getFloat64(off, true) : dv.getFloat32(off, true)
    if (bits === 8) return (dv.getUint8(off) - 128) / 128 // 8-bit PCM is unsigned
    if (bits === 16) return dv.getInt16(off, true) / 32768
    if (bits === 24) {
      const v = dv.getUint8(off) | (dv.getUint8(off + 1) << 8) | (dv.getUint8(off + 2) << 16)
      return (v & 0x800000 ? v - 0x1000000 : v) / 8388608
    }
    if (bits === 32) return dv.getInt32(off, true) / 2147483648
    return 0
  }
  const mono = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const base = dataOff + f * bytesPerSample * channels
    for (let c = 0; c < channels; c++) sum += readSample(base + c * bytesPerSample)
    mono[f] = sum / channels
  }
  if (sampleRate === targetRate) return mono
  // Linear-interpolation resample to the model's expected rate.
  const outLen = Math.max(1, Math.round((frames * targetRate) / sampleRate))
  const out = new Float32Array(outLen)
  const ratio = (frames - 1) / Math.max(1, outLen - 1)
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(frames - 1, i0 + 1)
    out[i] = mono[i0] + (mono[i1] - mono[i0]) * (x - i0)
  }
  return out
}

/** Default {@link mediaToTransformersInput}. */
export const defaultMediaToTransformersInput = mediaToTransformersInput

/**
 * A streaming accumulator over transformers.js `TextStreamer` decoded-text deltas.
 *
 * @remarks
 * transformers.js streams **decoded text** (via the `TextStreamer` callback), not structured events.
 * This accumulator just concatenates the deltas; tool-call and reasoning extraction run **once after
 * the stream drains**, over `content()`, via the shared parser layer.
 */
export interface TransformersJsStreamAccumulator {
  /** Feed one decoded-text delta; returns it (for live prose reporting). */
  feed(delta: string): string
  /** The full accumulated text. */
  content(): string
}

/** Create a {@link TransformersJsStreamAccumulator}. */
export const createTransformersJsStreamAccumulator = (): TransformersJsStreamAccumulator => {
  let buf = ''
  return {
    feed(delta) {
      if (typeof delta !== 'string' || delta.length === 0) return ''
      buf += delta
      return delta
    },
    content: () => buf,
  }
}

/** Default {@link createTransformersJsStreamAccumulator}. */
export const defaultCreateTransformersJsStreamAccumulator = createTransformersJsStreamAccumulator

// Re-export the tool definition shape under the chat-completions tool alias for convenience.
export type { ChatCompletionsTool }
