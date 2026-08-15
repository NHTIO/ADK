import { Tool } from '@nhtio/adk/forge'
import { validator } from '@nhtio/validation'
import { classifySandboxPathRejection } from './paths'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { SpooledArtifact } from '@nhtio/adk/spooled_artifact'
import { runToolGate, type ToolGateFn } from '../tools/_shared'
import { E_TURN_GATE_ABORTED } from '../../lib/exceptions/runtime'
import { E_SANDBOX_GATE_REQUIRED, E_SANDBOX_REFUSED, E_SANDBOX_FAILED } from './exceptions'
import { defaultSandboxNarrator, type SandboxNarrator, type SandboxOutcome } from './narrator'
import type { SandboxPolicy } from './types'
import type { PathTranslator } from './contracts/path_translator'
import type { SandboxPolicyEnforcer } from './contracts/policy_enforcer'

/** Configuration for the streaming shell-command tool. */
export interface RunShellCommandOptions {
  /** Streaming policy enforcer; unlike BinaryExecutor this exposes live stdout/stderr. */
  readonly sandbox: SandboxPolicyEnforcer
  /** Policy applied to the spawned command. */
  readonly policy: SandboxPolicy
  /** Model-path translator for the working directory. */
  readonly translator: PathTranslator
  /** Required human/policy approval gate. */
  readonly gate?: ToolGateFn
  /** Optional command-name allow-list. */
  readonly allowedCommands?: readonly string[]
  /**
   * Environment variables to add to every command this tool spawns.
   *
   * @remarks
   * ADDITIVE, and applied LAST — over both the host variables the enforcer allow-listed and SRT's own
   * proxy/CA plumbing. It is not the host-inheritance control: the enforcer decides what the child
   * inherits (`envAllowList` / `inheritHostEnv` on the Node adapter), and this cannot re-admit a
   * variable the enforcer withheld except by supplying the value literally here.
   *
   * Anything put here is readable by the model — `run_shell_command` runs commands the model chose,
   * and `env` is one of them — so pass configuration, not credentials.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Optional tool description override. */
  readonly description?: string
  /** Injectable model-facing outcome renderer. */
  readonly narrate?: SandboxNarrator
}

const encoder = new TextEncoder()
const line = (value: string): Uint8Array => encoder.encode(`${value}\n`)

/**
 * Assemble the factory-style `run_shell_command` tool. It is intentionally not a bulk-registered
 * battery value. `cwd` is a model-supplied workspace-relative path and receives the complete
 * PathTranslator gauntlet, including symlink refusal; the default is the workspace root.
 *
 * The command spawns first, then stdout and stderr are drained concurrently and merged in arrival
 * order into one stream and one `storeRetrievableBytes` call. Diagnostics are polled while drains
 * run and written as `[sandbox] denied: …` at their observation point ("observed after", not
 * "caused by"). The command is never accumulated here. `timeout_seconds` defaults to 300 and is
 * a tool argument. Non-zero exits, violations, timeouts, and post-spawn I/O failures return the
 * singular artifact; failures meaning the command never ran throw instead.
 */
