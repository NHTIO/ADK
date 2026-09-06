/**
 * @module @nhtio/adk/batteries/orchestration/dispatch_reasoner
 */

import { Message, Tool } from '@nhtio/adk/common'
import { inMemoryMediaReader } from '@nhtio/adk/common'
import { DispatchRunner } from '@nhtio/adk/dispatch_runner'
import { isObject, isInstanceOf } from '../../lib/utils/guards'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import { wrapInstruction, stripInstructionTags, validateReasonerOutput } from './reason'
import type { Schema } from '@nhtio/validation'
import type { ReasonerFn, EncodableValue } from './types'
import type { RawDispatchContext } from '@nhtio/adk/types'
import type { DispatchContext, DispatchExecutorFn } from '@nhtio/adk/types'

/**
 * An `AbortController` pre-aborted when `signal` already is, so a cancelled reasoning request
 * does not start a dispatch. `RawDispatchContext` takes a controller rather than a signal.
 */
const signalController = (signal?: AbortSignal): AbortController => {
  const controller = new AbortController()
  if (signal?.aborted === true) controller.abort()
  else signal?.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/**
 * The persistence callbacks a standalone `DispatchContext` requires, as no-ops.
 *
 * A reasoning dispatch is a single question with a single structured answer: nothing it produces
 * outlives the call, so there is no store to write to and no history to fetch. Bytes are the one
 * exception — a large result needs somewhere to live for the duration — so those two callbacks
 * are backed by the supplied spool store. Kept internal deliberately: exporting this shape would
 * commit the battery to it.
 */
const noopPersistence = (
  spoolStore: InMemorySpoolStore
): Omit<RawDispatchContext, 'systemPrompt' | 'messages' | 'tools' | 'turnAbortController'> => ({
  fetchMemories: async () => [],
  fetchMessages: async () => [],
  fetchThoughts: async () => [],
  fetchToolCalls: async () => [],
  fetchTools: async () => [],
  fetchRetrievables: async () => [],
  refreshStandingInstructions: async () => [],
  storeStandingInstruction: async () => {},
  mutateStandingInstruction: async () => {},
  deleteStandingInstruction: async () => {},
  storeMemory: async () => {},
  mutateMemory: async () => {},
  deleteMemory: async () => {},
  storeRetrievable: async () => {},
  mutateRetrievable: async () => {},
  deleteRetrievable: async () => {},
  storeMessage: async () => {},
  mutateMessage: async () => {},
  deleteMessage: async () => {},
  storeThought: async () => {},
  mutateThought: async () => {},
  deleteThought: async () => {},
  storeToolCall: async () => {},
  mutateToolCall: async () => {},
  deleteToolCall: async () => {},
  storeMediaBytes: async (_ctx, _id, bytes) =>
    inMemoryMediaReader(
      isInstanceOf(bytes, 'Uint8Array', Uint8Array)
        ? bytes
        : new TextEncoder().encode(String(bytes))
    ),
  storeRetrievableBytes: (_ctx, id, bytes) => spoolStore.write(id, bytes as Uint8Array),
})

/**
 * Builds a reasoner that answers through a forced tool dispatch.
 *
 * A reasoning node must return a structured, schema-validated result, but
 * {@link DispatchRunner.dispatch} resolves to `void`. This helper bridges that
 * gap by wiring the node's output schema onto a forced tool's `inputSchema` and
 * capturing the arguments the model submits to that tool. Because the tool's
 * input schema is the node's output schema, validation rejects malformed
 * arguments before the handler ever runs, so the model cannot answer with
 * unstructured prose.
 *
 * The captured value is read from a closure after the dispatch resolves; the
 * void return value is irrelevant. If the tool is never called, the dispatch is
 * a halting failure and this function throws rather than fabricating or
 * returning a partial result.
 *
 * The boundary this draws is deliberate: the battery owns the forced-tool protocol and the retry
 * bound, and the CONSUMER owns the model. `DispatchRunner` takes an injected executor rather than
 * a model identifier, so a consumer wires whichever provider they already use and this helper
 * never grows credential handling.
 *
 * @param options - Configuration for the reasoner.
 * @param options.executor - The consumer's LLM call, invoked by the runner on every iteration.
 * @param options.spoolStore - Store used to spool large results. Defaults to a
 *   fresh {@link InMemorySpoolStore} so a large reasoning result always has
 *   somewhere to go.
 * @param options.toolName - Name of the forced capture tool. Defaults to
 *   `'submit_reasoning'`.
 * @returns A {@link ReasonerFn} that resolves to the validated reasoning
 *   result or throws if no valid result could be captured.
 */
export const createDispatchReasoner = (options: {
  executor: DispatchExecutorFn
  spoolStore?: InMemorySpoolStore
  toolName?: string
}): ReasonerFn => {
  const spoolStore = options.spoolStore ?? new InMemorySpoolStore()
  const toolName = options.toolName ?? 'submit_reasoning'

  // Constructing Message and Tool here is a documented CONTRIBUTING §13
  // exception, which is why this helper lives at its own subpath and not in the
  // battery's environment-neutral barrel.
  const reasoner: ReasonerFn = async (req) => {
    const { prompt, outputSchema, maxAttempts, signal } = req
    const schema: Schema = outputSchema

    const corrective: string[] = []

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let captured: Record<string, EncodableValue> | undefined

      const tool = new Tool({
        name: toolName,
        description: 'Submit the structured reasoning result for this node.',
        inputSchema: schema,
        handler: async (args: unknown, ctx: DispatchContext) => {
          if (isObject(args)) {
            captured = args as Record<string, EncodableValue>
          }
          ctx.ack()
          return 'Reasoning accepted.'
        },
      })

      const body =
        corrective.length > 0
          ? wrapInstruction(prompt, `The previous attempt was rejected. ${corrective.join(' ')}`)
          : prompt

      const now = new Date()
      const message = new Message({
        id: `reason-${attempt}-${now.getTime()}`,
        role: 'user',
        content: body,
        createdAt: now,
        updatedAt: now,
      })

      await DispatchRunner.dispatch({
        executor: options.executor,
        raw: {
          systemPrompt: 'Answer only by calling the submission tool.',
          messages: [message],
          tools: [tool],
          turnAbortController: signalController(signal),
          ...noopPersistence(spoolStore),
        },
      })

      if (captured === undefined) {
        corrective.push('The tool was never called; a structured result is required.')
        continue
      }

      const validation = validateReasonerOutput(schema, captured)
      if (validation === true) {
        return captured
      }

      corrective.push(stripInstructionTags(validation))
    }

    throw new Error(
      `Reasoning failed after ${maxAttempts} attempt(s): no valid structured result was captured.`
    )
  }

  return reasoner
}
