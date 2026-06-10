import { describe, expect, it } from 'vitest'
import { toPipe, toOps, fromOps } from '../../../../src/batteries/media/plan'
import { parsePipeRaw, lowerSegments } from '../../../../src/batteries/media/pipe'
import {
  validateSegments,
  validateOps,
  availableVerbs,
} from '../../../../src/batteries/media/validate'
import type { MediaPlan } from '../../../../src/batteries/media/plan'
import type { CapabilityProbe } from '../../../../src/batteries/media/validate'

const ALL_ENGINES: CapabilityProbe = { hasConvert: () => true, hasMutate: () => true }
const NO_ENGINES: CapabilityProbe = { hasConvert: () => false, hasMutate: () => false }

const parse = (q: string, capabilities: CapabilityProbe = ALL_ENGINES): MediaPlan =>
  validateSegments(parsePipeRaw(q), { capabilities })

const stripSpans = (plan: MediaPlan): MediaPlan => ({
  steps: plan.steps.map(({ verb, args }) => ({ verb, args })),
})

describe('pipe lexer + parser', () => {
  it('parses the flagship statement', () => {
    const plan = parse('select pages=2-5 | redact match=/\\d{3}-\\d{2}-\\d{4}/ | convert to=pdf')
    expect(plan.steps.map((s) => s.verb)).toEqual(['select', 'redact', 'convert'])
    expect(plan.steps[0].args.pages).toEqual([2, 3, 4, 5])
    expect(plan.steps[1].args.match).toEqual({ source: '\\d{3}-\\d{2}-\\d{4}', flags: '' })
    expect(plan.steps[2].args.to).toBe('pdf')
  })

  it('parses two-word verbs without a verb table at parse time (lookahead)', () => {
    const plan = parse('extract text | chunk by=sentence size=512')
    expect(plan.steps[0].verb).toBe('extract.text')
    expect(plan.steps[1].verb).toBe('chunk')
    expect(plan.steps[1].args).toEqual({ by: 'sentence', size: 512 })
  })

  it('folds separators in verbs: extract_text ≡ extract text ≡ extract.text', () => {
    for (const q of ['extract_text', 'extract text', 'extract.text']) {
      expect(parse(q).steps[0].verb).toBe('extract.text')
    }
  })

  it('folds namespace separators: sheet.update_cells ≡ sheet update_cells ≡ sheet update cells', () => {
    const json = `'[{"address":"B2","value":3}]'`
    for (const q of [
      `sheet.update_cells updates=${json}`,
      `sheet update_cells updates=${json}`,
      `sheet update cells updates=${json}`,
    ]) {
      expect(parse(q).steps[0].verb).toBe('sheet.update_cells')
    }
  })

  it('parses mixed range/int lists', () => {
    const plan = parse('select pages=2-5,8,11-13')
    expect(plan.steps[0].args.pages).toEqual([2, 3, 4, 5, 8, 11, 12, 13])
  })

  it('parses @id media refs', () => {
    const plan = parse('merge with=@018f-aa,@018f-bb')
    expect(plan.steps[0].args.with).toEqual([
      { kind: 'id', id: '018f-aa' },
      { kind: 'id', id: '018f-bb' },
    ])
  })

  it('parses a single @id ref for diff', () => {
    const plan = parse('diff with=@abc123')
    expect(plan.steps[0].args.with).toEqual({ kind: 'id', id: 'abc123' })
  })

  it('parses quoted-JSON structured args', () => {
    const plan = parse(`sheet update_cells sheet=Summary updates='[{"address":"B2","value":42}]'`)
    expect(plan.steps[0].args.updates).toEqual([{ address: 'B2', value: 42 }])
    expect(plan.steps[0].args.sheet).toBe('Summary')
  })

  it('parses class-aware regex literals', () => {
    const plan = parse('redact match=/[/:]/')
    expect(plan.steps[0].args.match).toEqual({ source: '[/:]', flags: '' })
  })

  it('canonicalizes regex flags (ig -> gi)', () => {
    const plan = parse('redact match=/ssn/ig')
    expect(plan.steps[0].args.match).toEqual({ source: 'ssn', flags: 'gi' })
  })

  it('tolerates whitespace around = and multiline pipes', () => {
    const plan = parse('convert to = pdf')
    expect(plan.steps[0].args.to).toBe('pdf')
    const multi = parse('select pages=1\n  | convert to=pdf')
    expect(multi.steps).toHaveLength(2)
  })

  it('tolerates # comments', () => {
    const plan = parse('convert to=pdf # make it a pdf')
    expect(plan.steps[0].args.to).toBe('pdf')
  })

  it('parses booleans', () => {
    const plan = parse('audio transcribe lang=en translate=true')
    expect(plan.steps[0].args.translate).toBe(true)
  })

  it('treats quoted numbers as names, bare numbers as 1-based indices (frozen 0.11)', () => {
    const byIndex = parse(`sheet delete_rows sheet=3 rows=1`)
    expect(byIndex.steps[0].args.sheet).toBe(3)
    const byName = parse(`sheet delete_rows sheet="2025" rows=1`)
    expect(byName.steps[0].args.sheet).toBe('2025')
  })
})

