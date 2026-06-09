import { isError } from '../../src/lib/utils/guards'
import type { Tool } from '../../src/lib/classes/tool'
import type { DispatchContext } from '../../src/lib/contracts/dispatch_context'

/**
 * Builds a minimal duck-typed stub of {@link DispatchContext} suitable for unit-testing
 * bundled tool executors. Exposes only the fields `Tool.executor` actually reads (`id`,
 * `emitToolExecutionStart`, `emitToolExecutionEnd`) — real DispatchContext construction
 * is out of scope for these unit tests.
 */
export const makeToolCtxStub = (): DispatchContext =>
  ({
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
  }) as unknown as DispatchContext

/**
 * Discriminated outcome of invoking a tool executor: either it `resolved` with the handler's
 * output, or it `threw` (the executor wrapped a handler error in `E_TOOL_DOWNSTREAM_ERROR`, or
 * validation rejected with `E_INVALID_TOOL_ARGS`). `errorName` is the thrown exception's
 * constructor name for easy assertion.
 */
export type ToolOutcome =
  | { kind: 'resolved'; out: string }
  | { kind: 'threw'; errorName: string; message: string; error: unknown }

/**
 * Invoke a tool executor and capture resolve-vs-throw as a value, never re-throwing.
 *
 * This makes the bundled-tool contract directly assertable: a well-behaved tool either
 * resolves to a string (a real result OR a graceful `"Error: …"` string) or, for
 * schema-invalid args, throws `E_INVALID_TOOL_ARGS`. ANY other thrown error
 * (`E_TOOL_DOWNSTREAM_ERROR`) is a defect. Assert on `.kind` / `.errorName` rather than
 * wrapping calls in ad-hoc try/catch — and so a test cannot accidentally pass by matching a
 * buggy handler's output, because "did it throw?" is an explicit field.
 *
 * @example
 * const r = await callTool(formatListTool, { items: ['a'], indent: 1e9 })
 * expect(r.kind).toBe('resolved') // currently 'threw' — exposes the unclamped-indent bug
 */
export const callTool = async (tool: Tool, args: unknown): Promise<ToolOutcome> => {
  try {
    const out = (await tool.executor(makeToolCtxStub())(args)) as string
    return { kind: 'resolved', out }
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && 'constructor' in error
        ? (error as { constructor: { name: string } }).constructor.name
        : 'Error'
    const message = isError(error) ? error.message : String(error)
    return { kind: 'threw', errorName, message, error }
  }
}
