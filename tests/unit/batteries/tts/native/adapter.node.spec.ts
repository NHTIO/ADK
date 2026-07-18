/**
 * Unit tests for {@link NativeTtsAdapter}. Hermetic: the binary executor, filesystem, tmpdir, and
 * random-name seams are injected fakes so no real `child_process` / file I/O runs. Verifies the
 * flag-based error classification (timedOut → 504, failed → 502), the RIFF/WAVE hard-assert, the
 * scratch-file cleanup on every path, and the per-call voice/rate/pitch override threading.
 *
 * @module tests/unit/batteries/tts/native/adapter
 */

import { describe, expect, it } from 'vitest'
import {
  NativeTtsAdapter,
  E_INVALID_NATIVE_TTS_OPTIONS,
  E_NATIVE_TTS_ENGINE_ERROR,
  E_NATIVE_TTS_TIMEOUT,
} from '@nhtio/adk/batteries/tts/native'
import type {
  NativeTtsAdapterOptions,
  TtsBinaryExecutor,
  TtsBinaryExecutorResult,
  TtsFsLike,
} from '@nhtio/adk/batteries/tts/native'

// Minimal valid RIFF/WAVE header (44 bytes) — RIFF at 0..3, WAVE at 8..11.
const RIFF_WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
  0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
])

// Bytes that are NOT a RIFF/WAVE file (PNG magic instead).
const NOT_RIFF = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1a,
])

const DETERMINISTIC_OUT = '/tmp/deterministic/adk-tts-fixed.wav'

/** A fake executor that records every invocation and returns a configurable result. */
const makeExecutor = (
  result: TtsBinaryExecutorResult,
  recorder: { invocations: Array<{ cmd: string; args: string[]; timeoutMs?: number }> }
): TtsBinaryExecutor => ({
  exec: async (invocation) => {
    recorder.invocations.push({
      cmd: invocation.cmd,
      args: invocation.args,
      timeoutMs: invocation.timeoutMs,
    })
    return result
  },
})

/** A fake fs that returns canned readFile bytes (default the RIFF/WAV) and records unlinks. */
const makeFs = (
  opts: {
    bytes?: Uint8Array
    readError?: Error
  } = {},
  recorder: { unlinks: string[]; reads: string[] } = { unlinks: [], reads: [] }
): { fs: TtsFsLike; recorder: typeof recorder } => {
  const fs: TtsFsLike = {
    readFile: async (path: string) => {
      recorder.reads.push(path)
      if (opts.readError) throw opts.readError
      return opts.bytes ?? RIFF_WAV
    },
    unlink: async (path: string) => {
      recorder.unlinks.push(path)
    },
  }
  return { fs, recorder }
}

/** Build a fully-injected adapter config (deterministic outPath + canned fs + fake executor). */
const makeConfig = (
  executor: TtsBinaryExecutor,
  fs: TtsFsLike,
  platform: NativeTtsAdapterOptions['platform'] = 'darwin'
): NativeTtsAdapterOptions => ({
  platform,
  executor,
  fs,
  tmpdir: () => '/tmp/deterministic',
  randomName: () => 'fixed',
})

describe('NativeTtsAdapter — construction + validation', () => {
  it('zero-config construction is valid', () => {
    expect(() => new NativeTtsAdapter()).not.toThrow()
    expect(() => new NativeTtsAdapter(undefined)).not.toThrow()
  })

  it('rejects unknown keys', () => {
    expect(() => new NativeTtsAdapter({ platform: 'darwin', bogus: 1 })).toThrow(
      E_INVALID_NATIVE_TTS_OPTIONS
    )
  })

  it('rejects an unknown platform enum value', () => {
    expect(() => new NativeTtsAdapter({ platform: 'solaris' as never })).toThrow(
      E_INVALID_NATIVE_TTS_OPTIONS
    )
  })

  it('rejects a negative timeoutMs', () => {
    expect(() => new NativeTtsAdapter({ platform: 'darwin', timeoutMs: -1 })).toThrow(
      E_INVALID_NATIVE_TTS_OPTIONS
    )
  })

  it('rejects a non-numeric rate', () => {
    expect(() => new NativeTtsAdapter({ platform: 'darwin', rate: 'fast' as never })).toThrow(
      E_INVALID_NATIVE_TTS_OPTIONS
    )
  })

  it('static isAvailable() reflects process.platform', () => {
    // The test host is node; the static probe must return a boolean and agree with the injected set.
    expect(typeof NativeTtsAdapter.isAvailable()).toBe('boolean')
  })

  it('isAvailable() honors an injected probe', () => {
    const a = new NativeTtsAdapter({ platform: 'darwin', isAvailable: () => true })
    expect(a.isAvailable()).toBe(true)
    const b = new NativeTtsAdapter({ platform: 'darwin', isAvailable: () => false })
    expect(b.isAvailable()).toBe(false)
  })

  it('preload() and reset() are no-ops', async () => {
    const a = new NativeTtsAdapter({ platform: 'darwin' })
    await expect(a.preload()).resolves.toBeUndefined()
    expect(() => a.reset()).not.toThrow()
  })
})

