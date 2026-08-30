import { DateTime } from 'luxon'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
// `chat_common/helpers` is deliberately NOT `@module`-tagged — it stays a private, inlined module,
// so it is absent from the published package's `exports` map and importing it here breaks the smoke
// checks, which install the built package rather than resolving source. Consume the identical
// function through a battery barrel that re-exports it publicly instead.
import { looksLikeSpooledArtifact } from '@nhtio/adk/batteries/llm/litert_lm'
import {
  ArtifactTool,
  isInstanceOf,
  Media,
  Message,
  SpooledArtifact,
  Thought,
  Tokenizable,
  ToolCall,
} from '@nhtio/adk'
import type {
  DispatchContext,
  DispatchExecutorFn,
  DispatchExecutorHelpers,
  SpooledArtifactConstructor,
  SpoolReader,
} from '@nhtio/adk'

/**
 * Duck-typed "spool store" contract that the scripted executor uses to persist tool-call
 * bytes. Any object whose `write(callId, bytes)` returns either a synchronously available
 * {@link SpoolReader} or a `Promise<SpoolReader>` qualifies — including the in-memory
 * {@link InMemorySpoolStore} and the flydrive-backed `FlydriveSpoolStore`.
 */
export interface ScriptStore {
  write(callId: string, bytes: string | Uint8Array): SpoolReader | Promise<SpoolReader>
}

/**
 * A single scripted iteration of what the LLM "did" in a dispatch loop.
 *
 * @remarks
 * Each `ScenarioStep` describes the side-effects an executor should produce for one iteration.
 * Composed into an `DispatchExecutorFn` via {@link scriptStep} (single iteration) or
 * {@link scriptedExecutor} (full script).
 *
 * Fields are processed in this order: `toolCalls`, then `thought`, then `message`, then `ack`
 * or `nack`. `ack` and `nack` are mutually exclusive — providing both throws at script-build
 * time.
 */
export interface ScenarioStep {
  /** Emit an assistant message via `helpers.reportMessage` then persist via `ctx.storeMessage`. */
  message?: string
  /** Emit a thought via `helpers.reportThought` then persist via `ctx.storeThought`. */
  thought?: string
  /**
   * Tool requests to execute in this iteration. For each entry the executor looks up the tool
   * via `ctx.tools.get(tool)`, invokes `tool.executor(ctx)(args)` for real, writes the
   * resulting bytes into the supplied {@link InMemorySpoolStore}, constructs a `ToolCall`
   * (using the tool's `artifactConstructor` or an explicit override), and persists it via
   * `ctx.storeToolCall`.
   */
  toolCalls?: Array<{
    tool: string
    args: unknown
    artifactConstructor?: SpooledArtifactConstructor
  }>
  /** Call `ctx.ack()` after all other side-effects complete. Mutually exclusive with `nack`. */
  ack?: boolean
  /** Call `ctx.nack(err)` after all other side-effects complete. Mutually exclusive with `ack`. */
  nack?: Error
}

const counterFor = () => {
  let n = 0
  return () => `${++n}`
}

/**
 * Builds an `DispatchExecutorFn` that performs the side-effects described by a single
 * {@link ScenarioStep} when invoked.
 *
 * @remarks
 * Pure — no vitest imports. Composes naturally with `vi.fn<DispatchExecutorFn>().mockImplementationOnce(scriptStep(...))`
 * when per-call introspection is needed. For the common linear case, prefer
 * {@link scriptedExecutor}.
 *
 * @param step - The scenario step to materialise.
 * @param store - The {@link InMemorySpoolStore} that backs tool-call result bytes.
 * @returns A function with the `DispatchExecutorFn` signature.
 */
