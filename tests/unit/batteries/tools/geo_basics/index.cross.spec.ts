import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  geoBboxContainsTool,
  geoDistanceTool,
  geoWithinRadiusTool,
} from '../../../../../src/batteries/tools/geo_basics'

const runDist = async (args: Record<string, unknown>): Promise<string> => {
  return (await geoDistanceTool.executor(makeToolCtxStub())(args)) as string
}
const runRadius = async (args: Record<string, unknown>): Promise<string> => {
  return (await geoWithinRadiusTool.executor(makeToolCtxStub())(args)) as string
}
const runBbox = async (args: Record<string, unknown>): Promise<string> => {
  return (await geoBboxContainsTool.executor(makeToolCtxStub())(args)) as string
}

describe('geoDistanceTool', () => {
  it('distance from a point to itself is 0', async () => {
    const out = await runDist({ lat1: 40, lon1: -74, lat2: 40, lon2: -74 })
    expect(out).toMatch(/Distance: 0\.0000 km/)
  })

  it('NYC to LA is approximately 3936 km', async () => {
    // NYC: 40.7128, -74.0060; LA: 34.0522, -118.2437
    const out = await runDist({
      lat1: 40.7128,
      lon1: -74.006,
      lat2: 34.0522,
      lon2: -118.2437,
    })
    expect(out).toMatch(/Distance:/)
    const km = Number.parseFloat(out.match(/Distance: ([\d.]+) km/)![1])
    // Real great-circle distance is ~3935.7 km — allow a small tolerance
    expect(km).toBeGreaterThan(3900)
    expect(km).toBeLessThan(3970)
  })

  it('reports distance in both km and miles', async () => {
    const out = await runDist({ lat1: 0, lon1: 0, lat2: 0, lon2: 1 })
    expect(out).toMatch(/km/)
    expect(out).toMatch(/miles/)
  })

  it('rejects latitudes outside -90..90', async () => {
    const out = await runDist({ lat1: 100, lon1: 0, lat2: 0, lon2: 0 })
    expect(out).toMatch(/^Error/)
    expect(out).toContain('latitude')
  })

  it('rejects longitudes outside -180..180', async () => {
    const out = await runDist({ lat1: 0, lon1: 200, lat2: 0, lon2: 0 })
    expect(out).toMatch(/^Error/)
    expect(out).toContain('longitude')
  })

  it('rejects missing args via schema', async () => {
    await expect(runDist({ lat1: 0, lon1: 0 })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('geoWithinRadiusTool', () => {
  it('returns Yes when the point is inside the radius (km, default)', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0.001,
      radius: 1,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('returns No when the point is outside the radius (km)', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 1,
      point_lon: 1,
      radius: 10,
    })
    expect(out).toMatch(/^No/)
  })

  it('uses miles when unit is "miles"', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0.001,
      radius: 1,
      unit: 'miles',
    })
    expect(out).toContain('miles')
  })

  it('rejects non-positive radius', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0,
      radius: 0,
    })
    expect(out).toMatch(/^Error/)
    expect(out).toContain('positive')
  })

  it('rejects invalid coordinates', async () => {
    const out = await runRadius({
      center_lat: 200,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0,
      radius: 5,
    })
    expect(out).toMatch(/^Error/)
  })
})

describe('geoBboxContainsTool', () => {
  it('returns Yes for a point inside a simple box', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 5,
      point_lon: 5,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('returns No for a point outside the box', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 20,
      point_lon: 5,
    })
    expect(out).toMatch(/^No/)
  })

  it('handles antimeridian-wrapping boxes (SW lon > NE lon)', async () => {
    // Box covering 170°E to -170°W (wrapping). A point at 175 should be inside.
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 170,
      ne_lat: 10,
      ne_lon: -170,
      point_lat: 5,
      point_lon: 175,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('also includes points on the other side of the antimeridian', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 170,
      ne_lat: 10,
      ne_lon: -170,
      point_lat: 5,
      point_lon: -175,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('rejects when SW latitude exceeds NE latitude', async () => {
    const out = await runBbox({
      sw_lat: 10,
      sw_lon: 0,
      ne_lat: 5,
      ne_lon: 10,
      point_lat: 7,
      point_lon: 5,
    })
    expect(out).toMatch(/^Error/)
    expect(out).toContain('SW latitude')
  })
})