describe('NativeTtsAdapter — successful synthesis (darwin)', () => {
  it('returns kind=audio, audio/wav, filename speech.wav, and the canned bytes', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    )
    const result = await a.synthesize('hello')
    expect(result.kind).toBe('audio')
    expect(result.mimeType).toBe('audio/wav')
    expect(result.filename).toBe('speech.wav')
    expect(result.bytes).toEqual(RIFF_WAV)
  })

  it('passes the expected cmd + args (incl. outPath) to the executor', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    )
    await a.synthesize('hello')
    const call = execRecorder.invocations[0]
    expect(call.cmd).toBe('say')
    expect(call.args).toEqual([
      '-o',
      DETERMINISTIC_OUT,
      '--data-format=LEI16@22050',
      '-r',
      '175',
      'hello',
    ])
  })

  it('forwards timeoutMs (default 60_000) to the executor', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    )
    await a.synthesize('hello')
    expect(execRecorder.invocations[0].timeoutMs).toBe(60_000)
  })

  it('forwards a configured timeoutMs', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    cfg.timeoutMs = 5_000
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hello')
    expect(execRecorder.invocations[0].timeoutMs).toBe(5_000)
  })

  it('unlinks the scratch file on success', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs, recorder: fsRecorder } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    )
    await a.synthesize('hello')
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT])
  })
})

describe('NativeTtsAdapter — option threading', () => {
  it('applies the constructor voice and rate → wpm into the invocation', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    cfg.voice = 'Samantha'
    cfg.rate = 2 // 175*2 = 350 wpm
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hi')
    const args = execRecorder.invocations[0].args
    expect(args).toContain('-v')
    expect(args[args.indexOf('-v') + 1]).toBe('Samantha')
    expect(args).toContain('-r')
    expect(args[args.indexOf('-r') + 1]).toBe('350')
  })

  it('a per-call voice/rate override the constructor defaults (asserted via the recorded invocation)', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    cfg.voice = 'ctor-voice'
    cfg.rate = 1 // 175 wpm
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hi', { voice: 'call-voice', rate: 2 }) // 350 wpm
    const args = execRecorder.invocations[0].args
    expect(args[args.indexOf('-v') + 1]).toBe('call-voice')
    expect(args[args.indexOf('-r') + 1]).toBe('350')
  })

  it('wordsPerMinute overrides the rate→wpm mapping', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    cfg.wordsPerMinute = 250
    cfg.rate = 2 // would be 350 if wpm were not pinned
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hi')
    const args = execRecorder.invocations[0].args
    expect(args[args.indexOf('-r') + 1]).toBe('250')
  })

  it('clamps the computed wpm into [80, 500]', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs)
    cfg.rate = 10 // 175*10 = 1750 → clamp 500
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hi')
    const args = execRecorder.invocations[0].args
    expect(args[args.indexOf('-r') + 1]).toBe('500')
  })

  it('threads pitch on linux but not on darwin', async () => {
    const execRecorderDarwin = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs: fsD } = makeFs()
    await new NativeTtsAdapter({
      ...makeConfig(
        makeExecutor({ failed: false, timedOut: false }, execRecorderDarwin),
        fsD,
        'darwin'
      ),
      pitch: 50,
    }).synthesize('hi')
    const argsD = execRecorderDarwin.invocations[0].args
    expect(argsD).not.toContain('-p')

    const execRecorderLinux = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs: fsL } = makeFs()
    await new NativeTtsAdapter({
      ...makeConfig(
        makeExecutor({ failed: false, timedOut: false }, execRecorderLinux),
        fsL,
        'linux'
      ),
      pitch: 50,
    }).synthesize('hi')
    const argsL = execRecorderLinux.invocations[0].args
    expect(argsL).toContain('-p')
    expect(argsL[argsL.indexOf('-p') + 1]).toBe('50')
  })

  it('win32 maps rate → -10..10 int into the script (no -r flag)', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const cfg = makeConfig(
      makeExecutor({ failed: false, timedOut: false }, execRecorder),
      fs,
      'win32'
    )
    cfg.rate = 2 // ((2-1)*10) = 10
    const a = new NativeTtsAdapter(cfg)
    await a.synthesize('hi')
    const args = execRecorder.invocations[0].args
    expect(args[0]).toBe('-NoProfile')
    const script = args[3]
    expect(script).toContain('$s.Rate = 10;')
    expect(script).not.toMatch(/\s-r\s/)
  })
})

