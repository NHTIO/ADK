import { Tool } from '@nhtio/adk/forge'
import { validator } from '@nhtio/validation'
import { classifySandboxPathRejection } from './paths'
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { SpooledArtifact } from '@nhtio/adk/spooled_artifact'
import { runToolGate, type ToolGateFn } from '../tools/_shared'
import { E_TURN_GATE_ABORTED } from '../../lib/exceptions/runtime'
import { defaultSandboxNarrator, type SandboxNarrator, type SandboxOutcome } from './narrator'
import {
  E_SANDBOX_GATE_REQUIRED,
  E_SANDBOX_REFUSED,
  E_SANDBOX_FAILED,
  E_SANDBOX_NETWORK_GRANT_UNSUPPORTED,
} from './exceptions'
import type { SandboxPolicy } from './types'
import type { PathTranslator } from './contracts/path_translator'
import type { SandboxPolicyEnforcer } from './contracts/policy_enforcer'

/**
 * What one `run_shell_command` invocation actually did.
 *
 * @remarks
 * The structured completion for {@link createRunShellCommandTool}'s `onCompletion` callback.
 * Deliberately issued once per invocation, on EVERY terminal outcome — a clean exit, a non-zero
 * exit, a timeout, a kill, a gate/approval denial, and an enforcer throw all settle this — because
 * the audit seam exists precisely so a denied or killed command is not indistinguishable from a
 * successful one.
 *
 * Field rules:
 * - `exitCode` is the child's real exit status, or `null` when the command never ran (a gate
 *   denial, a path refusal, a spawn failure) or its exit status is unknowable.
 * - `failed` is `true` for every outcome that is not a successful zero exit, INCLUDING denials,
 *   timeouts, killed children, enforcer errors, and a per-call `policy` function that failed.
 *   `exitCode !== 0` implies `failed`, and so do outcomes with `exitCode: null`.
 * - `timedOut` marks the `timeout_seconds` deadline firing (`exitCode` is then `null` or the killed
 *   child's status, depending on whether `completed` settled).
 * - `killedBy` names the signal that ACTUALLY terminated the child instead of letting it exit,
 *   read from the real child settlement (Node's `signalCode`), e.g. `'SIGKILL'` when the enforcer
 *   kills the process group on a timeout. Absent when the child exited on its own (a clean exit, a
 *   non-zero exit, or a timeout it won by exiting before the kill landed).
 * - `denied` marks a refusal BEFORE the command ran (a gate denial, a path/gate/allow-list
 *   refusal) — no child was spawned.
 * - `diagnostics` carries everything the enforcer reported (`diagnosticsFor`, the `[sandbox]
 *   denied: …` lines) plus, for a handler failure, the thrown value's message — including a per-call
 *   `policy` function that threw or rejected, which fires this completion before the error surfaces.
 *   Empty usually.
 * - `artifactRef` names the returned {@link SpooledArtifact}'s correlation id — the same id the
 *   spool store keyed the stream under — so an audit sink can join the completion to the artifact.
 *   It is present whenever the run reached the enforcer, including an enforcer throw (its id still
 *   keys any diagnostics recorded for that run). It is absent for the very first refusals (those
 *   throw before any stream exists) and a throwing per-call `policy` (it fails before a stream is
 *   opened).
 *
 * The tool's own return type is UNCHANGED: it still resolves to the artifact. This type travels
 * only through the callback, so existing consumers keep compiling.
 */
export interface RunShellCommandCompletion {
  /** The child's real exit status; `null` when the command never ran or never reported one. */
  readonly exitCode: number | null
  /** `true` for every non-success outcome, including denials, timeouts, kills, and enforcer throws. */
  readonly failed: boolean
  /** Whether the `timeout_seconds` deadline fired and terminated the command. */
  readonly timedOut: boolean
  /** The signal that actually killed the child instead of letting it exit, when one did, e.g. `'SIGKILL'`. */
  readonly killedBy?: string
  /** Whether the command was refused before spawning (gate denial, path refusal, allow-list). */
  readonly denied?: boolean
  /** Enforcer diagnostics (`[sandbox] denied: …` lines) and, on a handler failure, its message. */
  readonly diagnostics: readonly string[]
  /** The spool store correlation id backing the invocation's returned artifact, when one exists. */
  readonly artifactRef?: string
}

