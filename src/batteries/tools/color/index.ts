/**
 * Pre-constructed tools for color conversion and palette-oriented calculations.
 *
 * @module @nhtio/adk/batteries/tools/color
 *
 * @remarks
 * Pre-constructed bundled tools for the `color` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'

type RGB = { r: number; g: number; b: number }
type HSL = { h: number; s: number; l: number }

function hexToRgb(hex: string): RGB | null {
  const cleaned = hex.replace(/^#/, '')
  // Reject any non-hex character up front. `Number.parseInt('1Z', 16)` silently drops the trailing
  // 'Z' and returns 1 (passing the NaN check below), so '#1Z2Z3Z' would otherwise be accepted as a
  // bogus colour rgb(1, 2, 3).
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return null

  let r: number
  let g: number
  let b: number

  if (cleaned.length === 3) {
    r = Number.parseInt(cleaned[0] + cleaned[0], 16)
    g = Number.parseInt(cleaned[1] + cleaned[1], 16)
    b = Number.parseInt(cleaned[2] + cleaned[2], 16)
  } else if (cleaned.length === 6) {
    r = Number.parseInt(cleaned.slice(0, 2), 16)
    g = Number.parseInt(cleaned.slice(2, 4), 16)
    b = Number.parseInt(cleaned.slice(4, 6), 16)
  } else {
    return null
  }

  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null
  return { r, g, b }
}

function parseRgbString(input: string): RGB | null {
  const match = input.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i)
  if (!match) return null
  const r = Number.parseInt(match[1], 10)
  const g = Number.parseInt(match[2], 10)
  const b = Number.parseInt(match[3], 10)
  if (r > 255 || g > 255 || b > 255) return null
  return { r, g, b }
}

function parseHslString(input: string): HSL | null {
  const match = input.match(/^hsl\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?\s*\)$/i)
  if (!match) return null
  return {
    h: Number.parseInt(match[1], 10) % 360,
    s: Math.min(100, Number.parseInt(match[2], 10)),
    l: Math.min(100, Number.parseInt(match[3], 10)),
  }
}

const NAMED_COLORS: Record<string, string> = {
  'black': '#000000',
  'white': '#FFFFFF',
  'transparent': '#FFFFFF',
  'aqua': '#00FFFF',
  'magenta': '#FF00FF',
  'fuchsia': '#FF00FF',
  'silver': '#C0C0C0',
  'maroon': '#800000',
  'olive': '#808000',
  'navy': '#000080',
  'coral': '#FF7F50',
  'crimson': '#DC143C',
  'gold': '#FFD700',
  'ivory': '#FFFFF0',
  'khaki': '#F0E68C',
  'lavender': '#E6E6FA',
  'plum': '#DDA0DD',
  'salmon': '#FA8072',
  'sienna': '#A0522D',
  'tan': '#D2B48C',
  'tomato': '#FF6347',
  'turquoise': '#40E0D0',
  'violet': '#EE82EE',
  'wheat': '#F5DEB3',
  'red': '#F44336',
  'red-lighten-5': '#FFEBEE',
  'red-lighten-4': '#FFCDD2',
  'red-lighten-3': '#EF9A9A',
  'red-lighten-2': '#E57373',
  'red-lighten-1': '#EF5350',
  'red-darken-1': '#E53935',
  'red-darken-2': '#D32F2F',
  'red-darken-3': '#C62828',
  'red-darken-4': '#B71C1C',
  'red-accent-1': '#FF8A80',
  'red-accent-2': '#FF5252',
  'red-accent-3': '#FF1744',
  'red-accent-4': '#D50000',
  'pink': '#E91E63',
  'pink-lighten-5': '#FCE4EC',
  'pink-lighten-4': '#F8BBD0',
  'pink-lighten-3': '#F48FB1',
  'pink-lighten-2': '#F06292',
  'pink-lighten-1': '#EC407A',
  'pink-darken-1': '#D81B60',
  'pink-darken-2': '#C2185B',
  'pink-darken-3': '#AD1457',
  'pink-darken-4': '#880E4F',
  'pink-accent-1': '#FF80AB',
  'pink-accent-2': '#FF4081',
  'pink-accent-3': '#F50057',
  'pink-accent-4': '#C51162',
  'purple': '#9C27B0',
  'purple-lighten-5': '#F3E5F5',
  'purple-lighten-4': '#E1BEE7',
  'purple-lighten-3': '#CE93D8',
  'purple-lighten-2': '#BA68C8',
  'purple-lighten-1': '#AB47BC',
  'purple-darken-1': '#8E24AA',
  'purple-darken-2': '#7B1FA2',
  'purple-darken-3': '#6A1B9A',
  'purple-darken-4': '#4A148C',
  'purple-accent-1': '#EA80FC',
  'purple-accent-2': '#E040FB',
  'purple-accent-3': '#D500F9',
  'purple-accent-4': '#AA00FF',
  'deep-purple': '#673AB7',
  'deep-purple-lighten-5': '#EDE7F6',
  'deep-purple-lighten-4': '#D1C4E9',
  'deep-purple-lighten-3': '#B39DDB',
  'deep-purple-lighten-2': '#9575CD',
  'deep-purple-lighten-1': '#7E57C2',
  'deep-purple-darken-1': '#5E35B1',
  'deep-purple-darken-2': '#512DA8',
  'deep-purple-darken-3': '#4527A0',
  'deep-purple-darken-4': '#311B92',
  'deep-purple-accent-1': '#B388FF',
  'deep-purple-accent-2': '#7C4DFF',
  'deep-purple-accent-3': '#651FFF',
  'deep-purple-accent-4': '#6200EA',
  'indigo': '#3F51B5',
  'indigo-lighten-5': '#E8EAF6',
  'indigo-lighten-4': '#C5CAE9',
  'indigo-lighten-3': '#9FA8DA',
  'indigo-lighten-2': '#7986CB',
  'indigo-lighten-1': '#5C6BC0',
  'indigo-darken-1': '#3949AB',
  'indigo-darken-2': '#303F9F',
  'indigo-darken-3': '#283593',
  'indigo-darken-4': '#1A237E',
  'indigo-accent-1': '#8C9EFF',
  'indigo-accent-2': '#536DFE',
  'indigo-accent-3': '#3D5AFE',
  'indigo-accent-4': '#304FFE',
  'blue': '#2196F3',
  'blue-lighten-5': '#E3F2FD',
  'blue-lighten-4': '#BBDEFB',
  'blue-lighten-3': '#90CAF9',
  'blue-lighten-2': '#64B5F6',
  'blue-lighten-1': '#42A5F5',
  'blue-darken-1': '#1E88E5',
  'blue-darken-2': '#1976D2',
  'blue-darken-3': '#1565C0',
  'blue-darken-4': '#0D47A1',
  'blue-accent-1': '#82B1FF',
  'blue-accent-2': '#448AFF',
  'blue-accent-3': '#2979FF',
  'blue-accent-4': '#2962FF',
  'light-blue': '#03A9F4',
  'light-blue-lighten-5': '#E1F5FE',
  'light-blue-lighten-4': '#B3E5FC',
  'light-blue-lighten-3': '#81D4FA',
  'light-blue-lighten-2': '#4FC3F7',
  'light-blue-lighten-1': '#29B6F6',
  'light-blue-darken-1': '#039BE5',
  'light-blue-darken-2': '#0288D1',
  'light-blue-darken-3': '#0277BD',
  'light-blue-darken-4': '#01579B',
  'light-blue-accent-1': '#80D8FF',
  'light-blue-accent-2': '#40C4FF',
  'light-blue-accent-3': '#00B0FF',
  'light-blue-accent-4': '#0091EA',
  'cyan': '#00BCD4',
  'cyan-lighten-5': '#E0F7FA',
  'cyan-lighten-4': '#B2EBF2',
  'cyan-lighten-3': '#80DEEA',
  'cyan-lighten-2': '#4DD0E1',
  'cyan-lighten-1': '#26C6DA',
  'cyan-darken-1': '#00ACC1',
  'cyan-darken-2': '#0097A7',
  'cyan-darken-3': '#00838F',
  'cyan-darken-4': '#006064',
  'cyan-accent-1': '#84FFFF',
  'cyan-accent-2': '#18FFFF',
  'cyan-accent-3': '#00E5FF',
  'cyan-accent-4': '#00B8D4',
  'teal': '#009688',
  'teal-lighten-5': '#E0F2F1',
  'teal-lighten-4': '#B2DFDB',
  'teal-lighten-3': '#80CBC4',
  'teal-lighten-2': '#4DB6AC',
  'teal-lighten-1': '#26A69A',
  'teal-darken-1': '#00897B',
  'teal-darken-2': '#00796B',
  'teal-darken-3': '#00695C',
  'teal-darken-4': '#004D40',
  'teal-accent-1': '#A7FFEB',
  'teal-accent-2': '#64FFDA',
  'teal-accent-3': '#1DE9B6',
  'teal-accent-4': '#00BFA5',
  'green': '#4CAF50',
  'green-lighten-5': '#E8F5E9',
  'green-lighten-4': '#C8E6C9',
  'green-lighten-3': '#A5D6A7',
  'green-lighten-2': '#81C784',
  'green-lighten-1': '#66BB6A',
  'green-darken-1': '#43A047',
  'green-darken-2': '#388E3C',
  'green-darken-3': '#2E7D32',
  'green-darken-4': '#1B5E20',
  'green-accent-1': '#B9F6CA',
  'green-accent-2': '#69F0AE',
  'green-accent-3': '#00E676',
  'green-accent-4': '#00C853',
  'light-green': '#8BC34A',
  'light-green-lighten-5': '#F1F8E9',
  'light-green-lighten-4': '#DCEDC8',
  'light-green-lighten-3': '#C5E1A5',
  'light-green-lighten-2': '#AED581',
  'light-green-lighten-1': '#9CCC65',
  'light-green-darken-1': '#7CB342',
  'light-green-darken-2': '#689F38',
  'light-green-darken-3': '#558B2F',
  'light-green-darken-4': '#33691E',
  'light-green-accent-1': '#CCFF90',
  'light-green-accent-2': '#B2FF59',
  'light-green-accent-3': '#76FF03',
  'light-green-accent-4': '#64DD17',
  'lime': '#CDDC39',
  'lime-lighten-5': '#F9FBE7',
  'lime-lighten-4': '#F0F4C3',
  'lime-lighten-3': '#E6EE9C',
  'lime-lighten-2': '#DCE775',
  'lime-lighten-1': '#D4E157',
  'lime-darken-1': '#C0CA33',
  'lime-darken-2': '#AFB42B',
  'lime-darken-3': '#9E9D24',
  'lime-darken-4': '#827717',
  'lime-accent-1': '#F4FF81',
  'lime-accent-2': '#EEFF41',
  'lime-accent-3': '#C6FF00',
  'lime-accent-4': '#AEEA00',
  'yellow': '#FFEB3B',
  'yellow-lighten-5': '#FFFDE7',
  'yellow-lighten-4': '#FFF9C4',
  'yellow-lighten-3': '#FFF59D',
  'yellow-lighten-2': '#FFF176',
  'yellow-lighten-1': '#FFEE58',
  'yellow-darken-1': '#FDD835',
  'yellow-darken-2': '#FBC02D',
  'yellow-darken-3': '#F9A825',
  'yellow-darken-4': '#F57F17',
  'yellow-accent-1': '#FFFF8D',
  'yellow-accent-2': '#FFFF00',
  'yellow-accent-3': '#FFEA00',
  'yellow-accent-4': '#FFD600',
  'amber': '#FFC107',
  'amber-lighten-5': '#FFF8E1',
  'amber-lighten-4': '#FFECB3',
  'amber-lighten-3': '#FFE082',
  'amber-lighten-2': '#FFD54F',
  'amber-lighten-1': '#FFCA28',
  'amber-darken-1': '#FFB300',
  'amber-darken-2': '#FFA000',
  'amber-darken-3': '#FF8F00',
  'amber-darken-4': '#FF6F00',
  'amber-accent-1': '#FFE57F',
  'amber-accent-2': '#FFD740',
  'amber-accent-3': '#FFC400',
  'amber-accent-4': '#FFAB00',
  'orange': '#FF9800',
  'orange-lighten-5': '#FFF3E0',
  'orange-lighten-4': '#FFE0B2',
  'orange-lighten-3': '#FFCC80',
  'orange-lighten-2': '#FFB74D',
  'orange-lighten-1': '#FFA726',
  'orange-darken-1': '#FB8C00',
  'orange-darken-2': '#F57C00',
  'orange-darken-3': '#EF6C00',
  'orange-darken-4': '#E65100',
  'orange-accent-1': '#FFD180',
  'orange-accent-2': '#FFAB40',
  'orange-accent-3': '#FF9100',
  'orange-accent-4': '#FF6D00',
  'deep-orange': '#FF5722',
  'deep-orange-lighten-5': '#FBE9E7',
  'deep-orange-lighten-4': '#FFCCBC',
  'deep-orange-lighten-3': '#FFAB91',
  'deep-orange-lighten-2': '#FF8A65',
  'deep-orange-lighten-1': '#FF7043',
  'deep-orange-darken-1': '#F4511E',
  'deep-orange-darken-2': '#E64A19',
  'deep-orange-darken-3': '#D84315',
  'deep-orange-darken-4': '#BF360C',
  'deep-orange-accent-1': '#FF9E80',
  'deep-orange-accent-2': '#FF6E40',
  'deep-orange-accent-3': '#FF3D00',
  'deep-orange-accent-4': '#DD2C00',
  'brown': '#795548',
  'brown-lighten-5': '#EFEBE9',
  'brown-lighten-4': '#D7CCC8',
  'brown-lighten-3': '#BCAAA4',
  'brown-lighten-2': '#A1887F',
  'brown-lighten-1': '#8D6E63',
  'brown-darken-1': '#6D4C41',
  'brown-darken-2': '#5D4037',
  'brown-darken-3': '#4E342E',
  'brown-darken-4': '#3E2723',
  'blue-grey': '#607D8B',
  'blue-grey-lighten-5': '#ECEFF1',
  'blue-grey-lighten-4': '#CFD8DC',
  'blue-grey-lighten-3': '#B0BEC5',
  'blue-grey-lighten-2': '#90A4AE',
  'blue-grey-lighten-1': '#78909C',
  'blue-grey-darken-1': '#546E7A',
  'blue-grey-darken-2': '#455A64',
  'blue-grey-darken-3': '#37474F',
  'blue-grey-darken-4': '#263238',
  'grey': '#9E9E9E',
  'gray': '#9E9E9E',
  'grey-lighten-5': '#FAFAFA',
  'grey-lighten-4': '#F5F5F5',
  'grey-lighten-3': '#EEEEEE',
  'grey-lighten-2': '#E0E0E0',
  'grey-lighten-1': '#BDBDBD',
  'grey-darken-1': '#757575',
  'grey-darken-2': '#616161',
  'grey-darken-3': '#424242',
  'grey-darken-4': '#212121',
}

function parseColor(input: string): RGB | null {
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()

  if (NAMED_COLORS[lower]) {
    return hexToRgb(NAMED_COLORS[lower])
  }

  if (trimmed.startsWith('#')) return hexToRgb(trimmed)
  if (lower.startsWith('rgb(')) return parseRgbString(trimmed)
  if (lower.startsWith('hsl(')) {
    const hsl = parseHslString(trimmed)
    return hsl ? hslToRgb(hsl) : null
  }

  return hexToRgb(trimmed)
}

function rgbToHex(rgb: RGB): string {
  const toHex = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`
}

function rgbToHsl(rgb: RGB): HSL {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

  let h = 0
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

function hslToRgb(hsl: HSL): RGB {
  const h = hsl.h / 360
  const s = hsl.s / 100
  const l = hsl.l / 100

  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }

  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

function relativeLuminance(rgb: RGB): number {
  const srgb = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
}

function contrastRatio(c1: RGB, c2: RGB): number {
  const l1 = relativeLuminance(c1)
  const l2 = relativeLuminance(c2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function rotateHue(hsl: HSL, degrees: number): HSL {
  return { h: (hsl.h + degrees + 360) % 360, s: hsl.s, l: hsl.l }
}

function formatColor(rgb: RGB): string {
  const hex = rgbToHex(rgb)
  const hsl = rgbToHsl(rgb)
  return `${hex} / rgb(${rgb.r}, ${rgb.g}, ${rgb.b}) / hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`
}

/**
 * Compute the WCAG 2.1 contrast ratio between two colours.
 *
 * @remarks
 * Accepts hex (`#rgb`, `#rrggbb`), `rgb()`, `hsl()`, or one of the CSS / Material Design named
 * colours. Reports the ratio and pass/fail against WCAG AA and AAA at both normal and large text
 * sizes. If the foreground/background combination fails AA Normal (4.5:1), the tool suggests
 * lightened or darkened variants that would pass.
 */
