/**
 * WebGPU memory observability for the on-device LLM batteries — surface the budget, don't impose a cap.
 *
 * @remarks
 * This module is INTERNAL to the bundled LLM batteries (no `@module` tag → no public subpath; inlined
 * into each consumer by the bundler). It is re-exported from each on-device battery's public barrel.
 *
 * **Why this exists.** On the WebGPU execution provider, ONNX Runtime Web (which transformers.js and
 * LiteRT-LM both drive in the browser) keeps a per-size **buffer freelist** inside its JSEP GPU data
 * manager: a freed activation buffer is NOT destroyed, it is parked in a bucket for reuse. The bucket
 * sizing follows the largest tensor shape the model has run, so as prompts grow the retained
 * working-set grows with them — a **high-water-mark**, not an unbounded count leak. The pool is flushed
 * only when every session of the model is released (`InferenceSession` disposal → ORT clears the cache
 * when `sessionCount === 0`; see microsoft/onnxruntime#22490). There is **no public ORT flag** to bound
 * or flush the freelist mid-life, and `freeDimensionOverrides` cannot pin a KV-cached autoregressive
 * decoder's dynamic seq/past dims (it throws `ShapeInferenceError`). So past a point, a long-context
 * turn exhausts the device budget and ORT throws `Failed to allocate memory for buffer mapping`.
 *
 * **The ADK stance is to SURFACE this, not to silently clamp the consumer's request.** A battery that
 * auto-caps the context window to "protect" the caller is imposing a restriction; the ADK makes the
 * trade-off VISIBLE (this module's probe + the opt-in live instrument) and ACTIONABLE (a typed,
 * catchable error — see {@link isGpuOutOfMemoryError} and the battery's `E_*_GPU_OUT_OF_MEMORY`), and
 * leaves the levers REACHABLE (`session_options` passthrough, an explicit `recycle()` that triggers the
 * freelist flush). The DEFAULT stays "honor what the caller asked for"; the application layer decides
 * how to react (warn + retry smaller, recycle, switch model, …).
 */

/**
 * A snapshot of the WebGPU device's memory budget, as reported by the adapter/device limits.
 *
 * @remarks
 * All sizes are bytes. `maxBufferSize` and `maxStorageBufferBindingSize` are the hard per-allocation
 * ceilings a single ONNX tensor buffer cannot exceed — the practical wall an over-large context window
 * hits first (e.g. ~4 GiB on Apple Metal). These are LIMITS, not live usage; pair with
 * {@link GpuBufferInstrument} for live high-water-mark tracking.
 */
export interface GpuBudget {
  /** Largest single `GPUBuffer` the device will allocate, in bytes (`GPUSupportedLimits.maxBufferSize`). */
  maxBufferBytes: number
  /** Largest storage-buffer binding, in bytes (`GPUSupportedLimits.maxStorageBufferBindingSize`). */
  maxStorageBufferBindingBytes: number
  /** Best-effort adapter description (vendor/architecture/device), when the runtime exposes it. */
  adapterInfo?: { vendor?: string; architecture?: string; device?: string; description?: string }
  /** `true` when these numbers came from a real `navigator.gpu` device; `false`/absent ⇒ unavailable. */
  available: boolean
}

/**
 * Detect the WebGPU "out of memory / failed to allocate" family of errors from a message string.
 *
 * @remarks
 * ORT-web surfaces GPU exhaustion through several non-obvious signatures depending on where the
 * allocation failed (buffer mapping, device loss, unaligned-access fallback, Dawn validation). This
 * matcher is the single source of truth both on-device batteries use to translate a raw provider throw
 * into a typed, catchable `E_*_GPU_OUT_OF_MEMORY`. Substring/case-insensitive; intentionally broad on
 * the well-known phrases but anchored enough not to swallow unrelated errors. Verified against the
 * signatures observed in the flagship agent's WebGPU OOM repro (Apple Metal, 4 GiB budget).
 *
 * @param message - The error message (or any stringifiable value's `String(...)` form).
 * @returns `true` when the message matches a known GPU-exhaustion signature.
 */
