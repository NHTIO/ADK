import { dset } from 'dset'
import { klona } from 'klona'
import { default as delve } from 'dlv'
import { isInstanceOf, isObject } from '../utils/guards'
import { E_INVALID_INITIAL_REGISTRY_VALUE } from '../exceptions/runtime'

/**
 * A controlled-mutation key-value store with dot-path access and deep-clone isolation.
 *
 * @remarks
 * The registry enforces a safe read/write contract: callers never hold a live reference into
 * the internal store. Every value that enters (`set`) or leaves (`get`, `all`) is deep-cloned
 * via `klona`, so mutations to a retrieved value cannot affect stored state and vice versa.
 *
 * Keys are dot-delimited paths (e.g. `"user.profile.name"`), resolved via `dlv` for reads and
 * `dset` for writes; intermediate objects are created automatically on write.
 */
export class Registry {
  #store: Record<string, unknown>

  /**
   * @param initial - Optional plain object to seed the registry. Deep-cloned on construction.
   * @throws {@link @nhtio/adk!E_INVALID_INITIAL_REGISTRY_VALUE} when `initial` is defined but not a plain object.
   */
  constructor(initial?: Record<string, unknown>) {
    if ('undefined' !== typeof initial && !isObject(initial)) {
      throw new E_INVALID_INITIAL_REGISTRY_VALUE()
    }
    this.#store = initial ? klona(initial) : {}
  }

  /**
   * Returns `true` if `value` is a {@link Registry} instance.
   *
   * @remarks
   * Uses {@link @nhtio/adk!isInstanceOf} for cross-realm safety.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link Registry} instance.
   */
  public static isRegistry(value: unknown): value is Registry {
    return isInstanceOf(value, 'Registry', Registry)
  }

  /**
   * Retrieves the value at `key`, returning `defaultValue` if the path is absent.
   *
   * @remarks
   * The returned value is a deep clone — mutating it will not affect the stored state.
   *
   * @typeParam T - Expected type of the value at `key`.
   * @param key - Dot-delimited path into the store (e.g. `"user.name"`).
   * @param defaultValue - Fallback returned when the path resolves to `undefined`.
   * @returns A deep clone of the stored value cast to `T`, or `defaultValue` when the path is absent.
   */
  get<T = unknown>(key: string, defaultValue?: T): T {
    const cloned = klona(this.#store)
    const value = delve(cloned, key)
    return 'undefined' === typeof value ? (defaultValue as T) : (value as T)
  }

  /**
   * Sets the value at `key`, creating intermediate objects as needed.
   *
   * @remarks
   * The stored value is isolated from the caller — mutating `value` after this call will not
   * affect what is held in the registry.
   *
   * @param key - Dot-delimited path into the store (e.g. `"user.name"`).
   * @param value - Value to store at the path.
   */
  set(key: string, value: unknown): void {
    dset(this.#store, key, value)
  }

  /**
   * Returns `true` if the registry has a value at `key`, `false` otherwise.
   *
   * @remarks
   * A key resolving to `undefined` is treated as absent — same convention as {@link Registry.get}'s
   * `defaultValue` fallback. No clone is performed; this is a pure existence check.
   *
   * @param key - Dot-delimited path into the store (e.g. `"user.name"`).
   * @returns `true` when the path resolves to a value other than `undefined`.
   */
  has(key: string): boolean {
    return 'undefined' !== typeof delve(this.#store, key)
  }

  /**
   * Returns all leaf dot-paths present in the registry.
   *
   * @remarks
   * The store is deep-cloned before traversal. Plain objects are walked recursively with path
   * segments joined by dots; arrays, primitives, `null`, and class instances are treated as leaves.
   *
   * @returns A string array of dot-delimited paths to leaf values in the store.
   */
  keys(): string[] {
    const store = klona(this.#store)
    const keys: string[] = []

    const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
      if (!isObject(value)) return false
      const prototype = Object.getPrototypeOf(value)
      return prototype === Object.prototype || prototype === null
    }

    const walk = (value: unknown, segments: string[]): void => {
      if (!isPlainRecord(value)) {
        if (segments.length > 0) keys.push(segments.join('.'))
        return
      }

      for (const [segment, child] of Object.entries(value)) {
        walk(child, [...segments, segment])
      }
    }

    walk(store, [])
    return keys
  }

  /**
   * Returns a deep clone of the entire store contents.
   *
   * @returns A plain object snapshot of all stored key-value pairs.
   */
  all(): Record<string, unknown> {
    return klona(this.#store)
  }
}