export const colorContrastTool = new Tool({
  name: 'color_contrast',
  description:
    'Check the contrast ratio between two colors for WCAG accessibility compliance. Reports the contrast ratio and pass/fail for WCAG AA and AAA levels.',
  inputSchema: validator.object({
    foreground: validator
      .string()
      .required()
      .description('Foreground color (hex, rgb(), hsl(), or named color).'),
    background: validator
      .string()
      .required()
      .description('Background color (hex, rgb(), hsl(), or named color).'),
  }),
  handler: async (args) => {
    const { foreground, background } = args as { foreground: string; background: string }
    const fg = parseColor(foreground)
    const bg = parseColor(background)

    if (!fg) return `Error: could not parse foreground color "${foreground}".`
    if (!bg) return `Error: could not parse background color "${background}".`

    const ratio = contrastRatio(fg, bg)
    const rounded = Math.round(ratio * 100) / 100

    const aaLargeText = ratio >= 3
    const aaNormalText = ratio >= 4.5
    const aaaLargeText = ratio >= 4.5
    const aaaNormalText = ratio >= 7

    const lines = [
      `Foreground: ${formatColor(fg)}`,
      `Background: ${formatColor(bg)}`,
      `Contrast ratio: ${rounded}:1`,
      '',
      'WCAG 2.1 compliance:',
      `  AA  Normal text (4.5:1): ${aaNormalText ? 'PASS' : 'FAIL'}`,
      `  AA  Large text  (3.0:1): ${aaLargeText ? 'PASS' : 'FAIL'}`,
      `  AAA Normal text (7.0:1): ${aaaNormalText ? 'PASS' : 'FAIL'}`,
      `  AAA Large text  (4.5:1): ${aaaLargeText ? 'PASS' : 'FAIL'}`,
    ]

    if (!aaNormalText) {
      const fgHsl = rgbToHsl(fg)
      const bgHsl = rgbToHsl(bg)
      const fgLighter = fgHsl.l > bgHsl.l

      const suggestions: string[] = []
      if (fgLighter) {
        const lighter = hslToRgb({ ...fgHsl, l: Math.min(100, fgHsl.l + 15) })
        const darkerBg = hslToRgb({ ...bgHsl, l: Math.max(0, bgHsl.l - 15) })
        if (contrastRatio(lighter, bg) >= 4.5) {
          suggestions.push(
            `  Lighten foreground to ${rgbToHex(lighter)} (ratio: ${Math.round(contrastRatio(lighter, bg) * 100) / 100}:1)`
          )
        }
        if (contrastRatio(fg, darkerBg) >= 4.5) {
          suggestions.push(
            `  Darken background to ${rgbToHex(darkerBg)} (ratio: ${Math.round(contrastRatio(fg, darkerBg) * 100) / 100}:1)`
          )
        }
      } else {
        const darker = hslToRgb({ ...fgHsl, l: Math.max(0, fgHsl.l - 15) })
        const lighterBg = hslToRgb({ ...bgHsl, l: Math.min(100, bgHsl.l + 15) })
        if (contrastRatio(darker, bg) >= 4.5) {
          suggestions.push(
            `  Darken foreground to ${rgbToHex(darker)} (ratio: ${Math.round(contrastRatio(darker, bg) * 100) / 100}:1)`
          )
        }
        if (contrastRatio(fg, lighterBg) >= 4.5) {
          suggestions.push(
            `  Lighten background to ${rgbToHex(lighterBg)} (ratio: ${Math.round(contrastRatio(fg, lighterBg) * 100) / 100}:1)`
          )
        }
      }

      if (suggestions.length > 0) {
        lines.push('', 'Suggestions to reach AA Normal (4.5:1):')
        lines.push(...suggestions)
      }
    }

    return lines.join('\n')
  },
})

