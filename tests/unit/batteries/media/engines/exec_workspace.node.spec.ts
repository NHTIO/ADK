import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { execaExecutor } from '../../../../../src/batteries/media/engines/execa_executor'
import { fsScratchWorkspace } from '../../../../../src/batteries/media/engines/fs_workspace'
import {
  implementsBinaryExecutor,
  implementsScratchWorkspace,
} from '../../../../../src/batteries/media/contracts'

describe('execaExecutor', () => {
  it('conforms to the BinaryExecutor contract', () => {
    expect(implementsBinaryExecutor(execaExecutor())).toBe(true)
  })

  it('runs a binary and captures stdout', async () => {
    const executor = execaExecutor()
    const result = await executor.exec({ cmd: 'echo', args: ['hello'] })
    expect(result.failed).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
  })

  it('reports non-zero exits via failed, never throws', async () => {
    const executor = execaExecutor()
    const result = await executor.exec({ cmd: 'false', args: [] })
    expect(result.failed).toBe(true)
    expect(result.exitCode).not.toBe(0)
  })

  it('reports missing binaries via failed (WORKER_UNAVAILABLE mapping is the caller’s)', async () => {
    const executor = execaExecutor()
    const result = await executor.exec({ cmd: 'definitely-not-a-real-binary-xyz', args: [] })
    expect(result.failed).toBe(true)
  })

  it('honors timeouts', async () => {
    const executor = execaExecutor()
    const result = await executor.exec({ cmd: 'sleep', args: ['5'], timeoutMs: 100 })
    expect(result.failed).toBe(true)
  })
})

describe('fsScratchWorkspace', () => {
  const root = join(tmpdir(), 'adk-media-spec')

  it('requires an explicit root (no platform default)', () => {
    // @ts-expect-error missing root on purpose
    expect(() => fsScratchWorkspace({})).toThrow(/explicit root/)
  })

  it('mints conforming workspaces with unique dirs', async () => {
    const factory = fsScratchWorkspace({ root })
    const a = await factory()
    const b = await factory()
    try {
      expect(implementsScratchWorkspace(a)).toBe(true)
      expect(a.dir()).not.toBe(b.dir())
    } finally {
      await a.dispose()
      await b.dispose()
    }
  })

  it('materializes bytes to a readable path and lists files', async () => {
    const factory = fsScratchWorkspace({ root })
    const ws = await factory()
    try {
      const path = await ws.materialize(new TextEncoder().encode('content'), 'input.txt')
      expect(path.startsWith(ws.dir())).toBe(true)
      expect(new TextDecoder().decode(await ws.read(path))).toBe('content')
      expect(await ws.list()).toContain('input.txt')
    } finally {
      await ws.dispose()
    }
  })

  it('sanitizes path separators in filenames', async () => {
    const factory = fsScratchWorkspace({ root })
    const ws = await factory()
    try {
      const path = await ws.materialize(new Uint8Array([1]), '../escape/attempt.bin')
      expect(path.startsWith(ws.dir())).toBe(true)
      expect(path).not.toContain('escape/')
    } finally {
      await ws.dispose()
    }
  })

  it('dispose removes the directory', async () => {
    const factory = fsScratchWorkspace({ root })
    const ws = await factory()
    const dir = ws.dir()
    await ws.materialize(new Uint8Array([1, 2]), 'f.bin')
    await ws.dispose()
    await expect(stat(dir)).rejects.toThrow()
  })

  it('executor + workspace compose: a binary reads a materialized path', async () => {
    const factory = fsScratchWorkspace({ root })
    const ws = await factory()
    try {
      const path = await ws.materialize(new TextEncoder().encode('from-file'), 'in.txt')
      const result = await execaExecutor().exec({ cmd: 'cat', args: [path] })
      expect(result.stdout).toBe('from-file')
    } finally {
      await ws.dispose()
    }
  })
})