export const isGpuOutOfMemoryError = (message: string): boolean =>
  // WebGPU device-buffer exhaustion (the VRAM ceiling) ...
  /failed to allocate memory for buffer mapping|out of memory|device is lost|requestdevicefailed|operation does not support unaligned accesses|failed to create.*buffer|mapasync|exceeds the max buffer size limit|buffer is bound to|memory copy/i.test(
    message
  ) ||
  // ... AND WASM linear-memory exhaustion (the ONNX-runtime heap, hit first at large context windows on
  // the WASM/JSEP path). transformers.js rethrows ORT's `RuntimeError: memory access out of bounds` /
  // emscripten `Cannot enlarge memory` / `abort(OOM)` verbatim. Same capacity signal, same remedy
  // (reduce the window / recycle / smaller model), so it maps to the same typed error.
  /memory access out of bounds|cannot enlarge memory|abort\(oom\)|out of bounds memory access/i.test(
    message
  )

/** Minimal structural view of the bits of `navigator.gpu` we read — keeps the module env-neutral. */
interface NavigatorGpuLike {
  gpu?: {
    requestAdapter: (opts?: unknown) => Promise<GpuAdapterLike | null | undefined>
  }
}
interface GpuAdapterLike {
  readonly limits?: {
    readonly maxBufferSize?: number
    readonly maxStorageBufferBindingSize?: number
  }
  readonly info?: {
    vendor?: string
    architecture?: string
    device?: string
    description?: string
  }
  requestAdapterInfo?: () => Promise<GpuAdapterLike['info']>
}

/**
 * Probe the host WebGPU device for its memory budget (per-allocation ceilings + adapter info).
 *
 * @remarks
 * Reads `navigator.gpu` adapter limits — this is OBSERVABILITY ONLY; it allocates nothing and changes
 * no behavior. Returns `{ available: false }` (with zeroed sizes) when WebGPU is absent (Node, a
 * browser without the API, or a refused adapter) so callers can branch without try/catch. Best-effort
 * and never throws. A battery emits the result through its lifecycle hook so the application can show
 * "you have ~N GiB of GPU budget" and let the user choose a context window accordingly.
 *
 * @param nav - Injectable `navigator`-like object for tests; defaults to the global `navigator`.
 * @returns The {@link GpuBudget} snapshot.
 */
export const probeGpuBudget = async (nav?: NavigatorGpuLike): Promise<GpuBudget> => {
  const unavailable: GpuBudget = {
    maxBufferBytes: 0,
    maxStorageBufferBindingBytes: 0,
    available: false,
  }
  const n =
    nav ??
    (typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorGpuLike) : undefined)
  if (!n?.gpu?.requestAdapter) return unavailable
  try {
    const adapter = await n.gpu.requestAdapter()
    if (!adapter) return unavailable
    const limits = adapter.limits ?? {}
    // `info` is sync on recent specs; older builds expose `requestAdapterInfo()`. Best-effort either way.
    let info = adapter.info
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      info = await adapter.requestAdapterInfo().catch(() => undefined)
    }
    return {
      maxBufferBytes: Number(limits.maxBufferSize ?? 0),
      maxStorageBufferBindingBytes: Number(limits.maxStorageBufferBindingSize ?? 0),
      ...(info
        ? {
            adapterInfo: {
              ...(info.vendor ? { vendor: info.vendor } : {}),
              ...(info.architecture ? { architecture: info.architecture } : {}),
              ...(info.device ? { device: info.device } : {}),
              ...(info.description ? { description: info.description } : {}),
            },
          }
        : {}),
      available: true,
    }
  } catch {
    return unavailable
  }
}

