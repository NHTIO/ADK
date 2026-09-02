/**
 * Pure text-shaped step implementations: chunking, plain-text extraction, text diff/patch,
 * and the text-mode redact/update_text paths.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. The split functions are ported
 * verbatim from the source server's `chunk_text` adapter (its green unit suite ports with
 * them). All implementations here operate on in-memory bytes and run in any environment.
 */

import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import { isTextual } from '@nhtio/adk/lib/mime/is_textual'
import { decodeText } from '@nhtio/adk/lib/text/decode_text'
import { familyOf, replaceExtension, MIME } from '../formats'
import {
  isStructuredPatch,
  parseStructuredPatch,
  applyOperations,
  normalizeWorkspacePath,
} from '../../../lib/patch'
import type { RegExpRef, MediaRef, MediaArgScalar } from '../plan'
import type { StepImpl, StepResult, StepPayload } from '../runtime'
import type { ParsedApplyPatch, WorkspaceFile } from '../../../lib/patch'

/** One text chunk with its position in the source. */
export interface Chunk {
  index: number
  text: string
  char_start: number
  char_end: number
}

/** Split text on double-newline paragraph boundaries, with optional character overlap. */
export const splitParagraph = (text: string, overlap: number): Chunk[] => {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  const chunks: Chunk[] = []
  let pos = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const overlapText =
      i > 0 && overlap > 0
        ? blocks
            .slice(Math.max(0, i - 1), i)
            .join('\n\n')
            .slice(-overlap)
        : ''
    const chunkText = overlapText ? `${overlapText}\n\n${block}` : block
    chunks.push({ index: i, text: chunkText, char_start: pos, char_end: pos + block.length })
    pos += block.length + 2
  }
  return chunks
}

/** Split text on sentence-ending punctuation, with optional character overlap. */
export const splitSentence = (text: string, overlap: number): Chunk[] => {
  const sentences = text.match(/[^.!?]+[.!?](?:\s|$)|[^.!?]+$/g) ?? [text]
  const chunks: Chunk[] = []
  let pos = 0
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim()
    if (!sentence) continue
    const overlapText =
      i > 0 && overlap > 0
        ? sentences
            .slice(Math.max(0, i - 1), i)
            .join(' ')
            .slice(-overlap)
        : ''
    const chunkText = overlapText ? `${overlapText} ${sentence}` : sentence
    chunks.push({
      index: chunks.length,
      text: chunkText,
      char_start: pos,
      char_end: pos + sentence.length,
    })
    pos += sentence.length + 1
  }
  return chunks
}

/** Split text into fixed-size character windows with optional overlap. */
export const splitFixed = (text: string, chunkSize: number, overlap: number): Chunk[] => {
  const chunks: Chunk[] = []
  const step = Math.max(1, chunkSize - overlap)
  let i = 0
  let idx = 0
  while (i < text.length) {
    const start = Math.max(0, i - overlap)
    const end = i + chunkSize
    chunks.push({
      index: idx++,
      text: text.slice(start, end),
      char_start: start,
      char_end: Math.min(end, text.length),
    })
    i += step
  }
  return chunks
}

const encoder = new TextEncoder()

export { decodeText } from '@nhtio/adk/lib/text/decode_text'

const textPayload = (source: StepPayload, text: string, suffix: string): StepPayload => ({
  bytes: encoder.encode(text),
  mimeType: MIME.TXT,
  filename: replaceExtension(source.filename, suffix),
})

// ── step implementations ─────────────────────────────────────────────────────

/** `chunk` — split text content into retrieval chunks (data result). */
export const chunkStep: StepImpl = async (ctx) => {
  const by = argOf<string>(ctx.step, 'by') ?? 'paragraph'
  const size = argOf<number>(ctx.step, 'size') ?? 1000
  const overlap = argOf<number>(ctx.step, 'overlap') ?? 0
  const text = decodeText(ctx.payload.bytes)
  const chunks =
    by === 'sentence'
      ? splitSentence(text, overlap)
      : by === 'fixed'
        ? splitFixed(text, size, overlap)
        : splitParagraph(text, overlap)
  return { kind: 'data', data: chunks, asText: JSON.stringify(chunks) }
}

