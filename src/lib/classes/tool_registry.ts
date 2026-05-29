import { isInstanceOf } from '../utils/guards'
import { E_TOOL_ALREADY_REGISTERED } from '../exceptions/runtime'
import type { Tool } from './tool'
import type { DispatchContext } from '../contracts/dispatch_context'

/**
 * Options accepted by {@link ToolRegistry.merge}.
 */
export interface MergeOptions {
  /**
   * What to do when two registries contain a tool with the same name AND neither tool's own
   * `onCollision` resolves the collision.
   *
   * @remarks
   * - `'throw'` (default): raise {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} on the first unresolved
   *   collision. Mirrors the default behaviour of {@link ToolRegistry.register} and surfaces
   *   accidental name shadowing immediately.
   * - `'replace'`: the later registry's tool wins.
   * - `'keep'`: the earlier registry's tool wins; later occurrences are dropped.
   *
   * Per-tool {@link @nhtio/adk!Tool.onCollision} takes precedence: if the incoming tool declares
   * `'replace'` or `'keep'`, that policy wins regardless of this option. Only when the incoming
   * tool's policy is `'throw'` (the default) does this fallback apply.
   *
   * @defaultValue `'throw'`
   */
  onCollision?: 'throw' | 'replace' | 'keep'
}

/**
 * A mutable, turn-scoped collection of {@link @nhtio/adk!Tool} instances.
 *
 * @remarks
 * Each `TurnRunner.run()` call constructs a fresh `ToolRegistry` from the runner's configured
 * baseline tools, so middleware edits are isolated to the current turn and cannot bleed across
 * concurrent or subsequent turns.
 *
 * `Tool` instances are immutable, so `all()` returns a fresh array without deep-cloning.
 *
 * `register()` throws {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} if a tool with the same name is already
 * present — pass `overwrite: true` to replace it explicitly.
 */
export class ToolRegistry {
  #tools: Map<string, Tool>

  /**
   * Returns `true` if `value` is a {@link ToolRegistry} instance.
   *
   * @param value - The value to test.
   * @returns `true` when `value` is a {@link ToolRegistry} instance.
   */
  public static isToolRegistry(value: unknown): value is ToolRegistry {
    return isInstanceOf(value, 'ToolRegistry', ToolRegistry)
  }

  /**
   * @param tools - Optional initial tools. Insertion order is preserved. Duplicate names throw
   *   {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} — ensure each tool has a unique name.
   * @throws {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} when two tools in `tools` share a name.
   */
  constructor(tools?: Tool[]) {
    this.#tools = new Map()
    for (const tool of tools ?? []) {
      this.register(tool)
    }
  }

  /**
   * Adds a tool to the registry.
   *
   * @param tool - The tool to register.
   * @param overwrite - When `true`, silently replaces an existing tool with the same name.
   *   Defaults to `false`.
   * @throws {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} when a tool with the same name is already registered
   *   and `overwrite` is not `true`.
   */
  register(tool: Tool, overwrite?: boolean): void {
    if (this.#tools.has(tool.name) && !overwrite) {
      throw new E_TOOL_ALREADY_REGISTERED()
    }
    this.#tools.set(tool.name, tool)
  }

  /**
   * Removes the tool with the given name from the registry.
   *
   * @remarks
   * No-ops if no tool with that name is registered.
   *
   * @param name - The name of the tool to remove.
   */
  unregister(name: string): void {
    this.#tools.delete(name)
  }

  /**
   * Returns the tool registered under `name`, or `undefined` if not present.
   *
   * @param name - The tool name to look up.
   */
  get(name: string): Tool | undefined {
    return this.#tools.get(name)
  }

  /**
   * Returns `true` if a tool with the given name is registered.
   *
   * @param name - The tool name to test.
   */
  has(name: string): boolean {
    return this.#tools.has(name)
  }

