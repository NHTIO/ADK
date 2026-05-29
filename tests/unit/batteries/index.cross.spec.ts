import { describe, expect, it } from 'vitest'
import * as batteries from '../../../src/batteries'
import { calculateTool, evaluateKatexTool } from '../../../src/batteries'
import { calculateTool as calculateFromTools } from '../../../src/batteries/tools'

describe('@nhtio/adk/batteries', () => {
  it('re-exports individual tools by name', () => {
    expect(calculateTool.name).toBe('calculate')
    expect(evaluateKatexTool.name).toBe('evaluate_katex')
  })

  it('is a plain re-export of @nhtio/adk/batteries/tools', () => {
    expect(calculateTool).toBe(calculateFromTools)
  })

  it('exposes the full bundled set via `Object.values(batteries)`', () => {
    const all = Object.values(batteries)
    // Every entry should be defined (some entries are pure type-only exports that get
    // tree-shaken to undefined values, but everything that survives must exist).
    for (const value of all) {
      expect(value).toBeDefined()
    }
    // Filter to entries with a string `.name` (tools, adapter classes, exception constructors).
    const named = all.filter(
      (v) => typeof (v as { name?: unknown } | null | undefined)?.name === 'string'
    ) as Array<{ name: string }>
    // Sanity: there should be many tools (~45) wired in, plus LLM adapter + exception classes.
    expect(named.length).toBeGreaterThan(20)
    const names = named.map((t) => t.name)
    expect(names).toContain('calculate')
    expect(names).toContain('evaluate_katex')
    expect(names).toContain('color_contrast')
    expect(names).toContain('date_add')
  })
})
