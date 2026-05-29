import { describe, expect, it } from 'vitest'
import { isError, isInstanceOf, isObject } from '../../../src/lib/utils/guards'

class Animal {
  constructor(public readonly name: string) {}
}

class Dog extends Animal {}

describe('isObject', () => {
  it('returns true for plain objects', () => {
    expect(isObject({})).toBe(true)
    expect(isObject({ a: 1 })).toBe(true)
    expect(isObject(Object.create(null))).toBe(true)
  })

  it('returns false for null', () => {
    expect(isObject(null)).toBe(false)
  })

  it('returns false for arrays', () => {
    expect(isObject([])).toBe(false)
    expect(isObject([1, 2, 3])).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isObject('hello')).toBe(false)
    expect(isObject(42)).toBe(false)
    expect(isObject(true)).toBe(false)
    expect(isObject(undefined)).toBe(false)
    expect(isObject(Symbol('x'))).toBe(false)
  })
})

describe('isError', () => {
  it('returns true for native Error instances', () => {
    expect(isError(new Error('boom'))).toBe(true)
    expect(isError(new TypeError('bad'))).toBe(true)
    expect(isError(new RangeError('range'))).toBe(true)
  })

  it('returns true for Error subclasses', () => {
    class CustomError extends Error {}
    expect(isError(new CustomError('custom'))).toBe(true)
  })

  it('returns false for non-Error values', () => {
    expect(isError({ message: 'looks like an error' })).toBe(false)
    expect(isError('error string')).toBe(false)
    expect(isError(null)).toBe(false)
    expect(isError(undefined)).toBe(false)
    expect(isError(42)).toBe(false)
  })
})

describe('isInstanceOf', () => {
  it('returns true for direct instances via instanceof', () => {
    const a = new Animal('rex')
    expect(isInstanceOf(a, 'Animal', Animal)).toBe(true)
  })

  it('returns true for subclass instances when the parent constructor is supplied', () => {
    const d = new Dog('rex')
    expect(isInstanceOf(d, 'Animal', Animal)).toBe(true)
    expect(isInstanceOf(d, 'Dog', Dog)).toBe(true)
  })

  it('falls back to constructor-name comparison when ctor is omitted', () => {
    const a = new Animal('rex')
    expect(isInstanceOf(a, 'Animal')).toBe(true)
    expect(isInstanceOf(a, 'Dog')).toBe(false)
  })

  it('returns false for null and primitives', () => {
    expect(isInstanceOf(null, 'Animal', Animal)).toBe(false)
    expect(isInstanceOf(undefined, 'Animal', Animal)).toBe(false)
    expect(isInstanceOf(42, 'Animal', Animal)).toBe(false)
    expect(isInstanceOf('rex', 'Animal', Animal)).toBe(false)
  })

  it('returns false for plain objects without a matching constructor name', () => {
    expect(isInstanceOf({ name: 'rex' }, 'Animal')).toBe(false)
  })
})
