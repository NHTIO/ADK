/**
 * Helper utilities for the vector storage provider battery.
 *
 * @module @nhtio/adk/batteries/vector/helpers
 */

import type { DistanceMetric } from './types'

/** Whether a raw backend score is a similarity (higher = closer) or a distance (lower = closer). */
export type ScoreKind = 'similarity' | 'distance'

/** Clamp `n` into the inclusive `[0, 1]` range. */
export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * Normalize a backend's raw score into a `[0, 1]` similarity where higher is closer, accounting for
 * the distance metric and whether the raw value is a similarity or a distance.
 *
 * @param raw - The backend's raw score.
 * @param metric - The distance metric the score was computed under.
 * @param kind - Whether `raw` is a similarity or a distance.
 * @returns The normalized similarity in `[0, 1]`.
 */
export const normalizeScore = (raw: number, metric: DistanceMetric, kind: ScoreKind): number => {
  if (metric === 'cosine') {
    if (kind === 'similarity') {
      return clamp01((raw + 1) / 2)
    } else {
      const sim = 1 - raw
      return clamp01((sim + 1) / 2)
    }
  } else if (metric === 'dot') {
    if (kind === 'similarity') {
      return clamp01(1 / (1 + Math.exp(-raw)))
    } else {
      return clamp01(1 / (1 + Math.exp(raw)))
    }
  } else if (metric === 'euclidean') {
    const d = Math.max(0, raw)
    return clamp01(1 / (1 + d))
  } else {
    return clamp01(raw)
  }
}

/** Look up the adapter-specific value for `metric` in a complete metric→value map. */
export const mapMetric = <T>(metric: DistanceMetric, map: Record<DistanceMetric, T>): T =>
  map[metric]

/** `true` if `vector`'s length matches `expected` (or `expected` is undefined). */
export const dimensionsMatch = (vector: number[], expected: number | undefined): boolean =>
  expected === undefined ? true : vector.length === expected

/** `true` if `vector` is an array of finite numbers (no NaN/Infinity). */
export const isFiniteVector = (vector: number[]): boolean =>
  Array.isArray(vector) && vector.every((n) => typeof n === 'number' && Number.isFinite(n))
