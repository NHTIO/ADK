/**
 * Environment-neutral aggregate barrel for bundled OCR specialist batteries.
 *
 * @module @nhtio/adk/batteries/specialists/ocr
 *
 * @remarks
 * Aggregate barrel for the OCR specialist batteries. Today this re-exports the tesseract.js
 * battery — environment-neutral (Node + browser, no native binary), so it's reachable from this
 * shared modality barrel same as the other environment-neutral specialist batteries. Deep-import
 * `@nhtio/adk/batteries/specialists/ocr/tesseract_js` directly if you only need that one battery.
 */

export { TesseractJsOcrAdapter } from './tesseract_js'

export {
  tesseractJsOcrOptionsSchema,
  validateOptions as validateTesseractJsOcrOptions,
} from './tesseract_js'

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
} from './tesseract_js'

export { E_INVALID_TESSERACT_JS_OCR_OPTIONS, E_TESSERACT_JS_OCR_ENGINE_ERROR } from './tesseract_js'
