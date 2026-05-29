/**
 * Pre-constructed tools for basic geographic distance and coordinate calculations.
 *
 * @module @nhtio/adk/batteries/tools/geo_basics
 *
 * @remarks
 * Pre-constructed bundled tools for the `geo_basics` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'

const EARTH_RADIUS_KM = 6371.0088

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a))
}

function validateLatLon(lat: unknown, lon: unknown, label: string): string | null {
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90)
    return `Error: ${label} latitude must be a number between -90 and 90.`
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180)
    return `Error: ${label} longitude must be a number between -180 and 180.`
  return null
}

/**
 * Great-circle (haversine) distance between two geographic coordinates.
 *
 * @remarks
 * Uses the Earth's mean radius (6371.0088 km). Returns both kilometres and miles.
 */
export const geoDistanceTool = new Tool({
  name: 'geo_distance',
  description:
    'Calculate the great-circle (haversine) distance between two geographic coordinates. Returns distance in km and miles.',
  inputSchema: validator.object({
    lat1: validator
      .number()
      .required()
      .description('Latitude of point A (decimal degrees, -90 to 90)'),
    lon1: validator
      .number()
      .required()
      .description('Longitude of point A (decimal degrees, -180 to 180)'),
    lat2: validator
      .number()
      .required()
      .description('Latitude of point B (decimal degrees, -90 to 90)'),
    lon2: validator
      .number()
      .required()
      .description('Longitude of point B (decimal degrees, -180 to 180)'),
  }),
  handler: async (args) => {
    const { lat1, lon1, lat2, lon2 } = args as {
      lat1: number
      lon1: number
      lat2: number
      lon2: number
    }

    const errA = validateLatLon(lat1, lon1, 'point A')
    if (errA) return errA
    const errB = validateLatLon(lat2, lon2, 'point B')
    if (errB) return errB

    const km = haversineKm(lat1, lon1, lat2, lon2)
    const miles = km * 0.621371

    return `Distance: ${km.toFixed(4)} km / ${miles.toFixed(4)} miles`
  },
})

/**
 * Check whether a point lies within a radius of a centre coordinate.
 *
 * @remarks
 * Uses the haversine distance internally; returns the radius unit chosen by the caller
 * (km or miles) in the result string.
 */
export const geoWithinRadiusTool = new Tool({
  name: 'geo_within_radius',
  description:
    'Check whether a point is within a given radius (km or miles) of a center coordinate.',
  inputSchema: validator.object({
    center_lat: validator.number().required().description('Center latitude'),
    center_lon: validator.number().required().description('Center longitude'),
    point_lat: validator.number().required().description('Point latitude to test'),
    point_lon: validator.number().required().description('Point longitude to test'),
    radius: validator.number().required().description('Radius value (must be positive)'),
    unit: validator
      .string()
      .valid('km', 'miles')
      .default('km')
      .description('Unit for the radius (default: km)'),
  }),
  handler: async (args) => {
    const {
      center_lat: centerLat,
      center_lon: centerLon,
      point_lat: pointLat,
      point_lon: pointLon,
      radius,
      unit,
    } = args as {
      center_lat: number
      center_lon: number
      point_lat: number
      point_lon: number
      radius: number
      unit: string
    }

    const errC = validateLatLon(centerLat, centerLon, 'center')
    if (errC) return errC
    const errP = validateLatLon(pointLat, pointLon, 'point')
    if (errP) return errP
    if (!Number.isFinite(radius) || radius <= 0) return 'Error: radius must be a positive number.'

    const km = haversineKm(centerLat, centerLon, pointLat, pointLon)
    const distInUnit = unit === 'miles' ? km * 0.621371 : km
    const within = distInUnit <= radius

    return `${within ? 'Yes' : 'No'} — distance is ${distInUnit.toFixed(4)} ${unit} (radius: ${radius} ${unit})`
  },
})

/**
 * Check whether a point falls inside an axis-aligned bounding box.
 *
 * @remarks
 * The bounding box is defined by its SW and NE corners. Boxes that wrap the antimeridian
 * (i.e. SW longitude greater than NE longitude) are handled correctly.
 */
export const geoBboxContainsTool = new Tool({
  name: 'geo_bbox_contains',
  description:
    'Check whether a point falls inside an axis-aligned bounding box defined by its SW and NE corners.',
  inputSchema: validator.object({
    sw_lat: validator.number().required().description('South-west corner latitude'),
    sw_lon: validator.number().required().description('South-west corner longitude'),
    ne_lat: validator.number().required().description('North-east corner latitude'),
    ne_lon: validator.number().required().description('North-east corner longitude'),
    point_lat: validator.number().required().description('Point latitude to test'),
    point_lon: validator.number().required().description('Point longitude to test'),
  }),
  handler: async (args) => {
    const {
      sw_lat: swLat,
      sw_lon: swLon,
      ne_lat: neLat,
      ne_lon: neLon,
      point_lat: pointLat,
      point_lon: pointLon,
    } = args as {
      sw_lat: number
      sw_lon: number
      ne_lat: number
      ne_lon: number
      point_lat: number
      point_lon: number
    }

    for (const [lat, lon, label] of [
      [swLat, swLon, 'SW'],
      [neLat, neLon, 'NE'],
      [pointLat, pointLon, 'point'],
    ] as [number, number, string][]) {
      const err = validateLatLon(lat, lon, label)
      if (err) return err
    }

    if (swLat > neLat) return 'Error: SW latitude must be ≤ NE latitude.'

    const latIn = pointLat >= swLat && pointLat <= neLat

    // Handle bounding boxes that wrap the antimeridian
    const lonIn =
      swLon <= neLon
        ? pointLon >= swLon && pointLon <= neLon
        : pointLon >= swLon || pointLon <= neLon

    const inside = latIn && lonIn
    return inside
      ? `Yes — point (${pointLat}, ${pointLon}) is inside the bounding box.`
      : `No — point (${pointLat}, ${pointLon}) is outside the bounding box.`
  },
})
