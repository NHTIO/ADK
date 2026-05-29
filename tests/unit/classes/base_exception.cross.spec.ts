import { describe, expect, it } from 'vitest'
import { BaseException } from '../../../src/lib/classes/base_exception'

class TestException extends BaseException {
  static code = 'TEST_EXCEPTION'
  static status = 418
  static fatal = false
  static message = 'a teapot exception occurred'
}

class FatalException extends BaseException {
  static code = 'FATAL_EXCEPTION'
  static status = 500
  static fatal = true
}

class ExceptionWithHelp extends BaseException {
  static code = 'HELP_EXCEPTION'
  static help = 'Check the documentation for details.'
}

describe('BaseException', () => {
  describe('construction', () => {
    it('is an instance of Error', () => {
      const e = new TestException('boom')
      expect(e).toBeInstanceOf(Error)
      expect(e).toBeInstanceOf(BaseException)
    })

    it('sets name to the constructor class name', () => {
      const e = new TestException('boom')
      expect(e.name).toBe('TestException')
    })

    it('falls back to the static message when no message is provided', () => {
      const e = new TestException()
      expect(e.message).toBe('a teapot exception occurred')
    })

    it('prefers the instance message over the static fallback', () => {
      const e = new TestException('explicit')
      expect(e.message).toBe('explicit')
    })
  })

  describe('static defaults', () => {
    it('inherits code from the subclass static', () => {
      expect(new TestException('m').code).toBe('TEST_EXCEPTION')
    })

    it('inherits status from the subclass static', () => {
      expect(new TestException('m').status).toBe(418)
    })

    it('inherits fatal from the subclass static', () => {
      expect(new TestException('m').fatal).toBe(false)
      expect(new FatalException('m').fatal).toBe(true)
    })

    it('inherits help when defined on the subclass', () => {
      expect(new ExceptionWithHelp('m').help).toBe('Check the documentation for details.')
    })
  })

  describe('per-throw overrides', () => {
    it('lets options.code override the static default', () => {
      const e = new TestException('m', { code: 'OVERRIDE' })
      expect(e.code).toBe('OVERRIDE')
    })

    it('lets options.status override the static default', () => {
      const e = new TestException('m', { status: 500 })
      expect(e.status).toBe(500)
    })

    it('lets options.fatal override the static default', () => {
      const e = new TestException('m', { fatal: true })
      expect(e.fatal).toBe(true)
    })

    it('passes options.cause through to Error', () => {
      const cause = new Error('root cause')
      const e = new TestException('m', { cause })
      expect(e.cause).toBe(cause)
    })
  })

  describe('toString', () => {
    it('includes the code when present', () => {
      const e = new TestException('boom')
      expect(e.toString()).toBe('TestException [TEST_EXCEPTION]: boom')
    })

    it('omits the code bracket when no code is set', () => {
      class NoCodeException extends BaseException {}
      const e = new NoCodeException('plain')
      expect(e.toString()).toBe('NoCodeException: plain')
    })
  })

  describe('Symbol.toStringTag', () => {
    it('returns the constructor name', () => {
      const e = new TestException('m')
      expect(Object.prototype.toString.call(e)).toBe('[object TestException]')
    })
  })

  describe('BaseException.isBaseException', () => {
    it('returns true for BaseException instances', () => {
      expect(BaseException.isBaseException(new TestException('m'))).toBe(true)
      expect(BaseException.isBaseException(new BaseException('m'))).toBe(true)
    })

    it('returns false for plain Errors', () => {
      expect(BaseException.isBaseException(new Error('plain'))).toBe(false)
      expect(BaseException.isBaseException(new TypeError('plain'))).toBe(false)
    })

    it('returns false for non-error values', () => {
      expect(BaseException.isBaseException(null)).toBe(false)
      expect(BaseException.isBaseException(undefined)).toBe(false)
      expect(BaseException.isBaseException('boom')).toBe(false)
      expect(BaseException.isBaseException({})).toBe(false)
    })
  })
})