/**
 * Generate a colour palette from a base colour using a named harmony.
 *
 * @remarks
 * Supported schemes: `complementary`, `analogous`, `triadic`, `split-complementary`,
 * `monochromatic`. Each entry reports its hex, rgb, and hsl forms, plus the contrast ratio
 * relative to the base colour.
 */
export const colorSchemeTool = new Tool({
  name: 'color_scheme',
  description:
    'Generate a color palette from a base color. Supports complementary, analogous, triadic, split-complementary, and monochromatic schemes.',
  inputSchema: validator.object({
    color: validator
      .string()
      .required()
      .description('Base color (hex, rgb(), hsl(), or named color).'),
    scheme: validator
      .string()
      .valid('complementary', 'analogous', 'triadic', 'split-complementary', 'monochromatic')
      .required()
      .description('Type of color scheme to generate.'),
  }),
  handler: async (args) => {
    const { color, scheme } = args as {
      color: string
      scheme: 'complementary' | 'analogous' | 'triadic' | 'split-complementary' | 'monochromatic'
    }
    const rgb = parseColor(color)
    if (!rgb) return `Error: could not parse color "${color}".`

    const hsl = rgbToHsl(rgb)
    const palette: { label: string; rgb: RGB }[] = [{ label: 'Base', rgb }]

    switch (scheme) {
      case 'complementary':
        palette.push({ label: 'Complement', rgb: hslToRgb(rotateHue(hsl, 180)) })
        break

      case 'analogous':
        palette.push({ label: 'Analogous -30', rgb: hslToRgb(rotateHue(hsl, -30)) })
        palette.push({ label: 'Analogous +30', rgb: hslToRgb(rotateHue(hsl, 30)) })
        break

      case 'triadic':
        palette.push({ label: 'Triadic +120', rgb: hslToRgb(rotateHue(hsl, 120)) })
        palette.push({ label: 'Triadic +240', rgb: hslToRgb(rotateHue(hsl, 240)) })
        break

      case 'split-complementary':
        palette.push({ label: 'Split +150', rgb: hslToRgb(rotateHue(hsl, 150)) })
        palette.push({ label: 'Split +210', rgb: hslToRgb(rotateHue(hsl, 210)) })
        break

      case 'monochromatic':
        palette.push({ label: 'Light', rgb: hslToRgb({ ...hsl, l: Math.min(100, hsl.l + 20) }) })
        palette.push({ label: 'Lighter', rgb: hslToRgb({ ...hsl, l: Math.min(100, hsl.l + 35) }) })
        palette.push({ label: 'Dark', rgb: hslToRgb({ ...hsl, l: Math.max(0, hsl.l - 20) }) })
        palette.push({ label: 'Darker', rgb: hslToRgb({ ...hsl, l: Math.max(0, hsl.l - 35) }) })
        break
    }

    const lines = [`Color scheme: ${scheme}`, '']
    for (const entry of palette) {
      lines.push(`${entry.label}: ${formatColor(entry.rgb)}`)
    }

    if (palette.length > 1) {
      lines.push('', 'Contrast ratios with base:')
      for (const entry of palette.slice(1)) {
        const ratio = Math.round(contrastRatio(rgb, entry.rgb) * 100) / 100
        lines.push(`  ${entry.label}: ${ratio}:1`)
      }
    }

    return lines.join('\n')
  },
})

