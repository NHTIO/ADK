import { describe, expect, it } from 'vitest'
import {
  globMatches,
  patternCanContinue,
  patternsOverlap,
  validatePattern,
} from '../../../../src/batteries/dev_tools/matcher'

describe('dev-tools matcher grammar', () => {
  it('matches stars within one segment only', () => {
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(globMatches('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globMatches('src/**/x.ts', 'src/x.ts')).toBe(true)
    expect(globMatches('src/**/x.ts', 'src/a/x.ts')).toBe(true)
    expect(globMatches('src/**', 'src')).toBe(true)
  })

  it('validates the minimal grammar and normalizes authored separators', () => {
    expect(validatePattern(' src\\*.ts ')).toBe('src/*.ts')
    expect(validatePattern('a/**/**/b')).toBe('a/**/b')
    for (const pattern of [
      'src/foo**bar.ts',
      '**.ts',
      'a/**b/c',
      'a/?/b',
      'a/[ab]/b',
      'a/{b}/c',
      'a/!b',
      'a/^b',
    ]) {
      expect(() => validatePattern(pattern)).toThrow()
    }
  })

  it('is case-sensitive and applies the dot rule to matching', () => {
    expect(globMatches('src/*.ts', 'src/.hidden.ts')).toBe(false)
    expect(globMatches('src/.*.ts', 'src/.hidden.ts')).toBe(true)
    expect(globMatches('**', '.hidden')).toBe(false)
    expect(globMatches('.*', '.hidden')).toBe(true)
    expect(globMatches('src/*.TS', 'src/a.ts')).toBe(false)
  })

  it('applies the dot rule to overlap and mkdir satisfiability too', () => {
    expect(patternsOverlap('**', '.hidden')).toBe(false)
    expect(patternsOverlap('src/**', 'src/.hidden')).toBe(false)
    expect(patternsOverlap('.*', '.hidden')).toBe(true)
    expect(patternsOverlap('*.ts', '.x.ts')).toBe(false)
    expect(patternsOverlap('a/*', 'a/.x')).toBe(false)
    expect(patternsOverlap('**/*.ts', 'x/.a.ts')).toBe(false)
    expect(patternsOverlap('*.ts', 'x.ts')).toBe(true)
    expect(patternsOverlap('a/*', 'a/x')).toBe(true)
    expect(patternsOverlap('**/*.ts', 'x/a.ts')).toBe(true)
    expect(patternCanContinue('**', '.hidden')).toBe(false)
    expect(patternCanContinue('src/**', 'src/.hidden')).toBe(false)
    expect(patternCanContinue('.*', '.hidden')).toBe(false)
    expect(patternCanContinue('src/**', 'src')).toBe(true)
  })

  it('computes the named segment and path overlaps', () => {
    expect(patternsOverlap('foo*.ts', '*.test.ts')).toBe(true)
    expect(patternsOverlap('foo*.ts', 'bar*.ts')).toBe(false)
    expect(patternsOverlap('a*b*c', 'ab*c')).toBe(true)
    expect(patternsOverlap('src/generated/*.ts', 'src/**')).toBe(true)
    expect(patternsOverlap('src/generated/*.ts', 'test/**')).toBe(false)
    expect(patternsOverlap('src/generated/*.ts', 'src/*.js')).toBe(false)
  })
})
