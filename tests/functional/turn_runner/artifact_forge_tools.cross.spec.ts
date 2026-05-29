import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptStep } from '../../_fixtures/scripted_executor'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { Tool, Tokenizable, ArtifactTool, ToolRegistry, SpooledArtifact } from '@nhtio/adk'
import type { DispatchContext, DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk'

// Multi-line payload that gives `artifact_grep` something interesting to match against.
const PAYLOAD = 'alpha\nbeta\ngamma\nbanana\n'

const emitTool = new Tool({
  name: 'emit_payload',
  description: 'Emits the fixture payload used to exercise the forged artifact-query tools.',
  inputSchema: validator.object({}),
  handler: () => PAYLOAD,
})

describe('TurnRunner: forgeTools — full executor loop', () => {
  it('forges artifact_* tools the model can invoke against a prior artifact, then prunes them on ack', async () => {
    const store = new InMemorySpoolStore()

    // Capture state from the executor body so the assertions can see what happened inside the
    // dispatch loop without having to fish it out of the events array.
    type Captured = {
      forgedNames: string[]
      forgedAreArtifactTools: boolean
      forgedAreEphemeral: boolean
      grepCallToolCallId?: string
      grepCallFromArtifactTool?: boolean
      grepResultsClass?: string
      grepBytes?: string
      registryAfterAck?: string[]
    }
    const captured: Captured = {
      forgedNames: [],
      forgedAreArtifactTools: false,
      forgedAreEphemeral: false,
    }

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: produce a real spooled artifact via the emit tool. scriptStep handles
        // the bytes → store → ToolCall → ctx.turnToolCalls plumbing exactly the way a real
        // executor would.
        await scriptStep({ toolCalls: [{ tool: 'emit_payload', args: {} }] }, store)(ctx, helpers)
        return
      }

      if (ctx.iteration === 1) {
        // Iteration 1: forge the artifact-query tools, merge them onto the main registry, and
        // bind the registry to the ctx so the ephemeral forged tools auto-prune on ack.
        const main = ctx.tools
        const forged = SpooledArtifact.forgeTools(ctx)

        captured.forgedNames = forged
          .all()
          .map((t) => t.name)
          .sort()
        captured.forgedAreArtifactTools = forged.all().every((t) => ArtifactTool.isArtifactTool(t))
        captured.forgedAreEphemeral = forged.all().every((t) => t.ephemeral === true)

        // Register the forged tools onto the main registry so subsequent lookups via
        // `ctx.tools.get(...)` resolve them. Each forged tool already declares
        // `onCollision: 'replace'`, so the dance with the merge-level option is unnecessary.
        const merged = ToolRegistry.merge([main, forged], { onCollision: 'replace' })
        for (const tool of merged.all()) main.register(tool, true)
        main.bindContext(ctx)

        // Now invoke artifact_grep against the prior ToolCall's callId. scriptStep wires the
        // ArtifactTool branch automatically — it sees `ArtifactTool.isArtifactTool(tool)` is
        // true and wraps the bytes in a Tokenizable instead of constructing a new
        // SpooledArtifact.
        const [priorTc] = [...ctx.turnToolCalls]
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'artifact_grep',
                args: { callId: priorTc.id, pattern: '^b' },
              },
            ],
          },
          store
        )(ctx, helpers)

        // Find the freshly-stored grep ToolCall and capture its shape.
        const allCalls = [...ctx.turnToolCalls]
        const grepCall = allCalls.find((c) => c.tool === 'artifact_grep')!
        captured.grepCallToolCallId = grepCall.id
        captured.grepCallFromArtifactTool = grepCall.fromArtifactTool
        captured.grepResultsClass = grepCall.results?.constructor.name
        if (Tokenizable.isTokenizable(grepCall.results)) {
          captured.grepBytes = grepCall.results.toString()
        }

        // Ack triggers the bound `pruneEphemeral` — verify after the fact.
        ctx.ack()
        captured.registryAfterAck = main
          .all()
          .map((t) => t.name)
          .sort()
        return
      }

      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [emitTool],
    })

    await run()

    // The forged registry should ship the canonical seven base-method tools.
    expect(captured.forgedNames).toEqual([
      'artifact_byte_length',
      'artifact_cat',
      'artifact_estimate_tokens',
      'artifact_grep',
      'artifact_head',
      'artifact_line_count',
      'artifact_tail',
    ])
    expect(captured.forgedAreArtifactTools).toBe(true)
    expect(captured.forgedAreEphemeral).toBe(true)

    // The grep call's ToolCall record carries the ArtifactTool marker, and `results` is a
    // Tokenizable (NOT a SpooledArtifact) — the structural fix that breaks the otherwise-
    // recursive grep-on-the-grep-result loop.
    expect(captured.grepCallFromArtifactTool).toBe(true)
    expect(captured.grepResultsClass).toBe('Tokenizable')
    // Pattern '^b' matches 'beta' and 'banana'. ArtifactTool serialises string[] via join('\n').
    expect(captured.grepBytes).toBe('beta\nbanana')

    // After ack, the bound `pruneEphemeral` should have dropped every ephemeral forged tool —
    // only the original emit_payload baseline remains.
    expect(captured.registryAfterAck).toEqual(['emit_payload'])
  })

  it('forging again on a fresh ctx after a prior turn excludes the grep ToolCall from the callId enum', async () => {
    // This proves the recursion-breaking filter: ToolCalls produced by an ArtifactTool MUST
    // not appear in any subsequent forgeTools(ctx)'s `callId` enum.
    const store = new InMemorySpoolStore()
    let dumpedDescription: string | undefined

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        await scriptStep({ toolCalls: [{ tool: 'emit_payload', args: {} }] }, store)(ctx, helpers)
        return
      }
      if (ctx.iteration === 1) {
        // Forge + invoke artifact_grep so an ArtifactTool ToolCall ends up in turnToolCalls.
        const forged = SpooledArtifact.forgeTools(ctx)
        for (const tool of forged.all()) ctx.tools.register(tool, true)
        ctx.tools.bindContext(ctx)
        const [priorTc] = [...ctx.turnToolCalls]
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'artifact_grep',
                args: { callId: priorTc.id, pattern: '^b' },
              },
            ],
          },
          store
        )(ctx, helpers)

        // Now re-forge — the ArtifactTool-sourced ToolCall must be filtered out.
        const reforged = SpooledArtifact.forgeTools(ctx)
        const head = reforged.get('artifact_head')!
        dumpedDescription = JSON.stringify(head.describe().inputSchema)

        ctx.ack()
        return
      }
      ctx.ack()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [emitTool],
    })

    await run()

    expect(dumpedDescription).toBeDefined()
    // The original emit_payload ToolCall id is `tc-i0-1` (scriptStep namespacing).
    expect(dumpedDescription).toContain('tc-i0-1')
    // The ArtifactTool-sourced ToolCall id is `tc-i1-1` — must NOT be in the new enum.
    expect(dumpedDescription).not.toContain('tc-i1-1')
  })

  it('omitting bindContext leaks ephemeral tools across iterations (documents the contract)', async () => {
    // This test exists to document the failure mode, not to demonstrate desirable behaviour.
    // The contract is: you MUST call `registry.bindContext(ctx)` after merging forged tools.
    const store = new InMemorySpoolStore()
    let registryAfterAck: string[] = []

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        await scriptStep({ toolCalls: [{ tool: 'emit_payload', args: {} }] }, store)(ctx, helpers)
        return
      }
      const forged = SpooledArtifact.forgeTools(ctx)
      for (const tool of forged.all()) ctx.tools.register(tool, true)
      // INTENTIONALLY OMITTED: ctx.tools.bindContext(ctx)
      ctx.ack()
      registryAfterAck = ctx.tools
        .all()
        .map((t) => t.name)
        .sort()
    }

    const { run } = makeFixtureRunner({
      executorCallback: exec,
      tools: [emitTool],
    })

    await run()

    // Without bindContext, the ephemeral forged tools survive — the canonical mistake.
    expect(registryAfterAck).toContain('artifact_grep')
    expect(registryAfterAck).toContain('artifact_head')
  })
})