/**
 * Lighten or darken a colour by a percentage of HSL lightness.
 *
 * @remarks
 * `amount` is clamped to `[1, 100]`; `steps` is clamped to `[1, 10]`. With `steps > 1` the tool
 * emits a ramp of progressively-adjusted colours, useful for generating tint/shade scales.
 */
export const colorAdjustTool = new Tool({
  name: 'color_adjust',
  description:
    'Lighten or darken a color by a specified amount. Returns the adjusted color in hex, rgb, and hsl formats. Can generate multiple steps for a tint/shade scale.',
  inputSchema: validator.object({
    color: validator
      .string()
      .required()
      .description('Color to adjust (hex, rgb(), hsl(), or named color).'),
    action: validator
      .string()
      .valid('lighten', 'darken')
      .required()
      .description('Whether to lighten or darken the color.'),
    amount: validator
      .number()
      .default(15)
      .description('Amount to adjust per step (1-100, percentage of lightness). Default: 15.'),
    steps: validator
      .number()
      .default(1)
      .description('Generate multiple steps of adjustment (1-10). Default: 1.'),
  }),
  handler: async (args) => {
    const {
      color,
      action,
      amount: rawAmount,
      steps: rawSteps,
    } = args as {
      color: string
      action: 'lighten' | 'darken'
      amount: number
      steps: number
    }
    const rgb = parseColor(color)
    if (!rgb) return `Error: could not parse color "${color}".`

    const amount = Math.max(1, Math.min(100, rawAmount))
    const steps = Math.max(1, Math.min(10, rawSteps))
    const hsl = rgbToHsl(rgb)

    const lines = [`Original: ${formatColor(rgb)}`]

    for (let i = 1; i <= steps; i++) {
      const delta = amount * i
      const newL = action === 'lighten' ? Math.min(100, hsl.l + delta) : Math.max(0, hsl.l - delta)
      const adjusted = hslToRgb({ ...hsl, l: newL })
      const label =
        steps === 1
          ? `${action === 'lighten' ? 'Lightened' : 'Darkened'} (${delta}%)`
          : `Step ${i} (${action} ${delta}%)`
      lines.push(`${label}: ${formatColor(adjusted)}`)
    }

    return lines.join('\n')
  },
})
