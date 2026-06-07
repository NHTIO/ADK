/**
 * Helper utilities for the vector storage provider battery.
 *
 * @module @nhtio/adk/batteries/vector/helpers
 */

import type { DistanceMetric } from './types'

export type ScoreKind = 'similarity' | 'distance'

export const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

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

export const mapMetric = <T>(metric: DistanceMetric, map: Record<DistanceMetric, T>): T =>
  map[metric]

export const dimensionsMatch = (vector: number[], expected: number | undefined): boolean =>
  expected === undefined ? true : vector.length === expected

export const isFiniteVector = (vector: number[]): boolean =>
  Array.isArray(vector) && vector.every((n) => typeof n === 'number' && Number.isFinite(n))
