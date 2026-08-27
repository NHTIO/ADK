import { execa } from 'execa'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * Exercises the standalone wrapper process end-to-end: the real BUILT `dist/claude-code-cli-wrapper.mjs`
 * asset (never the TS source — see `claude_code_cli_wrapper_resolves.node.spec.ts` for why the
 * built location matters), driven exactly as `adapter.ts` drives it
 * (`execa(process.execPath, [wrapperPath])`), with the `claude` grandchild replaced by
 * `tests/_fixtures/claude_code_cli/fake_claude.mjs` — a REAL subprocess, since OS
 * process-group/signal semantics (Decision D) cannot be exercised by any in-process fake.
 *
 * The wrapper only initiates its OWN shutdown on a terminal `result` line (Decision D step 5) —
 * any other terminal condition (grandchild exit with no result, a hung grandchild) leaves the
 * wrapper waiting for the ADAPTER to send `shutdown`, exactly as `adapter.ts`'s own
 * `gracefulShutdown()` does. Every harness helper below either drives a real `result` to
 * completion or explicitly sends `shutdown`/a signal — a test that does neither would hang for
 * the wrapper's own lack of self-termination, not a test bug.
 */
const distDir = join(__dirname, '../../../../../dist')
const wrapperPath = join(distDir, 'claude-code-cli-wrapper.mjs')
const fakeClaudePath = join(__dirname, '../../../../_fixtures/claude_code_cli/fake_claude.mjs')
const distBuilt = existsSync(wrapperPath)

type WireEvent = Record<string, unknown>

/** A thin harness around one spawned wrapper subprocess: NDJSON-framed event capture + command send. */
class WrapperHarness {
  readonly child: ReturnType<typeof execa>
  readonly events: WireEvent[] = []
  #buffer = ''
  #waiters: Array<{ predicate: (e: WireEvent) => boolean; resolve: (e: WireEvent) => void }> = []

  constructor(env: Record<string, string | undefined> = {}) {
    this.child = execa(process.execPath, [wrapperPath], {
      cleanup: true,
      reject: false,
      env: { ...process.env, ...env },
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.#onData(chunk))
  }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf-8')
    let idx = this.#buffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.#buffer.slice(0, idx)
      this.#buffer = this.#buffer.slice(idx + 1)
      idx = this.#buffer.indexOf('\n')
      if (line.trim().length === 0) continue
      let parsed: WireEvent
      try {
        parsed = JSON.parse(line) as WireEvent
      } catch {
        continue
      }
      this.events.push(parsed)
      this.#waiters = this.#waiters.filter((w) => {
        if (w.predicate(parsed)) {
          w.resolve(parsed)
          return false
        }
        return true
      })
    }
  }

  waitFor(predicate: (e: WireEvent) => boolean, timeoutMs = 8_000): Promise<WireEvent> {
    const already = this.events.find(predicate)
    if (already) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.resolve !== resolve)
        reject(new Error(`timed out waiting for event matching predicate after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#waiters.push({
        predicate,
        resolve: (e) => {
          clearTimeout(timer)
          resolve(e)
        },
      })
    })
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(command)}\n`)
  }

  async waitForExit(): Promise<{ exitCode: number | null; signal: string | null }> {
    return (await this.child) as unknown as { exitCode: number | null; signal: string | null }
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.child.kill(signal)
  }
}

/** Default stream-json lines: a normal init + a normal terminal success result. */
const defaultFakeClaudeLines = (): Array<Record<string, unknown>> => [
  { type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] },
  { type: 'result', is_error: false, result: 'ok', session_id: 's1' },
]

const baseRunCommand = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'run',
  prompt: 'test prompt',
  model: 'claude-sonnet-5',
  allowedTools: [],
  auth: { apiKey: 'sk-test' },
  claudeBin: fakeClaudePath,
  forwardSubagentText: false,
  unsupportedResultMediaPolicy: 'throw',
  bridgedTools: [],
  ...overrides,
})

/** Extracts the bridge's `http://127.0.0.1:<port>/` URL from a logged fake-claude argv array. */
const extractBridgeUrl = (argv: string[]): string => {
  const idx = argv.indexOf('--mcp-config')
  if (idx === -1) throw new Error('--mcp-config not found in argv')
  const config = JSON.parse(argv[idx + 1]!) as {
    mcpServers: { adk_bridge: { url: string } }
  }
  return config.mcpServers.adk_bridge.url
}

