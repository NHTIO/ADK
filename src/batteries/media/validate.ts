/**
 * The semantic validator: checks raw parsed segments (or ops) against the verb table and the
 * deployment's configured engines, producing the validated {@link MediaPlan} or a
 * model-actionable error.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry. This is the layer no parser
 * toolkit could supply — every error names what was wrong, suggests the nearest valid form,
 * and shows a corrective exemplar (frozen design 0.14). Engine narrowing happens HERE, never
 * at parse time (frozen 0.3): the same string parses identically in every deployment; only
 * validation differs.
 */

import { isMediaRef, isRegExpRef } from './plan'
import { isError, isObject } from '@nhtio/adk/guards'
import { VERB_INDEX, suggestVerbs, foldVerb } from './verbs'
import {
  E_MEDIA_UNKNOWN_VERB,
  E_MEDIA_UNKNOWN_ARG,
  E_MEDIA_BAD_ARG,
  E_MEDIA_MISSING_ARG,
  E_MEDIA_ENGINE_REQUIRED,
} from './exceptions'
import type { RawSegment, RawArgValue } from './pipe'
import type { VerbSpec, VerbArgSpec, VerbRequirement } from './verbs'
import type { MediaPlan, MediaStep, MediaArgValue, MediaArgScalar, MediaOp } from './plan'

/**
 * The minimal synchronous capability probe the validator narrows against. The pipeline's
 * engine registry implements it; tests stub it.
 */
export interface CapabilityProbe {
  /** `true` when some engine declares a matching convert edge (omit either side for "any"). */
  hasConvert(from?: string, to?: string): boolean
  /** `true` when some engine declares a mutate capability. */
  hasMutate(): boolean
}

/** Options for {@link validateSegments} / {@link validateOps}. */
export interface ValidateOptions {
  /** The deployment's capabilities. Narrows advertised verbs + error suggestions. */
  capabilities: CapabilityProbe
}

/** `true` when the deployment satisfies a verb's capability requirement. */
const satisfies = (capabilities: CapabilityProbe, requires: VerbRequirement): boolean =>
  requires.capability === 'mutate'
    ? capabilities.hasMutate()
    : capabilities.hasConvert(requires.from, requires.to)

/** A human phrase for an unmet requirement, for the do-not-retry error. */
const requirementText = (requires: VerbRequirement): string => {
  if (requires.capability === 'mutate') return 'an engine that can mutate this media'
  const from = requires.from ? ` from ${requires.from}` : ''
  const to = requires.to ? ` to ${requires.to}` : ''
  return `an engine that can convert${from}${to}`
}

/** The folded verb forms available under a given capability configuration. */
export const availableVerbs = (capabilities: CapabilityProbe): string[] => {
  const out: string[] = []
  for (const [id, spec] of VERB_INDEX) {
    if (spec.requires && !satisfies(capabilities, spec.requires)) continue
    out.push(id.replace(/[._]+/g, ' '))
  }
  return out
}

const levSuggest = (verbText: string, capabilities: CapabilityProbe): string => {
  const suggestions = suggestVerbs(verbText, availableVerbs(capabilities))
  return suggestions.length > 0 ? ` did you mean "${suggestions[0]}"?` : ''
}

const verbList = (capabilities: CapabilityProbe): string => availableVerbs(capabilities).join(', ')

const resolveVerb = (
  verbText: string,
  capabilities: CapabilityProbe,
  position: number
): VerbSpec => {
  const canonical = foldVerb(verbText.split(' ')) ?? verbText
  const spec = VERB_INDEX.get(canonical)
  if (!spec) {
    throw new E_MEDIA_UNKNOWN_VERB([
      `unknown verb "${verbText}" at segment ${position}.${levSuggest(verbText, capabilities)} Available verbs: ${verbList(capabilities)}`,
    ])
  }
  if (spec.requires && !satisfies(capabilities, spec.requires)) {
    throw new E_MEDIA_ENGINE_REQUIRED([
      `verb "${verbText}" requires ${requirementText(spec.requires)}, and none is configured in this deployment. Do not retry this verb here. Available verbs: ${verbList(capabilities)}`,
    ])
  }
  return spec
}

