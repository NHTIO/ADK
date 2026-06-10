import { describe, expect, it } from 'vitest'
import { BUNDLED_SUMMARIES } from '../../../../src/batteries/media/lint'
import { jimpEngine } from '../../../../src/batteries/media/engines/jimp'
import { sharpEngine } from '../../../../src/batteries/media/engines/sharp'

/**
 * The lint plugin's no-shadowed-engine rule reasons about the bundled factories from a
 * hand-maintained summary table (an ESLint rule cannot execute the factories it lints).
 * That table is a drift bomb unless something pins it to reality — this spec is that pin:
 * every summary must match the live factory's declared capabilities EXACTLY. If you changed
 * an engine's declarations, update BUNDLED_SUMMARIES in lint.ts to match.
 */
describe('lint BUNDLED_SUMMARIES drift pin', () => {
  const summaryOf = (engine: {
    mutates?: readonly {
      over: readonly string[]
      ops: readonly string[]
      encodes: readonly string[]
    }[]
    converts?: readonly { from: readonly string[]; to: readonly string[] }[]
  }) => ({
    mutates: (engine.mutates ?? []).map((m) => ({
      over: [...m.over],
      ops: [...m.ops],
      encodes: [...m.encodes],
    })),
    converts: (engine.converts ?? []).map((c) => ({ from: [...c.from], to: [...c.to] })),
  })

  it('jimpEngine summary matches the live factory declarations', () => {
    const live = summaryOf(jimpEngine())
    expect({
      mutates: BUNDLED_SUMMARIES.jimpEngine.mutates,
      converts: BUNDLED_SUMMARIES.jimpEngine.converts,
    }).toEqual(live)
  })

  it('sharpEngine summary matches the live factory declarations', () => {
    const live = summaryOf(sharpEngine())
    expect({
      mutates: BUNDLED_SUMMARIES.sharpEngine.mutates,
      converts: BUNDLED_SUMMARIES.sharpEngine.converts,
    }).toEqual(live)
  })

  it('every summarized factory is covered by a drift assertion in this spec', () => {
    // If a new factory is added to BUNDLED_SUMMARIES, this fails until a matching
    // live-comparison test is added above.
    expect(Object.keys(BUNDLED_SUMMARIES).sort()).toEqual(['jimpEngine', 'sharpEngine'])
  })
})
