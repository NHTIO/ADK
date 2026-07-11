// Unit coverage for the shared WebGPU memory-observability layer (gpu_budget). Env-neutral
// (node + browser), no provider peers — the OOM-signature detector, the device-budget probe (with an
// injected navigator-like), and the opt-in live buffer instrument (with an injected GPUDevice-like
// global). Imported from the transformers.js battery barrel, which re-exports the chat_common layer.
// The detector is load-bearing: it is the single source of truth that turns ORT-web's cryptic
// exhaustion throws into the typed, catchable E_LLM_GPU_OUT_OF_MEMORY both on-device batteries nack.

import { describe, expect, it, vi } from 'vitest'
import {
  isGpuOutOfMemoryError,
  probeGpuBudget,
  instrumentGpuBuffers,
} from '@nhtio/adk/batteries/llm/transformers_js'

describe('isGpuOutOfMemoryError', () => {
  it('matches the known ORT-web / WebGPU + WASM-heap exhaustion signatures (case-insensitive)', () => {
    const signatures = [
      // WebGPU device-buffer (VRAM) exhaustion
      'Failed to allocate memory for buffer mapping',
      'WebGPU device error(3): Failed to allocate memory for buffer mapping',
      'out of memory',
      'Device is lost',
      'RequestDeviceFailed',
      'operation does not support unaligned accesses',
      'Failed to create a session buffer',
      'mapAsync ... Invalid Buffer',
      'Buffer exceeds the max buffer size limit',
      // WASM linear-memory (ORT heap) exhaustion — hit first at large context windows on WASM/JSEP.
      // transformers.js rethrows these verbatim; same capacity signal, same remedy.
      'An error occurred during model execution: "RuntimeError: memory access out of bounds".',
      'RuntimeError: memory access out of bounds',
      'Cannot enlarge memory arrays',
      'out of bounds memory access',
      'abort(OOM)',
    ]
    for (const s of signatures) {
      expect(isGpuOutOfMemoryError(s)).toBe(true)
      expect(isGpuOutOfMemoryError(s.toLowerCase())).toBe(true)
      expect(isGpuOutOfMemoryError(s.toUpperCase())).toBe(true)
    }
  })

  it('does NOT match unrelated errors (no false positives)', () => {
    const benign = [
      'Tool not found: get_order',
      'ValidationError: "city" is required',
      'Network request failed',
      'Tool arguments must be a JSON object',
      'the model declined to answer',
      '',
    ]
    for (const s of benign) expect(isGpuOutOfMemoryError(s)).toBe(false)
  })
})

describe('probeGpuBudget', () => {
  it('reads adapter limits + info from an injected navigator-like', async () => {
    const nav = {
      gpu: {
        requestAdapter: async () => ({
          limits: {
            maxBufferSize: 4 * 1024 * 1024 * 1024,
            maxStorageBufferBindingSize: 2_147_483_644,
          },
          info: {
            vendor: 'apple',
            architecture: 'metal-3',
            device: '',
            description: 'Apple M-series',
          },
        }),
      },
    }
    const b = await probeGpuBudget(nav)
    expect(b.available).toBe(true)
    expect(b.maxBufferBytes).toBe(4 * 1024 * 1024 * 1024)
    expect(b.maxStorageBufferBindingBytes).toBe(2_147_483_644)
    expect(b.adapterInfo).toMatchObject({ vendor: 'apple', architecture: 'metal-3' })
    // An empty info string is dropped (not surfaced as a blank field).
    expect(b.adapterInfo).not.toHaveProperty('device')
  })

  it('falls back to requestAdapterInfo() when info is absent', async () => {
    const nav = {
      gpu: {
        requestAdapter: async () => ({
          limits: { maxBufferSize: 1024, maxStorageBufferBindingSize: 512 },
          requestAdapterInfo: async () => ({ vendor: 'mesa' }),
        }),
      },
    }
    const b = await probeGpuBudget(nav)
    expect(b.available).toBe(true)
    expect(b.adapterInfo).toMatchObject({ vendor: 'mesa' })
  })

  it('returns {available:false} when WebGPU is absent', async () => {
    const b = await probeGpuBudget({})
    expect(b.available).toBe(false)
    expect(b.maxBufferBytes).toBe(0)
    expect(b.maxStorageBufferBindingBytes).toBe(0)
  })

  it('returns {available:false} when the adapter request rejects (never throws)', async () => {
    const nav = {
      gpu: {
        requestAdapter: async () => {
          throw new Error('adapter refused')
        },
      },
    }
    const b = await probeGpuBudget(nav)
    expect(b.available).toBe(false)
  })

  it('returns {available:false} when requestAdapter resolves null', async () => {
    const nav = { gpu: { requestAdapter: async () => null } }
    const b = await probeGpuBudget(nav)
    expect(b.available).toBe(false)
  })
})

