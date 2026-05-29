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
export * from './standing_instructions'
export * from './statistics'
export * from './string_processing'
export * from './structured_data'
export * from './text_analysis'
export * from './text_comparison'
export * from './time'
export * from './unit_conversion'
