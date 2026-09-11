import { validator } from '@nhtio/validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'
import { runToolGate } from '@nhtio/adk/batteries/tools/_shared'
import type { SkillManager } from './types'
import type { DispatchContext } from '@nhtio/adk/types'
import type { ToolGateFn } from '@nhtio/adk/batteries/tools/_shared'

/** Deployment-time controls for the lifecycle tools forged by {@link forgeSkillTools}. */
export interface ForgeSkillToolsOptions {
  /** The gate used for lifecycle mutations. */
  readonly gate?: ToolGateFn
}

const context = (value: unknown): DispatchContext => value as DispatchContext

/** Forge the five stateful lifecycle tools for one skill manager. */
export const forgeSkillTools = (
  manager: SkillManager,
  options: ForgeSkillToolsOptions = {}
): Record<string, Tool> => {
  const tools: Record<string, Tool> = {}
  const make = (
    name: string,
    description: string,
    inputSchema: ReturnType<typeof validator.object>,
    handler: (args: Record<string, unknown>, ctx: DispatchContext) => Promise<unknown>
  ): void => {
    const tool = new Tool({
      name,
      description,
      inputSchema,
      artifactConstructor: () => SpooledJsonArtifact,
      handler: async (args, ctx) =>
        JSON.stringify(await handler(args as Record<string, unknown>, context(ctx))),
    })
    tools[name] = tool
  }

  make(
    'list_skills',
    'List discoverable skills and their routing metadata. Use query to filter by id, name, or description.',
    validator
      .object({
        refresh: validator.boolean(),
        query: validator.string(),
      })
      .unknown(false),
    async (args) => {
      if (args.refresh === true) await manager.refresh()
      const query = typeof args.query === 'string' ? args.query.toLocaleLowerCase() : undefined
      const entries = manager
        .catalog()
        .filter((entry) => {
          if (!query) return true
          return [entry.ref.id, entry.ref.name, entry.ref.description].some((value) =>
            value.toLocaleLowerCase().includes(query)
          )
        })
        .map((entry) => ({
          id: entry.ref.id,
          name: entry.ref.name,
          description: entry.ref.description,
          version: entry.ref.version,
          sourceId: entry.ref.sourceId,
          loaded: entry.loaded,
          ...(entry.updateAvailable === undefined
            ? {}
            : { updateAvailable: entry.updateAvailable }),
          ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy.sourceId } : {}),
          ...(entry.ref.license === undefined ? {} : { license: entry.ref.license }),
          ...(entry.ref.metadata === undefined ? {} : { metadata: entry.ref.metadata }),
          ...(entry.ref.compatibility === undefined
            ? {}
            : { compatibility: entry.ref.compatibility }),
        }))
      return { skills: entries, unsafe: manager.unsafe }
    }
  )
  make(
    'list_loaded_skills',
    'List skills projected into this dispatch and therefore callable right now.',
    validator.object({}).unknown(false),
    async (_args, ctx) => ({
      skills: manager.projected(ctx).map((skill) => skill.id),
      initialized: manager.loaded(),
    })
  )
  make(
    'refresh_skills',
    'Refresh one named skill and replace its loaded version in this dispatch, or omit skill to refresh all skills.',
    validator.object({ skill: validator.string() }).unknown(false),
    async (args, ctx) => {
      await runToolGate(options.gate, ctx, 'refresh_skills', {
        ...(typeof args.skill === 'string' ? { skill: args.skill } : {}),
      })
      const result = await manager.refreshAndProject(
        ctx,
        typeof args.skill === 'string' ? args.skill : undefined
      )
      return result
    }
  )
  make(
    'load_skill',
    'Load a skill body and register its tools for this dispatch.',
    validator.object({ skill: validator.string().required() }).unknown(false),
    async (args, ctx) => {
      const skill = args.skill as string
      await runToolGate(options.gate, ctx, 'load_skill', { skill })
      return manager.load(skill, ctx)
    }
  )
  make(
    'unload_skill',
    'Deactivate a loaded skill and unregister its tools.',
    validator.object({ skill: validator.string().required() }).unknown(false),
    async (args, ctx) => {
      const skill = args.skill as string
      await runToolGate(options.gate, ctx, 'unload_skill', { skill })
      await manager.unload(skill, ctx)
      return { id: skill, unloaded: true }
    }
  )
  return tools
}
