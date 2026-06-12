import { describe, expect, it } from 'vitest'
import { BUNDLED_SUMMARIES } from '../../../../src/batteries/media/lint'
import { dataEngine } from '../../../../src/batteries/media/engines/data'
import { jimpEngine } from '../../../../src/batteries/media/engines/jimp'
import { sharpEngine } from '../../../../src/batteries/media/engines/sharp'
import { sheetjsEngine } from '../../../../src/batteries/media/engines/sheetjs'
import { exceljsEngine } from '../../../../src/batteries/media/engines/exceljs'

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
    edits?: readonly { over: readonly string[]; ops: readonly string[] }[]
  }) => ({
    mutates: (engine.mutates ?? []).map((m) => ({
      over: [...m.over],
      ops: [...m.ops],
      encodes: [...m.encodes],
    })),
    converts: (engine.converts ?? []).map((c) => ({ from: [...c.from], to: [...c.to] })),
    edits: (engine.edits ?? []).map((e) => ({ over: [...e.over], ops: [...e.ops] })),
  })

  const pinned = (name: string) => ({
    mutates: BUNDLED_SUMMARIES[name].mutates,
    converts: BUNDLED_SUMMARIES[name].converts,
    edits: BUNDLED_SUMMARIES[name].edits,
  })

  it('dataEngine summary matches the live factory declarations', () => {
    expect(pinned('dataEngine')).toEqual(summaryOf(dataEngine()))
  })

  it('exceljsEngine summary matches the live factory declarations', () => {
    expect(pinned('exceljsEngine')).toEqual(summaryOf(exceljsEngine()))
  })

  it('jimpEngine summary matches the live factory declarations', () => {
    expect(pinned('jimpEngine')).toEqual(summaryOf(jimpEngine()))
  })

  it('sharpEngine summary matches the live factory declarations', () => {
    expect(pinned('sharpEngine')).toEqual(summaryOf(sharpEngine()))
  })

  it('sheetjsEngine summary matches the live factory declarations', () => {
    expect(pinned('sheetjsEngine')).toEqual(summaryOf(sheetjsEngine()))
  })

  it('every summarized factory is covered by a drift assertion in this spec', () => {
    // If a new factory is added to BUNDLED_SUMMARIES, this fails until a matching
    // live-comparison test is added above.
    expect(Object.keys(BUNDLED_SUMMARIES).sort()).toEqual([
      'dataEngine',
      'exceljsEngine',
      'jimpEngine',
      'sharpEngine',
      'sheetjsEngine',
    ])
  })
})
