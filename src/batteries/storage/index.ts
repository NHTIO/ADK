/**
 * Environment-neutral aggregate barrel for bundled storage batteries.
 *
 * @module @nhtio/adk/batteries/storage
 *
 * @remarks
 * Aggregate barrel for the storage batteries. Re-exports only **environment-neutral** storage
 * helpers — currently just the in-memory battery — so that consumers can import this barrel from
 * either Node or the browser without dragging in environment-specific runtime requirements.
 *
 * Environment-specific batteries are reachable only through their own subpath:
 *
 * - `@nhtio/adk/batteries/storage/flydrive` — Node-only (uses `node:stream`).
 * - `@nhtio/adk/batteries/storage/opfs` — browser-only (uses the OPFS API).
 *
 * Deep-import the subpath you need; don't expect either to be re-exported from this barrel.
 */

export * from './in_memory'
