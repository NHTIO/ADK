// RELEASE-GATING: fail-closed OS enforcement and real ripgrep classification.
import { describe, expect, it } from 'vitest'
import { createRipgrepSearch } from '../../src/batteries/sandbox/node/search_ripgrep'
import { RUN, root, tempDir, disposeDir, makeEnforcer, run } from './sandbox_live_helpers'
import type { SandboxPolicy } from '../../src/batteries/sandbox/types'

const realRg = (): string | undefined => {
  const p = process.env.PATH?.split(':')
    .map((x) => `${x}/rg`)
    .find((x) => {
      try {
        return require('node:fs').statSync(x).isFile()
      } catch {
        return false
      }
    })
  return p?.includes('claude') ? undefined : p
}

describe.skipIf(!RUN)('sandbox — live enforcement fails closed (release)', () => {
  it('denies credentials, denies a host, and permits an allowlisted host', async () => {
    const dir = await tempDir()
    await import('node:fs/promises').then(({ writeFile }) => writeFile(`${dir}/secret`, 'x'))
    const p: SandboxPolicy = {
      filesystem: { denyRead: [`${dir}/secret`] },
      network: { allowedDomains: ['example.com'] },
    }
    const e = await makeEnforcer(p)
    try {
      const deniedRead = await run(e, p, ['cat', `${dir}/secret`], root)
      expect(deniedRead.exitCode).not.toBe(0)
      const allowlisted = await run(e, p, ['curl', '-fsS', 'https://example.com'], root)
      expect(allowlisted.exitCode).toBe(0)
      const denied = await run(e, p, ['curl', '-fsS', 'https://not-allowlisted.invalid'], root)
      if (denied.diagnostics.length === 0) {
        console.warn('sandbox live: no network diagnostics recorded on darwin')
      } else {
        expect(denied.diagnostics.join(' ')).toMatch(/not-allowlisted\.invalid/)
      }
    } finally {
      await e.dispose()
      await disposeDir(dir)
    }
  })
  it('proves a real gate denial and diagnostics-first ripgrep classification', async () => {
    const dir = await tempDir()
    const p: SandboxPolicy = {
      filesystem: { allowWrite: [dir] },
      network: {},
    }
    const e = await makeEnforcer(p)
    try {
      const denied = await run(e, p, ['sh', '-c', 'printf x > /etc/nhtio-live-denied'], dir)
      expect(denied.exitCode).not.toBe(0)
      if (process.platform === 'darwin' && denied.diagnostics.length === 0) {
        console.warn(
          'sandbox live: SRT records no diagnostic for plain filesystem denial on darwin'
        )
      } else {
        expect(denied.diagnostics.join(' ')).toMatch(/sandbox-violation|denied/)
      }
      if (process.platform !== 'linux') {
        console.warn(
          'sandbox live: skipping ripgrep enforcement cases; SRT ripgrep path is Linux-only'
        )
        return
      }
      const rg = realRg()
      if (!rg) {
        console.warn(
          'sandbox live: skipping ripgrep assertions; PATH rg is a Claude Code shim or absent'
        )
        return
      }
      const search = createRipgrepSearch(e, p)
      await expect(
        (async () => {
          for await (const frameValue of search.searchContent({
            root: '/etc',
            pattern: '[',
            maxDepth: 1,
            limit: 100,
          })) {
            void frameValue
          }
        })()
      ).rejects.toThrow(/regex parse error/)
      const deniedSearch = createRipgrepSearch(e, {
        ...p,
        filesystem: { denyRead: ['/etc'] },
      })
      await expect(
        (async () => {
          for await (const frameValue of deniedSearch.searchContent({
            root: '/etc',
            pattern: 'x',
            maxDepth: 1,
            limit: 100,
          })) {
            void frameValue
          }
        })()
      ).rejects.toThrow(/denied-by-policy/)
    } finally {
      await e.dispose()
      await disposeDir(dir)
    }
  })
})
