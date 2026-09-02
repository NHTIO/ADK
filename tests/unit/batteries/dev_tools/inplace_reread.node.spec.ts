import { describe, expect, it } from 'vitest'
import { createDevPipeline } from '../../../../src/batteries/dev_tools'

const stream = (t: string) =>
  new ReadableStream<Uint8Array>({
    start: (c) => {
      c.enqueue(new TextEncoder().encode(t))
      c.close()
    },
  })
const translator = {
  toRelative: async (p: string) => p.replace(/^\//, ''),
  toBackendPath: (p: string) => `/root${p ? `/${p}` : ''}`,
  redact: (p: string) => `[r:${p}]`,
  assertNoSymlinkComponents: async () => {},
}

describe('dev-tools in-place re-read authority', () => {
  // The headline workflow: `lint --fix` mutates DISK, so the authoritative re-read must refresh
  // the workspace from what actually landed. Without it a later `check` reasons about the text
  // the model wrote rather than the text the fixer produced — silently wrong, and invisible.
  it('refreshes the workspace from disk so a later step sees the fixer output, not stale text', async () => {
    // Mutable disk the "fixer" edits behind the pipeline's back.
    const disk: Record<string, string> = { '/root/a.ts': 'original' }
    const fs = {
      stat: async (p: string) => {
        if (disk[p] === undefined) throw new Error('ENOENT')
        return { size: disk[p].length, version: String(disk[p].length), kind: 'file' } as const
      },
      read: async (p: string) => {
        if (disk[p] === undefined) throw new Error('ENOENT')
        return stream(disk[p])
      },
      write: async () => {},
      async *list() {
        for (const p of Object.keys(disk))
          yield { kind: 'item' as const, path: p, entryKind: 'file' as const }
        yield { kind: 'done' as const, complete: true as const }
      },
    }
    const seen: string[] = []
    const dp = await createDevPipeline({
      handle: { effectivePolicy: () => ({ allow: ['**'] }) },
      fileSystem: fs,
      pathTranslator: translator,
      gate: async () => ({ approved: true }),
      root: '/root',
      engines: [
        async () => ({
          id: 'fixer',
          lints: [
            {
              extensions: ['ts'],
              fixable: true,
              inPlace: true,
              scope: ['**'],
              // Mutates DISK directly, exactly as `eslint --fix` does.
              lint: async () => {
                disk['/root/a.ts'] = 'FIXED-ON-DISK'
                return {}
              },
            },
          ],
        }),
        async () => ({
          id: 'observer',
          checks: [
            {
              extensions: ['ts'],
              check: async (req: any) => {
                seen.push(req.files.get('a.ts')?.text ?? '(gone)')
                return {}
              },
            },
          ],
        }),
      ],
    } as any)

    await dp.ops(
      ['a.ts'],
      [
        { step: 'lint', args: { fix: true } },
        { step: 'check', args: {} },
      ]
    )
    expect(seen[0]).toBe('FIXED-ON-DISK')
  })
})
