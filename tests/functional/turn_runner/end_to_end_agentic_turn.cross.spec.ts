import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { scriptStep } from '../../_fixtures/scripted_executor'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { Tool, Tokenizable, ToolRegistry, SpooledMarkdownArtifact } from '@nhtio/adk'
import type { DispatchContext, DispatchExecutorFn, DispatchExecutorHelpers } from '@nhtio/adk'

// A multi-iteration agentic turn end-to-end through the real TurnRunner + DispatchRunner
// machinery, using the scripted-executor mock harness as the "model". The scenario:
//
//   iter 0: model calls `fetch_doc` -> emits a SpooledMarkdownArtifact ToolCall
//   iter 1: model forges artifact-query tools, narrows to markdown, calls artifact_md_headings
//   iter 2: model calls artifact_md_links on the same artifact
//   iter 3: model emits the final assistant summary and acks
//
// Every primitive the harness ships is exercised in one coherent flow:
//   - real Tool with artifactConstructor wiring (fetch_doc -> SpooledMarkdownArtifact)
//   - real SpooledArtifact persistence into an InMemorySpoolStore via scriptStep
//   - real SpooledMarkdownArtifact.forgeTools(ctx) producing both base and md-specific tools
//   - real ToolRegistry.merge + bindContext lifecycle for ephemeral cleanup on ack
//   - real ArtifactTool handler dispatch (artifact_md_headings -> Tokenizable result)
//   - real ToolCall records with fromArtifactTool flag flipped on artifact-query results
//   - real event surface: functional bus (message/thought/toolCall) + observability bus
//     (turn*, dispatch*, iteration*, toolExecution*)

const MARKDOWN_PAYLOAD = `---
title: Release notes
version: 1.2.0
---

# Release notes

## Highlights

The release ships [docs](https://example.com/docs) and [an api guide](https://example.com/api).

## Bug fixes

- Fixed [issue 42](https://example.com/i/42)
- Restored compatibility

## Internal

\`\`\`ts
const x = 1
\`\`\`
`

const fetchDocTool = new Tool({
  name: 'fetch_doc',
  description: 'Fetch the project documentation as markdown.',
  inputSchema: validator.object({
    section: validator.string().optional().description('Optional section anchor.'),
  }),
  artifactConstructor: () => SpooledMarkdownArtifact,
  handler: () => MARKDOWN_PAYLOAD,
})