  /**
   * Returns a fresh array of all registered tools in insertion order.
   *
   * @remarks
   * Since {@link @nhtio/adk!Tool} instances are immutable, no deep-cloning is needed.
   */
  all(): Tool[] {
    return Array.from(this.#tools.values())
  }

  /**
   * Removes every tool whose {@link @nhtio/adk!Tool.ephemeral} flag is `true`.
   *
   * @remarks
   * Synchronous and idempotent — calling it twice in a row is a no-op the second time. The
   * canonical caller is {@link ToolRegistry.bindContext}, which schedules this method to run
   * at {@link @nhtio/adk!DispatchContext.ack}. Non-ephemeral tools are left untouched.
   */
  pruneEphemeral(): void {
    for (const [name, tool] of this.#tools) {
      if (tool.ephemeral) {
        this.#tools.delete(name)
      }
    }
  }

  /**
   * Binds this registry to a {@link @nhtio/adk!DispatchContext} so that {@link pruneEphemeral} runs
   * automatically when the context is acked.
   *
   * @remarks
   * The handler does NOT fire on {@link @nhtio/adk!DispatchContext.nack} — failed executor runs leave
   * any forged tools in place so the consumer can inspect what was registered when debugging the
   * failure. Subscriptions are short-lived and die with the context regardless.
   *
   * Forgetting this call after merging in `Subclass.forgeTools(ctx)` output means ephemeral tools
   * accumulate across executor invocations, and subsequent `forgeTools(ctx)` calls in later
   * iterations will see a stale `callId` enum that excludes new tool calls. The plan-documented
   * pattern is:
   *
   * ```ts
   * const executor: DispatchExecutorFn = async (ctx) => {
   *   const forged = SpooledArtifact.forgeTools(ctx)
   *   const merged = ToolRegistry.merge([main, forged])
   *   main.bindContext(ctx)
   *   const result = await llm.invoke({ tools: merged.all(), ... })
   *   ctx.ack()
   * }
   * ```
   *
   * @param ctx - The execution context whose `ack` event should trigger pruning.
   * @returns An unsubscribe function — calling it before `ctx.ack()` prevents pruning. Rarely
   *   useful outside of tests.
   *
   * @see {@link @nhtio/adk!SpooledArtifact.forgeTools}
   * @see {@link @nhtio/adk!DispatchContext.onAck}
   */
  bindContext(ctx: DispatchContext): () => void {
    return ctx.onAck(() => this.pruneEphemeral())
  }

  /**
   * Combines multiple {@link ToolRegistry} instances into a fresh registry without mutating any
   * input.
   *
   * @remarks
   * Iteration is left-to-right across `registries` and then in each registry's insertion order.
   * Collisions are resolved by consulting the **incoming** tool's {@link @nhtio/adk!Tool.onCollision} first:
   *
   * - `'replace'` (per-tool): the incoming tool wins, replacing the existing entry.
   * - `'keep'` (per-tool): the existing entry wins; the incoming tool is dropped.
   * - `'throw'` (per-tool, the default): fall back to the merge-level `options.onCollision`.
   *
   * The merge-level `options.onCollision` defaults to `'throw'`, which mirrors {@link register}.
   *
   * The result is a brand-new registry; no input is mutated and no event subscription is
   * propagated. Each `Tool`'s `ephemeral` flag carries through unchanged — the flag lives on the
   * tool, not the registry, so `bindContext(ctx)` on the merged registry will prune the forged
   * tools as expected.
   *
   * @param registries - Registries to merge, in priority order (left-to-right insertion).
   * @param options - Merge-level collision policy. Defaults to `{ onCollision: 'throw' }`.
   * @returns A fresh {@link ToolRegistry} containing the resolved union of all inputs.
   * @throws {@link @nhtio/adk!E_TOOL_ALREADY_REGISTERED} when the resolved collision policy is `'throw'`
   *   and a collision occurs.
   */
  static merge(registries: ToolRegistry[], options?: MergeOptions): ToolRegistry {
    const policy = options?.onCollision ?? 'throw'
    const merged = new ToolRegistry()
    for (const registry of registries) {
      for (const tool of registry.all()) {
        const existing = merged.get(tool.name)
        if (!existing) {
          merged.register(tool)
          continue
        }
        const incomingPolicy = tool.onCollision
        if (incomingPolicy === 'replace') {
          merged.register(tool, true)
          continue
        }
        if (incomingPolicy === 'keep') {
          continue
        }
        // Incoming policy is 'throw' — fall back to the merge-level option.
        if (policy === 'replace') {
          merged.register(tool, true)
          continue
        }
        if (policy === 'keep') {
          continue
        }
        throw new E_TOOL_ALREADY_REGISTERED()
      }
    }
    return merged
  }
}