export const createRunShellCommandTool = (options: RunShellCommandOptions): Tool => {
  if (!options.gate) throw new E_SANDBOX_GATE_REQUIRED(['run_shell_command requires a gate'])
  const inputSchema = validator.object({
    command: validator.string().required().description('Shell command to execute.'),
    cwd: validator
      .string()
      .default('')
      .description('Workspace-relative working directory; defaults to the workspace root.'),
    timeout_seconds: validator
      .number()
      .min(1)
      .default(300)
      .description('Command timeout in seconds; defaults to 300. Raise it for slow commands.'),
  })
  return new Tool({
    name: 'run_shell_command',
    description:
      options.description ??
      'Run a shell command under the sandbox. Output is one interleaved artifact; sandbox denials appear inline. cwd is workspace-relative and timeout_seconds defaults to 300.',
    inputSchema,
    trusted: false,
    handler: async (raw, ctx) => {
      const args = raw as {
        command: string
        cwd: string
        timeout_seconds: number
      }
      const narrate = options.narrate ?? defaultSandboxNarrator
      try {
        await runToolGate(options.gate, ctx, 'run_shell_command', args)
      } catch (error) {
        if (isInstanceOf(error, 'E_TURN_GATE_ABORTED', E_TURN_GATE_ABORTED)) {
          if (ctx.abortSignal.aborted) throw error
          throw new E_SANDBOX_FAILED([narrate({ kind: 'aborted' })])
        }
        const outcome =
          (error as { outcome?: SandboxOutcome; kind?: string }).outcome ??
          ((error as { kind?: string }).kind === 'gate-declined'
            ? ({ kind: 'gate-declined' } satisfies SandboxOutcome)
            : undefined)
        if (outcome?.kind === 'gate-declined') throw new E_SANDBOX_REFUSED([narrate(outcome)])
        throw new E_SANDBOX_REFUSED([narrate({ kind: 'gate-unavailable', reason: 'error' })])
      }
      let relative: string
      try {
        // NO pre-emptive leading-`/` rejection. The model's world IS the sandbox, so `/src/index.ts`
        // means "top of what I can see" and must NORMALISE to the root — rejecting it punishes the
        // model for a distinction we deliberately hid, and produces the mangle-retry loop the
        // LLM-operator rules exist to prevent. `toRelative` owns the whole gauntlet, `~` included.
        relative = await options.translator.toRelative(args.cwd)
        await options.translator.assertNoSymlinkComponents(relative)
      } catch (error) {
        // An ALREADY-NARRATED refusal passes through: re-wrapping it would discard a more precise
        // outcome and relabel it `escape`.
        if (
          isInstanceOf(error, 'E_SANDBOX_REFUSED', E_SANDBOX_REFUSED) ||
          isInstanceOf(error, 'E_SANDBOX_FAILED', E_SANDBOX_FAILED)
        )
          throw error
        // And the REASON is classified, not assumed — `cwd` is the model-supplied path on the one
        // tool that runs arbitrary code, so "use a workspace-relative path" is the wrong advice for
        // a NUL byte or a UNC form.
        throw new E_SANDBOX_FAILED([
          narrate({
            kind: 'path-rejected',
            input: args.cwd,
            reason: classifySandboxPathRejection(args.cwd) ?? 'escape',
          }),
        ])
      }
      const commandName = args.command.trim().split(/\s+/, 1)[0]
      if (options.allowedCommands && !options.allowedCommands.includes(commandName))
        throw new E_SANDBOX_REFUSED([
          narrate({
            kind: 'denied-by-policy',
            path: commandName,
            axis: 'read',
          }),
        ])
      const correlationId = crypto.randomUUID()
      const controller = new AbortController()
      const abort = (): void => controller.abort(ctx.abortSignal.reason)
      if (ctx.abortSignal.aborted) abort()
      else ctx.abortSignal.addEventListener('abort', abort, { once: true })
      let timerFired = false
      const timeout = setTimeout(() => {
        timerFired = true
        controller.abort()
      }, args.timeout_seconds * 1000)
      // A stream controller is captured without buffering any payload.
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
      const merged = new ReadableStream<Uint8Array>({
        start(mergedController) {
          streamController = mergedController
        },
      })
      const write = (bytes: Uint8Array): void => streamController?.enqueue(bytes)
      const close = (): void => streamController?.close()
      let execution: Awaited<ReturnType<SandboxPolicyEnforcer['run']>>
      try {
        // The policy enforcer owns the configured shell (including binShell); this is a shell
        // command payload, not a second shell selection made by the tool.
        const argv = [args.command]
        execution = await options.sandbox.run({
          argv,
          policy: options.policy,
          correlationId,
          cwd: options.translator.toBackendPath(relative),
          signal: controller.signal,
          ...(options.env === undefined ? {} : { env: { ...options.env } }),
        })
      } catch (error) {
        clearTimeout(timeout)
        const outcome = (error as { outcome?: SandboxOutcome }).outcome
        if (outcome?.kind === 'denied-by-policy') throw new E_SANDBOX_REFUSED([narrate(outcome)])
        throw new E_SANDBOX_FAILED([
          narrate({
            kind: 'io-failure',
            detail: isError(error) ? error.message : String(error),
          }),
        ])
      }
      const storeWrite = ctx.storeRetrievableBytes(correlationId, merged)
      const seen = new Set<string>()
      const poll = (): void => {
        for (const denial of options.sandbox.diagnosticsFor(correlationId)) {
          if (!seen.has(denial)) {
            seen.add(denial)
            // Redacted because a denial is upstream TEXT and routinely names an absolute host path —
            // the one line in this stream the battery authors from someone else's words. The exit-code
            // and timeout lines below are numbers this battery formats, so they carry nothing to scrub.
            // This does NOT extend to the child's own stdout, which no field translation can reach.
            write(line(`[sandbox] denied: ${options.translator.redact(denial)} (observed after)`))
          }
        }
      }
      const drain = async (source: ReadableStream<Uint8Array>): Promise<void> => {
        const reader = source.getReader()
        try {
          for (;;) {
            const item = await reader.read()
            if (item.done) return
            write(item.value)
            poll()
          }
        } finally {
          reader.releaseLock()
        }
      }
      let polling = true
      const poller = (async (): Promise<void> => {
        while (polling) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          if (polling) poll()
        }
      })()
      let completed: Awaited<typeof execution.completed> | undefined
      try {
        await Promise.all([drain(execution.stdout), drain(execution.stderr)])
        completed = await execution.completed
      } finally {
        clearTimeout(timeout)
        polling = false
        await poller
        poll()
        if (timerFired) write(line(`[timed out after ${args.timeout_seconds}s]`))
        else if (completed && completed.exitCode !== 0)
          write(line(`Exit code: ${completed.exitCode}`))
        close()
      }
      const reader = await storeWrite
      return new SpooledArtifact(reader)
    },
  })
}
