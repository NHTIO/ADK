/**
 * Stateful skill discovery, activation, and deactivation for ADK agents.
 *
 * @module @nhtio/adk/batteries/skills
 */

export * from './contracts'
export * from './types'
export * from './exceptions'
export { parseSkillMd } from './manifest'
export { createSkillManager } from './manager'
export {
  skillsTurnInputMiddleware,
  skillsTurnOutputMiddleware,
  skillsDispatchInputMiddleware,
  skillsDispatchOutputMiddleware,
  createSkillMiddlewareSet,
} from './middleware'
export type { SkillMiddlewareOptions } from './middleware'
export { forgeSkillTools } from './forge'
export type { ForgeSkillToolsOptions } from './forge'
export { createSkillArtifactRegistry } from './artifacts'
export type { SkillArtifactRegistry } from './artifacts'
export { renderError } from './exceptions'
