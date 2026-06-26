/**
 * Shared, provider-neutral lifecycle/boot-progress contract for the on-device + remote LLM batteries.
 *
 * @remarks
 * Each battery already exposes a provider-shaped `onInitProgress` covering only the **download** phase
 * (and shaped differently per provider). This module adds a NORMALIZED layer on top: a coarse phase
 * machine — `loading → compiling → ready → generating → complete` (or `error`) — observable via an
 * aggregate firehose callback ({@link BatteryLifecycleHooks.onLifecycle}) AND targeted per-phase hooks.
 * It exists because the WebGPU/wasm **boot** between download and first token (engine/graph/shader
 * compilation, accelerator registration) was otherwise invisible to a consumer, and because there was no
 * cross-battery notion of "what phase is this model in right now." That boot span is now surfaced as the
 * `compiling` phase — a COARSE marker (the runtimes expose the boundary, not a granular progress stream).
 *
 * The hooks are OPT-IN and additive: `onInitProgress` is unchanged; where a provider reports download
 * progress, the battery ALSO forwards it into a `loading` lifecycle report (with normalized `progress`
 * 0..1 and the raw payload on `raw`). This submodule is private to the bundled batteries — consumers
 * import the re-exported names from each battery's public subpath, never from here.
 */

import { DateTime } from 'luxon'

/** The coarse lifecycle phases a battery transitions through. */
export type BatteryLifecyclePhase =
  | 'loading'
  | 'compiling'
  | 'ready'
  | 'generating'
  | 'complete'
  | 'error'

/** Which battery emitted a lifecycle report. */
export type BatteryLifecycleBattery =
  | 'transformers_js'
  | 'litert_lm'
  | 'webllm'
  | 'transformers_js_embed'

/** A single normalized lifecycle report. */
export interface BatteryLifecycleReport {
  /** The phase being entered. */
  phase: BatteryLifecyclePhase
  /** The battery that produced this report. */
  battery: BatteryLifecycleBattery
  /** Best-effort model identifier (the `model` option; `'<stream>'` / `'<blob>'` when not a string). */
  model: string
  /** ISO-8601 timestamp stamped when the report was emitted. */
  at: string
  /** Human-readable detail, e.g. `'booting WebGPU runtime'`. */
  detail?: string
  /** Normalized download/load progress in `0..1`, when the provider reports it (the `loading` phase). */
  progress?: number
  /** The provider's own progress payload, passed through verbatim (the `loading` phase). */
  raw?: unknown
  /** The failure, populated only when `phase === 'error'`. */
  error?: unknown
}

/** A lifecycle report consumer. */
export type BatteryLifecycleCallback = (report: BatteryLifecycleReport) => void

/**
 * The opt-in lifecycle option block mixed into each battery's options interface. Every phase transition
 * fires {@link onLifecycle} (the firehose) AND the matching per-phase hook; subscribe to either or both.
 * All optional — omitting them leaves behavior byte-for-byte unchanged.
 */
export interface BatteryLifecycleHooks {
  /** Fires on EVERY phase transition (the firehose). */
  onLifecycle?: BatteryLifecycleCallback
  /** Weights/runtime loading — may fire repeatedly with `progress` as the provider reports it. */
  onLoading?: BatteryLifecycleCallback
  /**
   * Engine/graph/shader compilation after download, before the first token. A COARSE marker: the
   * on-device runtimes (LiteRT `Engine.create`, transformers.js `from_pretrained`) expose the boundary —
   * download done, opaque WebGPU/WASM graph build about to run — but NOT a progress stream, so `progress`
   * is usually absent. Often the slowest part of a cold start; without this it was invisible.
   */
  onCompiling?: BatteryLifecycleCallback
  /** Engine/pipeline resolved and cached, before the first generation. */
  onReady?: BatteryLifecycleCallback
  /** Immediately before the provider generate call (fires per turn). */
  onGenerating?: BatteryLifecycleCallback
  /** After the turn's output is parsed + persisted, before `ack` (fires per turn). */
  onComplete?: BatteryLifecycleCallback
  /** A load or generation failure (paired with `nack`). */
  onError?: BatteryLifecycleCallback
}

/** Map each phase to the per-phase hook key on {@link BatteryLifecycleHooks}. */
const PER_PHASE_HOOK: Record<BatteryLifecyclePhase, keyof BatteryLifecycleHooks> = {
  loading: 'onLoading',
  compiling: 'onCompiling',
  ready: 'onReady',
  generating: 'onGenerating',
  complete: 'onComplete',
  error: 'onError',
}

/** Invoke a consumer callback, swallowing any throw so a misbehaving hook never breaks a dispatch. */
const safeInvoke = (
  cb: BatteryLifecycleCallback | undefined,
  report: BatteryLifecycleReport
): void => {
  if (typeof cb !== 'function') return
  try {
    cb(report)
  } catch {
    // A throwing consumer hook must never abort loading or a turn. Intentionally swallowed.
  }
}

/**
 * Build a {@link BatteryLifecycleReport} (stamping `at`) and dispatch it to the firehose
 * ({@link BatteryLifecycleHooks.onLifecycle}) AND the per-phase hook for `phase`. A no-op when `hooks`
 * is undefined or carries no relevant callbacks. Defensive: each callback is invoked through
 * {@link safeInvoke}, so a throwing consumer never disrupts the battery.
 *
 * @param hooks - The merged lifecycle hooks (may be undefined).
 * @param battery - Which battery is emitting.
 * @param model - Best-effort model id string.
 * @param phase - The phase being entered.
 * @param extra - Optional `detail` / `progress` / `raw` / `error` fields.
 * @param now - Injectable clock for tests; defaults to luxon `DateTime.now().toISO()`.
 */
export const emitLifecycle = (
  hooks: BatteryLifecycleHooks | undefined,
  battery: BatteryLifecycleBattery,
  model: string,
  phase: BatteryLifecyclePhase,
  extra?: Partial<Pick<BatteryLifecycleReport, 'detail' | 'progress' | 'raw' | 'error'>>,
  now: () => string = () => DateTime.now().toISO() as string
): void => {
  if (!hooks) return
  if (!hooks.onLifecycle && !hooks[PER_PHASE_HOOK[phase]]) return
  const report: BatteryLifecycleReport = {
    phase,
    battery,
    model,
    at: now(),
    ...(extra ?? {}),
  }
  safeInvoke(hooks.onLifecycle, report)
  safeInvoke(hooks[PER_PHASE_HOOK[phase]], report)
}

/** Default {@link emitLifecycle}. */
export const defaultEmitLifecycle = emitLifecycle
