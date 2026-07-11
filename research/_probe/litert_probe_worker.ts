// STEP-0 FEASIBILITY PROBE (throwaway) — prove @litert-lm/core Engine.create boots WebGPU and
// generates ONE token INSIDE a module Worker. If this fails with document/window/self-not-defined or
// "WebGPU not available", the engine-in-worker migration is NO-GO for LiteRT (see the approved plan).
//
// Built by litert-probe.vite.config.mts → docs/public/repl/litert-probe-worker.js, loaded by URL from
// research/probe_worker_engine.mjs. Imports ONLY the engine peer (Pattern B). Not shipped.

import { Engine } from '@litert-lm/core'

const E2B_URL =
  'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm'

interface ProbeResult {
  ok: boolean
  stage: string
  gpuAdapter?: boolean
  gpuDevice?: boolean
  sample?: string
  error?: string
}

async function probe(): Promise<ProbeResult> {
  // 1. Can the WORKER see + acquire WebGPU at all?
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
    return { ok: false, stage: 'gpu-probe', error: 'navigator.gpu missing in worker' }
  }
  let gpuAdapter = false
  let gpuDevice = false
  try {
    const adapter = await navigator.gpu.requestAdapter()
    gpuAdapter = !!adapter
    if (adapter) {
      const device = await adapter.requestDevice()
      gpuDevice = !!device
      // sentinel device.lost wiring (the mechanism the real fix relies on) — just prove it's attachable
      void device.lost.then(() => {})
    }
  } catch (e) {
    return {
      ok: false,
      stage: 'gpu-acquire',
      gpuAdapter,
      error: String((e as Error)?.message ?? e),
    }
  }

  // 2. Boot the LiteRT engine (its own WebGPU/wasm boot happens inside Engine.create).
  let engine: Engine
  try {
    engine = await Engine.create({ model: E2B_URL } as never)
  } catch (e) {
    return {
      ok: false,
      stage: 'engine-create',
      gpuAdapter,
      gpuDevice,
      error: String((e as Error)?.message ?? e),
    }
  }

  // 3. One tiny streaming generation — read a single chunk.
  try {
    const conv = await engine.createConversation()
    const stream = conv.sendMessageStreaming([{ role: 'user', content: 'Say hi.' }] as never)
    const reader = (stream as ReadableStream<{ content?: unknown }>).getReader()
    let sample = ''
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read()
      if (done) break
      const c = value?.content
      sample += typeof c === 'string' ? c : JSON.stringify(c)
      if (sample.length > 0) break
    }
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
    ;(engine as unknown as { delete?: () => void }).delete?.()
    return { ok: true, stage: 'generate', gpuAdapter, gpuDevice, sample: sample.slice(0, 40) }
  } catch (e) {
    return {
      ok: false,
      stage: 'generate',
      gpuAdapter,
      gpuDevice,
      error: String((e as Error)?.message ?? e),
    }
  }
}

self.onmessage = (ev: MessageEvent): void => {
  if (ev.data?.op !== 'go') return
  probe().then(
    (r) => self.postMessage(r),
    (e) => self.postMessage({ ok: false, stage: 'uncaught', error: String(e?.message ?? e) })
  )
}
