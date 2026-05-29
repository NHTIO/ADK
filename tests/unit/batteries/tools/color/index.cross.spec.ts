import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  colorAdjustTool,
  colorContrastTool,
  colorSchemeTool,
} from '../../../../../src/batteries/tools/color'

const runContrast = async (args: Record<string, unknown>): Promise<string> => {
  return (await colorContrastTool.executor(makeToolCtxStub())(args)) as string
}
const runScheme = async (args: Record<string, unknown>): Promise<string> => {
  return (await colorSchemeTool.executor(makeToolCtxStub())(args)) as string
}
const runAdjust = async (args: Record<string, unknown>): Promise<string> => {
  return (await colorAdjustTool.executor(makeToolCtxStub())(args)) as string
}

describe('colorContrastTool', () => {
  it('reports max contrast (21:1) for black on white', async () => {
    const out = await runContrast({ foreground: '#000000', background: '#FFFFFF' })
    expect(out).toContain('Contrast ratio: 21:1')
    expect(out).toContain('AA  Normal text (4.5:1): PASS')
    expect(out).toContain('AAA Normal text (7.0:1): PASS')
  })

  it('reports 1:1 for identical colors', async () => {
    const out = await runContrast({ foreground: '#888888', background: '#888888' })
    expect(out).toContain('Contrast ratio: 1:1')
    expect(out).toContain('AA  Normal text (4.5:1): FAIL')
  })

  it('accepts CSS named colors', async () => {
    const out = await runContrast({ foreground: 'black', background: 'white' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('accepts Material Design named colors', async () => {
    const out = await runContrast({ foreground: 'red', background: 'white' })
    expect(out).toMatch(/Contrast ratio: \d/)
  })

  it('accepts rgb() syntax', async () => {
    const out = await runContrast({ foreground: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('accepts hsl() syntax', async () => {
    const out = await runContrast({ foreground: 'hsl(0, 0%, 0%)', background: 'hsl(0, 0%, 100%)' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('emits suggestions when AA Normal fails', async () => {
    const out = await runContrast({ foreground: '#777777', background: '#FFFFFF' })
    expect(out).toContain('AA  Normal text (4.5:1): FAIL')
    expect(out).toContain('Suggestions to reach AA Normal')
  })

  it('does not emit suggestions when contrast passes AA Normal', async () => {
    const out = await runContrast({ foreground: '#000000', background: '#FFFFFF' })
    expect(out).not.toContain('Suggestions to reach AA Normal')
  })

  it('errors on unparseable foreground', async () => {
    const out = await runContrast({ foreground: 'not-a-color', background: '#FFF' })
    expect(out).toMatch(/^Error.*foreground/)
  })

  it('errors on unparseable background', async () => {
    const out = await runContrast({ foreground: '#000', background: 'not-a-color' })
    expect(out).toMatch(/^Error.*background/)
  })
})

describe('colorSchemeTool', () => {
  it('complementary yields the base and its 180° opposite', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'complementary' })
    expect(out).toContain('Color scheme: complementary')
    expect(out).toContain('Base:')
    expect(out).toContain('Complement:')
    expect(out).toContain('Contrast ratios with base:')
  })

  it('analogous yields three colors', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'analogous' })
    expect(out).toContain('Analogous -30')
    expect(out).toContain('Analogous +30')
  })

  it('triadic yields three evenly-spaced hues', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'triadic' })
    expect(out).toContain('Triadic +120')
    expect(out).toContain('Triadic +240')
  })

  it('split-complementary yields two split colors', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'split-complementary' })
    expect(out).toContain('Split +150')
    expect(out).toContain('Split +210')
  })

  it('monochromatic yields lighter/darker variants', async () => {
    const out = await runScheme({ color: '#3F51B5', scheme: 'monochromatic' })
    expect(out).toContain('Light')
    expect(out).toContain('Lighter')
    expect(out).toContain('Dark')
    expect(out).toContain('Darker')
  })

  it('schema rejects unknown scheme', async () => {
    await expect(runScheme({ color: '#FF0000', scheme: 'mystery' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('errors on unparseable color', async () => {
    const out = await runScheme({ color: 'nope', scheme: 'complementary' })
    expect(out).toMatch(/^Error/)
  })
})

describe('colorAdjustTool', () => {
  it('lighten increases lightness', async () => {
    const out = await runAdjust({ color: '#888888', action: 'lighten', amount: 20 })
    expect(out).toContain('Original:')
    expect(out).toContain('Lightened (20%)')
  })

  it('darken decreases lightness', async () => {
    const out = await runAdjust({ color: '#888888', action: 'darken', amount: 20 })
    expect(out).toContain('Darkened (20%)')
  })

  it('lightens black toward white', async () => {
    const out = await runAdjust({ color: '#000000', action: 'lighten', amount: 50 })
    // Lightening pure black by 50% lightness lands at neutral grey
    expect(out).toMatch(/#808080/i)
  })

  it('darkens white toward black', async () => {
    const out = await runAdjust({ color: '#FFFFFF', action: 'darken', amount: 50 })
    expect(out).toMatch(/#808080/i)
  })

  it('emits a multi-step ramp when steps > 1', async () => {
    const out = await runAdjust({ color: '#888888', action: 'lighten', amount: 10, steps: 3 })
    expect(out).toContain('Step 1 (lighten 10%)')
    expect(out).toContain('Step 2 (lighten 20%)')
    expect(out).toContain('Step 3 (lighten 30%)')
  })

  it('clamps amount to [1, 100]', async () => {
    const huge = await runAdjust({ color: '#888888', action: 'lighten', amount: 9999 })
    // Lightening any color by 100% of lightness produces white (#ffffff)
    expect(huge).toMatch(/#ffffff/i)
  })

  it('clamps steps to [1, 10]', async () => {
    const out = await runAdjust({ color: '#888888', action: 'lighten', amount: 5, steps: 99 })
    expect(out).toContain('Step 10')
    expect(out).not.toContain('Step 11')
  })

  it('uses default amount of 15 when omitted', async () => {
    const out = await runAdjust({ color: '#888888', action: 'lighten' })
    expect(out).toContain('Lightened (15%)')
  })

  it('schema rejects unknown action', async () => {
    await expect(runAdjust({ color: '#888888', action: 'invert' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('errors on unparseable color', async () => {
    const out = await runAdjust({ color: 'nope', action: 'lighten' })
    expect(out).toMatch(/^Error/)
  })
})