const suggestArg = (name: string, spec: VerbSpec): string => {
  const candidates = Object.keys(spec.args)
  const ranked = suggestVerbs(name, candidates)
  return ranked.length > 0 ? ` did you mean "${ranked[0]}"?` : ''
}

const argList = (spec: VerbSpec): string => {
  const names = Object.keys(spec.args)
  return names.length > 0 ? names.join(', ') : '(none)'
}

const exemplar = (spec: VerbSpec): string => {
  const verb = spec.id.replace(/\./g, ' ')
  const parts: string[] = [verb]
  for (const [name, arg] of Object.entries(spec.args)) {
    if (!arg.required) continue
    parts.push(`${name}=${exampleValue(arg)}`)
  }
  return parts.join(' ')
}

const exampleValue = (arg: VerbArgSpec): string => {
  switch (arg.type) {
    case 'enum':
      return arg.values?.[0] ?? 'value'
    case 'number':
      return String(arg.min ?? 1)
    case 'number-list':
      return '1-3,5'
    case 'string-list':
      return 'a,b'
    case 'boolean':
      return 'true'
    case 'regex-or-string-list':
      return '"literal text"'
    case 'media-ref':
      return '@<media id>'
    case 'media-ref-list':
      return '@<media id>'
    case 'json':
      return `'[…]'`
    default:
      return '"value"'
  }
}

/** Coerce + check one arg value against its spec. Returns the IR-final value. */
const checkArg = (
  verb: VerbSpec,
  name: string,
  raw: { value: MediaArgValue; quoted: boolean }
): MediaArgValue => {
  const spec = verb.args[name]
  const verbText = verb.id.replace(/\./g, ' ')
  const where = `arg "${name}" on "${verbText}"`
  const bad = (msg: string): never => {
    throw new E_MEDIA_BAD_ARG([`${where}: ${msg}. Write it like: ${exemplar(verb)}`])
  }
  const v = raw.value
  switch (spec.type) {
    case 'name-or-index': {
      if (typeof v === 'number') {
        if (!Number.isInteger(v) || v < 1) bad('indices are 1-based integers')
        return v
      }
      if (typeof v !== 'string') bad('expected a 1-based index or a quoted name')
      return v
    }
    case 'string': {
      if (typeof v === 'number' && !raw.quoted) return String(v)
      if (typeof v !== 'string')
        bad(`expected text${typeof v === 'object' ? ', got a structured value' : ''}`)
      return v
    }
    case 'number': {
      if (typeof v !== 'number') bad('expected a number')
      const n = v as number
      if (spec.min !== undefined && n < spec.min) bad(`must be ≥ ${spec.min} (indices are 1-based)`)
      if (spec.max !== undefined && n > spec.max) bad(`must be ≤ ${spec.max}`)
      return n
    }
    case 'boolean': {
      if (typeof v !== 'boolean') bad('expected true or false')
      return v
    }
    case 'enum': {
      const s = typeof v === 'number' ? String(v) : v
      if (typeof s !== 'string' || !spec.values?.includes(s)) {
        bad(`"${String(v)}" is not valid; valid values: ${spec.values?.join(', ')}`)
      }
      return s as string
    }
    case 'number-list': {
      const arr = Array.isArray(v) ? v : [v]
      if (!arr.every((x): x is number => typeof x === 'number'))
        bad('expected numbers (e.g. 1-3,5)')
      const nums = arr as number[]
      if (spec.min !== undefined && nums.some((n) => n < (spec.min as number))) {
        bad(`values must be ≥ ${spec.min} (indices are 1-based)`)
      }
      return nums
    }
    case 'string-list': {
      const arr = Array.isArray(v) ? v : [v]
      if (!arr.every((x): x is string => typeof x === 'string'))
        bad('expected names (quote values with special characters)')
      const strs = arr as string[]
      if (spec.values && !strs.every((s) => spec.values?.includes(s))) {
        bad(`valid values: ${spec.values.join(', ')}`)
      }
      return strs
    }
    case 'regex-or-string-list': {
      if (isRegExpRef(v)) return v
      const arr = Array.isArray(v) ? v : [v]
      if (arr.every((x) => typeof x === 'string' || isRegExpRef(x))) return arr as MediaArgScalar[]
      bad('expected literal text, a list of literals, or a /regex/')
      break
    }
    case 'media-ref': {
      if (isMediaRef(v)) return v
      bad('expected a media reference: with=@<media id> (get ids from list_media)')
      break
    }
    case 'media-ref-list': {
      const arr = Array.isArray(v) ? v : [v]
      if (arr.every(isMediaRef)) return arr as MediaArgScalar[]
      bad('expected media references: with=@<id>,@<id> (get ids from list_media)')
      break
    }
    case 'json': {
      // From pipe: a quoted string containing JSON. From ops: already-structured JSON.
      if (typeof v === 'string') {
        if (!raw.quoted) bad(`expected a quoted JSON value, e.g. ${name}='[…]'`)
        try {
          return JSON.parse(v) as MediaArgValue
        } catch (err) {
          const detail = isError(err) ? err.message : String(err)
          bad(`the quoted value is not valid JSON (${detail})`)
        }
      }
      if (isObject(v) || Array.isArray(v)) return v
      bad(`expected a JSON value, e.g. ${name}='[…]'`)
      break
    }
  }
  /* unreachable */
  throw new E_MEDIA_BAD_ARG([`${where}: invalid value`])
}

