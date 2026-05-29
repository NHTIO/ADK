import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import {
  ValidationException,
  asyncValidateOrThrow,
  isValidationError,
  passesSchema,
  validateOrThrow,
} from '../../../src/lib/utils/validation'

const userSchema = validator
  .object({
    name: validator.string().required(),
    age: validator.number().integer().min(0).required(),
  })
  .required()

describe('passesSchema', () => {
  it('returns true when value satisfies the schema', () => {
    expect(passesSchema(userSchema, { name: 'alice', age: 30 })).toBe(true)
  })

  it('returns false when value violates the schema', () => {
    expect(passesSchema(userSchema, { name: 'alice' })).toBe(false)
    expect(passesSchema(userSchema, { name: 'alice', age: -1 })).toBe(false)
  })

  it('returns false for non-object values when schema expects an object', () => {
    expect(passesSchema(userSchema, 'not an object')).toBe(false)
    expect(passesSchema(userSchema, null)).toBe(false)
  })
})

describe('validateOrThrow', () => {
  it('returns the validated value on success', () => {
    const result = validateOrThrow(userSchema, { name: 'alice', age: 30 })
    expect(result).toEqual({ name: 'alice', age: 30 })
  })

  it('throws ValidationException when validation fails', () => {
    expect(() => validateOrThrow(userSchema, {})).toThrow(ValidationException)
  })

  it('aggregates all field errors into the thrown ValidationException', () => {
    try {
      validateOrThrow(userSchema, { age: -1 })
      expect.fail('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationException)
      expect((err as ValidationException).details?.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('coerces values when convert is true', () => {
    const result = validateOrThrow<{ name: string; age: number }>(
      userSchema,
      { name: 'alice', age: '30' },
      true
    )
    expect(result.age).toBe(30)
  })

  it('does not coerce when convert is false (default)', () => {
    expect(() => validateOrThrow(userSchema, { name: 'alice', age: '30' })).toThrow(
      ValidationException
    )
  })
})

describe('asyncValidateOrThrow', () => {
  it('returns the validated value on success', async () => {
    const result = await asyncValidateOrThrow(userSchema, { name: 'alice', age: 30 })
    expect(result).toEqual({ name: 'alice', age: 30 })
  })

  it('rejects with ValidationException on failure', async () => {
    await expect(asyncValidateOrThrow(userSchema, {})).rejects.toBeInstanceOf(ValidationException)
  })
})

describe('ValidationException', () => {
  it('carries the details from the underlying ValidationError', () => {
    try {
      validateOrThrow(userSchema, {})
      expect.fail('should have thrown')
    } catch (err) {
      const exc = err as ValidationException
      expect(exc.details).toBeDefined()
      expect(Array.isArray(exc.details)).toBe(true)
      expect(exc.details!.length).toBeGreaterThan(0)
    }
  })

  it('joins details messages into a single human-readable message', () => {
    try {
      validateOrThrow(userSchema, { age: -1 })
      expect.fail('should have thrown')
    } catch (err) {
      const exc = err as ValidationException
      expect(typeof exc.message).toBe('string')
      expect(exc.message).toContain('and')
    }
  })

  it('is non-fatal', () => {
    try {
      validateOrThrow(userSchema, {})
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as ValidationException).fatal).toBe(false)
    }
  })
})

describe('isValidationError', () => {
  it('returns true for ValidationError-shaped values', () => {
    try {
      validateOrThrow(userSchema, {})
      expect.fail('should have thrown')
    } catch (err) {
      const exc = err as ValidationException
      expect(isValidationError(exc.cause)).toBe(true)
    }
  })

  it('returns false for non-error values', () => {
    expect(isValidationError({ message: 'no details field' })).toBe(false)
    expect(isValidationError(null)).toBe(false)
    expect(isValidationError('error')).toBe(false)
  })
})
