import { describe, expect, it } from 'vitest'
import { makeToolCtxStub, callTool } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { convertUnitTool } from '../../../../../src/batteries/tools/unit_conversion'

const run = async (value: number, from: string, to: string): Promise<string> => {
  const ctx = makeToolCtxStub()
  const out = await convertUnitTool.executor(ctx)({ value, from, to })
  return out as string
}

describe('convertUnitTool', () => {
  describe('length', () => {
    it('1 km = 1000 m', async () => {
      expect(await run(1, 'km', 'm')).toContain('1000 metres')
    })

    it('1 mi ≈ 1609.344 m', async () => {
      const out = await run(1, 'mi', 'm')
      expect(out).toMatch(/1609\.344/)
    })

    it('100 cm = 1 m', async () => {
      const out = await run(100, 'cm', 'm')
      expect(out).toMatch(/=\s*1\s+metres/)
    })

    it('1 ft = 12 in', async () => {
      const out = await run(1, 'ft', 'in')
      expect(out).toMatch(/=\s*12\s+inches/)
    })
  })

  describe('mass', () => {
    it('1 kg = 1000 g', async () => {
      expect(await run(1, 'kg', 'g')).toContain('1000 grams')
    })

    it('1 lb ≈ 453.59237 g', async () => {
      const out = await run(1, 'lb', 'g')
      expect(out).toMatch(/453\.59237/)
    })
  })

  describe('volume', () => {
    it('1 L = 1000 mL', async () => {
      expect(await run(1, 'L', 'mL')).toContain('1000 millilitres')
    })

    it('1 gal ≈ 3.7854118 L (default 8 significant digits)', async () => {
      const out = await run(1, 'gal', 'L')
      expect(out).toMatch(/3\.7854118/)
    })

    it('1 gal = 3.785411784 L at higher precision', async () => {
      const r = await callTool(convertUnitTool, { value: 1, from: 'gal', to: 'L', precision: 10 })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toContain('3.785411784')
    })
  })

  describe('temperature', () => {
    it('0 °C = 32 °F', async () => {
      const out = await run(0, 'C', 'F')
      expect(out).toMatch(/=\s*32°F/)
    })

    it('100 °C = 212 °F', async () => {
      const out = await run(100, 'C', 'F')
      expect(out).toMatch(/=\s*212°F/)
    })

    it('0 °C = 273.15 K', async () => {
      const out = await run(0, 'C', 'K')
      expect(out).toMatch(/=\s*273\.15K/)
    })

    it('273.15 K = 0 °C', async () => {
      const out = await run(273.15, 'K', 'C')
      expect(out).toMatch(/=\s*0°C/)
    })

    it('rejects converting a temperature unit to a non-temperature unit', async () => {
      const out = await run(100, 'C', 'm')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('not a temperature unit')
    })

    it('rejects converting a non-temperature unit to a temperature unit', async () => {
      const out = await run(100, 'm', 'C')
      expect(out).toMatch(/^Error/)
    })
  })

  describe('speed', () => {
    it('1 km/h ≈ 0.2777... m/s', async () => {
      const out = await run(1, 'km_h', 'm_s')
      expect(out).toMatch(/0\.2777/)
    })

    it('1 m/s = 3.6 km/h', async () => {
      const out = await run(1, 'm_s', 'km_h')
      expect(out).toMatch(/=\s*3\.6\s+km\/h/)
    })
  })

  describe('data', () => {
    it('1 B = 8 bits', async () => {
      expect(await run(1, 'B', 'bit')).toContain('8 bits')
    })

    it('1 KiB = 1024 bytes', async () => {
      expect(await run(1, 'KiB', 'B')).toContain('1024 bytes')
    })

    it('1 KB = 1000 bytes (decimal)', async () => {
      expect(await run(1, 'KB', 'B')).toContain('1000 bytes')
    })
  })

  describe('time', () => {
    it('1 h = 60 min', async () => {
      expect(await run(1, 'h', 'min')).toContain('60 minutes')
    })

    it('1 d = 86400 s', async () => {
      expect(await run(1, 'd', 's')).toContain('86400 seconds')
    })
  })

  describe('angle', () => {
    it('180 deg ≈ π rad', async () => {
      const out = await run(180, 'deg', 'rad')
      expect(out).toMatch(/3\.14159/)
    })
  })

  describe('cross-category rejection', () => {
    it('rejects converting between different categories (length to mass)', async () => {
      const out = await run(1, 'm', 'kg')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('different categories')
    })
  })

  describe('unknown unit', () => {
    it('returns an error string for an unknown source unit', async () => {
      const out = await run(1, 'totallyUnknown', 'm')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('Unknown unit')
    })

    it('returns an error string for an unknown target unit', async () => {
      const out = await run(1, 'm', 'totallyUnknown')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('Unknown unit')
    })
  })

  describe('schema rejection', () => {
    it('throws E_INVALID_TOOL_ARGS when value is not a number', async () => {
      const ctx = makeToolCtxStub()
      await expect(
        convertUnitTool.executor(ctx)({ value: 'not a number', from: 'm', to: 'km' })
      ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('throws E_INVALID_TOOL_ARGS when from is missing', async () => {
      const ctx = makeToolCtxStub()
      await expect(convertUnitTool.executor(ctx)({ value: 1, to: 'km' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('throws E_INVALID_TOOL_ARGS when to is missing', async () => {
      const ctx = makeToolCtxStub()
      await expect(convertUnitTool.executor(ctx)({ value: 1, from: 'm' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })

  describe('tool surface', () => {
    it('has name `convert_unit`', () => {
      expect(convertUnitTool.name).toBe('convert_unit')
    })
  })

  // ─── Extended oracle tests ────────────────────────────────────────────

  describe('length — oracle & round-trips', () => {
    // Oracle: 2 ft = 0.6096 m
    it('2 ft = 0.6096 m', async () => {
      const out = await run(2, 'ft', 'm')
      expect(out).toMatch(/0\.6096/)
    })

    // Oracle: 1 mi = 1.609344 km
    it('1 mi = 1.609344 km', async () => {
      const out = await run(1, 'mi', 'km')
      expect(out).toMatch(/1\.609344/)
    })

    // Oracle: 1 yd = 0.9144 m
    it('1 yd = 0.9144 m', async () => {
      const out = await run(1, 'yd', 'm')
      expect(out).toMatch(/0\.9144/)
    })

    // Oracle: 1 nmi = 1852 m
    it('1 nmi = 1852 m', async () => {
      const out = await run(1, 'nmi', 'm')
      expect(out).toMatch(/1852/)
    })

    // INVARIANT: A→B→A round-trip preserves value
    it('INVARIANT: ft→m→ft round-trip', async () => {
      const out1 = await run(5, 'ft', 'm')
      const mVal = Number.parseFloat(out1.match(/= ([\d.]+)/)![1])
      const out2 = await run(mVal, 'm', 'ft')
      const ftVal = Number.parseFloat(out2.match(/= ([\d.]+)/)![1])
      expect(ftVal).toBeCloseTo(5, 6)
    })
  })

  describe('mass — oracle', () => {
    // Oracle: 1 kg = 1000 g
    it('1 kg = 1000 g', async () => {
      const out = await run(1, 'kg', 'g')
      expect(out).toContain('1000 grams')
    })

    // Oracle: 1 lb = 16 oz
    it('1 lb = 16 oz (approximately)', async () => {
      const out = await run(1, 'lb', 'oz')
      expect(out).toMatch(/16/)
    })

    // Oracle: 1 t = 1,000,000 g
    it('1 metric ton = 1,000,000 g', async () => {
      const out = await run(1, 't', 'g')
      expect(out).toMatch(/1000000/)
    })

    // Oracle: 1 st (stone) = 14 lb
    it('1 stone ≈ 14 lb', async () => {
      const out = await run(1, 'st', 'lb')
      expect(out).toMatch(/14/)
    })
  })

  describe('volume — oracle', () => {
    // Oracle: 1 m3 = 1000 L
    it('1 m³ = 1000 L', async () => {
      const out = await run(1, 'm3', 'L')
      expect(out).toMatch(/1000/)
    })

    // Oracle: 1 cup = 48 tsp
    it('1 cup ≈ 48 tsp', async () => {
      const out = await run(1, 'cup', 'tsp')
      expect(out).toMatch(/48/)
    })

    // Oracle: 1 gal = 4 qt
    it('1 gal = 4 qt', async () => {
      const out = await run(1, 'gal', 'qt')
      expect(out).toMatch(/4/)
    })
  })

  describe('temperature — oracle & round-trips', () => {
    // Oracle: -40°C = -40°F (the point where C and F meet)
    it('-40°C = -40°F', async () => {
      const out = await run(-40, 'C', 'F')
      expect(out).toMatch(/-40°F/)
    })

    // Oracle: 212°F = 100°C
    it('212°F = 100°C', async () => {
      const out = await run(212, 'F', 'C')
      expect(out).toMatch(/100°C/)
    })

    // Oracle: 0 K = -273.15°C
    it('0 K = -273.15°C', async () => {
      const out = await run(0, 'K', 'C')
      expect(out).toMatch(/-273\.15°C/)
    })

    // INVARIANT: C→F→C round-trip
    it('INVARIANT: C→F→C round-trip preserves value', async () => {
      const out1 = await run(37.5, 'C', 'F')
      const fVal = Number.parseFloat(out1.match(/= ([\d.-]+)°F/)![1])
      const out2 = await run(fVal, 'F', 'C')
      const cVal = Number.parseFloat(out2.match(/= ([\d.-]+)°C/)![1])
      expect(cVal).toBeCloseTo(37.5, 4)
    })

    // K→K identity
    it('K→K identity', async () => {
      const out = await run(300, 'K', 'K')
      expect(out).toMatch(/= 300K/)
    })

    // Cross-category: temperature to length
    it('rejects C → m (cross-category)', async () => {
      const out = await run(100, 'C', 'm')
      expect(out).toMatch(/^Error/)
    })
  })

  describe('speed — oracle', () => {
    // Oracle: 1 mph = 1.609344 km/h
    it('1 mph ≈ 1.609344 km/h', async () => {
      const out = await run(1, 'mph', 'km_h')
      expect(out).toMatch(/1\.609344/)
    })

    // Oracle: 1 kn ≈ 1.852 km/h
    it('1 knot ≈ 1.852 km/h', async () => {
      const out = await run(1, 'kn', 'km_h')
      expect(out).toMatch(/1\.85[12]/)
    })

    // Oracle: 1 ft/s = 0.3048 m/s
    it('1 ft/s = 0.3048 m/s', async () => {
      const out = await run(1, 'ft_s', 'm_s')
      expect(out).toMatch(/0\.3048/)
    })
  })

  describe('area — oracle', () => {
    // Oracle: 1 km² = 1,000,000 m²
    it('1 km² = 1,000,000 m²', async () => {
      const out = await run(1, 'km2', 'm2')
      expect(out).toMatch(/1000000/)
    })

    // Oracle: 1 acre ≈ 4046.856 m²
    it('1 acre ≈ 4046.856 m²', async () => {
      const out = await run(1, 'acre', 'm2')
      expect(out).toMatch(/4046\.856/)
    })

    // Oracle: 1 ha = 10,000 m²
    it('1 ha = 10,000 m²', async () => {
      const out = await run(1, 'ha', 'm2')
      expect(out).toMatch(/10000/)
    })
  })

  describe('data — oracle & bit/byte base', () => {
    // Oracle: 1 GiB = 1073741824 B
    it('1 GiB = 1073741824 B', async () => {
      const out = await run(1, 'GiB', 'B')
      expect(out).toMatch(/1073741824/)
    })

    // Oracle: 1 GiB in bits = 8589934592 bits
    it('1 GiB = 8589934592 bits', async () => {
      const out = await run(1, 'GiB', 'bit')
      expect(out).toMatch(/8589934592/)
    })

    // Oracle: 1 MiB = 1048576 B (binary)
    it('1 MiB = 1048576 B', async () => {
      const out = await run(1, 'MiB', 'B')
      expect(out).toMatch(/1048576/)
    })

    // Oracle: 1 MB = 1000000 B (decimal, not binary)
    it('1 MB = 1000000 B (decimal)', async () => {
      const out = await run(1, 'MB', 'B')
      expect(out).toMatch(/1000000/)
    })

    // Oracle: 1 TB = 8,000,000,000,000 bits (decimal)
    it('1 TB = 8000000000000 bits', async () => {
      const out = await run(1, 'TB', 'bit')
      expect(out).toMatch(/8000000000000/)
    })

    // INVARIANT: bit↔byte round-trip
    it('INVARIANT: B→bit→B round-trip', async () => {
      const out1 = await run(256, 'B', 'bit')
      const bitVal = Number.parseFloat(out1.match(/= ([\d.]+)/)![1])
      const out2 = await run(bitVal, 'bit', 'B')
      const bVal = Number.parseFloat(out2.match(/= ([\d.]+)/)![1])
      expect(bVal).toBeCloseTo(256, 6)
    })
  })

  describe('time — oracle', () => {
    // Oracle: 1 wk = 7 d
    it('1 wk = 7 days', async () => {
      const out = await run(1, 'wk', 'd')
      expect(out).toMatch(/7 days/)
    })

    // Oracle: 1 ms = 0.001 s
    it('1 ms = 0.001 s', async () => {
      const out = await run(1, 'ms', 's')
      expect(out).toMatch(/0\.001 seconds/)
    })

    // INVARIANT: s→min→h round-trip
    it('INVARIANT: h→min→h round-trip', async () => {
      const out1 = await run(3, 'h', 'min')
      const minVal = Number.parseFloat(out1.match(/= ([\d.]+)/)![1])
      const out2 = await run(minVal, 'min', 'h')
      const hVal = Number.parseFloat(out2.match(/= ([\d.]+)/)![1])
      expect(hVal).toBeCloseTo(3, 6)
    })
  })

  describe('energy — oracle', () => {
    // Oracle: 1 kJ = 1000 J
    it('1 kJ = 1000 J', async () => {
      const out = await run(1, 'kJ', 'J')
      expect(out).toMatch(/1000 joules/)
    })

    // Oracle: 1 kcal = 1000 cal
    it('1 kcal = 1000 cal', async () => {
      const out = await run(1, 'kcal', 'cal')
      expect(out).toMatch(/1000 calories/)
    })

    // Oracle: 1 kWh = 3,600,000 J
    it('1 kWh = 3600000 J', async () => {
      const out = await run(1, 'kWh', 'J')
      expect(out).toMatch(/3600000/)
    })

    // Oracle: 1 Wh = 3600 J
    it('1 Wh = 3600 J', async () => {
      const out = await run(1, 'Wh', 'J')
      expect(out).toMatch(/3600/)
    })
  })

  describe('pressure — oracle', () => {
    // Oracle: 1 bar = 100 kPa
    it('1 bar = 100 kPa', async () => {
      const out = await run(1, 'bar', 'kPa')
      expect(out).toMatch(/100 kilopascals/)
    })

    // Oracle: 1 atm ≈ 101325 Pa
    it('1 atm = 101325 Pa', async () => {
      const out = await run(1, 'atm', 'Pa')
      expect(out).toMatch(/101325/)
    })

    // Oracle: 1 MPa = 1,000,000 Pa
    it('1 MPa = 1000000 Pa', async () => {
      const out = await run(1, 'MPa', 'Pa')
      expect(out).toMatch(/1000000/)
    })
  })

  describe('angle — oracle & round-trip', () => {
    // Oracle: 360 deg = 2π rad ≈ 6.283185307
    it('360 deg ≈ 2π rad', async () => {
      const out = await run(360, 'deg', 'rad')
      expect(out).toMatch(/6\.28318/)
    })

    // Oracle: 100 grad = 90 deg
    it('100 grad = 90 deg', async () => {
      const out = await run(100, 'grad', 'deg')
      expect(out).toMatch(/90 degrees/)
    })

    // INVARIANT: deg→rad→deg round-trip
    it('INVARIANT: deg→rad→deg round-trip', async () => {
      const out1 = await run(45, 'deg', 'rad')
      const radVal = Number.parseFloat(out1.match(/= ([\d.]+)/)![1])
      const out2 = await run(radVal, 'rad', 'deg')
      const degVal = Number.parseFloat(out2.match(/= ([\d.]+)/)![1])
      expect(degVal).toBeCloseTo(45, 6)
    })
  })

  describe('edge cases & invariants', () => {
    // Zero conversion
    it('0 m = 0 km', async () => {
      const out = await run(0, 'm', 'km')
      expect(out).toMatch(/0 kilometres/)
    })

    // Negative value
    it('-5 °C converts correctly', async () => {
      const out = await run(-5, 'C', 'F')
      // -5°C = 23°F
      expect(out).toMatch(/23°F/)
    })

    // Identity conversion: same unit
    it('identity: m → m', async () => {
      const out = await run(42, 'm', 'm')
      expect(out).toMatch(/42 metres/)
    })

    // Large values
    it('large values convert correctly', async () => {
      const out = await run(1000000, 'mm', 'km')
      expect(out).toMatch(/1 kilometre/)
    })

    // Fractional values
    it('fractional values: 0.5 km = 500 m', async () => {
      const out = await run(0.5, 'km', 'm')
      expect(out).toMatch(/500 metres/)
    })

    // Cross-category: mass to volume
    it('rejects kg → L (cross-category)', async () => {
      const out = await run(1, 'kg', 'L')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('different categories')
    })

    // Temperature mixed with non-temperature
    it('rejects K → m (temperature to length)', async () => {
      const out = await run(300, 'K', 'm')
      expect(out).toMatch(/^Error/)
      expect(out).toContain('not a temperature unit')
    })

    // mm to in (small values)
    it('1 mm ≈ 0.03937 in', async () => {
      const out = await run(1, 'mm', 'in')
      expect(out).toMatch(/0\.03937/)
    })
  })
})

// ─── callTool no-crash regression tests ───────────────────────────────

describe('unit_conversion — callTool no-crash edge cases', () => {
  it('cross-category conversion returns Error string, does not crash', async () => {
    const r = await callTool(convertUnitTool, { value: 1, from: 'm', to: 'kg' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('unknown unit returns Error string, does not crash', async () => {
    const r = await callTool(convertUnitTool, { value: 1, from: 'xyz', to: 'm' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('temperature to non-temperature returns Error string, does not crash', async () => {
    const r = await callTool(convertUnitTool, { value: 100, from: 'C', to: 'm' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('non-temperature to temperature returns Error string, does not crash', async () => {
    const r = await callTool(convertUnitTool, { value: 100, from: 'm', to: 'C' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('NaN value is rejected by schema (not a number)', async () => {
    const r = await callTool(convertUnitTool, { value: Number.NaN, from: 'm', to: 'km' })
    // Joi rejects NaN as not-a-number
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('Infinity value is rejected by schema (cannot be infinity)', async () => {
    const r = await callTool(convertUnitTool, { value: Infinity, from: 'm', to: 'km' })
    // Joi rejects Infinity
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('negative value for length converts correctly (no crash)', async () => {
    const r = await callTool(convertUnitTool, { value: -5, from: 'm', to: 'km' })
    expect(r.kind).toBe('resolved')
  })
})

// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('convertUnitTool — temperature below absolute zero', () => {
  // EXPECTED-RED: -1 K is physically impossible, but the handler converts it to -274.15 °C and
  // returns it without any warning/error. A correct tool flags sub-absolute-zero Kelvin input.
  it('does not silently convert -1 K to a temperature', async () => {
    const r = await callTool(convertUnitTool, { value: -1, from: 'K', to: 'C' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/error|invalid|absolute zero/i)
  })
})

// ── Numeric boundaries: BigNumber arithmetic + the precision arg ──────────────────────
describe('convertUnitTool — numeric boundaries', () => {
  const runC = (args: Record<string, unknown>) => callTool(convertUnitTool, args)

  it('does not overflow on a huge ratio (1e9 GiB → bits stays exact)', async () => {
    const r = await runC({ value: 1e9, from: 'GiB', to: 'bit' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).not.toContain('Infinity')
      // 1e9 GiB = 1e9 * 8 * 1024^3 bits = 8589934592000000000 (exact, not overflowed)
      expect(r.out).toContain('8589934592000000000 bits')
    }
  })

  it('does not underflow a tiny ratio to zero (1 in → km keeps the value)', async () => {
    const r = await runC({ value: 1, from: 'in', to: 'km' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      // 1 inch = 0.0254 m = 2.54e-5 km — must not collapse to 0
      expect(r.out).toMatch(/2\.54e-5/)
      expect(r.out).not.toMatch(/=\s*0 /)
    }
  })

  it('preserves full digits for a safe integer when precision is raised', async () => {
    // Default precision-8 renders MAX_SAFE_INTEGER metres in lossy sci form; precision 16 restores it.
    const r = await runC({ value: 9007199254740991, from: 'm', to: 'km', precision: 16 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toContain('9.007199254740991e+12')
  })

  it('honors the precision arg (3 significant digits)', async () => {
    const r = await runC({ value: 1, from: 'mi', to: 'km', precision: 3 })
    // 1 mile = 1.609344 km → 3 sig figs = 1.61
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toContain('1.61 kilometres')
  })

  it('still rejects a direct NaN/Infinity/unsafe value at the schema', async () => {
    for (const value of [Number.NaN, Infinity, 1e308]) {
      const r = await runC({ value, from: 'm', to: 'km' })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })
})
