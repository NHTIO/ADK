/**
 * Pre-constructed tools for converting values across common measurement units.
 *
 * @module @nhtio/adk/batteries/tools/unit_conversion
 *
 * @remarks
 * Pre-constructed bundled tools for the `unit_conversion` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'

type UnitDef = { category: string; factor: number; label: string }

const UNITS: Record<string, UnitDef> = {
  // Length (base: metre)
  m: { category: 'length', factor: 1, label: 'metres' },
  km: { category: 'length', factor: 1000, label: 'kilometres' },
  cm: { category: 'length', factor: 0.01, label: 'centimetres' },
  mm: { category: 'length', factor: 0.001, label: 'millimetres' },
  mi: { category: 'length', factor: 1609.344, label: 'miles' },
  ft: { category: 'length', factor: 0.3048, label: 'feet' },
  in: { category: 'length', factor: 0.0254, label: 'inches' },
  yd: { category: 'length', factor: 0.9144, label: 'yards' },
  nmi: { category: 'length', factor: 1852, label: 'nautical miles' },

  // Mass (base: gram)
  g: { category: 'mass', factor: 1, label: 'grams' },
  kg: { category: 'mass', factor: 1000, label: 'kilograms' },
  mg: { category: 'mass', factor: 0.001, label: 'milligrams' },
  t: { category: 'mass', factor: 1_000_000, label: 'metric tons' },
  lb: { category: 'mass', factor: 453.59237, label: 'pounds' },
  oz: { category: 'mass', factor: 28.349523125, label: 'ounces' },
  st: { category: 'mass', factor: 6350.29318, label: 'stone' },

  // Volume (base: litre)
  L: { category: 'volume', factor: 1, label: 'litres' },
  mL: { category: 'volume', factor: 0.001, label: 'millilitres' },
  m3: { category: 'volume', factor: 1000, label: 'cubic metres' },
  cm3: { category: 'volume', factor: 0.001, label: 'cubic centimetres' },
  gal: { category: 'volume', factor: 3.785411784, label: 'US gallons' },
  qt: { category: 'volume', factor: 0.946352946, label: 'US quarts' },
  pt: { category: 'volume', factor: 0.473176473, label: 'US pints' },
  cup: { category: 'volume', factor: 0.2365882365, label: 'US cups' },
  floz: { category: 'volume', factor: 0.029573529562, label: 'US fluid ounces' },
  tbsp: { category: 'volume', factor: 0.014786764781, label: 'tablespoons' },
  tsp: { category: 'volume', factor: 0.0049289215938, label: 'teaspoons' },

  // Speed (base: m/s)
  m_s: { category: 'speed', factor: 1, label: 'm/s' },
  km_h: { category: 'speed', factor: 1 / 3.6, label: 'km/h' },
  mph: { category: 'speed', factor: 0.44704, label: 'mph' },
  kn: { category: 'speed', factor: 0.514444, label: 'knots' },
  ft_s: { category: 'speed', factor: 0.3048, label: 'ft/s' },

  // Area (base: m²)
  m2: { category: 'area', factor: 1, label: 'm²' },
  km2: { category: 'area', factor: 1_000_000, label: 'km²' },
  cm2: { category: 'area', factor: 0.0001, label: 'cm²' },
  mm2: { category: 'area', factor: 0.000001, label: 'mm²' },
  ft2: { category: 'area', factor: 0.09290304, label: 'sq ft' },
  in2: { category: 'area', factor: 0.00064516, label: 'sq in' },
  yd2: { category: 'area', factor: 0.83612736, label: 'sq yd' },
  acre: { category: 'area', factor: 4046.8564224, label: 'acres' },
  ha: { category: 'area', factor: 10_000, label: 'hectares' },

  // Data storage (base: bit)
  bit: { category: 'data', factor: 1, label: 'bits' },
  B: { category: 'data', factor: 8, label: 'bytes' },
  KB: { category: 'data', factor: 8_000, label: 'kilobytes' },
  MB: { category: 'data', factor: 8_000_000, label: 'megabytes' },
  GB: { category: 'data', factor: 8_000_000_000, label: 'gigabytes' },
  TB: { category: 'data', factor: 8_000_000_000_000, label: 'terabytes' },
  KiB: { category: 'data', factor: 8 * 1024, label: 'kibibytes' },
  MiB: { category: 'data', factor: 8 * 1024 ** 2, label: 'mebibytes' },
  GiB: { category: 'data', factor: 8 * 1024 ** 3, label: 'gibibytes' },
  TiB: { category: 'data', factor: 8 * 1024 ** 4, label: 'tebibytes' },

  // Time (base: second)
  ms: { category: 'time', factor: 0.001, label: 'milliseconds' },
  s: { category: 'time', factor: 1, label: 'seconds' },
  min: { category: 'time', factor: 60, label: 'minutes' },
  h: { category: 'time', factor: 3600, label: 'hours' },
  d: { category: 'time', factor: 86400, label: 'days' },
  wk: { category: 'time', factor: 604800, label: 'weeks' },

  // Energy (base: joule)
  J: { category: 'energy', factor: 1, label: 'joules' },
  kJ: { category: 'energy', factor: 1000, label: 'kilojoules' },
  cal: { category: 'energy', factor: 4.184, label: 'calories' },
  kcal: { category: 'energy', factor: 4184, label: 'kilocalories' },
  Wh: { category: 'energy', factor: 3600, label: 'watt-hours' },
  kWh: { category: 'energy', factor: 3_600_000, label: 'kilowatt-hours' },
  BTU: { category: 'energy', factor: 1055.05585, label: 'BTU' },

  // Pressure (base: pascal)
  Pa: { category: 'pressure', factor: 1, label: 'pascals' },
  kPa: { category: 'pressure', factor: 1000, label: 'kilopascals' },
  MPa: { category: 'pressure', factor: 1_000_000, label: 'megapascals' },
  bar: { category: 'pressure', factor: 100_000, label: 'bar' },
  psi: { category: 'pressure', factor: 6894.757, label: 'psi' },
  atm: { category: 'pressure', factor: 101325, label: 'atm' },
  mmHg: { category: 'pressure', factor: 133.322, label: 'mmHg' },

  // Angle (base: radian)
  rad: { category: 'angle', factor: 1, label: 'radians' },
  deg: { category: 'angle', factor: Math.PI / 180, label: 'degrees' },
  grad: { category: 'angle', factor: Math.PI / 200, label: 'gradians' },
}

const TEMP_UNITS = new Set(['C', 'F', 'K'])
type TempUnit = 'C' | 'F' | 'K'
const TEMP_LABELS: Record<TempUnit, string> = { C: '°C', F: '°F', K: 'K' }

function toKelvin(value: number, unit: TempUnit): number {
  if (unit === 'C') return value + 273.15
  if (unit === 'F') return (value - 32) * (5 / 9) + 273.15
  return value
}

function fromKelvin(kelvin: number, unit: TempUnit): number {
  if (unit === 'C') return kelvin - 273.15
  if (unit === 'F') return (kelvin - 273.15) * (9 / 5) + 32
  return kelvin
}

const ALL_UNIT_KEYS = [...Object.keys(UNITS), 'C', 'F', 'K'].join(', ')

/**
 * Convert a numeric value between units of the same physical category.
 *
 * @remarks
 * Supported categories: length, mass, volume, temperature, speed, area, data, time, energy,
 * pressure, angle. Uses static conversion tables — no external data required. Temperature is
 * handled specially via a Kelvin intermediate to preserve precision across `C`/`F`/`K`.
 */