describe('instrumentGpuBuffers', () => {
  it('tallies live + peak bytes across createBuffer / destroy, and uninstall restores the original', () => {
    // A minimal GPUDevice-like: createBuffer returns an object with a destroy(). The instrument wraps
    // the PROTOTYPE method, so we model that shape with a class whose prototype carries createBuffer.
    const created: Array<{ size: number; destroy: () => void }> = []
    class FakeDevice {
      createBuffer(desc: { size: number }): { size: number; destroy: () => void } {
        const buf = { size: desc.size, destroy: () => {} }
        created.push(buf)
        return buf
      }
    }
    const origCreate = FakeDevice.prototype.createBuffer
    const g = { GPUDevice: FakeDevice }

    const inst = instrumentGpuBuffers(g)
    expect(FakeDevice.prototype.createBuffer).not.toBe(origCreate) // wrapped

    const dev = new FakeDevice()
    const a = dev.createBuffer({ size: 1000 })
    const b = dev.createBuffer({ size: 2000 })
    let s = inst.sample()
    expect(s.created).toBe(2)
    expect(s.live).toBe(2)
    expect(s.liveBytes).toBe(3000)
    expect(s.peakBytes).toBe(3000)

    a.destroy()
    s = inst.sample()
    expect(s.destroyed).toBe(1)
    expect(s.live).toBe(1)
    expect(s.liveBytes).toBe(2000)
    // peak is a high-water-mark — it does NOT drop when a buffer is freed.
    expect(s.peakBytes).toBe(3000)

    // A larger allocation pushes the peak up (the freelist-growth signature).
    dev.createBuffer({ size: 5000 })
    expect(inst.sample().peakBytes).toBe(7000)

    void b
    inst.uninstall()
    expect(FakeDevice.prototype.createBuffer).toBe(origCreate) // restored
  })

  it('is a safe no-op when WebGPU is unavailable (no GPUDevice)', () => {
    const inst = instrumentGpuBuffers({})
    const s = inst.sample()
    expect(s).toEqual({ created: 0, destroyed: 0, live: 0, liveBytes: 0, peakBytes: 0 })
    expect(() => inst.uninstall()).not.toThrow()
  })

  it('uninstall is idempotent', () => {
    class FakeDevice {
      createBuffer(): { destroy: () => void } {
        return { destroy: () => {} }
      }
    }
    const inst = instrumentGpuBuffers({ GPUDevice: FakeDevice })
    inst.uninstall()
    expect(() => inst.uninstall()).not.toThrow()
  })
})

// A throwing consumer must not be a concern here (the module never invokes consumer callbacks), but the
// instrument must never let a wrapped destroy throw out from under the caller's own destroy.
describe('instrumentGpuBuffers — destroy passthrough', () => {
  it('calls through to the original destroy exactly once', () => {
    const destroySpy = vi.fn()
    class FakeDevice {
      createBuffer(): { destroy: () => void } {
        return { destroy: destroySpy }
      }
    }
    const inst = instrumentGpuBuffers({ GPUDevice: FakeDevice })
    const dev = new FakeDevice()
    const buf = dev.createBuffer()
    buf.destroy()
    expect(destroySpy).toHaveBeenCalledTimes(1)
    inst.uninstall()
  })
})