/** Consumer-supplied completion observer; errors it throws are contained, never propagated. */
export type RunShellCommandCompletionFn = (completion: RunShellCommandCompletion) => void

/** The per-call context handed to a {@link RunShellCommandPolicyFn}. */
export interface RunShellCommandPolicyContext {
  /** The validated tool arguments (`command`, `cwd`, `timeout_seconds`) for this call. */
  readonly args: { command: string; cwd: string; timeout_seconds: number }
  /** The resolved workspace-relative `cwd` this call will run under. */
  readonly relativeCwd: string
}

/**
 * A policy resolved PER CALL rather than captured at construction.
 *
 * @remarks
 * Evaluated once per invocation, AFTER the gate has approved and AFTER `cwd` has passed the path
 * gauntlet, and its return value is passed to `enforcer.run` for that one child only — a policy
 * object captured at construction would keep a revoked grant alive forever. A per-call policy must
 * hand the ENFORCER a fresh object per call (`{ ...basePolicy }` at minimum): the enforcer stores
 * what it is handed, so a shared mutable object collapses concurrent runs back into one shared
 * policy.
 *
 * There is NO gate decision in the context. `ToolGateFn` approves with `void` and denies by
 * THROWING, and a thrown denial returns before this callback runs — so at the moment a policy is
 * resolved there is no approval artefact to hand over, and a denied call never reaches here.
 */
export type RunShellCommandPolicyFn = (
  context: RunShellCommandPolicyContext
) => SandboxPolicy | Promise<SandboxPolicy>