export const convertUnitTool = new Tool({
  name: 'convert_unit',
  description:
    'Convert a numeric value between units of the same category (length, mass, volume, temperature, speed, area, data, time, energy, pressure, angle). Uses static lookup tables — no external data required.',
  inputSchema: validator.object({
    value: validator.number().required().description('Numeric value to convert'),
    from: validator
      .string()
      .required()
      .description(`Source unit key. Supported keys: ${ALL_UNIT_KEYS}`),
    to: validator
      .string()
      .required()
      .description('Target unit key (must be in the same category as source)'),
  }),
  handler: async (args) => {
    const { value, from, to } = args as { value: number; from: string; to: string }

    if (TEMP_UNITS.has(from) || TEMP_UNITS.has(to)) {
      if (!TEMP_UNITS.has(from))
        return `Error: "${from}" is not a temperature unit. Use C, F, or K.`
      if (!TEMP_UNITS.has(to)) return `Error: "${to}" is not a temperature unit. Use C, F, or K.`
      const result = fromKelvin(toKelvin(value, from as TempUnit), to as TempUnit)
      const rounded = Number.parseFloat(result.toPrecision(10))
      return `${value}${TEMP_LABELS[from as TempUnit]} = ${rounded}${TEMP_LABELS[to as TempUnit]}`
    }

    const fromDef = UNITS[from]
    const toDef = UNITS[to]
    if (!fromDef) return `Error: Unknown unit "${from}". Supported: ${ALL_UNIT_KEYS}`
    if (!toDef) return `Error: Unknown unit "${to}". Supported: ${ALL_UNIT_KEYS}`
    if (fromDef.category !== toDef.category) {
      return `Error: Cannot convert "${from}" (${fromDef.category}) to "${to}" (${toDef.category}) — different categories.`
    }

    const inBase = value * fromDef.factor
    const result = inBase / toDef.factor
    const rounded = Number.parseFloat(result.toPrecision(10))
    return `${value} ${fromDef.label} = ${rounded} ${toDef.label}`
  },
})
