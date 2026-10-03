import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { runSandboxConformance } from '../../../../src/batteries/sandbox/conformance'
import { createRipgrepSearch } from '../../../../src/batteries/sandbox/node/search_ripgrep'
import { sandboxRuntimeGate, sandboxRuntimeGateReason } from '../../../_fixtures/sandbox_runtime'
import {
  srtEnforcer,
  releaseSrtOwnershipForTests,
} from '../../../../src/batteries/sandbox/node/srt_enforcer'
import type { SandboxPolicy } from '../../../../src/batteries/sandbox/types'

/**
 * `createRipgrepSearch` must express an unbounded search (issue #48).
 *
 * @remarks
 * Driven through the REAL Node SRT enforcer (seatbelt on this host) and a real spawned `rg`: the bug
 * was in argv construction (`--max-depth undefined` when the depth was omitted), which a fake
 * enforcer would not exercise.
 */

const roots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adk48-'))
  roots.push(root)
  return root
}

const policyFor = (root: string): SandboxPolicy => ({
  filesystem: { allowWrite: [root], allowRead: [root], gitSafeDirectories: [root] },
  network: { allowedDomains: [] },
})

const drain = async (source: AsyncIterable<unknown>) => {
  const frames: unknown[] = []
  for await (const frame of source) frames.push(frame)
  return frames
}

afterEach(async () => {
  releaseSrtOwnershipForTests()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('createRipgrepSearch argument validation (issue #48)', () => {
  it('rejects invalid explicit limits and depths before spawning', async () => {
    const fakeEnforcer = {
      run: async () => {
        throw new Error('search validation should fail before running enforcer')
      },
      diagnosticsFor: () => [],
      dispose: async () => {},
    } as any
    const search = createRipgrepSearch(fakeEnforcer, { filesystem: {}, network: {} })
    for (const limit of [0, -1, 1.5, Infinity, Number.NaN]) {
      await expect(
        drain(search.findPaths({ root: '/tmp', glob: '*.txt', maxDepth: 3, limit }))
      ).rejects.toThrow(/limit must be a positive integer/)
    }
    await expect(
      drain(search.findPaths({ root: '/tmp', glob: '*.txt', maxDepth: -1 }))
    ).rejects.toThrow(/maxDepth must be a non-negative integer/)
  })

  it('reports whether real-SRT ripgrep search assertions ran', () => {
    console.info(`sandbox runtime gate: ${sandboxRuntimeGateReason}`)
    expect(['darwin', 'linux']).toContain(process.platform)
  })
})

describe.skipIf(!sandboxRuntimeGate)(
  'createRipgrepSearch — unbounded mode with real rg (issue #48)',
  () => {
    const makeTree = async (): Promise<string> => {
      const root = await makeRoot()
      const { mkdir, writeFile } = await import('node:fs/promises')
      for (let i = 0; i < 5; i++) {
        await writeFile(join(root, `file-${i}.txt`), 'needle\n')
      }
      await mkdir(join(root, 'nested/deeper'), { recursive: true })
      await writeFile(join(root, 'nested/deeper/needle.txt'), 'needle\n')
      return root
    }

    it('returns every match then complete:true when limit is omitted', async () => {
      const root = await makeTree()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const search = createRipgrepSearch(enforcer, policy)
      const frames = (await drain(
        search.findPaths({ root, glob: '*.txt', maxDepth: 10 })
      )) as Array<{
        kind: string
        path?: string
        complete?: boolean
      }>
      const items = frames.filter((frame) => frame.kind === 'item')
      expect(items.length).toBe(6)
      expect(frames.at(-1)).toEqual({ kind: 'done', complete: true })
      await enforcer.dispose()
    }, 120_000)

    it('runs without --max-depth when maxDepth is omitted, and still completes', async () => {
      const root = await makeTree()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      // Wrap `run` to capture the argv the adapter built, around the REAL spawn.
      const argvs: string[][] = []
      const originalRun = enforcer.run.bind(enforcer)
      enforcer.run = async (op) => {
        argvs.push([...op.argv])
        return originalRun(op)
      }
      const search = createRipgrepSearch(enforcer, policy)
      const frames = (await drain(
        search.searchContent({ root, pattern: 'needle', limit: 100 })
      )) as Array<{ kind: string; complete?: boolean }>
      expect(frames.at(-1)).toEqual({ kind: 'done', complete: true })
      expect(argvs).toHaveLength(1)
      expect(argvs[0]).not.toContain('--max-depth')
      await enforcer.dispose()
    }, 120_000)

    it('limit:3 over 5 matches returns 3 then over-limit complete:false', async () => {
      const root = await makeTree()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const search = createRipgrepSearch(enforcer, policy)
      const frames = (await drain(
        search.findPaths({ root, glob: '*.txt', maxDepth: 10, limit: 3 })
      )) as Array<{ kind: string; complete?: boolean; omitted?: string }>
      expect(frames.filter((frame) => frame.kind === 'item')).toHaveLength(3)
      expect(frames.at(-1)).toEqual({
        kind: 'done',
        complete: false,
        omitted: 'over-limit',
        bound: 'limit',
        shown: 3,
      })
      await enforcer.dispose()
    }, 120_000)

    it('conforms under the shared protocol suite with omission as its unbounded mode', async () => {
      // The conformance suite's job is to prove framing/laziness/termination hold. The unbounded case
      // is a source whose bounds are OMITTED — every match must still arrive and terminate with exactly
      // one `{ complete: true }` frame, which is the contract the omission branch promises.
      const root = await makeTree()
      const policy = policyFor(root)
      const enforcer = await srtEnforcer({ policy })
      const search = createRipgrepSearch(enforcer, policy)
      await runSandboxConformance({
        list: (_signal, onStart) =>
          (async function* () {
            // `list_directory` has no limit/maxDepth concept; a complete empty listing conforms.
            onStart?.()
            yield { kind: 'done', complete: true } as const
          })(),
        findPaths: (_signal, onStart) =>
          (async function* () {
            onStart?.()
            // BOTH bounds omitted: the unbounded mode under test.
            yield* search.findPaths({ root, glob: '*.txt' })
          })(),
        searchContent: (_signal, onStart) =>
          (async function* () {
            onStart?.()
            yield* search.searchContent({ root, pattern: 'needle' })
          })(),
        read: async () => new ReadableStream<Uint8Array>(),
        stat: async () => ({ size: 0, version: 'constant' }),
      })
      await enforcer.dispose()
    }, 120_000)
  }
)