describe('TurnRunner: full agentic turn end-to-end', () => {
  it('drives a 4-iteration scenario: fetch -> forge -> query headings -> query links -> summarise + ack', async () => {
    const store = new InMemorySpoolStore()

    // Snapshot state from inside the executor so the assertions can see what the "model" saw
    // at each iteration without having to reconstruct it from the event log alone.
    const captured: {
      fetchedArtifactClass?: string
      forgedToolNames?: string[]
      forgedIncludeMarkdownTools?: boolean
      headingsResultClass?: string
      headingsBytes?: string
      linksResultClass?: string
      linksBytes?: string
      mainRegistryBeforeAck?: string[]
      mainRegistryAfterAck?: string[]
    } = {}

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        // Iteration 0: produce a real SpooledMarkdownArtifact via fetch_doc.
        await scriptStep(
          { toolCalls: [{ tool: 'fetch_doc', args: { section: 'release-notes' } }] },
          store
        )(ctx, helpers)
        const [fetchedCall] = [...ctx.turnToolCalls]
        captured.fetchedArtifactClass = fetchedCall.results?.constructor.name
        return
      }

      if (ctx.iteration === 1) {
        // Iteration 1: forge the artifact-query registry, merge onto the main registry, bind.
        const main = ctx.tools
        const forged = SpooledMarkdownArtifact.forgeTools(ctx)
        captured.forgedToolNames = forged
          .all()
          .map((t) => t.name)
          .sort()
        captured.forgedIncludeMarkdownTools = forged
          .all()
          .some((t) => t.name === 'artifact_md_headings')

        const merged = ToolRegistry.merge([main, forged], { onCollision: 'replace' })
        for (const tool of merged.all()) main.register(tool, true)
        main.bindContext(ctx)

        // Invoke artifact_md_headings against the prior markdown ToolCall.
        const fetchedCall = [...ctx.turnToolCalls].find((tc) => tc.tool === 'fetch_doc')!
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'artifact_md_headings',
                args: { callId: fetchedCall.id },
              },
            ],
          },
          store
        )(ctx, helpers)

        const headingsCall = [...ctx.turnToolCalls].find(
          (tc) => tc.tool === 'artifact_md_headings'
        )!
        captured.headingsResultClass = headingsCall.results?.constructor.name
        if (Tokenizable.isTokenizable(headingsCall.results)) {
          captured.headingsBytes = headingsCall.results.toString()
        }
        return
      }

      if (ctx.iteration === 2) {
        // Iteration 2: same artifact, different forged query — proves the ephemeral tools are
        // still live across iterations because nothing has acked yet.
        const fetchedCall = [...ctx.turnToolCalls].find((tc) => tc.tool === 'fetch_doc')!
        await scriptStep(
          {
            toolCalls: [
              {
                tool: 'artifact_md_links',
                args: { callId: fetchedCall.id },
              },
            ],
          },
          store
        )(ctx, helpers)
        const linksCall = [...ctx.turnToolCalls].find((tc) => tc.tool === 'artifact_md_links')!
        captured.linksResultClass = linksCall.results?.constructor.name
        if (Tokenizable.isTokenizable(linksCall.results)) {
          captured.linksBytes = linksCall.results.toString()
        }
        return
      }

      if (ctx.iteration === 3) {
        // Iteration 3: capture the registry on either side of ack so the ephemeral-cleanup
        // contract can be asserted from outside, then emit the final summary + ack.
        captured.mainRegistryBeforeAck = ctx.tools
          .all()
          .map((t) => t.name)
          .sort()
        await scriptStep(
          {
            thought: 'I now have the headings and links — drafting the summary.',
            message:
              'Release 1.2.0 ships docs, an api guide, and a fix for issue 42. Highlights and Bug fixes are the top-level sections.',
            ack: true,
          },
          store
        )(ctx, helpers)
        captured.mainRegistryAfterAck = ctx.tools
          .all()
          .map((t) => t.name)
          .sort()
        return
      }

      // Defensive: should never run, but if it does, terminate cleanly.
      ctx.ack()
    }

    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [fetchDocTool],
    })

    await run()

    // ── Iteration choreography ────────────────────────────────────────────────────────────
    // Four iterations started; only iters 0/1/2 produce iterationEnd because iter 3 acks
    // before iterationEnd would fire (the multi_iteration spec already documents this shape
    // for a 2-iter run; this verifies it scales).
    const iterStarts = events.filter((e) => e.kind === 'iterationStart')
    const iterEnds = events.filter((e) => e.kind === 'iterationEnd')
    expect(iterStarts).toHaveLength(4)
    expect(iterEnds).toHaveLength(3)
    expect(iterStarts.map((e) => (e.payload as { iteration: number }).iteration)).toEqual([
      0, 1, 2, 3,
    ])
    expect(iterEnds.map((e) => (e.payload as { iteration: number }).iteration)).toEqual([0, 1, 2])

    // ── Dispatch + turn lifecycle: each fires exactly once ────────────────────────────────
    // turnGateOpen / turnGateClosed are intentionally not asserted here: they fire only when
    // middleware calls `ctx.waitFor()`, and the fixture config registers no middleware.
    expect(events.filter((e) => e.kind === 'turnStart')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchStart')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'dispatchEnd')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'turnGateOpen')).toHaveLength(0)
    expect(events.filter((e) => e.kind === 'turnGateClosed')).toHaveLength(0)

    // dispatchEnd carries an "ack" status — proves the runner observed our terminal signal.
    const dispatchEnd = events.find((e) => e.kind === 'dispatchEnd')!
    expect((dispatchEnd.payload as { status: string }).status).toBe('ack')

    // ── Tool execution events ─────────────────────────────────────────────────────────────
    // Three tool invocations: fetch_doc, artifact_md_headings, artifact_md_links. Each emits
    // a matched pair of toolExecutionStart/toolExecutionEnd.
    const toolStarts = events.filter((e) => e.kind === 'toolExecutionStart')
    const toolEnds = events.filter((e) => e.kind === 'toolExecutionEnd')
    expect(toolStarts).toHaveLength(3)
    expect(toolEnds).toHaveLength(3)
    expect(toolStarts.map((e) => (e.payload as { toolName: string }).toolName)).toEqual([
      'fetch_doc',
      'artifact_md_headings',
      'artifact_md_links',
    ])

    // ── Functional bus: toolCall + thought + message ──────────────────────────────────────
    // Each tool call announces twice (request + result), so 3 invocations = 6 toolCall events.
    expect(events.filter((e) => e.kind === 'toolCall')).toHaveLength(6)
    expect(events.filter((e) => e.kind === 'thought')).toHaveLength(1)
    const messages = events.filter((e) => e.kind === 'message')
    expect(messages).toHaveLength(1)
    expect((messages[0].payload as { full: string }).full).toContain('Release 1.2.0')

    // No errors should have fired on the happy path.
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(0)

    // ── Artifact + tool-call substance ────────────────────────────────────────────────────
    // The fetch_doc ToolCall's results is a SpooledMarkdownArtifact thanks to the
    // `artifactConstructor` resolver — not a bare SpooledArtifact.
    expect(captured.fetchedArtifactClass).toBe('SpooledMarkdownArtifact')

    // Markdown forge ships base tools + md-specific tools merged into one registry.
    expect(captured.forgedIncludeMarkdownTools).toBe(true)
    expect(captured.forgedToolNames).toEqual(
      expect.arrayContaining([
        'artifact_byte_length',
        'artifact_cat',
        'artifact_estimate_tokens',
        'artifact_grep',
        'artifact_head',
        'artifact_line_count',
        'artifact_tail',
        'artifact_md_ast',
        'artifact_md_code_blocks',
        'artifact_md_frontmatter',
        'artifact_md_headings',
        'artifact_md_images',
        'artifact_md_links',
        'artifact_md_sections',
        'artifact_md_text',
      ])
    )

    // ArtifactTool query results are Tokenizable (NOT SpooledArtifact) — the structural carve-
    // out that prevents an artifact-query result from feeding back into another forgeTools.
    expect(captured.headingsResultClass).toBe('Tokenizable')
    expect(captured.linksResultClass).toBe('Tokenizable')
    // md_headings on the fixture payload returns an array of heading entries; the default
    // serialiser falls through to JSON.stringify for non-string[] / non-string returns.
    expect(captured.headingsBytes).toContain('Release notes')
    expect(captured.headingsBytes).toContain('Highlights')
    expect(captured.headingsBytes).toContain('Bug fixes')
    // md_links: same payload had three links — assert at least one resolved into the body.
    expect(captured.linksBytes).toContain('https://example.com/docs')
    expect(captured.linksBytes).toContain('https://example.com/api')
    expect(captured.linksBytes).toContain('https://example.com/i/42')

    // ── Ephemeral cleanup contract ────────────────────────────────────────────────────────
    // Before ack: the main registry still has the forged tools (we registered them there).
    expect(captured.mainRegistryBeforeAck).toEqual(
      expect.arrayContaining(['fetch_doc', 'artifact_md_headings', 'artifact_md_links'])
    )
    // After ack: every ephemeral forged tool has been pruned; only the baseline survives.
    expect(captured.mainRegistryAfterAck).toEqual(['fetch_doc'])
  })

  it('the same flow ends cleanly when an intermediate iteration nacks instead of acking', async () => {
    // Same primitive composition, but on iter 2 the model nacks (e.g., it decided the
    // artifact was unusable). Confirms the runner's nack path interacts correctly with the
    // ephemeral-cleanup machinery and that the full event lifecycle still completes.
    const store = new InMemorySpoolStore()
    const cause = new Error('decided to bail mid-turn')

    const exec: DispatchExecutorFn = async (
      ctx: DispatchContext,
      helpers: DispatchExecutorHelpers
    ): Promise<void> => {
      if (ctx.iteration === 0) {
        await scriptStep({ toolCalls: [{ tool: 'fetch_doc', args: {} }] }, store)(ctx, helpers)
        return
      }
      if (ctx.iteration === 1) {
        const forged = SpooledMarkdownArtifact.forgeTools(ctx)
        for (const tool of forged.all()) ctx.tools.register(tool, true)
        ctx.tools.bindContext(ctx)
        const fetchedCall = [...ctx.turnToolCalls].find((tc) => tc.tool === 'fetch_doc')!
        await scriptStep(
          {
            toolCalls: [{ tool: 'artifact_md_headings', args: { callId: fetchedCall.id } }],
          },
          store
        )(ctx, helpers)
        return
      }
      if (ctx.iteration === 2) {
        await scriptStep({ nack: cause }, store)(ctx, helpers)
        return
      }
      ctx.ack()
    }

    const { run, events } = makeFixtureRunner({
      executorCallback: exec,
      tools: [fetchDocTool],
    })

    await expect(run()).resolves.toBeUndefined()

    // dispatchEnd carries status "nack" and the original error — matches the nack_propagation
    // contract documented in nack_propagation.cross.spec.ts.
    const dispatchEnd = events.find((e) => e.kind === 'dispatchEnd')!
    const payload = dispatchEnd.payload as { status: string; error?: Error }
    expect(payload.status).toBe('nack')
    expect(payload.error).toBe(cause)

    // turnEnd still fires exactly once even on the nack path.
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)

    // The two tool invocations that did complete (fetch_doc + artifact_md_headings) still
    // produced their toolExecution event pairs — partial work is observed.
    expect(events.filter((e) => e.kind === 'toolExecutionStart')).toHaveLength(2)
    expect(events.filter((e) => e.kind === 'toolExecutionEnd')).toHaveLength(2)

    // An error event surfaced on the observability bus.
    expect(events.filter((e) => e.kind === 'error').length).toBeGreaterThanOrEqual(1)
  })
})
