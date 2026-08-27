import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { startMcpBridge } from '../../../../../src/batteries/llm/claude_code_cli/mcp_bridge'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpBridge } from '../../../../../src/batteries/llm/claude_code_cli/mcp_bridge'

describe('claude_code_cli mcp_bridge', () => {
  let bridge: McpBridge | undefined
  let client: Client | undefined

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {})
      client = undefined
    }
    if (bridge) {
      bridge.rejectPending('test teardown')
      await bridge.closeTransport().catch(() => {})
      await bridge.closeHttpServer().catch(() => {})
      bridge = undefined
    }
  })

  const connectClient = async (port: number): Promise<Client> => {
    const url = new URL(`http://127.0.0.1:${port}/`)
    const transport = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test-client', version: '1.0' })
    await c.connect(transport)
    return c
  }

  it('lists only the tools currently set via setBridgedTools', async () => {
    bridge = await startMcpBridge(() => {})
    bridge.setBridgedTools([
      { name: 'echo_tool', description: 'echoes', inputSchema: { type: 'object', properties: {} } },
    ])
    client = await connectClient(bridge.port)
    const result = await client.listTools()
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]).toMatchObject({
      name: 'echo_tool',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {} },
    })
  })

  it('carries plain JSON-Schema inputSchema through untouched (no Zod object reaches the wire)', async () => {
    bridge = await startMcpBridge(() => {})
    const inputSchema = {
      type: 'object',
      properties: { text: { type: 'string' }, count: { type: 'number' } },
      required: ['text'],
    }
    bridge.setBridgedTools([{ name: 'tool_a', description: 'd', inputSchema }])
    client = await connectClient(bridge.port)
    const result = await client.listTools()
    expect(result.tools[0]?.inputSchema).toEqual(inputSchema)
  })

  it('lists an empty tool set when none have been set yet (boot-time state)', async () => {
    bridge = await startMcpBridge(() => {})
    client = await connectClient(bridge.port)
    const result = await client.listTools()
    expect(result.tools).toEqual([])
  })

  it('round-trips a real CallTool through onToolCallRequest/resolveToolCall', async () => {
    let capturedRequestId: string | undefined
    let capturedTool: string | undefined
    let capturedArgs: unknown
    bridge = await startMcpBridge((requestId, toolName, args) => {
      capturedRequestId = requestId
      capturedTool = toolName
      capturedArgs = args
      // Simulate the adapter answering asynchronously.
      setTimeout(() => {
        bridge?.resolveToolCall(requestId, {
          content: [{ type: 'text', text: `echoed:${JSON.stringify(args)}` }],
        })
      }, 5)
    })
    bridge.setBridgedTools([
      { name: 'echo_tool', description: 'echoes', inputSchema: { type: 'object', properties: {} } },
    ])
    client = await connectClient(bridge.port)
    const result = await client.callTool({ name: 'echo_tool', arguments: { text: 'hi' } })
    expect(capturedTool).toBe('echo_tool')
    expect(capturedArgs).toEqual({ text: 'hi' })
    expect(capturedRequestId).toBeDefined()
    expect(result.content).toEqual([{ type: 'text', text: 'echoed:{"text":"hi"}' }])
  })

  it('rejects a CallTool for a name absent from the pre-filtered bridgedTools list, WITHOUT ever invoking onToolCallRequest', async () => {
    const onToolCallRequest = vi.fn()
    bridge = await startMcpBridge(onToolCallRequest)
    bridge.setBridgedTools([
      { name: 'allowed_tool', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ])
    client = await connectClient(bridge.port)
    const result = await client.callTool({ name: 'disallowed_tool', arguments: {} })
    expect(result.isError).toBe(true)
    expect(onToolCallRequest).not.toHaveBeenCalled()
  })

  it('rejects pending calls with isError:true when rejectPending is invoked before resolution', async () => {
    bridge = await startMcpBridge(() => {
      // Deliberately never resolve — rejectPending must settle it instead.
    })
    bridge.setBridgedTools([
      { name: 'hang_tool', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ])
    client = await connectClient(bridge.port)
    const callPromise = client.callTool({ name: 'hang_tool', arguments: {} })
    // Give the request a tick to actually reach the pending map.
    await new Promise((resolve) => setTimeout(resolve, 10))
    bridge.rejectPending('shutting down')
    const result = await callPromise
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('shutting down')
  })

  it('resolveToolCall on an unknown/already-settled requestId is a silent no-op', async () => {
    bridge = await startMcpBridge(() => {})
    expect(() =>
      bridge?.resolveToolCall('never-existed', { content: [{ type: 'text', text: 'x' }] })
    ).not.toThrow()
  })

  it('throws when a low-level Server is constructed WITHOUT the tools capability and a tools handler is invoked', async () => {
    const server = new Server({ name: 'no_tools_cap', version: '1' }, { capabilities: {} })
    expect(() => {
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }))
    }).toThrow()
  })

  it('supports multiple sequential requests over the same bridge connection (regression: stateless-mode single-request bug)', async () => {
    bridge = await startMcpBridge((requestId) => {
      bridge?.resolveToolCall(requestId, { content: [{ type: 'text', text: 'ok' }] })
    })
    bridge.setBridgedTools([
      { name: 'multi_tool', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ])
    client = await connectClient(bridge.port)
    // Three requests in sequence over the same client/transport — a bridge that only supports a
    // single request per connection (the SDK's `sessionIdGenerator: undefined` "stateless" mode)
    // would 500 starting with the second of these.
    const first = await client.listTools()
    expect(first.tools).toHaveLength(1)
    const second = await client.callTool({ name: 'multi_tool', arguments: {} })
    expect(second.content).toEqual([{ type: 'text', text: 'ok' }])
    const third = await client.listTools()
    expect(third.tools).toHaveLength(1)
  })

  it('reflects a setBridgedTools update made after the client already connected', async () => {
    bridge = await startMcpBridge(() => {})
    client = await connectClient(bridge.port)
    const before = await client.listTools()
    expect(before.tools).toEqual([])
    bridge.setBridgedTools([
      { name: 'late_tool', description: 'd', inputSchema: { type: 'object', properties: {} } },
    ])
    const after = await client.listTools()
    expect(after.tools).toHaveLength(1)
    expect(after.tools[0]?.name).toBe('late_tool')
  })
})
