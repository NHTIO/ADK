/**
 * Schema-first tool construction, invocation records, artifact tools, and registries.
 *
 * @module @nhtio/adk/forge
 *
 * @remarks
 * The forge — where tools are made. Schema-first primitives consumers compose into a working
 * tool surface: {@link @nhtio/adk!Tool} (the standard tool definition), {@link @nhtio/adk!ArtifactTool} (the
 * artifact-bound variant for custom spooled-artifact query tools), {@link @nhtio/adk!ToolCall} (the
 * persisted record of an invocation), and {@link @nhtio/adk!ToolRegistry} (the collection of tools
 * available within a turn). These are almost always used together — a runner registers tools,
 * the model emits tool calls, the executor invokes them via the registry, and the resulting
 * record is persisted as a `ToolCall`.
 *
 * Pairs with `@nhtio/adk/batteries/tools`, which ships ready-made tool *instances* built with
 * this forge. The forge defines what a tool is; the batteries provide tools already made.
 */

/**
 * @primaryExport
 */
export { Tool } from './lib/classes/tool'
/**
 * @primaryExport
 */
export type { RawTool, ToolHandler } from './lib/classes/tool'
/**
 * @primaryExport
 */
export type { SpooledArtifactConstructor } from './lib/classes/spooled_artifact'

/**
 * @primaryExport
 */
export { ArtifactTool } from './lib/classes/artifact_tool'
/**
 * @primaryExport
 */
export type { RawArtifactTool, ArtifactToolHandler } from './lib/classes/artifact_tool'

/**
 * @primaryExport
 */
export { ToolCall } from './lib/classes/tool_call'
/**
 * @primaryExport
 */
export type { RawToolCall } from './lib/classes/tool_call'

/**
 * @primaryExport
 */
export { ToolRegistry } from './lib/classes/tool_registry'
