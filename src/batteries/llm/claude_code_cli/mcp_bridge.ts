/**
 * The wrapper's local HTTP MCP server — real-tool bridging plus the actual enforcement of which
 * bridged tools are callable. Wrapper-only — never imported by `adapter.ts`.
 *
 * @remarks
 * Built on the LOW-LEVEL `Server` class from `@modelcontextprotocol/sdk/server`, never
 * `McpServer.registerTool()` (which requires Zod-shaped schemas — incompatible with ADK's
 * Joi-based tools, already rendered to plain JSON Schema by the adapter before this module ever
 * sees them). The low-level `Server` takes MCP *protocol* schemas (`ListToolsRequestSchema`/
 * `CallToolRequestSchema`), not per-tool argument schemas, so no Zod object is authored anywhere
 * in this file — the only Zod footprint is the two pre-built protocol-schema tokens imported from
 * the SDK itself.
 *
 * `--allowedTools` is kept in the CLI invocation only as a defense-in-depth, human-readable
 * statement of intent (see `wrapper.ts`'s argv construction) — it CANNOT be the real enforcement
 * mechanism, because `--dangerously-skip-permissions` removes the permission engine that an
 * allow-RULE feeds. The real enforcement happens here, twice over: `bridgedTools` arrives from the
 * adapter already pre-filtered to exclude `disallowedTools`, so a disallowed name is never even
 * listed; and the `CallTool` handler independently re-checks the requested name against that same
 * already-filtered list before ever emitting a `tool_call_request` to the adapter.
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { WrapperBridgedTool } from './wire'
import type { Server as HttpServer } from 'node:http'

/** A pending `CallTool` request awaiting a `tool_call_response` from the adapter. */
interface PendingCall {
  resolve: (result: { content: Array<Record<string, unknown>>; isError?: boolean }) => void
}

/** The running bridge: its bound port, and hooks to route calls to/from the adapter side. */
export interface McpBridge {
  /** The ephemeral loopback port the bridge is listening on. */
  port: number
  /**
   * Replaces the bridge's advertised tool set. The bridge starts with an EMPTY set at boot (so it
   * can bind its port and let the wrapper emit `ready` before a `run` command — carrying the real
   * tool list — has arrived); `wrapper.ts` calls this once, when `run` arrives, before spawning
   * `claude`.
   */
  setBridgedTools(tools: WrapperBridgedTool[]): void
  /**
   * Called by `wrapper.ts` when a `tool_call_response` command arrives from the adapter, to
   * settle the matching pending `CallTool` request.
   */
  resolveToolCall(
    requestId: string,
    result: { content: Array<Record<string, unknown>>; isError?: boolean }
  ): void
  /**
   * Reject every still-pending `CallTool` request with an `isError: true` result explaining the
   * bridge is shutting down. Must run BEFORE `close()` — an in-flight request is itself an active
   * HTTP connection, so settling it first is what lets `close()` (and the underlying `http.Server`
   * close callback) unblock.
   */
  rejectPending(reason: string): void
  /** Closes the MCP transport — this is what actually tears down any open SSE stream via its own `cleanup()` calls. Must run AFTER `rejectPending()` and BEFORE the HTTP listener is closed. */
  closeTransport(): Promise<void>
  /** Closes the HTTP listener. Callback-based under the hood — promisified here. Must run LAST. */
  closeHttpServer(): Promise<void>
}

/**
 * Start the bridge: bind an ephemeral loopback HTTP listener, wire a `StreamableHTTPServerTransport`
 * (session-scoped to this one wrapper-lifetime connection — see the `sessionIdGenerator` remark
 * below) to a low-level `Server` constructed with the explicit `tools` capability (required — the
 * SDK throws for `tools/list`/`tools/call` otherwise), and register the two handlers that make the
 * current `bridgedTools` set reachable over MCP.
 *
 * @remarks
 * Starts with an EMPTY tool set — the bridge must bind its port and let the wrapper emit `ready`
 * BEFORE the adapter has sent a `run` command carrying the real tool list (the adapter waits for
 * `ready` before sending `run`, so starting the bridge only after `run` arrives would deadlock
 * both sides). Call {@link McpBridge.setBridgedTools} once `run` arrives, before spawning `claude`.
 *
 * @param onToolCallRequest - Called with `(requestId, toolName, args)` for every `CallTool` the
 *   bridge accepts; the caller (`wrapper.ts`) forwards this as a `tool_call_request` `WrapperEvent`
 *   to the adapter and eventually calls `resolveToolCall` with the adapter's answer.
 */