export const scriptStep = (step: ScenarioStep, store: ScriptStore): DispatchExecutorFn => {
  if (step.ack === true && step.nack !== undefined) {
    throw new Error('scriptStep: ack and nack are mutually exclusive within a single step')
  }
  return async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
    const nextId = counterFor()
    // Per-iteration namespace so ids stay unique across multiple steps of a scriptedExecutor
    // run, while remaining deterministic when scriptStep is called standalone (iteration is
    // always 0 for a fresh standalone dispatch).
    const ns = `i${ctx.iteration}`

    // 1. Tool calls
    if (step.toolCalls && step.toolCalls.length > 0) {
      for (const tc of step.toolCalls) {
        const tool = ctx.tools.get(tc.tool)
        if (!tool) {
          throw new Error(`scriptStep: tool "${tc.tool}" is not registered on the DispatchContext`)
        }
        const callId = `tc-${ns}-${nextId()}`
        // Announce the request first
        helpers.reportToolCall(callId, { tool: tc.tool, args: tc.args })
        // Invoke the real tool executor; let bytes be persisted via the store
        const raw = await tool.executor(ctx)(tc.args)
        const isArtifactTool = ArtifactTool.isArtifactTool(tool)
        let results: SpooledArtifact | Tokenizable | Media | Media[]
        if (isArtifactTool) {
          // ArtifactTool: wrap the (string|Tokenizable) handler return into a Tokenizable.
          // No spool write, no SpooledArtifact construction — the value is already the
          // model-visible answer to a query against a prior artifact.
          if (Tokenizable.isTokenizable(raw)) {
            results = raw
          } else if (typeof raw === 'string') {
            results = new Tokenizable(raw)
          } else {
            throw new Error(
              `scriptStep: ArtifactTool "${tc.tool}" returned a non-string/non-Tokenizable value`
            )
          }
        } else if (looksLikeSpooledArtifact(raw)) {
          results = raw as SpooledArtifact
        } else if (Media.isMedia(raw)) {
          results = raw
        } else if (Array.isArray(raw) && raw.length > 0 && raw.every((m) => Media.isMedia(m))) {
          results = raw as Media[]
        } else if (typeof raw === 'string' || isInstanceOf(raw, 'Uint8Array', Uint8Array)) {
          const reader = await store.write(callId, raw)
          const ArtifactCtor =
            tc.artifactConstructor ??
            (
              tool as { artifactConstructor?: () => SpooledArtifactConstructor }
            ).artifactConstructor?.() ??
            SpooledArtifact
          results = new ArtifactCtor(reader)
        } else {
          throw new Error(
            `scriptStep: tool "${tc.tool}" returned an unexpected value type ${typeof raw}`
          )
        }
        // Announce the result + persist the full record
        helpers.reportToolCall(callId, {
          results,
          isError: false,
          isComplete: true,
        })
        const now = DateTime.now()
        const toolCall = new ToolCall({
          id: callId,
          tool: tc.tool,
          args: (tc.args ?? {}) as Record<string, unknown>,
          checksum: callId,
          isComplete: true,
          isError: false,
          results,
          fromArtifactTool: isArtifactTool,
          createdAt: now,
          updatedAt: now,
          completedAt: now,
        })
        await ctx.storeToolCall(toolCall)
      }
    }

    // 2. Thought
    if (step.thought !== undefined) {
      const id = `th-${ns}-${nextId()}`
      helpers.reportThought(id, step.thought, { isComplete: true })
      const now = DateTime.now()
      const thought = new Thought({
        id,
        content: step.thought,
        createdAt: now,
        updatedAt: now,
      })
      await ctx.storeThought(thought)
    }

    // 3. Message
    if (step.message !== undefined) {
      const id = `msg-${ns}-${nextId()}`
      helpers.reportMessage(id, step.message, { isComplete: true })
      const now = DateTime.now()
      const message = new Message({
        id,
        role: 'assistant',
        content: step.message,
        createdAt: now,
        updatedAt: now,
      })
      await ctx.storeMessage(message)
    }

    // 4. Signal
    if (step.ack === true) ctx.ack()
    else if (step.nack !== undefined) ctx.nack(step.nack)
  }
}

/**
 * Builds an `DispatchExecutorFn` that consumes one {@link ScenarioStep} per iteration based on
 * `ctx.iteration`.
 *
 * @remarks
 * The returned function carries the backing {@link InMemorySpoolStore} as a `store` property
 * so assertions can introspect persisted tool-result bytes. If the dispatch loops past the end
 * of the script, the executor defensively calls `ctx.ack()` so an under-scripted scenario
 * terminates cleanly rather than looping forever.
 *
 * @param steps - The ordered list of steps; one is consumed per dispatch iteration.
 * @param store - Optional {@link InMemorySpoolStore}; a fresh one is created if omitted.
 * @returns An `DispatchExecutorFn` augmented with `.store` for assertion access.
 */
export interface ScriptedExecutor<S extends ScriptStore = ScriptStore> extends DispatchExecutorFn {
  store: S
}

export function scriptedExecutor(steps: ScenarioStep[]): ScriptedExecutor<InMemorySpoolStore>
export function scriptedExecutor<S extends ScriptStore>(
  steps: ScenarioStep[],
  store: S
): ScriptedExecutor<S>
export function scriptedExecutor<S extends ScriptStore>(
  steps: ScenarioStep[],
  store?: S
): ScriptedExecutor<S | InMemorySpoolStore> {
  const resolvedStore: ScriptStore = store ?? new InMemorySpoolStore()
  // Pre-validate every step for the ack/nack conflict so a misconfigured script fails at
  // build time, not on the iteration that hits the bad step.
  for (const [i, step] of steps.entries()) {
    if (step.ack === true && step.nack !== undefined) {
      throw new Error(
        `scriptedExecutor: step ${i} has both ack and nack set; they are mutually exclusive`
      )
    }
  }

  const exec = async (ctx: DispatchContext, helpers: DispatchExecutorHelpers): Promise<void> => {
    const idx = ctx.iteration
    if (idx >= steps.length) {
      // Defensive: script ran out before signalling. Ack so we exit cleanly.
      ctx.ack()
      return
    }
    await scriptStep(steps[idx], resolvedStore)(ctx, helpers)
  }
  ;(exec as ScriptedExecutor<S | InMemorySpoolStore>).store = resolvedStore as
    | S
    | InMemorySpoolStore
  return exec as ScriptedExecutor<S | InMemorySpoolStore>
}
