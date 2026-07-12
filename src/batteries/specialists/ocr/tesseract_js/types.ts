/**
 * Option and result types for the tesseract.js OCR specialist adapter.
 *
 * @module @nhtio/adk/batteries/specialists/ocr/tesseract_js/types
 *
 * @remarks
 * Builds on the shared specialist input contracts
 * ({@link @nhtio/adk/batteries/specialists/_shared!SpecialistImageInput}) and the shared lifecycle
 * hooks ({@link BatteryLifecycleHooks}). `tesseract.js` worker/module shapes are **local aliases**,
 * never direct re-exports of the externalized peer.
 */

import type * as TesseractNS from 'tesseract.js'
import type { BatteryLifecycleHooks } from '../../../llm/chat_common'

// Re-export the shared lifecycle/boot-progress contract so consumers import it from this barrel.
export type {
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from '../../../llm/chat_common'

/** The `tesseract.js` module namespace this adapter drives. Local alias of the peer's own type. */
export type TesseractJsModule = typeof TesseractNS
/** A live `tesseract.js` worker instance. Local alias of the peer's own type. */
export type TesseractJsWorker = TesseractNS.Worker

/** The result of {@link @nhtio/adk/batteries/specialists/ocr/tesseract_js!TesseractJsOcrAdapter.recognize}. */
export interface RecognizeResult {
  /** The recognized text. */
  text: string
  /**
   * Tesseract's mean confidence for the recognized page, `0..100`, when the engine reports it.
   * `undefined` when the underlying result carries no numeric `confidence`.
   */
  confidence?: number
}

/** Per-call override options for {@link @nhtio/adk/batteries/specialists/ocr/tesseract_js!TesseractJsOcrAdapter.recognize}. */
export interface RecognizeOptions {
  /**
   * A subset of the adapter's constructor `languages` to recognize with for this call only.
   * See the adapter's `recognize` TSDoc for exactly how (and whether) this is honored against a
   * cached worker — tesseract.js v7 does not support re-initializing an existing worker's
   * languages, so this may throw rather than silently switching languages.
   */
  languages?: readonly string[]
}

/**
 * Factory for lazily resolving the `tesseract.js` module. Defaults to a dynamic
 * `import('tesseract.js')`; override to inject a test double or a bundler-friendly resolver.
 */
export type CreateTesseractJsModule = () => TesseractJsModule | Promise<TesseractJsModule>

/**
 * Factory for creating a `tesseract.js` worker. Defaults to
 * `mod.createWorker(languages, undefined, { langPath, cachePath, ...workerOptions })`; override to
 * inject a pre-built worker or a test double (the full worker-injection seam for tests).
 */
export type CreateTesseractJsWorker = (input: {
  languages: readonly string[]
  langPath?: string
  cachePath?: string
  workerOptions?: Record<string, unknown>
}) => TesseractJsWorker | Promise<TesseractJsWorker>

/**
 * Constructor options for the tesseract.js OCR adapter.
 *
 * @remarks
 * `languages` is REQUIRED with no default — language packs download on first use, so a deployment
 * must never silently fetch packs for languages it didn't plan for (mirrors
 * {@link @nhtio/adk/batteries/media/engines/tesseract_js!TesseractJsEngineOptions}).
 */
export interface TesseractJsOcrAdapterOptions extends BatteryLifecycleHooks {
  /** Languages to load, e.g. `['eng']`. REQUIRED — language packs download on first use. */
  languages: readonly string[]
  /** Where language data is fetched from (forwarded to `createWorker`). */
  langPath?: string
  /** Local cache directory for downloaded language data (forwarded to `createWorker`). */
  cachePath?: string
  /**
   * Escape hatch forwarded into `createWorker`'s options object, spread in AFTER `langPath` /
   * `cachePath` (so an explicit `workerOptions.langPath`/`workerOptions.cachePath` wins). Exists
   * because some bundlers mis-resolve tesseract.js's default `workerPath`/`corePath` URLs — this
   * lets a consumer supply the correct bundled asset URLs without the adapter needing bespoke
   * options for every bundler quirk.
   */
  workerOptions?: Record<string, unknown>
  /** Override the module resolution. Default: `import('tesseract.js')`. */
  tesseract?: CreateTesseractJsModule
  /** Override worker creation entirely — the full worker-injection seam for tests. */
  createWorker?: CreateTesseractJsWorker
  /** Override the availability probe. Default: `true` (tesseract.js is environment-neutral). */
  isAvailable?: () => boolean
}