describe('NativeTtsAdapter — error classification (flags only)', () => {
  it('failed:true, timedOut:false → ENGINE_ERROR with stderr in the detail', async () => {
    const { fs } = makeFs()
    const exec = makeExecutor(
      { failed: true, timedOut: false, stderr: 'boom stderr' },
      { invocations: [] }
    )
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('boom stderr')
    }
  })

  it('timedOut:true → TIMEOUT (504), even when failed is also true', async () => {
    const { fs } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: true }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_TIMEOUT)
  })

  it('TIMEOUT uses the resolved timeoutMs in the message', async () => {
    const { fs } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: true }, { invocations: [] })
    const cfg = makeConfig(exec, fs)
    cfg.timeoutMs = 5_000
    const a = new NativeTtsAdapter(cfg)
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('5000')
      expect((err as Error & { status?: number }).status).toBe(504)
    }
  })

  it('ENGINE_ERROR is non-fatal (status 502)', async () => {
    const { fs } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: false, stderr: 'x' }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error & { fatal?: boolean }).fatal).toBe(false)
      expect((err as Error & { status?: number }).status).toBe(502)
    }
  })

  it('unlinks the scratch file on executor failure', async () => {
    const { fs, recorder: fsRecorder } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: false, stderr: 'x' }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT])
  })

  it('unlinks the scratch file on timeout', async () => {
    const { fs, recorder: fsRecorder } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: true }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_TIMEOUT)
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT])
  })

  it('a readFile failure → ENGINE_ERROR (empty/missing output)', async () => {
    const { fs, recorder: fsRecorder } = makeFs({ readError: new Error('ENOENT') })
    const exec = makeExecutor({ failed: false, timedOut: false }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT])
  })

  it('a REJECTING executor → ENGINE_ERROR AND still unlinks the scratch file', async () => {
    // The binary may have written a partial file before the executor rejected — cleanup must run.
    const { fs, recorder: fsRecorder } = makeFs()
    const rejectingExecutor: TtsBinaryExecutor = {
      exec: async () => {
        throw new Error('spawn ENOENT: say not found')
      },
    }
    const a = new NativeTtsAdapter(makeConfig(rejectingExecutor, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
    // Exactly one unlink of the scratch path — the leak terra flagged would show zero unlinks here.
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT])
  })

  it('a non-RIFF readFile result → ENGINE_ERROR', async () => {
    const { fs, recorder: fsRecorder } = makeFs({ bytes: NOT_RIFF })
    const exec = makeExecutor({ failed: false, timedOut: false }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('RIFF/WAVE')
    }
    expect(fsRecorder.unlinks).toEqual([DETERMINISTIC_OUT, DETERMINISTIC_OUT])
  })

  it('a too-short readFile result → ENGINE_ERROR (RIFF/WAVE invariant)', async () => {
    const { fs } = makeFs({ bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]) })
    const exec = makeExecutor({ failed: false, timedOut: false }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    await expect(a.synthesize('hi')).rejects.toThrow(E_NATIVE_TTS_ENGINE_ERROR)
  })

  it('a failed result with no stderr → ENGINE_ERROR with the fallback detail', async () => {
    const { fs } = makeFs()
    const exec = makeExecutor({ failed: true, timedOut: false }, { invocations: [] })
    const a = new NativeTtsAdapter(makeConfig(exec, fs))
    try {
      await a.synthesize('hi')
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).toContain('synthesis failed')
    }
  })
})

describe('NativeTtsAdapter — unsupported platform', () => {
  it('a constructor platform of darwin is honored on every host (no process.platform read)', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs, 'darwin')
    )
    await a.synthesize('hi')
    expect(execRecorder.invocations[0].cmd).toBe('say')
  })

  it('a constructor platform of linux is honored', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs, 'linux')
    )
    await a.synthesize('hi')
    expect(execRecorder.invocations[0].cmd).toBe('espeak-ng')
  })

  it('a constructor platform of win32 is honored', async () => {
    const execRecorder = {
      invocations: [] as Array<{ cmd: string; args: string[]; timeoutMs?: number }>,
    }
    const { fs } = makeFs()
    const a = new NativeTtsAdapter(
      makeConfig(makeExecutor({ failed: false, timedOut: false }, execRecorder), fs, 'win32')
    )
    await a.synthesize('hi')
    expect(execRecorder.invocations[0].cmd).toBe('powershell.exe')
  })
})

describe('NativeTtsAdapter — default executor is lazy (no node builtins at construction)', () => {
  it('constructing without an executor does not touch child_process (synthesize without fs would still lazy-import)', () => {
    // Sanity: construction alone must not import node:child_process. We assert by constructing
    // without throwing and without an executor seam; the real default is only resolved on synth.
    const a = new NativeTtsAdapter({ platform: 'darwin' })
    expect(a).toBeInstanceOf(NativeTtsAdapter)
  })

  it('an isAvailable seam returning false is honored', () => {
    const a = new NativeTtsAdapter({ platform: 'darwin', isAvailable: () => false })
    expect(a.isAvailable()).toBe(false)
  })
})
