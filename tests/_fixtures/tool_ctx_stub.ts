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