/**
 * `extract.text` — Phase 0 covers the native-text path (txt/md/csv/json/html). Document
 * formats (pdf/docx/…) and OCR routes are added by later phases; until then they fail with a
 * clear reason.
 */
export const extractTextStep: StepImpl = async (ctx) => {
  const family = familyOf(ctx.payload.mimeType)
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  const isNativeText = isTextual(mime)
  if (!isNativeText) {
    throw new E_MEDIA_STEP_FAILED([
      'extract.text',
      `extraction for ${family} media (${mime}) is not yet implemented in this build`,
    ])
  }
  const text = decodeText(ctx.payload.bytes)
  return {
    kind: 'data',
    data: text,
    asText: text,
  }
}

/** `extract.metadata` — Phase 0: size/MIME/filename basics (format-aware fields come later). */
export const extractMetadataStep: StepImpl = async (ctx) => {
  const meta = {
    filename: ctx.payload.filename,
    mime_type: ctx.payload.mimeType,
    size_bytes: ctx.payload.bytes.byteLength,
    family: familyOf(ctx.payload.mimeType),
  }
  return { kind: 'data', data: meta, asText: JSON.stringify(meta) }
}

const toPattern = (value: MediaArgScalar): RegExp | string => {
  if (typeof value === 'string') return value
  const ref = value as RegExpRef
  return new RegExp(ref.source, ref.flags.includes('g') ? ref.flags : `${ref.flags}g`)
}

const applyRedaction = (text: string, patterns: MediaArgScalar[], replacement: string): string => {
  let out = text
  for (const p of patterns) {
    const pattern = toPattern(p)
    out =
      typeof pattern === 'string'
        ? out.split(pattern).join(replacement)
        : out.replace(pattern, replacement)
  }
  return out
}

/** `redact` — Phase 0: the text-media path. Document-format in-place redaction lands later. */
export const redactStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase()
  if (!isTextual(mime)) {
    throw new E_MEDIA_STEP_FAILED([
      'redact',
      `redaction for ${ctx.payload.mimeType} is not yet implemented in this build`,
    ])
  }
  const raw = ctx.step.args.match
  const patterns = (Array.isArray(raw) ? raw : [raw]) as MediaArgScalar[]
  const replacement = argOf<string>(ctx.step, 'replace') ?? '█'
  const text = applyRedaction(decodeText(ctx.payload.bytes), patterns, replacement)
  return { kind: 'media', payload: textPayload(ctx.payload, text, 'txt') }
}

/** `update_text` — Phase 0: the text-media path. */
export const updateTextStep: StepImpl = async (ctx) => {
  const mime = ctx.payload.mimeType.toLowerCase()
  if (!isTextual(mime)) {
    throw new E_MEDIA_STEP_FAILED([
      'update_text',
      `text update for ${ctx.payload.mimeType} is not yet implemented in this build`,
    ])
  }
  const anchor = argOf<string>(ctx.step, 'anchor') as string
  const replace = argOf<string>(ctx.step, 'replace') ?? ''
  const text = decodeText(ctx.payload.bytes)
  if (!text.includes(anchor)) {
    throw new E_MEDIA_STEP_FAILED([
      'update_text',
      `anchor text not found: "${anchor.slice(0, 80)}"`,
    ])
  }
  const updated = text.replace(anchor, replace)
  return { kind: 'media', payload: { ...ctx.payload, bytes: encoder.encode(updated) } }
}

/** Build a unified diff between two texts using the `diff` peer (lazy import). */
const unifiedDiff = async (aName: string, bName: string, a: string, b: string): Promise<string> => {
  const mod = await import('diff')
  return mod.createTwoFilesPatch(aName, bName, a, b)
}