const checkStep = (
  spec: VerbSpec,
  args: ReadonlyMap<string, { value: MediaArgValue; quoted: boolean }>
): MediaStep => {
  const verbText = spec.id.replace(/\./g, ' ')
  const finalArgs: Record<string, MediaArgValue> = {}
  for (const [name, raw] of args) {
    if (!(name in spec.args)) {
      throw new E_MEDIA_UNKNOWN_ARG([
        `verb "${verbText}" has no arg "${name}".${suggestArg(name, spec)} Args: ${argList(spec)}. Write it like: ${exemplar(spec)}`,
      ])
    }
    finalArgs[name] = checkArg(spec, name, raw)
  }
  for (const [name, argSpec] of Object.entries(spec.args)) {
    if (argSpec.required && !(name in finalArgs)) {
      throw new E_MEDIA_MISSING_ARG([
        `verb "${verbText}" requires arg "${name}" (${argSpec.description}). Write it like: ${exemplar(spec)}`,
      ])
    }
  }
  return { verb: spec.id, args: finalArgs }
}

/**
 * Validate raw pipe segments into a {@link MediaPlan}.
 *
 * @param segments - Output of `parsePipeRaw`.
 * @param options - The deployment's capability probe.
 * @returns The validated plan, spans preserved.
 */
export const validateSegments = (
  segments: readonly RawSegment[],
  options: ValidateOptions
): MediaPlan => {
  const steps: MediaStep[] = []
  segments.forEach((seg, i) => {
    const spec = resolveVerb(seg.verb.replace(/\./g, ' '), options.capabilities, i + 1)
    const step = checkStep(spec, seg.args)
    step.span = seg.span
    steps.push(step)
  })
  return { steps }
}

/**
 * Validate a JSON ops array into a {@link MediaPlan}. The same checks as the pipe path —
 * verbs fold the same way, args validate against the same specs — so the two front-ends
 * produce identical plans for equivalent statements.
 *
 * @param ops - The ops array.
 * @param options - The deployment's capability probe.
 * @returns The validated plan (no spans).
 */
export const validateOps = (ops: readonly MediaOp[], options: ValidateOptions): MediaPlan => {
  const steps: MediaStep[] = []
  ops.forEach((op, i) => {
    const spec = resolveVerb(op.verb.replace(/[._]+/g, ' '), options.capabilities, i + 1)
    const args = new Map<string, RawArgValue>(
      Object.entries(op.args).map(([k, v]) => [
        k,
        {
          value: v,
          quoted: typeof v === 'string',
          span: { offset: 0, line: 1, col: 1, length: 0 },
        },
      ])
    )
    steps.push(checkStep(spec, args))
  })
  return { steps }
}
