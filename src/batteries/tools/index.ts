/**
 * Aggregate barrel for every pre-constructed bundled tool category.
 *
 * @module @nhtio/adk/batteries/tools
 *
 * @remarks
 * Aggregate barrel of every bundled tool category. Re-exports each category's tools as named
 * exports so consumers can
 * `import { calculateTool, formatTableTool } from '@nhtio/adk/batteries/tools'`. Each category
 * is also exposed as its own subpath (`@nhtio/adk/batteries/tools/<category>`) for
 * finer-grained tree-shaking.
 */

export * from './color'
export * from './comparison'
export * from './data_structure'
export * from './datetime_extended'
export * from './datetime_math'
export * from './encoding'
export * from './formatting'
export * from './geo_basics'
export * from './math'
export * from './memory'
export * from './parsing'
export * from './retrievables'
// NOTE: scrapper and searxng export *factories* (e.g. `createScrapperArticleTool`,
// `createSearxngSearchTool`), not ready-made `Tool` constants. They are re-exported here for
// discoverability, but unlike their siblings they must NOT be bulk-registered via
// `Object.values(batteries)` — call a factory first, then register the returned tool.
export * from './scrapper'
export * from './searxng'
export * from './standing_instructions'
export * from './statistics'
export * from './string_processing'
export * from './structured_data'
export * from './text_analysis'
export * from './text_comparison'
// web_retrieval is the RAG glue (pure converters + storeRetrievables) shared by the scrapper and
// searxng batteries — functions, not Tools; safe to re-export for discoverability.
export * from './web_retrieval'
export * from './time'
export * from './unit_conversion'
