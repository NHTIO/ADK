import { execa } from 'execa'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
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

  it('always emits the fixed single-turn cap regardless of options', async () => {
    for (const options of [{ maxTurns: 1 }, {}]) {
      const argv = await runToCompletionAndReadArgv(options)
      const idx = argv.indexOf('--max-turns')
      expect(idx).toBeGreaterThanOrEqual(0)
      expect(argv[idx + 1]).toBe('1')
    }
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

  it('strips ELECTRON_RUN_AS_NODE and its own marker var from the grandchild when the marker is present (issue #42 defect #3)', async () => {
    // The wrapper's OWN env (not the grandchild's) carries both vars here — mirroring exactly how
    // `adapter.ts` injects them onto the wrapper itself when it detects an Electron host, per
    // Part C. `buildClaudeEnv` starts from `{ ...process.env }` (the WRAPPER's own env) before
    // constructing the grandchild's, so setting these on the spawned wrapper process (via
    // `spawnHarness`'s env, not a `run` command field) is the correct way to simulate that
    // injected condition.
    const envLog = trackTmpFile(tmpFile('env.json'))
    const h = spawnHarness({
      ELECTRON_RUN_AS_NODE: '1',
      ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD: '1',
      FAKE_CLAUDE_ENV_LOG: envLog,
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    await h.waitFor((e) => e.type === 'shutdown_complete')
    await h.waitForExit()

    const grandchildEnv = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>
    // Neither the stray var nor the wrapper-internal marker that gates stripping it should ever
    // reach the `claude` grandchild — the marker specifically, because it is purely an
    // adapter-to-wrapper signal with no meaning to `claude` itself, and would otherwise leak as an
    // unexplained ambient env var on every Electron-hosted run.
    expect(grandchildEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(grandchildEnv.ADK_CLAUDE_CODE_CLI_STRIP_RUN_AS_NODE_FROM_GRANDCHILD).toBeUndefined()
  })

  it('leaves an ambient ELECTRON_RUN_AS_NODE untouched when the marker is absent (a consumer-set var, not adapter-injected)', async () => {
    // Without the marker, this is presumed to be a consumer's own ambient env var for an unrelated
    // reason (see the source comment on `buildClaudeEnv`) — stripping it unconditionally would be
    // a surprising, undocumented behavior change for such a consumer.
    const envLog = trackTmpFile(tmpFile('env.json'))
    const h = spawnHarness({
      ELECTRON_RUN_AS_NODE: '1',
      FAKE_CLAUDE_ENV_LOG: envLog,
      FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    await h.waitFor((e) => e.type === 'shutdown_complete')
    await h.waitForExit()

    const grandchildEnv = JSON.parse(readFileSync(envLog, 'utf-8')) as Record<string, string>
    expect(grandchildEnv.ELECTRON_RUN_AS_NODE).toBe('1')
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
  it("process.exitCode is 0 on success and the process exits via shutdownNormally's own explicit process.exit(0) after the flush barrier (issue #42, part A)", async () => {
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

  it("forwards Claude's result subtype to the emitted wrapper result event", async () => {
    const h = spawnHarness({
      FAKE_CLAUDE_LINES: JSON.stringify([
        { type: 'result', subtype: 'error_max_turns', is_error: true },
      ]),
    })
    await h.waitFor((e) => e.type === 'ready')
    h.send(baseRunCommand())
    const result = await h.waitFor((e) => e.type === 'result')
    expect(result.subtype).toBe('error_max_turns')
    expect(result.isError).toBe(true)
    await h.waitFor((e) => e.type === 'shutdown_complete')
  })
})

describe.skipIf(!distBuilt)(
  'claude_code_cli wrapper — explicit exit survives a non-draining event loop (issue #42, part A)',
  () => {
    // `keep_alive_preload.cjs` installs a bare `setInterval` that never clears itself — on its
    // own, this keeps Node's event loop alive forever, exactly the symptom an Electron main
    // process exhibits (an open BrowserWindow, a live timer, an open server socket the HOST owns,
    // none of it under this wrapper's own control) without needing a real Electron binary in CI.
    // Loaded via `NODE_OPTIONS=--require`, it affects ONLY the spawned wrapper process below, not
    // this test file's own process. Before issue #42's part A fix, `shutdownNormally` fell off the
    // end of its own async function without ever calling `process.exit(0)` — fine in a host whose
    // loop drains on its own, but exactly the case that hangs here.
    const preloadPath = join(
      __dirname,
      '../../../../_fixtures/claude_code_cli/keep_alive_preload.cjs'
    )

    it('exits 0 with a full shutdown_complete round-trip even though something else is keeping the event loop alive', async () => {
      const h = spawnHarness({
        FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
        NODE_OPTIONS: `--require ${preloadPath}`,
      })
      await h.waitFor((e) => e.type === 'ready')
      h.send(baseRunCommand())
      await h.waitFor((e) => e.type === 'result')
      await h.waitFor((e) => e.type === 'shutdown_complete')
      const { exitCode, signal } = await h.waitForExit()
      expect(exitCode).toBe(0)
      expect(signal).toBeFalsy()
    })
  }
)

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

describe.skipIf(!distBuilt)(
  'claude_code_cli wrapper — backstop stays armed through the flush barrier (issue #42 defect #2)',
  () => {
    // Both tests below deliberately never read the wrapper's own stdout past the point they
    // detect `ready` — leaving that pipe's OS buffer to fill is exactly how a real backpressured
    // or closed reader looks from the wrapper's side, and neither test can use `WrapperHarness`
    // (which always attaches its own draining `stdout.on('data', ...)` listener) for this reason.
    // Both use `node:child_process.spawn` directly rather than `execa`, because `execa`'s own
    // returned promise does not settle until its OWN stdout stream reaches 'end' — which never
    // happens while this test is deliberately not draining it — whereas the raw `ChildProcess`'s
    // `'exit'` event fires independently of whether anything is reading its stdout, which is the
    // signal every assertion below actually needs.

    const spawnWrapper = (env: Record<string, string | undefined> = {}): ReturnType<typeof spawn> =>
      spawn(process.execPath, [wrapperPath], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

    /** Reads stdout in paused mode just long enough to observe one `ready` event, then stops reading entirely (leaving the pipe's OS buffer to fill on every subsequent write). */
    const waitForReadyThenStopReading = (child: ReturnType<typeof spawn>): Promise<void> =>
      new Promise((resolve) => {
        let buffer = ''
        let settled = false
        const onReadable = (): void => {
          if (settled) return
          const chunk = child.stdout?.read() as Buffer | null
          if (!chunk) return
          buffer += chunk.toString('utf-8')
          if (buffer.includes('"type":"ready"')) {
            settled = true
            child.stdout?.off('readable', onReadable)
            resolve()
          }
        }
        child.stdout?.on('readable', onReadable)
      })

    it('a wrapper whose flush barrier never resolves still force-exits via the backstop, not the normal 0-exit path (ordering regression)', async () => {
      // This test targets the ORDERING of `disarmBackstop()` relative to
      // `await waitForPendingWrites()` specifically — not general backpressure. An earlier draft
      // tried to induce this by flooding stdin with malformed commands to fill the real OS pipe
      // buffer, but that flood also backs up `runShutdownSequence`'s OWN
      // `await writeEvent({ type: 'shutdown_complete' })` call, which sits BEFORE either the
      // pre-fix or post-fix `disarmBackstop()` position — so that version of the test hung on an
      // earlier, unrelated line in both the fixed and reverted source, and its GREEN result did
      // not actually discriminate the ordering fix (confirmed empirically: it stayed GREEN even
      // against the reverted, pre-fix anchor).
      //
      // issue #42 round-2 defect #2: the previous mechanism (`ADK_CLAUDE_CODE_CLI_TEST_HOLD_PENDING_WRITE`)
      // was a test-only env hook baked into the PUBLISHED wrapper source — removed entirely. This
      // now holds one wrapper-TRACKED write open forever from OUTSIDE the wrapper, via a
      // `NODE_OPTIONS=--require` preload (`tests/_fixtures/claude_code_cli/stuck_flush_preload.cjs`,
      // same loading mechanism as `keep_alive_preload.cjs` above) that monkey-patches
      // `process.stdout.write` in the spawned wrapper process only: it waits for the first write
      // whose payload is a wrapper-emitted `log` event, passes those bytes through for real, but
      // withholds the CALLBACK the wrapper itself is waiting on — forever. Sending one malformed
      // (non-JSON) line over the wrapper's stdin below reliably triggers exactly one such `log`
      // write (wrapper.ts's NDJSON command reader calls the fire-and-forget
      // `log('trace', 'malformed-command', ...)` on a parse failure), which is itself a
      // `pendingWriteCount`-tracked `writeEvent(...)` call like every other wrapper write. Because
      // its callback never fires, `pendingWriteCount` never returns to zero, so
      // `waitForPendingWrites()` (called later, from `shutdownNormally`, once a real `shutdown`
      // command triggers `runShutdownSequence`) can never resolve on its own — isolating exactly
      // the moment that flush barrier is stuck, which is the only way to tell whether the backstop
      // is still armed at that point without racing real OS pipe capacity.
      const preloadPath = join(
        __dirname,
        '../../../../_fixtures/claude_code_cli/stuck_flush_preload.cjs'
      )
      const child = spawnWrapper({
        NODE_OPTIONS: `--require ${preloadPath}`,
      })
      try {
        await waitForReadyThenStopReading(child)

        // Not valid NDJSON — the wrapper's command reader fails to `JSON.parse` this line and
        // emits the fire-and-forget `log('trace', 'malformed-command', ...)` write the preload is
        // waiting to intercept.
        child.stdin?.write('this is not json\n')
        child.stdin?.write(`${JSON.stringify({ type: 'shutdown' })}\n`)

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('wrapper did not exit within the 8s bound — backstop did not fire'))
            }, 8_000)
            child.once('exit', (code, signal) => {
              clearTimeout(timer)
              resolve({ code, signal })
            })
          }
        )

        // The backstop's own exit path is `process.exitCode = 1; process.exit(1)` — distinct
        // from the normal path's `process.exitCode = 0; process.exit(0)`. Exit code 1 here is
        // proof the BACKSTOP fired despite `waitForPendingWrites()` never resolving on its own —
        // which is only possible if the backstop is still armed at that point (the fix); if
        // `disarmBackstop()` ran before the flush-barrier await (the bug), this would hang
        // forever instead, since nothing else in this path can force an exit.
        expect(exit.code).toBe(1)
      } finally {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, 12_000)

    it('a closed-read-end (EPIPE) on stdout mid-turn does not crash the process, and it still exits (not hangs)', async () => {
      const child = spawnWrapper({
        FAKE_CLAUDE_LINES: JSON.stringify(defaultFakeClaudeLines()),
      })
      try {
        await new Promise<void>((resolve) => {
          let buffer = ''
          const onReadable = (): void => {
            const chunk = child.stdout?.read() as Buffer | null
            if (!chunk) return
            buffer += chunk.toString('utf-8')
            if (buffer.includes('"type":"ready"')) {
              child.stdout?.off('readable', onReadable)
              // Destroy OUR OWN read end of the pipe now — every subsequent write the wrapper
              // makes to its stdout will raise a real EPIPE at the OS level. This is the exact
              // condition issue #42 defect #2 identifies: an unhandled 'error' event (or,
              // pre-fix, an unhandled promise rejection from `writeEvent`'s own promise) crashes
              // the process with exit code 1 instead of exiting cleanly.
              child.stdout?.destroy()
              resolve()
            }
          }
          child.stdout?.on('readable', onReadable)
        })

        let sawStderrCrash = false
        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf-8')
          // A Node uncaught-exception crash always prints this frame; an intentionally
          // stderr-logged non-EPIPE write error (the fix's own diagnostic path) never does.
          if (text.includes('triggerUncaughtException') || text.includes('Error: write EPIPE')) {
            sawStderrCrash = true
          }
        })

        const runCommand = baseRunCommand({
          claudeBin: fakeClaudePath,
        })
        child.stdin?.write(`${JSON.stringify(runCommand)}\n`)

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error('wrapper did not exit within the 8s bound'))
            }, 8_000)
            child.once('exit', (code, signal) => {
              clearTimeout(timer)
              resolve({ code, signal })
            })
          }
        )

        expect(sawStderrCrash).toBe(false)
        // Exit code 0: the normal-completion path, not the backstop's exit(1) — an EPIPE must
        // not even trip the backstop's alternate path, since nothing about it should hang.
        expect(exit.code).toBe(0)
      } finally {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, 12_000)
  }
)

describe.skipIf(!distBuilt)(
  'claude_code_cli wrapper — message-id race across lines in one stdout chunk (issue #43, fix B HIGH regression)',
  () => {
    it('two distinct assistant messages, a tool_use line in between, all delivered to the wrapper in ONE stdout chunk, get TWO distinct message_delta ids, each completed exactly once, in input order', async () => {
      // Every line below is written by `fake_claude.mjs` in a SINGLE `stdout.write()` call (see
      // that fixture's updated `emitLines`), so the wrapper's own `createNdjsonLineReader` sees
      // them as one chunk and its callback fires for all four lines synchronously, back to back,
      // before any of their handlers has had a chance to `await` anything — exactly the shape
      // that exposed the original fix-B race (unawaited `void handleClaudeLine(line)`: a second
      // line's handler could interleave with the first's still-pending `await writeEvent(...)`
      // and observe/reset shared id-state out of order). `message_delta`/`writeEvent` itself does
      // a real (fast) `process.stdout.write` per event, which already introduces its own
      // between-await scheduling — sufficient in practice to have reproduced the race against the
      // pre-fix wrapper without needing any artificial delay.
      const lines = [
        { type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: [] },
        // First complete assistant message (no preceding stream_event delta) — claims wrapper-local
        // id "message-0".
        {
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: 'first message text' }] },
        },
        // A stream_event delta belonging to the SECOND message, immediately following the first's
        // complete line in the very same chunk — pre-fix, this is where the race lived: the first
        // line's handler resets its shared state AFTER an `await`, and this second line's handler
        // could run its own synchronous prefix first and read the STALE (not-yet-reset) id.
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second ' } },
        },
        // The second message's own complete line, sealing it.
        {
          type: 'assistant',
          message: { id: 'm2', content: [{ type: 'text', text: 'second message text' }] },
        },
        { type: 'result', is_error: false, result: 'second message text', session_id: 's1' },
      ]

      const h = spawnHarness({
        FAKE_CLAUDE_LINES: JSON.stringify(lines),
      })
      await h.waitFor((e) => e.type === 'ready')
      h.send(baseRunCommand())
      await h.waitFor((e) => e.type === 'shutdown_complete')
      await h.waitForExit()

      const deltaEvents = h.events.filter(
        (e): e is WireEvent & { id: string; isComplete?: boolean } => e.type === 'message_delta'
      )
      expect(deltaEvents.length).toBeGreaterThanOrEqual(2)

      const completeEvents = deltaEvents.filter((e) => e.isComplete === true)
      // Exactly two DISTINCT messages were sealed complete — not one id reused/collided into a
      // single completion, and not one message silently dropped.
      expect(completeEvents).toHaveLength(2)
      const completeIds = completeEvents.map((e) => e.id)
      expect(new Set(completeIds).size).toBe(2)

      // The two sealed ids appear in the SAME order the input lines did: the message carrying
      // "first message text" was claimed and sealed strictly before the one carrying "second ".
      // Pre-fix, the race could make the second message's delta/seal reuse the first's id instead
      // of minting its own, or reorder which one is observed as sealed first.
      const firstDeltaIdxById = new Map<string, number>()
      deltaEvents.forEach((e, idx) => {
        if (!firstDeltaIdxById.has(e.id)) firstDeltaIdxById.set(e.id, idx)
      })
      const orderedIds = [...firstDeltaIdxById.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id)
      expect(orderedIds).toEqual(completeIds)
    }, 15_000)
  }
)
