/**
 * Arbitrary-precision numeric helpers for the bundled tools.
 *
 * @module @nhtio/adk/lib/helpers/bignum
 *
 * @remarks
 * ECMAScript numbers are IEEE-754 float64: arithmetic on user-supplied values can overflow to
 * `Infinity`, underflow to `0`, or silently lose precision (`0.1 + 0.2 === 0.30000000000000004`).
 * The numeric tool batteries (`statistics`, `data_structure`, `unit_conversion`, `math`) route
 * their aggregations and result formatting through this module so that:
 *
 * - large in-range sums stay exact instead of overflowing (`sum([1e308, 1e308]) → 2e308`),
 * - precision is preserved end-to-end (`sum([0.1, 0.2]) → 0.3`),
 * - output is rendered to a caller-chosen number of significant digits (default 8) without the
 *   lossy `Number.prototype.toPrecision`/`toFixed` round-trip that mangles even safe integers
 *   (e.g. `9007199254740991` rendered as `9007199255000`).
 *
 * Internally this is backed by a single {@link https://mathjs.org | mathjs} instance configured
 * for `BigNumber` (which bundles `decimal.js`) at 64 significant digits — comfortably more than
 * float64's ~15-17 and enough for the tools' needs without unbounded growth.
 *
 * The tools still RECEIVE float64 numbers (the model's tool-call arguments are JSON-parsed to
 * float64 upstream, and the typed-array input schemas reject `NaN`/`Infinity`/`> 2^53` before the
 * handler runs). BigNumber's job is the math and formatting in between, not the input boundary.
 */

import { create, all, type BigNumber } from 'mathjs'

/**
 * Precision (significant digits) the internal BigNumber engine computes with. Distinct from the
 * per-call display precision passed to {@link formatBig} — this is the working precision so that
 * intermediate results don't accumulate rounding error before they are formatted down.
 */
const WORKING_PRECISION = 64

/** Default display precision (significant digits) for tool output. */
export const DEFAULT_PRECISION = 8

const math = create(all, { number: 'BigNumber', precision: WORKING_PRECISION })

/** Coerce a JS number to a {@link BigNumber}. Non-finite inputs are a caller bug (schemas reject them). */
export const toBig = (n: number): BigNumber => math.bignumber(n)

/** Exact sum of a numeric array as a {@link BigNumber} (no float64 overflow/precision loss). */
export const bigSum = (nums: number[]): BigNumber =>
  nums.reduce<BigNumber>((acc, n) => math.add(acc, math.bignumber(n)), math.bignumber(0))

/** Exact arithmetic mean as a {@link BigNumber}. Caller guarantees `nums.length > 0`. */
export const bigMean = (nums: number[]): BigNumber =>
  math.divide(bigSum(nums), nums.length) as BigNumber

/** `value * fromFactor / toFactor` computed without intermediate float64 over/underflow. */
export const bigScale = (value: number, fromFactor: number, toFactor: number): BigNumber =>
  math.divide(
    math.multiply(math.bignumber(value), math.bignumber(fromFactor)),
    math.bignumber(toFactor)
  ) as BigNumber

/**
 * Render a {@link BigNumber} (or JS number) to a string at `precision` significant digits.
 *
 * @remarks
 * - An EXACT INTEGER is rendered in full fixed notation regardless of `precision`: an integer
 *   carries no fractional precision to lose, so `8000000000000` stays `8000000000000` rather than
 *   being truncated to `8e+12`. (Bounded at 30 digits to avoid pathological astronomically-large
 *   integers printing thousands of characters; beyond that, sig-fig exponential is used.)
 * - Non-integers are rendered at `precision` significant digits (default 8), stripping trailing
 *   zeros — avoiding the `toPrecision` artifact that mangled safe values, while still giving the
 *   caller control over how many digits they want (raise `precision` for more).
 * - Exact zero renders as `'0'`. (Genuinely tiny values like `2.54e-5` are preserved, NOT snapped.)
 */
export const formatBig = (
  value: BigNumber | number,
  precision: number = DEFAULT_PRECISION
): string => {
  const b = typeof value === 'number' ? math.bignumber(value) : value
  if (math.equal(b, 0)) return '0'
  const p = Number.isFinite(precision)
    ? Math.max(1, Math.min(64, Math.floor(precision)))
    : DEFAULT_PRECISION
  // Exact integers up to 30 digits: print in full, no precision truncation, no exponent. The
  // fixed-notation full string is the source of truth for "is this an exact integer" — mathjs's
  // `isInteger` is unreliable for Decimals carrying a fractional part under some configs.
  const fixed = math.format(b, { notation: 'fixed' })
  if (!fixed.includes('.') && fixed.replace('-', '').length <= 31) {
    return fixed
  }
  return math.format(b, { precision: p })
}

/** Convert a {@link BigNumber} back to a JS number (for cases that must hand off a float64). */
export const bigToNumber = (b: BigNumber): number => math.number(b)
