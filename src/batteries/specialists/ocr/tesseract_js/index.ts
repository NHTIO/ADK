/**
 * tesseract.js OCR specialist adapter battery — dual-environment WASM Tesseract.
 *
 * @module @nhtio/adk/batteries/specialists/ocr/tesseract_js
 *
 * @remarks
 * Environment-neutral (Node + browser, no native binary) — a construct-once specialist adapter
 * holding a single cached worker (see the adapter's module remarks for the deliberate divergence
 * from the per-call-worker `MediaEngine`). Re-exports the adapter class, the validation schema +
 * `validateOptions` wrapper, every option/result type alias, and the battery-scoped exceptions.
 */

export { TesseractJsOcrAdapter } from './adapter'

export { tesseractJsOcrOptionsSchema, validateOptions } from './validation'

export type {
  RecognizeResult,
  RecognizeOptions,
  TesseractJsModule,
  TesseractJsWorker,
  CreateTesseractJsModule,
  CreateTesseractJsWorker,
  TesseractJsOcrAdapterOptions,
  BatteryLifecyclePhase,
  BatteryLifecycleBattery,
  BatteryLifecycleReport,
  BatteryLifecycleCallback,
  BatteryLifecycleHooks,
} from './types'

export { E_INVALID_TESSERACT_JS_OCR_OPTIONS, E_TESSERACT_JS_OCR_ENGINE_ERROR } from './exceptions'
