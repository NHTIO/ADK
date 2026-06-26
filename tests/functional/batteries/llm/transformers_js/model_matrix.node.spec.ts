// Real-model matrix runner (transformers.js LLM, Node / onnxruntime-node) — the honest proof that each
// small ONNX family ACTUALLY emits the tool-call / reasoning format we assumed. Gated on
// TEST_MODEL_MATRIX=1 (CI skips); narrow to specific ids with TEST_MODEL_MATRIX_ONLY=id,id.
//
//   pnpm run test:matrix
//   TEST_MODEL_MATRIX=1 TEST_MODEL_MATRIX_ONLY=tjs-phi-4-mini pnpm run test:node
//
// Each entry loads its real model, drives ONE dispatch turn through the shared matrix context, and
// asserts via assertMatrixOutcome (lenient; dumps the raw last message on a miss — that's the
// discovery). A non-emitting small model is DATA: downgrade its entry, don't force-green it.

import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TransformersJsAdapter } from '@nhtio/adk/batteries/llm/transformers_js'
import { nodeLlmEntries, scenariosFor } from '../../../../_fixtures/model_matrix'
import {
  makeMatrixContext,
  makeMatrixHelpers,
  makeScenarioContext,
  buildAttachments,
  assertMatrixOutcome,
  assertScenarioOutcome,
} from '../../../../_fixtures/matrix_context'

const RUN = process.env.TEST_MODEL_MATRIX === '1'
const ONLY = (process.env.TEST_MODEL_MATRIX_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const entries = nodeLlmEntries().filter((e) => ONLY.length === 0 || ONLY.includes(e.id))

const bytesFor = (fixturePath: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(__dirname, '../../../../../', fixturePath)))

describe.skipIf(!RUN)('transformers.js LLM — real-model matrix (Node, gated)', () => {
  for (const entry of entries) {
    it(`${entry.id} (${entry.family})`, async () => {
      const adapter = new TransformersJsAdapter({
        model: entry.modelRef,
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
        stream: false,
        autoAck: true,
        maxNewTokens: entry.maxNewTokens ?? 96,
        doSample: false,
      })

      const attachments = buildAttachments(entry, bytesFor)
      const { ctx, stored } = makeMatrixContext(entry, attachments)

      let loadError: unknown
      try {
        await adapter.executor()(ctx, makeMatrixHelpers(stored))
      } catch (err) {
        loadError = err
      }

      if (loadError && entry.expectBrowserLoadProbe) {
        // Load-probe entry (e.g. nemotron_h): a failure to load is DATA, not a hard failure.

        console.warn(`[matrix] ${entry.id} load-probe failed (informational): ${String(loadError)}`)
        return
      }
      expect(loadError, `adapter threw for ${entry.id}`).toBeUndefined()

      const failures = assertMatrixOutcome(entry, stored)
      // Attach the entry note so a CI failure explains the expected format.
      expect(
        failures,
        `${entry.id}: ${failures.join(' | ')}${entry.note ? `  [note: ${entry.note}]` : ''}`
      ).toEqual([])
    }, 900_000)
  }
})

// ── DEEP scenario cross-product: every model × every capability-matching scenario × stream mode. ──
// This is the comprehensive run — multi-turn, parallel calls, reasoning+tool ordering, streaming-vs-
// batch, no-spurious-call, and the explicit thinking-off contract — against real weights. Same gate.
const SCENARIO_ONLY = (process.env.TEST_MATRIX_SCENARIO_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

describe.skipIf(!RUN)('transformers.js LLM — deep scenario matrix (Node, gated)', () => {
  for (const entry of entries) {
    const cells = scenariosFor(entry).filter(
      (c) => SCENARIO_ONLY.length === 0 || SCENARIO_ONLY.includes(c.scenario.id)
    )
    for (const { scenario, stream } of cells) {
      const label = `${entry.id} · ${scenario.id} · ${stream ? 'stream' : 'batch'}`
      it(
        label,
        async () => {
          const gen = scenario.generation ?? {}
          const adapter = new TransformersJsAdapter({
            model: entry.modelRef,
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
            // Scenario tokens win over the entry budget; canonical maxTokens (the shared contract).
            maxTokens: scenario.maxNewTokens ?? entry.maxNewTokens ?? 256,
            // enableThinking defaults OFF; a scenario opts in (reasoning-then-tool) or pins off explicitly.
            enableThinking: gen.enableThinking === true,
            ...gen,
          })

          const attachments = buildAttachments(entry, bytesFor)
          const { ctx, stored } = makeScenarioContext(entry, scenario, attachments)

          let loadError: unknown
          try {
            await adapter.executor()(ctx, makeMatrixHelpers(stored))
          } catch (err) {
            loadError = err
          }
          if (loadError && entry.expectBrowserLoadProbe) {
            console.warn(`[matrix] ${label} probe failed (informational): ${String(loadError)}`)
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

// Gate-status sentinel so the test collector never sees an empty file when the matrix is off.
describe('transformers.js LLM matrix — gate status', () => {
  it(`gate ${RUN ? 'OPEN' : 'closed'} (${entries.length} entries selected)`, () => {
    expect(Array.isArray(entries)).toBe(true)
  })
})