export const startMcpBridge = async (
  onToolCallRequest: (requestId: string, toolName: string, args: unknown) => void
): Promise<McpBridge> => {
  const pending = new Map<string, PendingCall>()
  let nextRequestId = 0
  let bridgedTools: WrapperBridgedTool[] = []

  const server = new Server({ name: 'adk_bridge', version: '1' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: bridgedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    if (!bridgedTools.some((t) => t.name === name)) {
      // Defense-in-depth: this should be unreachable in practice, since `bridgedTools` was
      // already filtered by the adapter before it ever reached this process — but re-check
      // anyway rather than trusting that invariant blindly.
      return {
        content: [{ type: 'text', text: `Tool "${name}" is not available in this session.` }],
        isError: true,
      }
    }
    const requestId = String(nextRequestId++)
    const result = await new Promise<{
      content: Array<Record<string, unknown>>
      isError?: boolean
    }>((resolve) => {
      pending.set(requestId, { resolve })
      onToolCallRequest(requestId, name, request.params.arguments)
    })
    return result
  })

  // NOT `sessionIdGenerator: undefined` ("stateless" mode). Confirmed directly against the
  // installed SDK (@modelcontextprotocol/sdk@1.29.0): `WebStandardStreamableHTTPServerTransport`
  // throws "Stateless transport cannot be reused across requests. Create a new transport per
  // request." on the SECOND request a stateless transport ever handles (source:
  // server/webStandardStreamableHttp.js's `_hasHandledRequest` guard in `handleRequest`) — every
  // `ListTools`/`CallTool` after the very first over the bridge's lifetime would 500. A single
  // wrapper-lifetime session id (scoped to one dispatch iteration, discarded with the process) is
  // what "stateless across DISPATCHES" (Decision D) actually requires here, not a stateless
  // transport in the SDK's own sense.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })

  // Settling a pending call (`resolveToolCall`/`rejectPending`'s `entry.resolve(...)`, below) only
  // unblocks the SDK's OWN internal handler-completion Promise — the actual `transport.send()` call
  // that flushes the JSON-RPC response over the wire happens several microtask turns later, inside
  // the SDK's own `.then(handler).then(send)` chain (`shared/protocol.js`'s `_onrequest`). Confirmed
  // by direct reproduction: calling `closeTransport()` immediately after `rejectPending()` (no gap)
  // silently drops the very response `rejectPending()` just produced — the caller's `CallTool`
  // promise then never settles. Wrapping `send` here to track every in-flight call is what lets
  // `closeTransport()` (below) drain them first, a real fix rather than a fixed-delay guess.
  const inFlightSends = new Set<Promise<unknown>>()
  const originalSend = transport.send.bind(transport)
  transport.send = ((...args: Parameters<typeof originalSend>) => {
    const sent = originalSend(...args)
    inFlightSends.add(sent)
    void sent.finally(() => inFlightSends.delete(sent))
    return sent
  }) as typeof transport.send

  await server.connect(transport)

  const httpServer: HttpServer = createHttpServer((req, res) => {
    void transport.handleRequest(req, res)
  })

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('MCP bridge HTTP listener did not bind to a port'))
        return
      }
      resolve(address.port)
    })
  })

  return {
    port,
    setBridgedTools(tools) {
      bridgedTools = tools
    },
    resolveToolCall(requestId, result) {
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      entry.resolve(result)
    },
    rejectPending(reason) {
      for (const [requestId, entry] of pending) {
        pending.delete(requestId)
        entry.resolve({ content: [{ type: 'text', text: reason }], isError: true })
      }
    },
    async closeTransport() {
      // A call `resolveToolCall`/`rejectPending` just settled has NOT yet reached
      // `transport.send()` at the instant those methods return — the SDK's own handler-completion
      // chain needs at least one more event-loop turn to get there (see the `inFlightSends`
      // remark above), so `inFlightSends` can still be empty here even though a send is about to
      // start. Yield one turn first, then drain whatever is actually in flight, repeating briefly
      // in case draining itself lets a further queued send begin — bounded so a genuinely stuck
      // send can't hang shutdown forever.
      await new Promise<void>((resolve) => setImmediate(resolve))
      for (let i = 0; i < 5; i++) {
        const snapshot = Array.from(inFlightSends)
        if (snapshot.length === 0) break
        await Promise.allSettled(snapshot)
      }
      await transport.close()
    },
    async closeHttpServer() {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
