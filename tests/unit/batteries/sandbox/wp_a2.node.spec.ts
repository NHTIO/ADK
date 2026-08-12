import { describe, expect, it } from 'vitest'
import {
  POSIX_SHELLS,
  assertArgvValue,
  assertAllowedRipgrepFlag,
  binaryHonorsDoubleDash,
  quoteShellArgs,
  validateBinShell,
} from '../../../../src/batteries/sandbox/escape'

describe('sandbox shell escaping (WP-A2)', () => {
  it('quotes shell metacharacters literally and round-trips argv', async () => {
    const argv = [
      'ordinary.txt',
      'out.txt; touch /tmp/pwned',
      'a && b',
      'x|y',
      '$(touch /tmp/pwned)',
      '`id`',
      '$VAR',
      'line\nnext',
      'a\'b"c',
      '*?[].txt',
    ]
    const quoted = await quoteShellArgs(argv)
    const script = `printf '%s\\0' ${quoted}`
    const result = await new Promise<{ stdout: string; status: number | null }>(
      (resolve, reject) => {
        const child = require('node:child_process').spawn('/bin/sh', ['-c', script], {
          encoding: 'utf8',
        })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', (status: number | null) => resolve({ stdout, status }))
      }
    )
    expect(result.status).toBe(0)
    expect(result.stdout.split('\0').slice(0, -1)).toEqual(argv)
    expect(require('node:fs').existsSync('/tmp/pwned')).toBe(false)
  })

  it('preserves the leading equals case through the upstream quote fast path', async () => {
    // A LEADING `=` must be QUOTED, because zsh performs equals-expansion on an unquoted `=value`
    // even under `zsh -c`. Upstream's bare fast path already handles this, which is exactly why we
    // call `quote()` instead of hand-rolling one — a naive quoter emits `=value` bare and the shell
    // expands it. So assert the whole argument is quoted, not that a `'='` fragment appears: upstream
    // wraps the entire arg (`'=value'`), and an earlier version of this assertion looked for `'='`
    // inside it and failed against the CORRECT implementation.
    const quoted = await quoteShellArgs(['=value'])
    expect(quoted).toBe("'=value'")
    // And the control: a value with no leading `=` takes the bare fast path unquoted, so the
    // assertion above is discriminating rather than "quote() always quotes".
    expect(await quoteShellArgs(['value'])).toBe('value')
  })

  it('rejects option injection only at argv-parser boundaries', () => {
    expect(() => assertArgvValue('--pre=/bin/sh')).toThrow(/must not begin/)
    expect(() => assertArgvValue('-weird.txt')).toThrow()
    expect(assertArgvValue('ordinary.txt')).toBe('ordinary.txt')
    expect(binaryHonorsDoubleDash('cp')).toBe(true)
    expect(binaryHonorsDoubleDash('ls')).toBe(false)
    expect(assertAllowedRipgrepFlag('--max-depth=2')).toBe('--max-depth=2')
    expect(() => assertAllowedRipgrepFlag('--pre=/bin/sh')).toThrow()
    expect(binaryHonorsDoubleDash('rg')).toBe(true)
  })

  it('validates binShell against the allowed absolute POSIX set', () => {
    for (const shell of ['/bin/bash', '/bin/sh', '/bin/dash', '/bin/zsh', '/bin/ksh'])
      expect(validateBinShell(shell)).toBe(shell)
    expect(validateBinShell()).toBe('/bin/bash')
    for (const value of ['cmd.exe', 'powershell.exe', 'fish', 'bash']) {
      expect(() => validateBinShell(value)).toThrow(
        new RegExp(`${value}|${POSIX_SHELLS.join('|')}`)
      )
    }
  })

  it('rejects NUL before any spawn is attempted', async () => {
    await expect(quoteShellArgs(['a\0b'])).rejects.toThrow(/NUL/)
  })
})
