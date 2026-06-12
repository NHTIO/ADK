/**
 * `append` and `data.*` step implementations: deterministic text/data mutations on in-memory
 * bytes — append a line, set/merge/delete at a JSON or YAML path.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. Pure and cross-env: text ops
 * are string concatenation; structured ops parse (JSON natively, YAML via the `js-yaml`
 * dependency), mutate the value tree, and re-serialize **preserving the source format** —
 * `data.set` on a YAML file yields YAML, on a JSON file yields JSON. These are the verbs
 * that make the lossy text family first-class media: `empty:json | data set path=… value=…`
 * is a create-then-populate chain with no engine requirement at all.
 */

import { MIME } from '../formats'
import { argOf } from '../runtime'
import { isError } from '@nhtio/adk/guards'
import { E_MEDIA_STEP_FAILED } from '../exceptions'
import type { StepImpl, StepPayload } from '../runtime'

const fail = (verb: string, message: string): never => {
  throw new E_MEDIA_STEP_FAILED([verb, message])
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** MIME types the text-shaped verbs operate on. */
const TEXTUAL = (mime: string): boolean =>
  mime.startsWith('text/') || mime === MIME.JSON || mime === MIME.YAML

/** `append` — append text to text-family media. */
export const appendStep: StepImpl = async (ctx) => {
  const verb = 'append'
  const mime = ctx.payload.mimeType.toLowerCase().split(';')[0].trim()
  if (!TEXTUAL(mime)) {
    fail(
      verb,
      `append expects text-family media (txt/md/csv/yaml/json-lines); the media is ${mime}`
    )
  }
  const text = argOf<string>(ctx.step, 'text') as string
  const newline = argOf<boolean>(ctx.step, 'newline') ?? true
  const current = decoder.decode(ctx.payload.bytes)
  const needsBreak = newline && current.length > 0 && !current.endsWith('\n')
  const next = current + (needsBreak ? '\n' : '') + text + (newline ? '\n' : '')
  return { kind: 'media', payload: { ...ctx.payload, bytes: encoder.encode(next) } }
}

// ── structured (JSON/YAML) path ops ──────────────────────────────────────────

type Doc = { value: unknown; format: 'json' | 'yaml' }

const parseDoc = async (verb: string, payload: StepPayload): Promise<Doc> => {
  const mime = payload.mimeType.toLowerCase().split(';')[0].trim()
  const text = decoder.decode(payload.bytes)
  if (mime === MIME.JSON) {
    try {
      return { value: text.trim() === '' ? null : (JSON.parse(text) as unknown), format: 'json' }
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      fail(verb, `the media is not valid JSON: ${detail}`)
    }
  }
  if (mime === MIME.YAML) {
    try {
      const { load } = await import('js-yaml')
      return { value: load(text) ?? null, format: 'yaml' }
    } catch (err) {
      const detail = isError(err) ? err.message : String(err)
      fail(verb, `the media is not valid YAML: ${detail}`)
    }
  }
  fail(verb, `data operations expect JSON or YAML media; the media is ${mime}`)
  /* unreachable */ throw new Error('unreachable')
}

const serializeDoc = async (doc: Doc, payload: StepPayload): Promise<StepPayload> => {
  if (doc.format === 'yaml') {
    const { dump } = await import('js-yaml')
    return { ...payload, bytes: encoder.encode(dump(doc.value)) }
  }
  return { ...payload, bytes: encoder.encode(JSON.stringify(doc.value, null, 2)) }
}

/** Parse a dot/bracket path (`a.b[2].c`) into segments. */
const parsePath = (verb: string, raw: string): Array<string | number> => {
  if (typeof raw !== 'string' || raw.trim() === '') fail(verb, 'path must be a non-empty string')
  const segments: Array<string | number> = []
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw))) {
    if (match[2] !== undefined) segments.push(Number(match[2]))
    else segments.push(match[1])
  }
  if (segments.length === 0) fail(verb, `could not parse path "${raw}"`)
  return segments
}

/** Walk to the parent of the path target, creating containers when `create` is set. */
const walkToParent = (
  verb: string,
  root: unknown,
  segments: Array<string | number>,
  create: boolean
): { parent: Record<string, unknown> | unknown[]; key: string | number } => {
  let node: unknown = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]
    const isIndex = typeof seg === 'number'
    if (node === null || typeof node !== 'object') {
      fail(verb, `path segment "${String(seg)}" walks through a non-container value`)
    }
    const container = node as Record<string, unknown> & unknown[]
    let next: unknown = isIndex ? container[seg] : container[seg as string]
    if (next === undefined || next === null) {
      if (!create) {
        fail(verb, `path segment "${String(seg)}" does not exist`)
      }
      next = typeof segments[i + 1] === 'number' ? [] : {}
      if (isIndex) container[seg] = next
      else container[seg as string] = next
    }
    node = next
  }
  if (node === null || typeof node !== 'object') {
    fail(verb, 'the path target parent is not an object or array')
  }
  return { parent: node as Record<string, unknown> | unknown[], key: segments[segments.length - 1] }
}