/** `diff` — compare against another media (text-comparable formats in Phase 0). */
export const diffStep: StepImpl = async (ctx) => {
  const ref = ctx.step.args.with as MediaRef
  if (ref.kind !== 'id') {
    throw new E_MEDIA_STEP_FAILED(['diff', 'builder refs are not yet supported here'])
  }
  const other = await ctx.resolveRef(ref.id)
  const a = decodeText(ctx.payload.bytes)
  const b = decodeText(other.bytes)
  const patch = await unifiedDiff(ctx.payload.filename, other.filename, a, b)
  const mod = await import('diff')
  const structured = mod.diffLines(a, b).map((part) => ({
    added: part.added === true,
    removed: part.removed === true,
    count: part.count ?? 0,
    value: part.value,
  }))
  const data = { patch, changes: structured }
  return { kind: 'data', data, asText: patch }
}

/**
 * `apply_patch` — apply a unified diff, or a structured `*** Begin Patch` envelope
 * (multi-file Add/Delete/Update/Move — the GitHub Copilot apply_patch dialect).
 */
export const applyPatchStep: StepImpl = async (ctx) => {
  const patch = argOf<string>(ctx.step, 'patch') as string
  if (isStructuredPatch(patch)) return applyStructuredPatch(ctx, patch)
  const text = decodeText(ctx.payload.bytes)
  const mod = await import('diff')
  const result = mod.applyPatch(text, patch)
  if (result === false) {
    throw new E_MEDIA_STEP_FAILED([
      'apply_patch',
      'the patch does not apply to this media content (context mismatch)',
    ])
  }
  return { kind: 'media', payload: { ...ctx.payload, bytes: encoder.encode(result) } }
}

/** The structured-envelope path: primary media + `with=@refs` form a virtual workspace. */
const applyStructuredPatch = async (
  ctx: Parameters<StepImpl>[0],
  patch: string
): Promise<StepResult> => {
  const verb = 'apply_patch'
  const fail = (message: string): never => {
    throw new E_MEDIA_STEP_FAILED([verb, message])
  }

  // Build the workspace: the primary media plus any @refs, keyed by normalized filename.
  const files = new Map<string, WorkspaceFile>()
  const addToWorkspace = (payload: StepPayload): void => {
    let path: string
    try {
      path = normalizeWorkspacePath(payload.filename)
    } catch (err) {
      fail(isError(err) ? err.message : String(err))
      /* unreachable */ throw err
    }
    if (files.has(path)) fail(`duplicate workspace path in inputs: "${path}"`)
    files.set(path, { text: decodeText(payload.bytes), mimeType: payload.mimeType })
  }
  addToWorkspace(ctx.payload)
  const raw = ctx.step.args.with
  if (raw !== undefined) {
    const refs = (Array.isArray(raw) ? raw : [raw]) as MediaRef[]
    for (const ref of refs) {
      if (ref.kind !== 'id') fail('builder refs are not yet supported here')
      addToWorkspace(await ctx.resolveRef((ref as { kind: 'id'; id: string }).id))
    }
  }

  let parsed: ParsedApplyPatch
  let applied: { files: Map<string, WorkspaceFile>; modifiedFiles: number }
  try {
    parsed = parseStructuredPatch(patch)
    applied = applyOperations(files, parsed)
  } catch (err) {
    fail(isError(err) ? err.message : String(err))
    /* unreachable */ throw err
  }

  const finalFiles = [...applied.files.entries()].sort(([a], [b]) => a.localeCompare(b))
  const payloads: StepPayload[] = finalFiles.map(([path, file]) => ({
    bytes: encoder.encode(file.text),
    mimeType: file.mimeType,
    filename: path,
  }))
  if (payloads.length === 0) fail('the patch deleted every file in the workspace')
  if (payloads.length === 1) return { kind: 'media', payload: payloads[0] }
  return { kind: 'media-list', payloads }
}