const activeHarnesses: WrapperHarness[] = []
const activeTmpFiles: string[] = []

afterEach(async () => {
  for (const h of activeHarnesses) {
    h.kill('SIGKILL')
    await h.waitForExit().catch(() => undefined)
  }
  activeHarnesses.length = 0
  for (const f of activeTmpFiles) {
    if (existsSync(f)) unlinkSync(f)
  }
  activeTmpFiles.length = 0
})

const spawnHarness = (env: Record<string, string | undefined> = {}): WrapperHarness => {
  const h = new WrapperHarness(env)
  activeHarnesses.push(h)
  return h
}

const tmpFile = (name: string): string =>
  join(tmpdir(), `claude-code-cli-wrapper-spec-${randomUUID()}-${name}`)

const trackTmpFile = (path: string): string => {
  activeTmpFiles.push(path)
  return path
}

/**
 * Spawns a wrapper, sends `run` with the given overrides against `fakeClaudePath` (which by
 * default emits `defaultFakeClaudeLines()` and then exits cleanly — a real terminal `result`),
 * waits for the wrapper's own self-initiated shutdown, and returns the parsed argv log plus the
 * harness (already awaited to exit). This is the common path for every pure argv-construction
 * assertion, where the fake grandchild's own behavior is irrelevant beyond "reaches a normal
 * result".
 */
const runToCompletionAndReadArgv = async (
  overrides: Record<string, unknown> = {}
): Promise<string[]> => {
  const argvLog = trackTmpFile(tmpFile('argv.json'))
  const h = spawnHarness({
    FAKE_CLAUDE_ARGV_LOG: argvLog,
    FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
  })
  await h.waitFor((e) => e.type === 'ready')
  h.send(baseRunCommand(overrides))
  await h.waitFor((e) => e.type === 'shutdown_complete')
  await h.waitForExit()
  return JSON.parse(readFileSync(argvLog, 'utf-8')) as string[]
}

describe.skipIf(!distBuilt)('claude_code_cli wrapper — argv construction (Decision F0)', () => {
  it('includes --tools "" and --dangerously-skip-permissions unconditionally', async () => {
    const argv = await runToCompletionAndReadArgv()
    const toolsIdx = argv.indexOf('--tools')
    expect(toolsIdx).toBeGreaterThanOrEqual(0)
    expect(argv[toolsIdx + 1]).toBe('')
    expect(argv).toContain('--dangerously-skip-permissions')
  })

  it('includes --allowedTools with the mcp__adk_bridge__-prefixed comma-joined names when bridgedTools is non-empty', async () => {
    const argv = await runToCompletionAndReadArgv({
      allowedTools: ['search_docs', 'lookup_user'],
      bridgedTools: [
        { name: 'search_docs', description: 'd', inputSchema: { type: 'object', properties: {} } },
        { name: 'lookup_user', description: 'd', inputSchema: { type: 'object', properties: {} } },
      ],
    })
    const idx = argv.indexOf('--allowedTools')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('mcp__adk_bridge__search_docs,mcp__adk_bridge__lookup_user')
  })

  it('OMITS --allowedTools entirely when bridgedTools is empty (never emitted with no following value)', async () => {
    const argv = await runToCompletionAndReadArgv({ allowedTools: [], bridgedTools: [] })
    expect(argv).not.toContain('--allowedTools')
  })

  it('fallbackModel: [a, b] produces exactly ["--fallback-model", "a,b"], never separate tokens', async () => {
    const argv = await runToCompletionAndReadArgv({ fallbackModel: ['a', 'b'] })
    const idx = argv.indexOf('--fallback-model')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe('a,b')
    expect(argv).not.toContain('a')
    expect(argv).not.toContain('b')
  })

  it('appendSystemPrompt produces --append-system-prompt <value> exactly once', async () => {
    const argv = await runToCompletionAndReadArgv({ appendSystemPrompt: 'be terse' })
    const occurrences = argv.filter((a) => a === '--append-system-prompt').length
    expect(occurrences).toBe(1)
    const idx = argv.indexOf('--append-system-prompt')
    expect(argv[idx + 1]).toBe('be terse')
  })

  it('--max-turns is included when maxTurns is set and omitted when absent', async () => {
    const argvWith = await runToCompletionAndReadArgv({ maxTurns: 5 })
    const idx = argvWith.indexOf('--max-turns')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argvWith[idx + 1]).toBe('5')

    const argvWithout = await runToCompletionAndReadArgv()
    expect(argvWithout).not.toContain('--max-turns')
  })

  it('the -- separator precedes the positional prompt', async () => {
    const argv = await runToCompletionAndReadArgv({ prompt: 'the actual prompt text' })
    expect(argv[argv.length - 2]).toBe('--')
    expect(argv[argv.length - 1]).toBe('the actual prompt text')
  })
})

