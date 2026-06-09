import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Extract distance in km from tool output like "Distance: 343.1234 km / 213.1234 miles" */
function extractKm(out: string): number {
  const m = out.match(/Distance:\s*([\d.]+)\s*km/)
  if (!m) throw new Error(`Could not extract km from: ${out}`)
  return Number.parseFloat(m[1])
}

/** Great-circle distance using the haversine formula (independent oracle) */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371.0088
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const KM_PER_MILE = 0.621371

/* ── existing basic tests ─────────────────────────────────────────────── */

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

  it('schema rejects missing args', async () => {
    await expect(runDist({ lat1: 0, lon1: 0 })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── independent oracle: hand-computed distances ─────────────────────── */

  it('Paris↔London ≈ 343 km (independent oracle)', async () => {
    // Paris: 48.8566, 2.3522; London: 51.5074, -0.1278
    const expected = haversineKm(48.8566, 2.3522, 51.5074, -0.1278)
    const out = await runDist({
      lat1: 48.8566,
      lon1: 2.3522,
      lat2: 51.5074,
      lon2: -0.1278,
    })
    const km = extractKm(out)
    expect(km).toBeCloseTo(expected, 0) // within ~1 km
  })

  it('equator 1° longitude ≈ 111 km (independent oracle)', async () => {
    const expected = haversineKm(0, 0, 0, 1)
    const out = await runDist({ lat1: 0, lon1: 0, lat2: 0, lon2: 1 })
    const km = extractKm(out)
    expect(km).toBeCloseTo(expected, 0)
  })

  it('identical points = 0 km (invariant)', async () => {
    const out = await runDist({ lat1: 51.5074, lon1: -0.1278, lat2: 51.5074, lon2: -0.1278 })
    expect(extractKm(out)).toBeCloseTo(0, 4)
  })

  /* ── INVARIANT: distance symmetry d(A,B) = d(B,A) ──────────────────── */

  it('distance is symmetric (A→B = B→A)', async () => {
    const out1 = await runDist({ lat1: 48.8566, lon1: 2.3522, lat2: 51.5074, lon2: -0.1278 })
    const out2 = await runDist({ lat1: 51.5074, lon1: -0.1278, lat2: 48.8566, lon2: 2.3522 })
    expect(extractKm(out1)).toBeCloseTo(extractKm(out2), 4)
  })

  /* ── antipodes ────────────────────────────────────────────────────────── */

  it('antipodal points are ≈ 20015 km apart (half earth circumference)', async () => {
    // Antipodes: (0, 0) and (0, 180) — but lon 180 is accepted
    const out = await runDist({ lat1: 0, lon1: 0, lat2: 0, lon2: 180 })
    const km = extractKm(out)
    // Half earth circumference ≈ 20015 km
    expect(km).toBeGreaterThan(19900)
    expect(km).toBeLessThan(20100)
  })

  /* ── North Pole ───────────────────────────────────────────────────────── */

  it('North Pole to equator ≈ 10008 km (quarter circumference)', async () => {
    const expected = haversineKm(90, 0, 0, 0)
    const out = await runDist({ lat1: 90, lon1: 0, lat2: 0, lon2: 0 })
    const km = extractKm(out)
    expect(km).toBeCloseTo(expected, 0)
  })

  /* ── Antimeridian: lon 179 → -179 should be short distance ──────────── */

  it('antimeridian crossing: lon 179 → -179 ≈ 222 km (not half-globe)', async () => {
    const expected = haversineKm(0, 179, 0, -179)
    const out = await runDist({ lat1: 0, lon1: 179, lat2: 0, lon2: -179 })
    const km = extractKm(out)
    expect(km).toBeCloseTo(expected, 0)
    // This should be small (~222 km), NOT half the globe
    expect(km).toBeLessThan(500)
  })

  /* ── South Pole ─────────────────────────────────────────────────────── */

  it('South Pole to North Pole ≈ 20015 km', async () => {
    const out = await runDist({ lat1: -90, lon1: 0, lat2: 90, lon2: 0 })
    const km = extractKm(out)
    expect(km).toBeGreaterThan(19900)
    expect(km).toBeLessThan(20100)
  })

  /* ── km/miles conversion ─────────────────────────────────────────────── */

  it('miles = km × 0.621371', async () => {
    const out = await runDist({ lat1: 0, lon1: 0, lat2: 0, lon2: 1 })
    const kmMatch = out.match(/Distance:\s*([\d.]+)\s*km/)
    const milesMatch = out.match(/([\d.]+)\s*miles/)
    expect(kmMatch).not.toBeNull()
    expect(milesMatch).not.toBeNull()
    const km = Number.parseFloat(kmMatch![1])
    const miles = Number.parseFloat(milesMatch![1])
    expect(miles).toBeCloseTo(km * KM_PER_MILE, 3)
  })

  /* ── error on non-finite coordinates ──────────────────────────────────── */

  it('rejects NaN latitude via schema', async () => {
    await expect(runDist({ lat1: Number.NaN, lon1: 0, lat2: 0, lon2: 0 })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('rejects Infinity longitude via schema', async () => {
    await expect(runDist({ lat1: 0, lon1: Infinity, lat2: 0, lon2: 0 })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
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

  /* ── INVARIANT: within_radius true iff distance ≤ radius ──────────── */

  it('point exactly at radius distance is inside (distance = radius)', async () => {
    // 1° at equator ≈ 111 km, so pick a point ~50 km away with radius 50 km
    // We'll compute the exact distance first
    const centerLat = 0
    const centerLon = 0
    const pointLon = 0.45 // about 50 km at equator
    const dist = haversineKm(centerLat, centerLon, centerLat, pointLon)
    const radius = Math.ceil(dist) // round up so point is within radius
    const out = await runRadius({
      center_lat: centerLat,
      center_lon: centerLon,
      point_lat: centerLat,
      point_lon: pointLon,
      radius: radius,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('point farther than radius is outside', async () => {
    // Point at 1° lon ≈ 111 km, radius 50 km
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 1,
      radius: 50,
    })
    expect(out).toMatch(/^No/)
  })

  /* ── radius in miles ─────────────────────────────────────────────────── */

  it('1° longitude at equator ≈ 69 miles, within 100-mile radius', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 1,
      radius: 100,
      unit: 'miles',
    })
    expect(out).toMatch(/^Yes/)
  })

  /* ── negative radius ──────────────────────────────────────────────────── */

  it('rejects negative radius', async () => {
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0,
      radius: -10,
    })
    expect(out).toMatch(/^Error/)
  })

  /* ── identical center and point ──────────────────────────────────────── */

  it('identical center and point is within any positive radius', async () => {
    const out = await runRadius({
      center_lat: 40.7128,
      center_lon: -74.006,
      point_lat: 40.7128,
      point_lon: -74.006,
      radius: 0.001,
      unit: 'km',
    })
    expect(out).toMatch(/^Yes/)
  })

  /* ── schema rejection ──────────────────────────────────────────────── */

  it('rejects unknown unit', async () => {
    await expect(
      runRadius({
        center_lat: 0,
        center_lon: 0,
        point_lat: 0,
        point_lon: 0,
        radius: 1,
        unit: 'furlongs',
      })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── point on boundary (distance = radius) ──────────────────────────── */

  it('point exactly at radius boundary (distance ≈ radius) reports Yes (≤)', async () => {
    // distance at equator for 0.5° lon ≈ 55.6 km
    // We'll compute the distance and set radius equal to it
    const d = haversineKm(0, 0, 0, 0.5)
    const out = await runRadius({
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0.5,
      radius: d,
    })
    // The implementation uses ≤, so this should be Yes
    expect(out).toMatch(/^Yes/)
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

  /* ── point exactly on boundary ─────────────────────────────────────── */

  it('point on SW corner is inside (boundary inclusive)', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 0,
      point_lon: 0,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('point on NE corner is inside', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 10,
      point_lon: 10,
    })
    expect(out).toMatch(/^Yes/)
  })

  /* ── poles ──────────────────────────────────────────────────────────── */

  it('bbox covering North Pole region contains North Pole', async () => {
    const out = await runBbox({
      sw_lat: 80,
      sw_lon: -180,
      ne_lat: 90,
      ne_lon: 180,
      point_lat: 90,
      point_lon: 0,
    })
    expect(out).toMatch(/^Yes/)
  })

  it('bbox in northern hemisphere does not contain South Pole point', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: -180,
      ne_lat: 90,
      ne_lon: 180,
      point_lat: -90,
      point_lon: 0,
    })
    expect(out).toMatch(/^No/)
  })

  /* ── antimeridian: point outside wrapping box ──────────────────────── */

  it('point at lon=0 is outside a box that wraps 170→-170', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 170,
      ne_lat: 10,
      ne_lon: -170,
      point_lat: 5,
      point_lon: 0,
    })
    expect(out).toMatch(/^No/)
  })

  /* ── invalid coordinates ─────────────────────────────────────────────── */

  it('rejects point latitude outside -90..90', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 100,
      point_lon: 5,
    })
    expect(out).toMatch(/^Error/)
  })

  it('rejects point longitude outside -180..180', async () => {
    const out = await runBbox({
      sw_lat: 0,
      sw_lon: 0,
      ne_lat: 10,
      ne_lon: 10,
      point_lat: 5,
      point_lon: 200,
    })
    expect(out).toMatch(/^Error/)
  })

  /* ── global bbox ─────────────────────────────────────────────────────── */

  it('global bbox contains any valid point', async () => {
    const out = await runBbox({
      sw_lat: -90,
      sw_lon: -180,
      ne_lat: 90,
      ne_lon: 180,
      point_lat: 45,
      point_lon: 90,
    })
    expect(out).toMatch(/^Yes/)
  })

  /* ── INVARIANT: within_radius true iff distance ≤ radius ────────────── */

  it('within_radius consistent with geo_distance for same points', async () => {
    const center = { lat: 48.8566, lon: 2.3522 }
    const point = { lat: 51.5074, lon: -0.1278 }
    const distOut = await runDist({
      lat1: center.lat,
      lon1: center.lon,
      lat2: point.lat,
      lon2: point.lon,
    })
    const distKm = extractKm(distOut)

    // With radius = distKm, should be inside
    const inOut = await runRadius({
      center_lat: center.lat,
      center_lon: center.lon,
      point_lat: point.lat,
      point_lon: point.lon,
      radius: Math.ceil(distKm),
    })
    expect(inOut).toMatch(/^Yes/)

    // With radius = distKm - 1, should be outside
    const outOut = await runRadius({
      center_lat: center.lat,
      center_lon: center.lon,
      point_lat: point.lat,
      point_lon: point.lon,
      radius: Math.max(0.001, distKm - 1),
    })
    expect(outOut).toMatch(/^No/)
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('geo_distance with poles must not crash', async () => {
    const r = await callTool(geoDistanceTool, { lat1: 90, lon1: 0, lat2: -90, lon2: 0 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string')
      // North Pole to South Pole ≈ 20015 km
      const km = extractKm(r.out)
      expect(km).toBeGreaterThan(19900)
      expect(km).toBeLessThan(20100)
    }
  })

  it('geo_distance antimeridian short-distance must NOT be half-globe', async () => {
    // lon 179 → -179 at equator should be ~222 km, NOT ~20000 km
    const r = await callTool(geoDistanceTool, { lat1: 0, lon1: 179, lat2: 0, lon2: -179 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const km = extractKm(r.out)
      // The haversine formula correctly computes the short arc: ~222 km
      // If the tool incorrectly takes the long arc, this would be ~20000 km
      expect(km).toBeLessThan(500) // EXPECTED-RED if tool computes wrong arc
    }
  })

  it('geo_within_radius with NaN radius must not crash', async () => {
    const r = await callTool(geoWithinRadiusTool, {
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0,
      radius: Number.NaN,
    })
    // NaN is not a finite number; schema may reject it, or handler may return Error string
    // Either way, it must NOT throw E_TOOL_DOWNSTREAM_ERROR
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })

  it('geo_within_radius with Infinity radius must not crash', async () => {
    const r = await callTool(geoWithinRadiusTool, {
      center_lat: 0,
      center_lon: 0,
      point_lat: 0,
      point_lon: 0,
      radius: Infinity,
    })
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })

  it('geo_bbox_contains with SW lat > NE lat must not crash', async () => {
    const r = await callTool(geoBboxContainsTool, {
      sw_lat: 10,
      sw_lon: 0,
      ne_lat: 5,
      ne_lon: 10,
      point_lat: 7,
      point_lon: 5,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).toMatch(/^Error/)
      expect(r.out).toContain('SW latitude')
    }
  })

  it('geo_bbox_contains with identical SW and NE corners must not crash', async () => {
    const r = await callTool(geoBboxContainsTool, {
      sw_lat: 5,
      sw_lon: 5,
      ne_lat: 5,
      ne_lon: 5,
      point_lat: 5,
      point_lon: 5,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})
