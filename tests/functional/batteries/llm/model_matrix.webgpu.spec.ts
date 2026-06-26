// Real-WebGPU on-device model matrix — runs the LiteRT-LM + transformers.js-webgpu entries on a REAL
// GPU, in-browser, through the actual adapters. This is the browser half of the matrix (the Node half
// is `model_matrix.node.spec.ts`); together they're the honest proof that each on-device model loads
// and emits the parser format we assume.
//
// It runs ONLY in the dedicated headed `browser-webgpu` vitest project, which vite.config.mts
// instantiates solely when TEST_MATRIX_BROWSER is set — i.e. via:
//
//   pnpm run test:matrix:browser
//
// So it never runs in normal CI / `test:browser` (shared runners have no GPU). Each entry is still
// gated on `'gpu' in navigator` (skips if the headed browser somehow lacks an adapter) AND on
// TEST_MODEL_MATRIX=1. Adapter LOAD failures on probe entries (expectBrowserLoadProbe) are recorded as
// DATA — a skipped assertion, not a hard failure — since "does this `.litertlm` load in 0.13.1?" is
// itself the finding.

import { describe, expect, it } from 'vitest'
import { LiteRtLmAdapter } from '@nhtio/adk/batteries/llm/litert_lm'
import { browserEntries, scenariosFor } from '../../../_fixtures/model_matrix'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { TransformersJsEmbeddingsAdapter } from '@nhtio/adk/batteries/embeddings/transformers_js'
import {
  makeMatrixContext,
  makeMatrixHelpers,
  makeScenarioContext,
  buildAttachments,
  assertMatrixOutcome,
  assertScenarioOutcome,
} from '../../../_fixtures/matrix_context'
import type { MatrixEntry } from '../../../_fixtures/model_matrix'