describe.skipIf(!distBuilt)('claude_code_cli wrapper — extraArgs injection-safety matrix', () => {
  it.each([
    { flag: '--effort', value: 'high' },
    { flag: '--agent', value: 'coder' },
    { flag: '--betas', value: ['beta-a', 'beta-b'] },
    { flag: '--json-schema', value: '{"type":"object"}' },
    { flag: '--name', value: 'session-1' },
    { flag: '--prompt-suggestions' },
  ])('an allowlisted extraArgs entry %j produces the expected argv fragment', async (entry) => {
    const argv = await runToCompletionAndReadArgv({ extraArgs: [entry] })
    const idx = argv.indexOf(entry.flag)
    expect(idx).toBeGreaterThanOrEqual(0)
    if ('value' in entry && entry.value !== undefined) {
      if (Array.isArray(entry.value)) {
        expect(argv.slice(idx + 1, idx + 1 + entry.value.length)).toEqual(entry.value)
      } else {
        expect(argv[idx + 1]).toBe(entry.value)
      }
    }
  })
})

describe.skipIf(!distBuilt)('claude_code_cli wrapper — env construction', () => {
  it('forwards apiKey as ANTHROPIC_API_KEY on the grandchild and clears an ambient ANTHROPIC_AUTH_TOKEN', async () => {
    const envLog = trackTmpFile(tmpFile('env.json'))
    const h = spawnHarness({
      ANTHROPIC_AUTH_TOKEN: 'ambient-leftover-token',
      FAKE_CLAUDE_ENV_LOG: envLog,
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand({ auth: { apiKey: 'sk-explicit' } }))
    await h.waitFor((e) => e.type === 'shutdown_complete')
    await h.waitForExit()

    const grandchildEnv = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>
    expect(grandchildEnv.ANTHROPIC_API_KEY).toBe('sk-explicit')
    expect(grandchildEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
  })

  it('forwards authToken as ANTHROPIC_AUTH_TOKEN and clears an ambient ANTHROPIC_API_KEY', async () => {
    const envLog = trackTmpFile(tmpFile('env.json'))
    const h = spawnHarness({
      ANTHROPIC_API_KEY: 'ambient-leftover-key',
      FAKE_CLAUDE_ENV_LOG: envLog,
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand({ auth: { authToken: 'tok-explicit' }, apiKey: undefined }))
    await h.waitFor((e) => e.type === 'shutdown_complete')
    await h.waitForExit()

    const grandchildEnv = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>
    expect(grandchildEnv.ANTHROPIC_AUTH_TOKEN).toBe('tok-explicit')
    expect(grandchildEnv.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it('mcpToolIdleTimeoutMs maps to CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT, never a CLI flag', async () => {
    const envLog = trackTmpFile(tmpFile('env.json'))
    const argvLog = trackTmpFile(tmpFile('argv.json'))
    const h = spawnHarness({
      FAKE_CLAUDE_ENV_LOG: envLog,
      FAKE_CLAUDE_ARGV_LOG: argvLog,
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand({ mcpToolIdleTimeoutMs: 12_345 }))
    await h.waitFor((e) => e.type === 'shutdown_complete')
    await h.waitForExit()

    const grandchildEnv = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>
    expect(grandchildEnv.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe('12345')
    const argv = JSON.parse(readFileSync(argvLog, 'utf-8')) as string[]
    expect(argv.join(' ')).not.toContain('12345')
  })
})

describe.skipIf(!distBuilt)('claude_code_cli wrapper — bounded grandchild-exit wait', () => {
  it('tolerates a grandchild that keeps running briefly after writing its terminal result line', async () => {
    const releaseFile = trackTmpFile(tmpFile('release'))
    const h = spawnHarness({
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
      // The default fixture exits immediately after its lines; to model "keeps running briefly
      // after the terminal result", make emitting the result line and exiting two separate
      // phases gated on a file the test controls, with a short delay in between.
      FAKE_CLAUDE_WAIT_FOR_FILE: releaseFile,
      FAKE_CLAUDE_LINES_AFTER: JSON.stringify([]),
      FAKE_CLAUDE_EXIT_DELAY_MS: '300',
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    await h.waitFor((e) => e.type === 'init')
    // The `result` line was part of FAKE_CLAUDE_LINES (emitted immediately at startup), but the
    // fixture then blocks on releaseFile before its own exit — modeling "wrote a terminal result
    // but the OS process hasn't exited yet." Release it now; the wrapper must wait (bounded) for
    // the actual exit rather than treating the written line as synonymous with process exit.
    await h.waitFor((e) => e.type === 'result')
    writeFileSync(releaseFile, '1')
    await h.waitFor((e) => e.type === 'shutdown_complete')
    const exit = await h.waitForExit()
    expect(exit.exitCode).toBe(0)
  })
})

describe.skipIf(!distBuilt)('claude_code_cli wrapper — happy path + exit code', () => {
  it('process.exitCode is 0 on success and the process exits naturally (no explicit process.exit(0) on this path)', async () => {
    const h = spawnHarness({
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    await h.waitFor((e) => e.type === 'result')
    await h.waitFor((e) => e.type === 'shutdown_complete')
    const { exitCode, signal } = await h.waitForExit()
    expect(exitCode).toBe(0)
    expect(signal).toBeFalsy()
  })
})

describe.skipIf(!distBuilt)(
  'claude_code_cli wrapper — shutdown-order regression (in-flight tools/call + open SSE stream)',
  () => {
    it('rejects the pending call, THEN closes the transport (SSE cleanup), THEN the HTTP listener, with no hang', async () => {
      const argvLog = trackTmpFile(tmpFile('argv.json'))
      const h = spawnHarness({
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_HANG: '1',
        FAKE_CLAUDE_LINES: JSON.stringify([
          { type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] },
        ]),
      })
      await h.waitFor((e) => e.type === 'ready')
      h.send(
        baseRunCommand({
          bridgedTools: [
            {
              name: 'slow_tool',
              description: 'd',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        })
      )
      await h.waitFor((e) => e.type === 'init')

      const argv = JSON.parse(readFileSync(argvLog, 'utf-8')) as string[]
      const bridgeUrl = extractBridgeUrl(argv)

      // Open a real SSE stream (GET) alongside a real in-flight tools/call (POST) — both must be
      // settled/cleaned up during shutdown, in the corrected order (Decision D step 5).
      const transport = new StreamableHTTPClientTransport(new URL(bridgeUrl))
      const client = new Client({ name: 'test-client', version: '1.0' })
      await client.connect(transport)

      const callPromise = client.callTool({ name: 'slow_tool', arguments: {} })
      // Give the request a tick to actually reach the bridge's pending map before we tear down.
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Trigger the wrapper's own shutdown sequence via SIGTERM (the same corrected sequence used
      // on the normal-completion path).
      h.kill('SIGTERM')

      const callResult = await callPromise
      expect(callResult.isError).toBe(true)

      const exit = await h.waitForExit()
      expect(exit.exitCode).toBe(0)

      await client.close().catch(() => undefined)
    }, 15_000)
  }
)

describe.skipIf(!distBuilt)('claude_code_cli wrapper — process group + signal handling', () => {
  it('spawns the grandchild detached in its own process group; SIGTERM to the wrapper kills that group', async () => {
    const h = spawnHarness({
      FAKE_CLAUDE_HANG: '1',
      FAKE_CLAUDE_LINES: JSON.stringify([
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] },
      ]),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    await h.waitFor((e) => e.type === 'init')

    // Give the grandchild a moment to actually be running.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await execa('pgrep', ['-f', 'fake_claude.mjs'], { reject: false })
    expect(before.stdout.trim().length).toBeGreaterThan(0)

    h.kill('SIGTERM')
    const exit = await h.waitForExit()
    expect(exit.exitCode).toBe(0)

    // Give the OS a moment to reap.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = await execa('pgrep', ['-f', 'fake_claude.mjs'], { reject: false })
    expect(after.stdout.trim()).toBe('')
  }, 15_000)
})
