/**
 * Battery-scoped exception constructors for the tesseract.js OCR specialist adapter.
 *
 * @module @nhtio/adk/batteries/specialists/ocr/tesseract_js/exceptions
 *
 * @remarks
 * Battery-scoped exception classes for the tesseract.js OCR adapter, minted via `createException`
 * from `@nhtio/adk/factories`. Categories mirror the embeddings batteries one-to-one — only the
 * engine-specific failure differs.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when the resolved adapter options fail validation against
 * `tesseractJsOcrOptionsSchema` — e.g. a missing/empty `languages` or an unknown option key.
 * Fatal: config bugs fail loud, not at recognize time.
 */
export const E_INVALID_TESSERACT_JS_OCR_OPTIONS = createException<[string]>(
  'E_INVALID_TESSERACT_JS_OCR_OPTIONS',
  'Invalid tesseract.js OCR adapter options: %s',
  'E_INVALID_TESSERACT_JS_OCR_OPTIONS',
  529,
  true
)

/**
 * Thrown when the tesseract.js worker fails to load (e.g. the `tesseract.js` peer is not
 * installed), when `recognize()` throws, or when a per-call language override cannot be honored
 * against a cached worker. Non-fatal. Printf arg: `[detail]`.
 */
export const E_TESSERACT_JS_OCR_ENGINE_ERROR = createException<[string]>(
  'E_TESSERACT_JS_OCR_ENGINE_ERROR',
  'tesseract.js OCR engine error: %s',
  'E_TESSERACT_JS_OCR_ENGINE_ERROR',
  502,
  false
)