describe('pipe syntax errors (model-actionable)', () => {
  const errOf = (q: string): string => {
    try {
      parse(q)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error(`expected ${q} to throw`)
  }

  it('rejects empty input with an exemplar', () => {
    expect(errOf('')).toContain('Write it like:')
  })

  it('rejects bare dashed values with quoting advice', () => {
    const msg = errOf('audio transcribe lang=en-US')
    expect(msg).toMatch(/quote/i)
  })

  it('rejects descending ranges', () => {
    expect(errOf('select pages=5-2')).toContain('descending')
  })

  it('rejects positional args with the named-only exemplar', () => {
    const msg = errOf('convert pdf x')
    expect(msg).toContain('name=value')
  })

  it('rejects duplicate args', () => {
    expect(errOf('convert to=pdf to=txt')).toContain('duplicate')
  })

  it('rejects invalid regex with the compile reason', () => {
    expect(errOf('redact match=/(/')).toContain('invalid regex')
  })
})

describe('semantic validation (did-you-mean + engine narrowing)', () => {
  const errOf = (q: string, capabilities: CapabilityProbe = ALL_ENGINES): string => {
    try {
      parse(q, capabilities)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error(`expected ${q} to throw`)
  }

  it('suggests the nearest verb on a typo', () => {
    const msg = errOf('redackt match=x')
    expect(msg).toContain('did you mean')
    expect(msg.toLowerCase()).toContain('redact')
  })

  it('suggests namespaced verbs from a bare suffix word', () => {
    const msg = errOf('resize width=256')
    expect(msg).toContain('image resize')
  })

  it('rejects capability-gated verbs with a do-not-retry directive when unconfigured', () => {
    const msg = errOf('convert to=pdf', NO_ENGINES)
    expect(msg).toContain('convert')
    expect(msg).toContain('none is configured')
    expect(msg).toContain('Do not retry')
  })

  it('never suggests unconfigured verbs', () => {
    const verbs = availableVerbs(NO_ENGINES)
    expect(verbs).not.toContain('convert')
    expect(verbs).toContain('select')
    expect(verbs).toContain('extract text')
  })

  it('rejects unknown args with did-you-mean', () => {
    const msg = errOf('convert format=pdf')
    expect(msg).toContain('no arg "format"')
    expect(msg).toContain('to')
  })

  it('rejects bad enum values listing the valid set', () => {
    const msg = errOf('convert to=pdff')
    expect(msg).toContain('not valid')
    expect(msg).toContain('pdf')
  })

  it('rejects missing required args with the arg description', () => {
    const msg = errOf('redact')
    expect(msg).toContain('requires arg "match"')
  })

  it('rejects 0-based indices with a 1-based reminder', () => {
    const msg = errOf('select pages=0')
    expect(msg).toContain('1-based')
  })

  it('rejects malformed embedded JSON with the parse reason', () => {
    const msg = errOf(`sheet update_cells updates='[{bad'`)
    expect(msg).toContain('not valid JSON')
  })

  it('requires json args to be quoted', () => {
    const msg = errOf('sheet update_cells updates=stuff')
    expect(msg).toContain('quoted JSON')
  })
})

describe('round-trip (frozen 0.7: fixed-point, canonical renderer)', () => {
  const roundTrip = (q: string): void => {
    const plan = stripSpans(parse(q))
    const rendered = toPipe(plan)
    const reparsed = stripSpans(parse(rendered))
    expect(reparsed).toEqual(plan)
    // idempotence
    expect(toPipe(reparsed)).toBe(rendered)
  }

  it('round-trips the flagship statement', () => {
    roundTrip('select pages=2-5 | redact match=/\\d{3}-\\d{2}-\\d{4}/ | convert to=pdf')
  })

  it('round-trips quoted-JSON structured args', () => {
    roundTrip(`sheet update_cells sheet=Summary updates='[{"address":"B2","value":42}]'`)
  })

  it('round-trips @id refs', () => {
    roundTrip('merge with=@018f-aa,@018f-bb')
  })

  it('round-trips regex with flags and slashes', () => {
    roundTrip('redact match=/a\\/b/gi')
  })

  it('compresses ascending runs without sorting or deduping', () => {
    const plan = stripSpans(parse('reorder order=3,1,2'))
    expect(toPipe(plan)).toBe('reorder order=3,1-2')
    const reparsed = stripSpans(parse(toPipe(plan)))
    expect(reparsed.steps[0].args.order).toEqual([3, 1, 2])
  })

  it('quotes strings that would lex as other tokens', () => {
    const plan = stripSpans(parse('sheet remove_sheet sheet="2025"'))
    expect(toPipe(plan)).toBe('sheet remove_sheet sheet="2025"')
  })

  it('pipe and ops forms of the same statement produce identical plans', () => {
    const fromPipe = stripSpans(parse('select pages=2-5 | convert to=pdf'))
    const fromOpsPlan = validateOps(
      [
        { verb: 'select', args: { pages: [2, 3, 4, 5] } },
        { verb: 'convert', args: { to: 'pdf' } },
      ],
      { capabilities: ALL_ENGINES }
    )
    expect(fromOpsPlan).toEqual(fromPipe)
  })

  it('toOps/fromOps are stable', () => {
    const plan = stripSpans(parse('select pages=1,3 | extract text'))
    const ops = toOps(plan)
    expect(stripSpans(fromOps(ops))).toEqual(plan)
    expect(toOps(fromOps(ops))).toEqual(ops)
  })

  it('ops verbs fold separators too', () => {
    const plan = validateOps([{ verb: 'extract_text', args: {} }], { capabilities: ALL_ENGINES })
    expect(plan.steps[0].verb).toBe('extract.text')
  })
})

describe('lowerSegments (structural lowering without validation)', () => {
  it('keeps unknown verbs for tooling', () => {
    const segments = parsePipeRaw('frobnicate x=1')
    const plan = lowerSegments(segments)
    expect(plan.steps[0].verb).toBe('frobnicate')
  })
})
