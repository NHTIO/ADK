/**
 * `image.*` and `audio.*` step implementations: fused raster transforms via the
 * imageTransform engine, and transcription via the audioDecode + asr engines.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. The split image verbs
 * (`resize`/`format`/`rotate`/`flip`/`strip_metadata`) read pipe-naturally, and the runtime
 * fuses **adjacent** image steps into a single engine invocation so a resize→format→rotate
 * chain costs one decode/encode (frozen design 0.13). Fusion happens here at execution time:
 * each image step folds its args into a shared fused request stored on the execution stash;
 * the LAST image step in a run performs the engine call.
 *
 * Audio transcription composes two engines: `audioDecode` (container → mono PCM) and `asr`
 * (PCM → text/subtitles). A small pure resampler bridges arbitrary sample rates to the
 * 16 kHz mono Float32Array ASR engines expect.
 */

import { argOf } from '../runtime'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
// Accepted-shared-runtime tier (see CONTRIBUTING.md → Design Decisions → #13 Battery design):
// pure, class-free resample primitive shared with the specialists `_shared` battery — no core
// class coupling, so this deep relative reach is accepted as-is, not re-exported through a shim.
import { resampleTo } from '../../../lib/utils/audio'
import { PCM_MIME, pcmToBytes, bytesToPcm } from '../contracts'
import type { MutateRequest } from '../contracts'
import type { StepImpl, StepContext, StepResult } from '../runtime'

// Re-exported for existing importers (`resampleTo` used to be defined locally in this module).
export { resampleTo }

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

// ── image fusion ─────────────────────────────────────────────────────────────

type FusedImageOps = Omit<MutateRequest, 'bytes' | 'mimeType' | 'signal'>

const IMAGE_VERBS = new Set([
  'image.resize',
  'image.format',
  'image.rotate',
  'image.flip',
  'image.strip_metadata',
])

const requireImage = (ctx: StepContext, verb: string): void => {
  if (!ctx.payload.mimeType.toLowerCase().startsWith('image/')) {
    fail(verb, `image operations expect an image; the media is ${ctx.payload.mimeType}`)
  }
}

/** Fold this step's args into the fused request. */
const foldImageStep = (ctx: StepContext, fused: FusedImageOps): FusedImageOps => {
  const args = ctx.step.args
  switch (ctx.step.verb) {
    case 'image.resize':
      return {
        ...fused,
        resize: {
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          fit: args.fit as FusedImageOps['resize'] extends undefined
            ? never
            : NonNullable<FusedImageOps['resize']>['fit'],
        },
      }
    case 'image.format':
      return {
        ...fused,
        format: { to: args.to as string, quality: args.quality as number | undefined },
        ...(args.strip_metadata !== undefined
          ? { stripMetadata: args.strip_metadata as boolean }
          : {}),
      }
    case 'image.rotate': {
      const deg = Number(args.deg) as 90 | 180 | 270
      const total = (((fused.rotate ?? 0) + deg) % 360) as 0 | 90 | 180 | 270
      return { ...fused, rotate: total === 0 ? undefined : total }
    }
    case 'image.flip': {
      const axis = args.axis as 'horizontal' | 'vertical' | 'both'
      const flip = { ...(fused.flip ?? {}) }
      if (axis === 'horizontal' || axis === 'both') flip.horizontal = !flip.horizontal
      if (axis === 'vertical' || axis === 'both') flip.vertical = !flip.vertical
      return { ...fused, flip }
    }
    case 'image.strip_metadata':
      return { ...fused, stripMetadata: true }
    default:
      return fused
  }
}

/** `true` when the NEXT step in the plan is also an image verb (so we defer the engine call). */
const nextIsImageStep = (ctx: StepContext): boolean => {
  const next = ctx.plan.steps[ctx.stepIndex + 1]
  return next !== undefined && IMAGE_VERBS.has(next.verb)
}

const FUSION_KEY = 'media.image.fused'