/** A live GPU-memory sample taken by a {@link GpuBufferInstrument}. */
export interface GpuBufferSample {
  /** Total `createBuffer` calls observed since instrumentation began. */
  created: number
  /** Total `buffer.destroy()` calls observed. */
  destroyed: number
  /** Currently-live buffer count (`created - destroyed`). */
  live: number
  /** Currently-live buffer bytes (the number that climbs as the freelist retains larger working sets). */
  liveBytes: number
  /** Peak live bytes seen — the high-water-mark that, against {@link GpuBudget}, predicts the OOM. */
  peakBytes: number
}

/** A handle returned by {@link instrumentGpuBuffers}: read live samples, then `uninstall()` to restore. */
export interface GpuBufferInstrument {
  /** Take a live sample of GPU buffer usage. */
  sample: () => GpuBufferSample
  /** Restore the original `createBuffer`/`destroy` (idempotent). Call when done measuring. */
  uninstall: () => void
}

/**
 * Install an OPT-IN live GPU-buffer instrument by wrapping `GPUDevice.prototype.createBuffer`.
 *
 * @remarks
 * This is the packaged, productionized form of the diagnostic probe used to PROVE the ORT-web freelist
 * high-water-mark growth. It wraps `createBuffer` (and the returned buffer's `destroy`) on the device
 * prototype to tally live/peak GPU bytes, so an application can watch the working-set climb toward the
 * {@link GpuBudget} ceiling and surface "you're at X of Y GiB" — turning the invisible cliff into a
 * gauge the user can act on BEFORE the OOM.
 *
 * It is **purely observational and strictly opt-in**: nothing in the batteries installs it. Wrapping a
 * global prototype is intrusive, so this is never on by default — an application enables it consciously
 * (typically only in a debug/diagnostics build). Always `uninstall()` when done. Returns a no-op
 * instrument when WebGPU is unavailable (Node / no API).
 *
 * @param globalScope - Injectable global for tests; defaults to `globalThis`.
 * @returns A {@link GpuBufferInstrument}; `sample()` returns zeroes when WebGPU is unavailable.
 */
export const instrumentGpuBuffers = (globalScope?: unknown): GpuBufferInstrument => {
  const g = (globalScope ?? (typeof globalThis !== 'undefined' ? globalThis : {})) as {
    GPUDevice?: { prototype?: Record<string, unknown> }
  }
  const proto = g.GPUDevice?.prototype
  const state: GpuBufferSample = {
    created: 0,
    destroyed: 0,
    live: 0,
    liveBytes: 0,
    peakBytes: 0,
  }
  const noop: GpuBufferInstrument = {
    sample: () => ({ ...state }),
    uninstall: () => {},
  }
  if (!proto || typeof proto.createBuffer !== 'function') return noop

  const origCreate = proto.createBuffer as (this: unknown, desc: { size?: number }) => unknown
  const wrappedCreate = function (this: unknown, desc: { size?: number }): unknown {
    const buf = origCreate.call(this, desc) as { destroy?: () => void } | null
    const size = Number(desc?.size ?? 0)
    state.created += 1
    state.live += 1
    state.liveBytes += size
    if (state.liveBytes > state.peakBytes) state.peakBytes = state.liveBytes
    if (buf && typeof buf.destroy === 'function') {
      const origDestroy = buf.destroy.bind(buf)
      buf.destroy = () => {
        state.destroyed += 1
        state.live -= 1
        state.liveBytes -= size
        return origDestroy()
      }
    }
    return buf
  }
  proto.createBuffer = wrappedCreate as unknown as Record<string, unknown>['createBuffer']

  let installed = true
  return {
    sample: () => ({ ...state }),
    uninstall: () => {
      if (!installed) return
      // Only restore if no one wrapped on top of us in the meantime.
      if (proto.createBuffer === (wrappedCreate as unknown)) {
        proto.createBuffer = origCreate as unknown as Record<string, unknown>['createBuffer']
      }
      installed = false
    },
  }
}