/** `data.set` — set a value at a JSON/YAML path, creating intermediate containers. */
export const dataSetStep: StepImpl = async (ctx) => {
  const verb = 'data set'
  const path = argOf<string>(ctx.step, 'path') as string
  const rawValue = argOf<string>(ctx.step, 'value')
  if (rawValue === undefined) fail(verb, 'value is required (JSON-encoded scalar or structure)')
  let value: unknown
  try {
    value = JSON.parse(String(rawValue))
  } catch {
    // A bare unquoted string is a convenience the model will reach for; accept it.
    value = String(rawValue)
  }
  const doc = await parseDoc(verb, ctx.payload)
  const segments = parsePath(verb, path)
  if (doc.value === null || typeof doc.value !== 'object') {
    doc.value = typeof segments[0] === 'number' ? [] : {}
  }
  const { parent, key } = walkToParent(verb, doc.value, segments, true)
  if (Array.isArray(parent)) parent[Number(key)] = value
  else parent[String(key)] = value
  return { kind: 'media', payload: await serializeDoc(doc, ctx.payload) }
}

/** Deep merge `fragment` into `target` (objects merge recursively; everything else replaces). */
const deepMerge = (target: unknown, fragment: unknown): unknown => {
  if (
    target === null ||
    fragment === null ||
    typeof target !== 'object' ||
    typeof fragment !== 'object' ||
    Array.isArray(target) !== Array.isArray(fragment) ||
    Array.isArray(fragment)
  ) {
    return fragment
  }
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) }
  for (const [k, v] of Object.entries(fragment as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v
  }
  return out
}

/** `data.merge` — merge a JSON fragment into the document (deep by default). */
export const dataMergeStep: StepImpl = async (ctx) => {
  const verb = 'data merge'
  const rawFragment = argOf<string>(ctx.step, 'fragment') as string
  const strategy = argOf<string>(ctx.step, 'strategy') ?? 'deep'
  let fragment: unknown
  try {
    fragment = JSON.parse(String(rawFragment))
  } catch (err) {
    const detail = isError(err) ? err.message : String(err)
    fail(verb, `fragment must be valid JSON: ${detail}`)
  }
  if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
    fail(verb, 'fragment must be a JSON object')
  }
  const doc = await parseDoc(verb, ctx.payload)
  if (doc.value === null || typeof doc.value !== 'object' || Array.isArray(doc.value)) {
    fail(verb, 'merge requires the document root to be an object')
  }
  doc.value =
    strategy === 'shallow'
      ? { ...(doc.value as Record<string, unknown>), ...(fragment as Record<string, unknown>) }
      : deepMerge(doc.value, fragment)
  return { kind: 'media', payload: await serializeDoc(doc, ctx.payload) }
}

/** `data.delete` — remove a key/index at a JSON/YAML path. */
export const dataDeleteStep: StepImpl = async (ctx) => {
  const verb = 'data delete'
  const path = argOf<string>(ctx.step, 'path') as string
  const doc = await parseDoc(verb, ctx.payload)
  const segments = parsePath(verb, path)
  if (doc.value === null || typeof doc.value !== 'object') {
    fail(verb, 'the document has no structure to delete from')
  }
  const { parent, key } = walkToParent(verb, doc.value, segments, false)
  if (Array.isArray(parent)) {
    const idx = Number(key)
    if (idx < 0 || idx >= parent.length) fail(verb, `index ${idx} is out of range`)
    parent.splice(idx, 1)
  } else {
    if (!(String(key) in parent)) fail(verb, `key "${String(key)}" does not exist at that path`)
    delete parent[String(key)]
  }
  return { kind: 'media', payload: await serializeDoc(doc, ctx.payload) }
}

/** The data step registry fragment, keyed by canonical verb id. */
export const DATA_STEPS: ReadonlyArray<[string, StepImpl]> = [
  ['append', appendStep],
  ['data.set', dataSetStep],
  ['data.merge', dataMergeStep],
  ['data.delete', dataDeleteStep],
]
