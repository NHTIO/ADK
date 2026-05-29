import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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

    it('1 gal ≈ 3.785411784 L', async () => {
      const out = await run(1, 'gal', 'L')
      expect(out).toMatch(/3\.785411784/)
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
})
