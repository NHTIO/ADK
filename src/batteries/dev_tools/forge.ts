/** Agent glue for the structured development-tools surface. @module @nhtio/adk/batteries/dev-tools/forge */
import { DEV_ARG_SPECS } from './arg_specs'
import { validator } from '@nhtio/validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'
import type { DevOp, DevPipeline } from './types'
import type { DispatchContext } from '@nhtio/adk/types'

/** Configuration for {@link forgeDevTools}. The pipeline owns approval; the forge never gates. */
export interface ForgeDevToolsOptions {
  /** Select the single composite tool or the stateless per-step tools. */
  surface: 'composite' | 'granular'
  /** Optional names and descriptions keyed by their default tool name. */
  overrides?: Record<string, { name?: string; description?: string }>
}

const stepSchema = (step: string, includePaths: boolean) => {
  const shape: Record<string, ReturnType<typeof validator.any>> = {}
  if (includePaths)
    shape.paths = validator
      .array()
      .items(validator.string())
      .required()
      .description('Workspace-relative paths or glob patterns to acquire.')
  for (const [name, rule] of Object.entries(DEV_ARG_SPECS[step] ?? {})) {
    let field: ReturnType<typeof validator.any>
    if (rule.type === 'string') field = validator.string()
    else if (rule.type === 'number') field = validator.number()
    else if (rule.type === 'boolean') field = validator.boolean()
    else if (rule.element === 'string') field = validator.array().items(validator.string())
    else if (typeof rule.element === 'object') {
      const fields: Record<string, ReturnType<typeof validator.any>> = {}
      for (const [key, spec] of Object.entries(rule.element.fields)) {
        const actual = typeof spec === 'string' ? { type: spec } : spec
        fields[key] = actual.type === 'string' ? validator.string() : validator.any().required()
        fields[key] = fields[key].required()
      }
      field = validator.array().items(validator.object(fields))
    } else field = validator.array()
    if (rule.required) field = field.required()
    shape[name] = field
  }
  return validator.object(shape)
}

const render = (result: Awaited<ReturnType<DevPipeline['ops']>>) => JSON.stringify(result, null, 2)
const opArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const { paths: omittedPaths, ...rest } = args
  void omittedPaths
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
}

/** Forge model-facing tools over a configured development pipeline. */
export const forgeDevTools = (
  pipeline: DevPipeline,
  options: ForgeDevToolsOptions
): Record<string, Tool> => {
  if (options?.surface !== 'composite' && options?.surface !== 'granular')
    throw new Error("forgeDevTools requires surface: 'composite' | 'granular'")
  const tools: Record<string, Tool> = {}
  const make = (
    defaultName: string,
    description: string,
    schema: ReturnType<typeof validator.object>,
    handler: (args: Record<string, unknown>, context: DispatchContext) => Promise<string>
  ) => {
    const override = options.overrides?.[defaultName]
    const tool = new Tool({
      name: override?.name ?? defaultName,
      description: override?.description ?? description,
      inputSchema: schema,
      artifactConstructor: () => SpooledJsonArtifact,
      handler: async (args, context) =>
        handler(args as Record<string, unknown>, context as DispatchContext),
    })
    tools[tool.name] = tool
  }
  if (options.surface === 'composite') {
    make(
      'dev_plan',
      'Run a multi-step development editing plan. Prefer this tool for workflows with more than one step.',
      validator.object({
        paths: validator.array().items(validator.string()).required(),
        ops: validator
          .array()
          .items(
            validator.object({
              step: validator.string().required(),
              args: validator.object({}).unknown(true).required(),
              label: validator.string(),
            })
          )
          .min(1)
          .required(),
      }),
      async (args, context) =>
        render(
          await pipeline.ops(args.paths as string[], args.ops as DevOp[], {
            signal: context.abortSignal,
          })
        )
    )
    return tools
  }
  for (const step of Object.keys(DEV_ARG_SPECS)) {
    if (step === 'write') continue
    make(
      step,
      `${step} over newly acquired workspace paths. This stateless granular tool persists mutations before returning; use dev_plan for multi-step work.`,
      stepSchema(step, true),
      async (args, context) => {
        const run = (
          pipeline as DevPipeline & {
            _runGranular?: (
              paths: readonly string[],
              ops: DevOp[],
              options?: { signal?: AbortSignal }
            ) => Promise<Awaited<ReturnType<DevPipeline['ops']>>>
          }
        )._runGranular
        const result = run
          ? await run(args.paths as string[], [{ step, args: opArgs(args) }], {
              signal: context.abortSignal,
            })
          : await pipeline.ops(args.paths as string[], [{ step, args: opArgs(args) }], {
              signal: context.abortSignal,
            })
        return render(result)
      }
    )
  }
  return tools
}