/** Configuration for the streaming shell-command tool. */
export interface RunShellCommandOptions {
  /** Streaming policy enforcer; unlike BinaryExecutor this exposes live stdout/stderr. */
  readonly sandbox: SandboxPolicyEnforcer
  /**
   * Policy applied to the spawned command: a static object for every call, or a per-call function.
   *
   * @remarks
   * A function is evaluated once per invocation, AFTER the gate has approved and after `cwd` has
   * passed the path gauntlet, and receives the call context (the validated tool args and the
   * resolved workspace-relative `cwd`). Its return is the policy for that ONE child — see
   * {@link RunShellCommandPolicyFn} for the fresh-object rule under concurrency.
   */
  readonly policy: SandboxPolicy | RunShellCommandPolicyFn
  /** Model-path translator for the working directory. */
  readonly translator: PathTranslator
  /** Required human/policy approval gate. */
  readonly gate?: ToolGateFn
  /**
   * Optional command-name allow-list; restricts the line to a single plain command.
   * Operators, pipes, redirection, grouping, backticks, all `$` expansion, and backslashes
   * are refused even inside quotes. The first word must be unquoted; argument quotes are allowed.
   * This is a name check, not a security boundary: the sandbox policy remains the boundary.
   */
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
  /**
   * Called exactly once per invocation with the structured completion, on EVERY terminal outcome.
   *
   * @remarks
   * Success, non-zero exit, timeout, kill/signal, gate/approval denial, and an enforcer throw all
   * settle this once — see {@link RunShellCommandCompletion} for the field rules. A callback that
   * throws is logged and swallowed: it must never break the tool call or surface as an unhandled
   * rejection (the issue-#39 bug class).
   */
  readonly onCompletion?: RunShellCommandCompletionFn
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
      .allow('')
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
      // Emitted EXACTLY ONCE per invocation, on every terminal outcome. The denied/pre-spawn and
      // enforcer-throw paths deliberately fire it too: this seam exists so those outcomes are
      // structured data instead of "no artifact arrived". A throwing observer is contained — its
      // failure must not replace the refusal/exception the caller is already receiving, and a raw
      // rejection escaping into the dispatch core is the issue-#39 bug class.
      let completionDone = false
      const emitCompletion = async (completion: RunShellCommandCompletion): Promise<void> => {
        if (completionDone) return
        completionDone = true
        if (!options.onCompletion) return
        try {
          await options.onCompletion(completion)
        } catch (error) {
          // Swallowed by design (see the option's docblock). `String` can itself throw, so the
          // message is assembled defensively.
          let detail: string
          try {
            detail = isError(error) ? error.message : String(error)
          } catch {
            detail = '<uncoercible>'
          }
          console.error(`[run_shell_command] onCompletion threw and was ignored: ${detail}`)
        }
      }
      const currentDiagnostics = (correlationId?: string): readonly string[] =>
        correlationId === undefined ? [] : [...options.sandbox.diagnosticsFor(correlationId)]
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
        await emitCompletion({
          exitCode: null,
          failed: true,
          timedOut: false,
          denied: true,
          diagnostics: currentDiagnostics(),
        })
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
        await emitCompletion({
          exitCode: null,
          failed: true,
          timedOut: false,
          denied: true,
          diagnostics: currentDiagnostics(),
        })
        throw new E_SANDBOX_FAILED([
          narrate({
            kind: 'path-rejected',
            input: args.cwd,
            reason: classifySandboxPathRejection(args.cwd) ?? 'escape',
          }),
        ])
      }
      // Only spaces and tabs separate shell words. JS `\s` also splits Unicode whitespace
      // that sh treats as part of the executable name, so it is not safe for this name check.
      const commandName = args.command.replace(/^[ \t]+/, '').split(/[ \t]/, 1)[0]
      // Conservative by design: do not interpret quoting. Even quoted metacharacters are refused,
      // as are all `$` expansions and backslashes (including escaped/continued command names).
      // Argument quotes remain useful, but the executable word itself must be plain and literal.
      const refusedSyntax = options.allowedCommands
        ? (args.command.match(/[;&|`$<>(){}\r\n\\]/)?.[0] ?? commandName.match(/['"]/)?.[0])
        : undefined
      if (
        options.allowedCommands &&
        (refusedSyntax !== undefined || !options.allowedCommands.includes(commandName))
      ) {
        await emitCompletion({
          exitCode: null,
          failed: true,
          timedOut: false,
          denied: true,
          diagnostics: currentDiagnostics(),
        })
        throw new E_SANDBOX_REFUSED([
          refusedSyntax !== undefined
            ? `Shell syntax ${JSON.stringify(refusedSyntax)} is refused: allowedCommands restricts the line to a single plain command (unquoted command name; no operators, pipes, substitution, expansion, redirection, grouping, or backslashes, even inside quotes).`
            : narrate({
                kind: 'denied-by-policy',
                path: commandName,
                axis: 'read',
              }),
        ])
      }
      // Resolve the policy for THIS call. A function is evaluated after the gate and the cwd
      // gauntlet (a revoked grant is then gone on the very next call, and the per-call context is
      // complete), and must be handed a fresh object per call, or concurrent runs would share one
      // mutable policy. Resolution sits INSIDE the completion seam: a throwing or rejecting policy
      // function is a terminal outcome like any other, so it fires `onCompletion` exactly once with
      // a failed completion and then rethrows the SAME error the caller saw before this seam existed.
      let resolvedPolicy: SandboxPolicy
      try {
        resolvedPolicy =
          typeof options.policy === 'function'
            ? await options.policy({ args, relativeCwd: relative })
            : options.policy
      } catch (error) {
        await emitCompletion({
          exitCode: null,
          failed: true,
          timedOut: false,
          diagnostics: [isError(error) ? error.message : String(error)],
        })
        throw error
      }
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
        // `command` is a real shell command LINE — `printf hello`, a pipe, quoting, redirection —
        // so it must reach a shell's `-c` as ONE argument. The enforcer quotes whatever `argv` it
        // receives (`quoteShellArgs(op.argv)`), so handing it `argv: [args.command]` made it quote
        // the whole line as a single word: the shell then looked for an executable literally named
        // `printf hello`, and every command with arguments exited 127. Wrapping the line in an
        // explicit `sh -c` makes the enforcer's argv contract correct — it receives a real command
        // with a real argument, which it can quote safely — instead of teaching every enforcer a
        // second "unquoted command" mode. `/bin/sh` is the POSIX shell present on every platform
        // SRT supports (macOS and Linux); SRT owns the outer shell (`binShell`) that invokes it.
        execution = await options.sandbox.run({
          argv: ['/bin/sh', '-c', args.command],
          policy: resolvedPolicy,
          correlationId,
          cwd: options.translator.toBackendPath(relative),
          signal: controller.signal,
          ...(options.env === undefined ? {} : { env: { ...options.env } }),
        })
      } catch (error) {
        clearTimeout(timeout)
        const outcome = (error as { outcome?: SandboxOutcome }).outcome
        // SRT refuses a divergent per-call network section BEFORE spawning. Preserve this
        // actionable typed admission error, not arbitrary untyped backend failures.
        const networkRefused = isInstanceOf(
          error,
          'E_SANDBOX_NETWORK_GRANT_UNSUPPORTED',
          E_SANDBOX_NETWORK_GRANT_UNSUPPORTED
        )
        await emitCompletion({
          exitCode: null,
          failed: true,
          timedOut: false,
          denied: networkRefused || outcome?.kind === 'denied-by-policy' ? true : undefined,
          diagnostics: [
            ...(isError(error) ? [error.message] : [String(error)]),
            ...currentDiagnostics(correlationId),
          ],
          artifactRef: correlationId,
        })
        if (networkRefused) throw error
        if (outcome?.kind === 'denied-by-policy') throw new E_SANDBOX_REFUSED([narrate(outcome)])
        throw new E_SANDBOX_FAILED([
          narrate({
            kind: 'io-failure',
            detail: isError(error) ? error.message : String(error),
          }),
        ])
      }
      const storeWrite = Promise.resolve(ctx.storeRetrievableBytes(correlationId, merged))
      // Observe immediately: the store can reject while drains/poller are still running.
      // Keep the original promise so the terminal path below rethrows the SAME error.
      void storeWrite.catch(() => {})
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
      let drainError: unknown
      try {
        await Promise.all([drain(execution.stdout), drain(execution.stderr)])
        completed = await execution.completed
      } catch (error) {
        drainError = error
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
      if (drainError !== undefined) {
        // A post-spawn I/O failure (a stream erroring mid-drain) also settles the completion: the
        // child may have run, so it is a failed, non-denied outcome rather than a silent rejection.
        await emitCompletion({
          exitCode: completed?.exitCode ?? null,
          failed: true,
          timedOut: timerFired,
          diagnostics: [
            ...(isError(drainError) ? [drainError.message] : [String(drainError)]),
            ...currentDiagnostics(correlationId),
          ],
        })
        throw drainError
      }
      let reader: Awaited<typeof storeWrite>
      try {
        reader = await storeWrite
      } catch (error) {
        await emitCompletion({
          exitCode: completed?.exitCode ?? null,
          failed: true,
          timedOut: timerFired,
          diagnostics: [
            ...(isError(error) ? [error.message] : [String(error)]),
            ...currentDiagnostics(correlationId),
          ],
        })
        throw error
      }
      // The tool's return type is unchanged (the artifact); the completion travels only through the
      // callback. `killedBy` is the signal that ACTUALLY terminated the child, taken from the real
      // settlement (`completed.signalCode`, Node's `ChildProcess.signalCode`), NOT from the abort
      // REASON we wrote onto the controller: on a timeout the reason is an `AbortError` while the
      // enforcer runs `process.kill(-pid, 'SIGKILL')`, so reading the reason reported `'AbortError'`
      // for a child killed with SIGKILL (issue #49 follow-up). It is reported only when the child was
      // actually signal-killed; a normal exit has no `killedBy`. `timerFired` alone is not enough —
      // the child can win the race and exit cleanly — so the signal is the sole source of truth.
      const killedBy = completed?.signalCode ?? undefined
      await emitCompletion({
        exitCode: completed?.exitCode ?? null,
        failed: completed ? completed.failed : timerFired,
        timedOut: timerFired,
        ...(killedBy === undefined ? {} : { killedBy }),
        diagnostics: currentDiagnostics(correlationId),
        artifactRef: correlationId,
      })
      return new SpooledArtifact(reader)
    },
  })
}
