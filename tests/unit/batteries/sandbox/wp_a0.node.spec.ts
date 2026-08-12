import { encode } from '@nhtio/encoder'
import { Media } from '../../../../src/common'
import { describe, expect, it, vi } from 'vitest'
import { ToolCall } from '../../../../src/lib/classes/tool_call'
import { createSandboxEpoch } from '../../../../src/batteries/sandbox/types'
import { E_READER_NOT_DESCRIBABLE } from '../../../../src/lib/exceptions/runtime'
import {
  createSandboxMedia,
  createSandboxMediaReader,
} from '../../../../src/batteries/sandbox/media_reader'
import type { SandboxFileSystem } from '../../../../src/batteries/sandbox/contracts/file_system'

const bytes = new TextEncoder().encode('sandbox payload')
const drain = async (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const item = await reader.read()
    if (item.done)
      return new Uint8Array(chunks.reduce((all, part) => [...all, ...part], [] as number[]))
    chunks.push(item.value)
  }
}

const makeFileSystem = (kind: 'file' | 'symlink' | 'other' = 'file') => {
  const read = vi.fn(
    async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
  )
  const fileSystem: SandboxFileSystem = {
    stat: async () => ({ size: bytes.byteLength, version: 'v1', kind }),
    list: async function* () {},
    read,
    write: async () => undefined,
  }
  return { fileSystem, read }
}

describe('sandbox media reader (WP-A0)', () => {
  it('reopens a fresh stream for every call and gets byteLength from stat', async () => {
    const { fileSystem, read } = makeFileSystem()
    const reader = createSandboxMediaReader({
      fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => true,
    })
    expect(await drain(await reader.stream())).toEqual(bytes)
    expect(await drain(await reader.stream())).toEqual(bytes)
    expect(read).toHaveBeenCalledTimes(2)
    expect(await reader.byteLength()).toBe(bytes.byteLength)
  })

  it.each(['symlink', 'other'] as const)('refuses %s before read', async (kind) => {
    const { fileSystem, read } = makeFileSystem(kind)
    const reader = createSandboxMediaReader({
      fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => true,
    })
    await expect(reader.stream()).rejects.toThrow(/not a regular file/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses every operation after the epoch dies', async () => {
    let live = true
    const { fileSystem, read } = makeFileSystem()
    const reader = createSandboxMediaReader({
      fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => live,
    })
    live = false
    await expect(reader.stream()).rejects.toMatchObject({ code: 'E_SANDBOX_NOT_INITIALIZED' })
    await expect(reader.byteLength()).rejects.toMatchObject({ code: 'E_SANDBOX_NOT_INITIALIZED' })
    expect(read).not.toHaveBeenCalled()
  })

  it('is deliberately non-describable, including through ToolCall encoding', () => {
    const reader = createSandboxMediaReader({
      fileSystem: makeFileSystem().fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => true,
    })
    expect(reader.describe).toBeUndefined()
    const media = createSandboxMedia({
      fileSystem: makeFileSystem().fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => true,
      kind: 'document',
      mimeType: 'text/plain',
      filename: 'x.txt',
      trustTier: 'first-party',
    })
    // The encoder wraps a non-encodable value in `E_ENCODING_FAILED` and hangs the real reason on
    // `cause`, so asserting the OUTER class would fail against a correct implementation. Assert the
    // CAUSE — that is what carries core's documented remedy ("back it with a describable reader").
    let thrown: unknown
    try {
      // `ToolCall` carries the encoder contract through `Symbol.for('@nhtio/encoder:toEncoded')`
      // rather than by importing `CustomEncodable`, so it satisfies the protocol at RUNTIME — which
      // is what this test exercises — while not matching the nominal interface structurally. The
      // cast is the seam between those two facts, not a way around a real type error.
      encode(
        new ToolCall({
          id: 'call',
          tool: 'stage',
          args: {},
          checksum: 'x',
          isComplete: true,
          isError: false,
          results: media,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:01.000Z',
          completedAt: '2024-01-01T00:00:02.000Z',
        }) as unknown as Parameters<typeof encode>[0]
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(E_READER_NOT_DESCRIBABLE)
  })

  it('does not register a resolver or provide a serialisable sandbox tag', () => {
    const media = createSandboxMedia({
      fileSystem: makeFileSystem().fileSystem,
      path: '/x',
      epoch: createSandboxEpoch(),
      isEpochLive: () => true,
      kind: 'document',
      mimeType: 'text/plain',
      filename: 'x',
      trustTier: 'first-party',
    })
    expect(Media.isMedia(media)).toBe(true)
  })
})
