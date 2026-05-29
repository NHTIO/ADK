import { describe, expect, it } from 'vitest'
import * as toolsBarrel from '../../../../src/batteries/tools'
import { calculateTool, evaluateKatexTool } from '../../../../src/batteries/tools'
import { calculateTool as calculateFromMath } from '../../../../src/batteries/tools/math'

describe('@nhtio/adk/batteries/tools', () => {
  it('aggregates exports from every category', () => {
    // A representative sample from several categories
    expect(toolsBarrel.calculateTool).toBeDefined()
    expect(toolsBarrel.evaluateKatexTool).toBeDefined()
    expect(toolsBarrel.colorContrastTool).toBeDefined()
    expect(toolsBarrel.formatTableTool).toBeDefined()
    expect(toolsBarrel.dateAddTool).toBeDefined()
    expect(toolsBarrel.statsDescribeTool).toBeDefined()
    expect(toolsBarrel.convertUnitTool).toBeDefined()
  })

  it('exposes the same tool instance whether imported from the barrel or the category subpath', () => {
    expect(calculateTool).toBe(calculateFromMath)
  })

  it('re-exports both math tools', () => {
    expect(calculateTool.name).toBe('calculate')
    expect(evaluateKatexTool.name).toBe('evaluate_katex')
  })
})