const imageStep: StepImpl = async (ctx) => {
  const verb = ctx.step.verb.replace(/\./g, ' ')
  requireImage(ctx, verb)
  const prior = (ctx.stash.get(FUSION_KEY) as FusedImageOps | undefined) ?? {}
  const fused = foldImageStep(ctx, prior)
  if (nextIsImageStep(ctx)) {
    // Defer: pass the payload through untouched; the last image step executes the engine.
    ctx.stash.set(FUSION_KEY, fused)
    return { kind: 'media', payload: ctx.payload }
  }
  ctx.stash.delete(FUSION_KEY)
  if (!ctx.engines.hasMutate()) {
    fail(
      verb,
      'no image-mutating engine is configured. Do not retry image verbs in this deployment.'
    )
  }
  const result = await ctx.engines.mutate({
    ...fused,
    bytes: ctx.payload.bytes,
    mimeType: ctx.payload.mimeType,
    signal: ctx.signal,
  })
  const ext = result.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'
  const dot = ctx.payload.filename.lastIndexOf('.')
  const base = dot > 0 ? ctx.payload.filename.slice(0, dot) : ctx.payload.filename
  return {
    kind: 'media',
    payload: { bytes: result.bytes, mimeType: result.mimeType, filename: `${base}.${ext}` },
  }
}

// ── audio ────────────────────────────────────────────────────────────────────

const ASR_SAMPLE_RATE = 16_000

/**
 * `audio.transcribe` — an explicit two-stage composition: convert the container to PCM,
 * resample to 16 kHz mono, then convert the PCM to the requested text form. The registry
 * never auto-chains through PCM (it is a terminal token), precisely because this resample
 * leg must happen between the two converts.
 */
const audioTranscribeStep: StepImpl = async (ctx): Promise<StepResult> => {
  const verb = 'audio transcribe'
  if (!ctx.payload.mimeType.toLowerCase().startsWith('audio/')) {
    fail(verb, `transcription expects audio; the media is ${ctx.payload.mimeType}`)
  }
  const out = (argOf<string>(ctx.step, 'out') ?? 'txt') as 'txt' | 'srt' | 'vtt' | 'json'
  if (!ctx.engines.hasConvert(ctx.payload.mimeType, 'pcm')) {
    fail(
      verb,
      `no engine that decodes ${ctx.payload.mimeType} to PCM is configured. Do not retry this verb in this deployment.`
    )
  }
  if (!ctx.engines.hasConvert(PCM_MIME, out)) {
    fail(
      verb,
      `no engine that transcribes PCM to "${out}" is configured. Do not retry this verb in this deployment.`
    )
  }
  const decoded = await ctx.engines.convert({
    bytes: ctx.payload.bytes,
    mimeType: ctx.payload.mimeType,
    filename: ctx.payload.filename,
    to: 'pcm',
    signal: ctx.signal,
  })
  const pcmOut = decoded.outputs[0]
  if (!pcmOut) fail(verb, 'audio decoding produced no output')
  const sourceRate = Number(pcmOut!.meta?.sampleRate)
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
    fail(verb, 'the decode engine did not report meta.sampleRate on its PCM output')
  }
  const pcm = resampleTo(bytesToPcm(pcmOut!.bytes), sourceRate, ASR_SAMPLE_RATE)
  const result = await ctx.engines.convert({
    bytes: pcmToBytes(pcm),
    mimeType: PCM_MIME,
    filename: ctx.payload.filename,
    to: out,
    options: {
      lang: argOf<string>(ctx.step, 'lang'),
      translate: argOf<boolean>(ctx.step, 'translate'),
    },
    signal: ctx.signal,
  })
  const final = result.outputs[0]
  if (!final) fail(verb, 'transcription produced no output')
  const text = new TextDecoder().decode(final!.bytes)
  return { kind: 'data', data: text, asText: text }
}

/** The image + audio step registry fragment. */
export const IMAGE_AUDIO_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['image.resize', imageStep],
  ['image.format', imageStep],
  ['image.rotate', imageStep],
  ['image.flip', imageStep],
  ['image.strip_metadata', imageStep],
  ['audio.transcribe', audioTranscribeStep],
]
