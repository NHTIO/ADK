/**
 * Caption (image-to-text) specialist modality barrel.
 *
 * @module @nhtio/adk/batteries/specialists/caption
 *
 * @remarks
 * Re-exports every caption adapter battery. Today that's the transformers.js (ONNX, dual-environment)
 * adapter; future adapters for this modality are added here alongside it.
 */

export * from './transformers_js'
