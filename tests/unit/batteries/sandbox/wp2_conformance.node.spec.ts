import { describe, expect, it } from 'vitest'
import { createExistingSymlinkGuard } from '../../../../src/batteries/sandbox/paths'
import {
  ConformanceMutations,
  ConformanceSources,
  runSandboxConformance,
} from '../../../../src/batteries/sandbox/conformance'
import type { SandboxFileSystem } from '../../../../src/batteries/sandbox/contracts/file_system'

const sourceFixture = (): ConformanceSources => {
  const done = { kind: 'done', complete: true } as const
  const stream = (_signal?: AbortSignal, onStart?: () => void) =>
    (async function* () {
      onStart?.()
      yield done
    })()
  return {
    list: stream,
    findPaths: stream,
    searchContent: stream,
    read: async () => new ReadableStream<Uint8Array>(),
    stat: async () => ({ size: 0, version: 'constant' }),
  }
}

const makeMutations = () => {
  const entries = new Map<string, { kind: 'file' | 'dir'; text: string }>([
    ['/default', { kind: 'dir', text: '' }],
    ['/other', { kind: 'dir', text: '' }],
  ])
  let serial = 0
  const path = (directory: 'default' | 'other' = 'default') => `/${directory}/fixture-${++serial}`
  const mutations: ConformanceMutations = {
    makeFile: async (text, options) => {
      const result = path(options?.directory)
      entries.set(result, { kind: 'file', text })
      return result
    },
    freePath: async (options) => path(options?.directory),
    stat: async (name) => {
      const entry = entries.get(name)
      if (!entry) throw new Error('missing')
      return {
        size: new TextEncoder().encode(entry.text).byteLength,
        version: entry.text,
        kind: entry.kind,
      }
    },
    read: async (name) => {
      const entry = entries.get(name)
      if (!entry || entry.kind !== 'file') throw new Error('not a file')
      return entry.text
    },
    write: async (name, text) => {
      const parent = name.slice(0, name.lastIndexOf('/'))
      if (!entries.has(parent)) throw new Error('parent missing')
      entries.set(name, { kind: 'file', text })
    },
    delete: async (name) => {
      entries.delete(name)
    },
    rename: async (from, to) => {
      const entry = entries.get(from)
      if (!entry) throw new Error('source missing')
      entries.delete(from)
      entries.set(to, entry)
    },
    mkdir: async (name) => {
      const existing = entries.get(name)
      if (existing?.kind === 'file') throw new Error('file exists')
      entries.set(name, { kind: 'dir', text: '' })
    },
  }
  return mutations
}

describe('sandbox mutation conformance (A6)', () => {
  it('exercises mutations, including overwrite, cross-directory rename, and mkdir semantics', async () => {
    const report = await runSandboxConformance(sourceFixture(), makeMutations())
    expect(report.skipped).toEqual([])
  })

  it('runs every optional combination and names only the omitted groups', async () => {
    const optional = ['delete', 'rename', 'mkdir'] as const
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const mutations = makeMutations()
      const omitted = optional.filter((_, index) => (mask & (1 << index)) === 0)
      for (const name of omitted) delete (mutations as Partial<ConformanceMutations>)[name]
      const report = await runSandboxConformance(sourceFixture(), mutations)
      expect(report.skipped).toEqual(omitted)
    }
  })

  it('uses callable tests for dynamically supplied optional members and never skips required write', async () => {
    const mutations = makeMutations() as ConformanceMutations & Record<string, unknown>
    ;(mutations as Record<string, unknown>).delete = true
    ;(mutations as Record<string, unknown>).rename = 1
    ;(mutations as Record<string, unknown>).mkdir = 'yes'
    const report = await runSandboxConformance(sourceFixture(), mutations)
    expect(report.skipped).toEqual(['delete', 'rename', 'mkdir'])
  })
})

describe('createExistingSymlinkGuard', () => {
  it('rejects visible symlinks and stops at the first missing component', async () => {
    const calls: string[] = []
    const fs = {
      stat: async (name: string) => {
        calls.push(name)
        if (name === '/root/link') return { size: 0, version: '1', kind: 'symlink' as const }
        if (name === '/root/missing') throw new Error('missing')
        return { size: 0, version: '1', kind: 'dir' as const }
      },
    } as SandboxFileSystem
    const guard = createExistingSymlinkGuard('/root/', fs)
    await expect(guard('link/child')).rejects.toThrow()
    calls.length = 0
    await expect(guard('missing/absent-final-target')).resolves.toBeUndefined()
    expect(calls).toEqual(['/root', '/root/missing'])
    calls.length = 0
    await expect(guard('existing/absent-final-target')).resolves.toBeUndefined()
    expect(calls).toEqual(['/root', '/root/existing', '/root/existing/absent-final-target'])
  })
})
