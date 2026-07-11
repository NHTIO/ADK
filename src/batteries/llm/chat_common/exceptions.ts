/**
 * Shared, wire-shape-agnostic exceptions for the on-device LLM batteries.
 *
 * @module @nhtio/adk/batteries/llm/chat_common/exceptions
 *
 * @remarks
 * INTERNAL to the bundled LLM batteries (no public subpath of its own) — re-exported from each
 * on-device battery's public barrel. Holds exceptions that are NOT specific to one battery's wire
 * shape; today, the WebGPU out-of-memory signal that both transformers.js and LiteRT-LM can hit on the
 * ONNX Runtime Web / WebGPU execution provider.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Raised when the WebGPU execution provider exhausts the device's GPU memory budget during generation.
 *
 * @remarks
 * The ADK stance is **surface, don't impose** — rather than silently capping the caller's context
 * window, the on-device batteries translate ORT-web's cryptic, location-dependent GPU-exhaustion throws
 * (`Failed to allocate memory for buffer mapping`, `device is lost`, `operation does not support
 * unaligned accesses`, …) into THIS single typed error, so an application can `catch` it structurally
 * — `if (isInstanceOf(err, 'E_LLM_GPU_OUT_OF_MEMORY')) …` — instead of string-matching runtime
 * internals, and react however it wants (warn + retry with a smaller window, `recycle()` the adapter to
 * flush the WebGPU buffer freelist, switch to a smaller model, …).
 *
 * Non-fatal: the adapter surfaces it via `ctx.nack(...)` (not a throw), exactly like the generic stream
 * error, so the turn ends cleanly and the application can offer a retry. The matcher behind the
 * translation is `isGpuOutOfMemoryError` in `./gpu_budget`. Printf args:
 * `[providerMessage, contextWindowSummary]` — the raw provider message and a short budget/window note
 * the application can show the user verbatim.
 */
export const E_LLM_GPU_OUT_OF_MEMORY = createException<[string, string]>(
  'E_LLM_GPU_OUT_OF_MEMORY',
  'on-device WebGPU ran out of GPU memory during generation: %s. %s',
  'E_LLM_GPU_OUT_OF_MEMORY',
  507,
  false
)
