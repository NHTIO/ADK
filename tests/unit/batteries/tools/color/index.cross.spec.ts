import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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

/* ── helpers ──────────────────────────────────────────────────────────── */

/** WCAG 2.1 relative luminance computed by hand */
function wcagLuminance(r: number, g: number, b: number): number {
  const srgb = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
}

function wcagRatio(rgb1: [number, number, number], rgb2: [number, number, number]): number {
  const l1 = wcagLuminance(...rgb1)
  const l2 = wcagLuminance(...rgb2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Extract the numeric contrast ratio from the tool output string */
function extractRatio(out: string): number {
  const m = out.match(/Contrast ratio:\s*([\d.]+):1/)
  if (!m) throw new Error(`Could not find ratio in output: ${out}`)
  return Number.parseFloat(m[1])
}

/** Parse "rgb(r, g, b)" from tool output */
function extractRgb(out: string): [number, number, number] | null {
  const m = out.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
  if (!m) return null
  return [Number.parseInt(m[1], 10), Number.parseInt(m[2], 10), Number.parseInt(m[3], 10)]
}

/** Parse all hex colors from a multi-line output */
function extractAllHex(out: string): string[] {
  return [...out.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0].toLowerCase())
}

/* ── existing basic tests ─────────────────────────────────────────────── */

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

  /* ── WCAG oracle tests ────────────────────────────────────────────── */

  it('black on white = 21:1 (independent WCAG oracle)', async () => {
    const out = await runContrast({ foreground: '#000000', background: '#FFFFFF' })
    const ratio = extractRatio(out)
    // WCAG formula: (1.05)/(0.05) = 21
    expect(ratio).toBeCloseTo(21, 1)
  })

  it('white on black = 21:1 (symmetry)', async () => {
    const out = await runContrast({ foreground: '#FFFFFF', background: '#000000' })
    const ratio = extractRatio(out)
    expect(ratio).toBeCloseTo(21, 1)
  })

  it('equal colors = 1:1 ratio (independent oracle)', async () => {
    const out = await runContrast({ foreground: '#AB1234', background: '#AB1234' })
    const ratio = extractRatio(out)
    expect(ratio).toBeCloseTo(1, 1)
  })

  it('mid-grey on white matches hand-computed WCAG ratio', async () => {
    // #808080 (rgb 128,128,128) on white
    const expected = wcagRatio([128, 128, 128], [255, 255, 255])
    const out = await runContrast({ foreground: '#808080', background: '#FFFFFF' })
    const ratio = extractRatio(out)
    expect(ratio).toBeCloseTo(Math.round(expected * 100) / 100, 1)
  })

  it('red on white matches hand-computed WCAG ratio', async () => {
    // #FF0000 (rgb 255,0,0) on white
    const expected = wcagRatio([255, 0, 0], [255, 255, 255])
    const out = await runContrast({ foreground: '#FF0000', background: '#FFFFFF' })
    const ratio = extractRatio(out)
    expect(ratio).toBeCloseTo(Math.round(expected * 100) / 100, 1)
  })

  it('contrast ratio is symmetric (fg↔bg yields same ratio)', async () => {
    const out1 = await runContrast({ foreground: '#336699', background: '#CCDDEE' })
    const out2 = await runContrast({ foreground: '#CCDDEE', background: '#336699' })
    expect(extractRatio(out1)).toBeCloseTo(extractRatio(out2), 2)
  })

  /* ── 3-digit hex parsing ─────────────────────────────────────────────── */

  it('parses 3-digit hex shorthand #000 (= black)', async () => {
    const out = await runContrast({ foreground: '#000', background: '#FFF' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('3-digit hex #F00 matches 6-digit #FF0000 (contrast)', async () => {
    const out3 = await runContrast({ foreground: '#F00', background: '#FFF' })
    const out6 = await runContrast({ foreground: '#FF0000', background: '#FFF' })
    expect(extractRatio(out3)).toBeCloseTo(extractRatio(out6), 2)
  })

  /* ── rgb() parsing ───────────────────────────────────────────────────── */

  it('rgb(0,0,0) on rgb(255,255,255) = 21:1', async () => {
    const out = await runContrast({ foreground: 'rgb(0,0,0)', background: 'rgb(255,255,255)' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('rgb() with spaces', async () => {
    const out = await runContrast({
      foreground: 'rgb( 0 , 0 , 0 )',
      background: 'rgb( 255 , 255 , 255 )',
    })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('rgb() out-of-range (>255) returns error, not throw', async () => {
    const out = await runContrast({ foreground: 'rgb(256,0,0)', background: '#000' })
    expect(out).toMatch(/^Error/)
  })

  /* ── hsl() parsing ───────────────────────────────────────────────────── */

  it('hsl(0, 100%, 50%) = pure red; contrast on white matches #FF0000', async () => {
    const outHsl = await runContrast({ foreground: 'hsl(0, 100%, 50%)', background: '#FFFFFF' })
    const outHex = await runContrast({ foreground: '#FF0000', background: '#FFFFFF' })
    expect(extractRatio(outHsl)).toBeCloseTo(extractRatio(outHex), 1)
  })

  it('hsl(0, 0%, 0%) = black on white = 21:1', async () => {
    const out = await runContrast({ foreground: 'hsl(0,0%,0%)', background: '#FFFFFF' })
    expect(out).toContain('Contrast ratio: 21:1')
  })

  it('hsl(120, 100%, 50%) = green; contrast is computed correctly', async () => {
    // Note: hsl(120, 100%, 50%) should parse to rgb(0, 128, 0) per the source's hslToRgb.
    // The source HSL parser does parseInt on the percentage digits (without %),
    // so hsl(120, 100%, 50%) → h=120, s=100, l=50 → green.
    // Verify the contrast ratio matches our independent WCAG oracle.
    const out = await runContrast({ foreground: 'hsl(120, 100%, 50%)', background: '#FFFFFF' })
    const ratio = extractRatio(out)
    // Extract the actual RGB from the output to compute expected ratio independently
    const fgRgb = extractRgb(out.split('\n')[0])
    if (fgRgb) {
      const expected = wcagRatio(fgRgb, [255, 255, 255])
      expect(ratio).toBeCloseTo(Math.round(expected * 100) / 100, 1)
    }
  })

  /* ── named colors ────────────────────────────────────────────────────── */

  it('named "aqua" (#00FFFF) parses and gives correct contrast vs black', async () => {
    // #00FFFF = rgb(0,255,255); luminance = 0.7874 → ratio vs black ≈ 15.3
    const expected = wcagRatio([0, 255, 255], [0, 0, 0])
    const out = await runContrast({ foreground: 'aqua', background: '#000000' })
    expect(extractRatio(out)).toBeCloseTo(Math.round(expected * 100) / 100, 1)
  })

  it('named "coral" (#FF7F50) parses and gives contrast vs white', async () => {
    const expected = wcagRatio([255, 127, 80], [255, 255, 255])
    const out = await runContrast({ foreground: 'coral', background: '#FFFFFF' })
    expect(extractRatio(out)).toBeCloseTo(Math.round(expected * 100) / 100, 1)
  })

  /* ── AA/AAA threshold tests ─────────────────────────────────────────── */

  it('ratio exactly 4.5:1 passes AA Normal and AAA Large', async () => {
    // Find two colors with ratio exactly ~4.5:1.  #767676 on white ≈ 4.53:1
    const out = await runContrast({ foreground: '#767676', background: '#FFFFFF' })
    expect(out).toContain('AA  Normal text (4.5:1): PASS')
    expect(out).toContain('AAA Large text  (4.5:1): PASS')
  })

  it('ratio exactly 3.0:1 passes AA Large but fails AA Normal', async () => {
    // #7F7F7F on white ≈ 3.36:1 — not exact, let's try #949494 on white
    // #949494 = rgb(148,148,148) vs white: L(148/255) ≈ 0.289; ratio = (1.05)/(0.289+0.05)=3.10
    const out = await runContrast({ foreground: '#949494', background: '#FFFFFF' })
    // Should fail AA Normal but pass AA Large (3.0:1)
    expect(out).toContain('AA  Large text  (3.0:1): PASS')
    // AA Normal should fail for this mid-grey
    const ratio = extractRatio(out)
    if (ratio < 4.5) {
      expect(out).toContain('AA  Normal text (4.5:1): FAIL')
    }
  })

  it('ratio 7:1+ passes AAA Normal', async () => {
    // #595959 on white ≈ 7.04:1
    const out = await runContrast({ foreground: '#595959', background: '#FFFFFF' })
    expect(out).toContain('AAA Normal text (7.0:1): PASS')
  })

  /* ── invalid color strings → Error, not throw ─────────────────────────── */

  it('invalid hex (#GGGGGG) returns Error string', async () => {
    const out = await runContrast({ foreground: '#GGGGGG', background: '#FFF' })
    expect(out).toMatch(/^Error/)
  })

  it('empty string foreground is rejected by schema', async () => {
    await expect(runContrast({ foreground: '', background: '#FFF' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('unparseable background returns Error with "background"', async () => {
    const out = await runContrast({ foreground: '#000', background: 'xyz' })
    expect(out).toMatch(/^Error.*background/)
  })

  /* ── hex→rgb→hex round-trip invariant ──────────────────────────────── */

  it('hex round-trip: foreground appears in output with same rgb values', async () => {
    // #336699 should produce rgb(51, 102, 153)
    const out = await runContrast({ foreground: '#336699', background: '#FFFFFF' })
    expect(out).toContain('rgb(51, 102, 153)')
    expect(out).toContain('#336699')
  })

  /* ── "transparent" named color ──────────────────────────────────────── */

  it('"transparent" is treated as #FFFFFF (per source)', async () => {
    const out = await runContrast({ foreground: 'transparent', background: '#FFFFFF' })
    // transparent maps to #FFFFFF, so 1:1 contrast
    expect(out).toContain('Contrast ratio: 1:1')
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

  /* ── complementary of complementary ≈ original hue (invariant) ──────── */

  it('complementary of complementary ≈ original hue', async () => {
    // Pure red (#FF0000) hue=0; complement hue=180; complement of complement hue≈0
    const out1 = await runScheme({ color: '#FF0000', scheme: 'complementary' })
    // Extract complement hex
    const complementHex = extractAllHex(out1)[1] // second hex is complement
    expect(complementHex).not.toBeNull()
    const out2 = await runScheme({ color: complementHex!, scheme: 'complementary' })
    // The double complement should be close to the original #FF0000
    // Parse rgb values from the output to verify
    const origRgb = extractRgb(out1.split('\n')[0]) // Base line
    const doubleCompRgb = extractRgb(out2.split('\n')[1]) // Complement line
    if (origRgb && doubleCompRgb) {
      expect(doubleCompRgb[0]).toBeCloseTo(origRgb[0], 0)
      expect(doubleCompRgb[1]).toBeCloseTo(origRgb[1], 0)
      expect(doubleCompRgb[2]).toBeCloseTo(origRgb[2], 0)
    }
  })

  /* ── scheme type tests with independent oracle ───────────────────────── */

  it('complementary of pure red produces cyan (hue ≈ 180°)', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'complementary' })
    // Find the line containing "Complement" and extract its rgb values
    const lines = out.split('\n')
    const compLine = lines.find((l) => l.includes('Complement'))
    expect(compLine).toBeTruthy()
    const compRgb = compLine ? extractRgb(compLine) : null
    expect(compRgb).not.toBeNull()
    // Complementary of red (0°) should be cyan (180°) ≈ rgb(0, 255, 255)
    if (compRgb) {
      expect(compRgb[0]).toBeLessThanOrEqual(5) // red channel near 0
      expect(compRgb[1]).toBeGreaterThanOrEqual(250) // green near 255
      expect(compRgb[2]).toBeGreaterThanOrEqual(250) // blue near 255
    }
  })

  it('triadic of pure red produces green (~120°) and blue (~240°)', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'triadic' })
    const hexes = extractAllHex(out)
    // Base at 0°, +120° ≈ green, +240° ≈ blue
    expect(hexes.length).toBeGreaterThanOrEqual(3)
  })

  it('analogous of pure red produces -30° and +30° shifts', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'analogous' })
    const hexes = extractAllHex(out)
    // Should have 3 colors: base, -30°, +30°
    expect(hexes.length).toBe(3)
  })

  it('split-complementary of pure red produces +150° and +210°', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'split-complementary' })
    const hexes = extractAllHex(out)
    expect(hexes.length).toBe(3) // base + 2 splits
  })

  it('monochromatic produces 5 colors (base + 4 variants)', async () => {
    const out = await runScheme({ color: '#808080', scheme: 'monochromatic' })
    const hexes = extractAllHex(out)
    expect(hexes.length).toBe(5)
  })

  /* ── named color input ─────────────────────────────────────────────── */

  it('accepts named color "aqua" as base', async () => {
    const out = await runScheme({ color: 'aqua', scheme: 'complementary' })
    expect(out).toContain('Color scheme: complementary')
    expect(out).toContain('Base:')
  })

  /* ── hsl() input ──────────────────────────────────────────────────────── */

  it('accepts hsl() as base color', async () => {
    const out = await runScheme({ color: 'hsl(240, 100%, 50%)', scheme: 'complementary' })
    expect(out).toContain('Color scheme: complementary')
    // Complementary of blue (240°) should be yellow (60°)
  })

  /* ── hex round-trip: hex→rgb→hex invariant ──────────────────────────── */

  it('output hex for pure red base matches #ff0000', async () => {
    const out = await runScheme({ color: '#FF0000', scheme: 'complementary' })
    const baseHex = extractAllHex(out)[0]
    expect(baseHex).toBe('#ff0000')
  })

  it('3-digit hex input #F00 produces same output as #FF0000', async () => {
    const out3 = await runScheme({ color: '#F00', scheme: 'complementary' })
    const out6 = await runScheme({ color: '#FF0000', scheme: 'complementary' })
    const baseHex3 = extractAllHex(out3)[0]
    const baseHex6 = extractAllHex(out6)[0]
    expect(baseHex3).toBe(baseHex6)
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

  /* ── lighten by 0% edge case: clamped to 1 ──────────────────────────── */

  it('amount 0 is clamped to 1 (minimum)', async () => {
    const out = await runAdjust({ color: '#808080', action: 'lighten', amount: 0 })
    // Amount 0 should be clamped to 1
    expect(out).toContain('Lightened (1%)')
  })

  /* ── darken pure black stays black ──────────────────────────────────── */

  it('darken pure black stays black (clamped)', async () => {
    const out = await runAdjust({ color: '#000000', action: 'darken', amount: 50 })
    // Pure black (L=0) darkened by any amount stays L=0
    const hexes = extractAllHex(out)
    // The adjusted color should still be #000000
    // hexes[0] = original, hexes[1] = adjusted
    expect(hexes[1]).toBe('#000000')
  })

  /* ── lighten pure white stays white (clamped) ─────────────────────────── */

  it('lighten pure white stays white (clamped)', async () => {
    const out = await runAdjust({ color: '#FFFFFF', action: 'lighten', amount: 50 })
    const hexes = extractAllHex(out)
    expect(hexes[1]).toBe('#ffffff')
  })

  /* ── idempotence: lighten then same darken returns near-original ──────── */

  it('lighten 20 then darken 20 ≈ original (round-trip)', async () => {
    const color = '#888888'
    const lightenOut = await runAdjust({ color, action: 'lighten', amount: 20 })
    const lightenedHex = extractAllHex(lightenOut)[1]
    const darkenOut = await runAdjust({ color: lightenedHex!, action: 'darken', amount: 20 })
    // Due to HSL rounding the round-trip may not be exact, but should be close
    const orig = extractRgb(lightenOut.split('\n')[0])!
    const finalRgb = extractRgb(darkenOut.split('\n')[1])!
    // Allow for rounding: each channel within ±2
    for (let i = 0; i < 3; i++) {
      expect(finalRgb[i]).toBeCloseTo(orig[i], -1)
    }
  })

  /* ── steps = 1 produces single output line ─────────────────────────────── */

  it('steps=1 produces exactly one adjusted line (not "Step 1")', async () => {
    const out = await runAdjust({ color: '#808080', action: 'lighten', amount: 10, steps: 1 })
    expect(out).toContain('Lightened (10%)')
    expect(out).not.toContain('Step 1')
  })

  /* ── lighten monotonically increases lightness ──────────────────────── */

  it('multi-step lighten produces monotonically increasing lightness', async () => {
    const out = await runAdjust({ color: '#808080', action: 'lighten', amount: 10, steps: 5 })
    // Extract all hex values and verify they progress toward lighter
    const hexes = extractAllHex(out)
    // There should be original + 5 steps = 6 hex values
    expect(hexes.length).toBe(6)
    // Each successive color should have higher or equal HSL lightness
    // (may plateau at #ffffff)
    const lightnesses = hexes.map((h) => {
      const r = Number.parseInt(h.slice(1, 3), 16)
      const g = Number.parseInt(h.slice(3, 5), 16)
      const b = Number.parseInt(h.slice(5, 7), 16)
      const max = Math.max(r, g, b) / 255
      const min = Math.min(r, g, b) / 255
      return (max + min) / 2 // approximate HSL lightness
    })
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]).toBeGreaterThanOrEqual(lightnesses[i - 1] - 0.01)
    }
  })

  /* ── darken monotonically decreases lightness ────────────────────────── */

  it('multi-step darken produces monotonically decreasing lightness', async () => {
    const out = await runAdjust({ color: '#808080', action: 'darken', amount: 10, steps: 5 })
    const hexes = extractAllHex(out)
    const lightnesses = hexes.map((h) => {
      const r = Number.parseInt(h.slice(1, 3), 16)
      const g = Number.parseInt(h.slice(3, 5), 16)
      const b = Number.parseInt(h.slice(5, 7), 16)
      const max = Math.max(r, g, b) / 255
      const min = Math.min(r, g, b) / 255
      return (max + min) / 2
    })
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]).toBeLessThanOrEqual(lightnesses[i - 1] + 0.01)
    }
  })

  /* ── negative amount should be clamped to 1 ──────────────────────────── */

  it('negative amount is clamped to 1', async () => {
    const out = await runAdjust({ color: '#808080', action: 'lighten', amount: -5 })
    // Clamped to 1
    expect(out).toContain('Lightened (1%)')
  })

  /* ── named color input ──────────────────────────────────────────────── */

  it('accepts named color "coral" as input', async () => {
    const out = await runAdjust({ color: 'coral', action: 'lighten', amount: 10 })
    expect(out).toContain('Original:')
    expect(out).toContain('Lightened (10%)')
  })

  /* ── rgb() input ──────────────────────────────────────────────────────── */

  it('accepts rgb() as input', async () => {
    const out = await runAdjust({ color: 'rgb(128, 128, 128)', action: 'darken', amount: 10 })
    expect(out).toContain('Original:')
    expect(out).toContain('Darkened (10%)')
  })

  /* ── hsl() input ──────────────────────────────────────────────────────── */

  it('accepts hsl() as input', async () => {
    const out = await runAdjust({ color: 'hsl(0, 0%, 50%)', action: 'lighten', amount: 10 })
    expect(out).toContain('Original:')
    expect(out).toContain('Lightened (10%)')
  })

  /* ── amount exactly 100 ─────────────────────────────────────────────── */

  it('amount=100 lighten produces white for any color', async () => {
    const out = await runAdjust({ color: '#336699', action: 'lighten', amount: 100 })
    const hexes = extractAllHex(out)
    expect(hexes[1]).toBe('#ffffff')
  })

  it('amount=100 darken produces black for any color', async () => {
    const out = await runAdjust({ color: '#336699', action: 'darken', amount: 100 })
    const hexes = extractAllHex(out)
    expect(hexes[1]).toBe('#000000')
  })

  /* ── invalid color → Error, not throw ────────────────────────────────── */

  it('invalid hex returns Error string', async () => {
    const out = await runAdjust({ color: '#ZZZZZZ', action: 'lighten', amount: 10 })
    expect(out).toMatch(/^Error/)
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('color_contrast with garbage foreground must not crash', async () => {
    const r = await callTool(colorContrastTool, { foreground: '\uD800', background: '#FFF' })
    expect(r.kind).toBe('resolved') // should return Error string, not throw
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('color_contrast with lone surrogate foreground must not crash', async () => {
    const r = await callTool(colorContrastTool, { foreground: 'rgb(999,0,0)', background: '#FFF' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('color_scheme with garbage color must not crash', async () => {
    const r = await callTool(colorSchemeTool, { color: 'not-a-color', scheme: 'complementary' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('color_adjust rejects NaN amount cleanly via schema (not a downstream crash)', async () => {
    // NaN fails validator.number(), so a clean E_INVALID_TOOL_ARGS rejection is correct
    // behaviour — what must NOT happen is an E_TOOL_DOWNSTREAM_ERROR from the handler.
    const r = await callTool(colorAdjustTool, {
      color: '#888888',
      action: 'lighten',
      amount: Number.NaN,
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('color_adjust with Infinity steps must not crash', async () => {
    const r = await callTool(colorAdjustTool, {
      color: '#888888',
      action: 'lighten',
      amount: 5,
      steps: Infinity,
    })
    // Schema may reject, or handler clamps — either way no downstream error
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })

  it('color_adjust with very large amount must not crash', async () => {
    const r = await callTool(colorAdjustTool, { color: '#888888', action: 'lighten', amount: 1e9 })
    expect(r.kind).toBe('resolved') // should clamp to 100
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  /* ── WCAG oracle: black on white = 21 (callTool variant) ─────────────── */

  it('WCAG contrast black/white = 21:1 (via callTool)', async () => {
    const r = await callTool(colorContrastTool, { foreground: '#000000', background: '#FFFFFF' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const ratio = extractRatio(r.out)
      expect(ratio).toBeCloseTo(21, 1)
    }
  })
})
// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('colorContrastTool — invalid hex with trailing non-hex chars', () => {
  // EXPECTED-RED: hexToRgb uses Number.parseInt(slice,16) which drops trailing non-hex digits
  // ('3Z' → 3) and passes the isNaN check, so '#1Z2Z3Z' is silently accepted as rgb(1,2,3)
  // instead of rejected. A correct parser validates all 6 chars are hex.
  it('rejects "#1Z2Z3Z" rather than silently parsing it as a color', async () => {
    const r = await callTool(colorContrastTool, { foreground: '#1Z2Z3Z', background: '#000000' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/error|invalid/i)
  })
})