// `__TEST_ENV__` is inlined by vite.config (browsers have no process.env).
const TEST_ENV: Record<string, string> =
  typeof __TEST_ENV__ !== 'undefined'
    ? __TEST_ENV__
    : ((globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {})

const HAS_WEBGPU =
  typeof navigator !== 'undefined' && 'gpu' in navigator && typeof navigator.gpu !== 'undefined'
const RUN = TEST_ENV.TEST_MODEL_MATRIX === '1' && HAS_WEBGPU
const ONLY = (TEST_ENV.TEST_MODEL_MATRIX_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const entries = browserEntries().filter((e) => ONLY.length === 0 || ONLY.includes(e.id))

const isUnitNorm = (v: number[]): boolean =>
  Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) < 1e-3

const cosine = (a: number[], b: number[]): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [i, element] of a.entries()) {
    dot += element * b[i]
    na += element * element
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// Fetch an attachment fixture over HTTP (vitest browser serves the repo root).
const fetchBytes = async (fixturePath: string): Promise<Uint8Array> => {
  const res = await fetch(`/${fixturePath}`)
  if (!res.ok) throw new Error(`failed to fetch ${fixturePath}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const buildAdapterAttachments = async (entry: MatrixEntry) => {
  if (!entry.attachments || entry.attachments.length === 0) return []
  const byPath = new Map<string, Uint8Array>()
  for (const a of entry.attachments) byPath.set(a.fixturePath, await fetchBytes(a.fixturePath))
  return buildAttachments(entry, (p) => byPath.get(p) ?? new Uint8Array())
}

// Build the adapter for an entry, optionally overlaid with a scenario's stream mode + generation
// overrides (canonical contract: `maxTokens` / `enableThinking`). `opts` absent → the smoke defaults.
const makeAdapter = (
  entry: MatrixEntry,
  opts?: { stream?: boolean; maxTokens?: number; generation?: Record<string, unknown> }
) => {
  const stream = opts?.stream ?? false
  const maxTokens = opts?.maxTokens ?? entry.maxNewTokens ?? 96
  const gen = opts?.generation ?? {}
  const enableThinking = (gen as { enableThinking?: boolean }).enableThinking === true
  if (entry.battery === 'litert_lm') {
    return new LiteRtLmAdapter({
      model: entry.modelRef,
      ...(entry.toolCallParser ? { toolCallParser: entry.toolCallParser as never } : {}),
      ...(entry.reasoningParser ? { reasoningParser: entry.reasoningParser as never } : {}),
      ...(entry.capabilities.image ? { visionModalityEnabled: true } : {}),
      ...(entry.capabilities.audio ? { audioModalityEnabled: true } : {}),
      stream,
      autoAck: true,
      maxTokens,
      enableThinking,
    })
  }
  return new TransformersJsAdapter({
    model: entry.modelRef,
    device: 'webgpu' as never,
    ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
    ...(entry.toolCallParser ? { toolCallParser: entry.toolCallParser as never } : {}),
    ...(entry.reasoningParser ? { reasoningParser: entry.reasoningParser as never } : {}),
    ...(entry.capabilities.image || entry.capabilities.audio
      ? {
          multimodal: {
            image: entry.capabilities.image ?? false,
            audio: entry.capabilities.audio ?? false,
          },
        }
      : {}),
    stream,
    autoAck: true,
    maxTokens,
    enableThinking,
  })
}

// Release a loaded adapter's native ONNX/WebGPU sessions between cells. The webgpu run builds a FRESH
// adapter per entry AND per scenario cell (~12 loads per model); without disposal the ONNX Runtime
// sessions + GPU/wasm buffers accumulate across one browser session until the heap is exhausted, which
// surfaces LATE as `Can't create a session … Failed to load external data file model_q4.onnx_data …
// memory copy` on models that loaded fine earlier (proven: granite-4 passes 11/11 in isolation but fails
// the same cells in a full run). All three adapters expose async `dispose()`. Errors are swallowed —
// teardown must never turn into a spurious red.
const disposeQuietly = async (adapter: { dispose?: () => Promise<unknown> }): Promise<void> => {
  try {
    if (typeof adapter.dispose === 'function') await adapter.dispose()
  } catch {
    // teardown is best-effort
  }
}

describe.skipIf(!RUN)('model matrix — real WebGPU (headed, gated)', () => {
  for (const entry of entries) {
    it(`${entry.id} (${entry.family})`, async () => {
      // ── Embeddings entries: drive embedMany on WebGPU; assert determinism + unit-norm. ──
      if (entry.battery === 'transformers_js_embed') {
        const adapter = new TransformersJsEmbeddingsAdapter({
          model: entry.modelRef,
          device: 'webgpu' as never,
          ...(entry.dtype ? { dtype: entry.dtype as never } : {}),
        })
        try {
          const [a, b] = await adapter.embedMany([entry.prompt, entry.prompt])
          expect(a.length, `${entry.id}: empty vector`).toBeGreaterThan(0)
          expect(isUnitNorm(a), `${entry.id}: vector not unit-norm`).toBe(true)
          expect(cosine(a, b), `${entry.id}: not deterministic`).toBeGreaterThan(0.9999)
        } finally {
          await disposeQuietly(adapter)
        }
        return
      }

      // ── LLM entries (LiteRT-LM / transformers.js-webgpu): drive one dispatch turn. ──
      const attachments = await buildAdapterAttachments(entry)
      const { ctx, stored } = makeMatrixContext(entry, attachments)

      let loadError: unknown
      const adapter = makeAdapter(entry)
      try {
        await adapter.executor()(ctx, makeMatrixHelpers(stored))
      } catch (err) {
        loadError = err
      } finally {
        await disposeQuietly(adapter)
      }

      // Probe entries (e.g. a non -web .litertlm, the LiteRT image gate): a load/run failure is the
      // finding, not a test failure. Record it and move on.
      if (loadError && entry.expectBrowserLoadProbe) {
        console.warn(`[matrix:webgpu] ${entry.id} probe did not load (DATA): ${String(loadError)}`)
        return
      }
      expect(loadError, `adapter threw for ${entry.id}`).toBeUndefined()

      const failures = assertMatrixOutcome(entry, stored)
      expect(
        failures,
        `${entry.id}: ${failures.join(' | ')}${entry.note ? `  [note: ${entry.note}]` : ''}`
      ).toEqual([])
    }, 900_000)
  }
})

// ── DEEP scenario cross-product on the REAL GPU: every browser LLM entry × capability-matching ──
// scenario × stream mode. Embeddings entries declare no LLM capabilities → scenariosFor() = [] → skipped.
const SCENARIO_ONLY = (TEST_ENV.TEST_MATRIX_SCENARIO_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

describe.skipIf(!RUN)('model matrix — deep scenario matrix (real WebGPU, headed, gated)', () => {
  for (const entry of entries) {
    if (entry.battery === 'transformers_js_embed') continue
    const cells = scenariosFor(entry).filter(
      (c) => SCENARIO_ONLY.length === 0 || SCENARIO_ONLY.includes(c.scenario.id)
    )
    for (const { scenario, stream } of cells) {
      const label = `${entry.id} · ${scenario.id} · ${stream ? 'stream' : 'batch'}`
      it(
        label,
        async () => {
          const attachments = await buildAdapterAttachments(entry)
          const { ctx, stored } = makeScenarioContext(entry, scenario, attachments)

          let loadError: unknown
          const adapter = makeAdapter(entry, {
            stream,
            maxTokens: scenario.maxNewTokens ?? entry.maxNewTokens ?? 256,
            generation: scenario.generation,
          })
          try {
            await adapter.executor()(ctx, makeMatrixHelpers(stored))
          } catch (err) {
            loadError = err
          } finally {
            await disposeQuietly(adapter)
          }
          if (loadError && entry.expectBrowserLoadProbe) {
            console.warn(`[matrix:webgpu] ${label} probe did not load (DATA): ${String(loadError)}`)
            return
          }
          expect(loadError, `adapter threw for ${label}`).toBeUndefined()

          const failures = assertScenarioOutcome(entry, scenario, stored)
          expect(failures, `${label}: ${failures.join(' | ')}  [${scenario.description}]`).toEqual(
            []
          )
        },
        900_000
      )
    }
  }
})

// Always-present marker so the file reports a result even when the gate is closed.
describe('model matrix — WebGPU gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'} (${entries.length} entries, webgpu=${HAS_WEBGPU})`, () => {
    expect(typeof RUN).toBe('boolean')
  })
})
