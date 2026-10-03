import { assertArgvValue, assertAllowedRipgrepFlag } from '../escape'
import type { HitFrame, PathFrame, SandboxPolicy } from '../types'
import type { SandboxPolicyEnforcer } from '../contracts/policy_enforcer'

/**
 * A classified ripgrep outcome.
 *
 * @remarks
 * CLASSIFICATION ORDER IS LOAD-BEARING: diagnostics are checked BEFORE the exit status, because `rg`
 * runs under the sandbox and a denied path surfaces as a non-zero exit *plus* a violation record.
 * Triage generically first and a policy refusal is permanently mislabelled `io-failure` — the model
 * is told "search broke" when the truth is "you may not read there", and `denied-by-policy` becomes
 * unreachable despite being in the tool's outcome list.
 *
 * `no-matches` is a RESULT, not an error: `rg` exits 1 when it ran correctly and matched nothing.
 */
export type RipgrepFailure =
  | { kind: 'denied-by-policy'; diagnostics: readonly string[] }
  | { kind: 'invalid-pattern'; message: string }
  | { kind: 'no-matches' }
  | { kind: 'io-failure'; message: string; exitCode: number }

/**
 * Convert a classified ripgrep failure into the error the searcher throws.
 *
 * @remarks
 * Exhaustive by construction: a new {@link RipgrepFailure} arm is a compile error here rather than
 * a silently generic message. `denied-by-policy` carries its diagnostics into the message — the
 * classification is checked BEFORE the generic exit-code triage precisely so a policy refusal is
 * not mislabelled `io-failure`, and flattening it back to a bare exit code here would discard the
 * only thing that makes that ordering worth having.
 *
 * @param failure - A classified failure other than `no-matches`, which is a result, not an error.
 * @returns The error to throw.
 */
const toRipgrepError = (failure: Exclude<RipgrepFailure, { kind: 'no-matches' }>): Error => {
  switch (failure.kind) {
    case 'denied-by-policy':
      return new Error(`denied-by-policy: ${failure.diagnostics.join('; ')}`)
    case 'invalid-pattern':
      return new Error(failure.message)
    case 'io-failure':
      return new Error(failure.message || `ripgrep exited ${failure.exitCode}`)
  }
}

const bytes = new TextDecoder()
const collect = async (
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<void> => {
  const reader = stream.getReader()
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      onText(bytes.decode(next.value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Validate an explicit `limit`, permitting full omission (unbounded).
 *
 * @remarks
 * Issue #48: the contract previously mandated `limit: number` and the adapter rejected everything
 * but a positive integer, so an UNBOUNDED search was inexpressible — the searcher forced a cap, and
 * `Number.MAX_SAFE_INTEGER` is a disguised one. Omission is now the documented unbounded mode: no
 * post-collection cap, the scan finishes `complete: true`. An EXPLICIT value must still be a positive
 * integer — `0`, negatives, non-integers, `Infinity` and `NaN` remain rejections, so a caller cannot
 * accidentally disable the bound they named.
 *
 * @param limit - The requested limit, or `undefined` for unbounded.
 * @returns The validated limit, or `undefined` when unbounded.
 */
export const resolveSearchLimit = (limit: number | undefined): number | undefined => {
  if (limit === undefined) return undefined
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('limit must be a positive integer, or omitted for an unbounded search')
  return limit
}

/**
 * Emit `--max-depth N` only when a depth was EXPLICITLY requested.
 *
 * @remarks
 * Issue #48: the adapter emitted this flag unconditionally, so omitting `maxDepth` produced the
 * literal argv `--max-depth undefined`, rg exited 2, and every omitted-depth search failed. Omission
 * now means unbounded — rg's own behaviour — and the flag is simply not emitted.
 *
 * @param maxDepth - The requested depth, or `undefined` for unbounded.
 * @returns The flag pair, or an empty array when unbounded.
 */
export const resolveMaxDepthArgv = (maxDepth: number | undefined): readonly string[] => {
  if (maxDepth === undefined) return []
  if (!Number.isInteger(maxDepth) || maxDepth < 0)
    throw new Error('maxDepth must be a non-negative integer, or omitted for an unbounded scan')
  return ['--max-depth', String(maxDepth)]
}

/** Stop yielding after `limit` items; `undefined` never stops. */
const wantMore = (shown: number, limit: number | undefined): boolean =>
  limit === undefined || shown < limit

/** Ripgrep backend. Both child pipes are drained immediately and concurrently. */
export const createRipgrepSearch = (
  enforcer: SandboxPolicyEnforcer,
  policy: SandboxPolicy
): {
  searchContent(o: {
    root: string
    pattern: string
    /** Omit for an unbounded scan (no `--max-depth`); an explicit integer sets the boundary. */
    maxDepth?: number
    /** Omit for no result cap: every match is returned and the scan finishes `complete: true`. Note
     * the whole scan is buffered before results are yielded, so an unbounded search over a very
     * large tree uses memory in proportion to the output — pass a `limit` where that matters. */
    limit?: number
    ignoreCase?: boolean
    literal?: boolean
    glob?: string
    iglob?: string
    follow?: boolean
    hidden?: boolean
    noIgnore?: boolean
    signal?: AbortSignal
  }): AsyncIterable<HitFrame>
  findPaths(o: {
    root: string
    glob: string
    /** Omit for an unbounded scan (no `--max-depth`); an explicit integer sets the boundary. */
    maxDepth?: number
    /** Omit for no result cap: every match is returned and the scan finishes `complete: true`. Note
     * the whole scan is buffered before results are yielded, so an unbounded search over a very
     * large tree uses memory in proportion to the output — pass a `limit` where that matters. */
    limit?: number
    iglob?: string
    follow?: boolean
    hidden?: boolean
    noIgnore?: boolean
    signal?: AbortSignal
  }): AsyncIterable<PathFrame>
} => {
  const run = async (argv: string[], cwd: string, signal?: AbortSignal) => {
    const correlationId = `${crypto.randomUUID()}-${Date.now().toString(36)}`
    const spawned = await enforcer.run({ argv, cwd, policy, correlationId, signal })
    let out = ''
    let err = ''
    const stdout = collect(spawned.stdout, (chunk) => {
      out += chunk
    })
    const stderr = collect(spawned.stderr, (chunk) => {
      err += chunk
    })
    const [, , completed] = await Promise.all([stdout, stderr, spawned.completed])
    const diagnostics = enforcer.diagnosticsFor(correlationId)
    const exitCode = completed.exitCode
    if (diagnostics.length > 0)
      return { failure: { kind: 'denied-by-policy', diagnostics } as RipgrepFailure, out, err }
    if (exitCode === 2 && err.startsWith('regex parse error'))
      return { failure: { kind: 'invalid-pattern', message: err } as RipgrepFailure, out, err }
    if (exitCode === 1) return { failure: { kind: 'no-matches' } as RipgrepFailure, out, err }
    if (exitCode !== 0)
      return { failure: { kind: 'io-failure', message: err, exitCode } as RipgrepFailure, out, err }
    return { failure: undefined, out, err }
  }
  /**
   * Defence-in-depth check that this adapter only ever emits flags it declared.
   *
   * @remarks
   * Scans the WHOLE argv rather than a fixed index window: the previous `slice(1, 5)` silently depended
   * on argv layout, so adding or reordering an argument moved the window off the flags. It also stops at
   * `--`, because everything after the terminator is a model-supplied VALUE — a pattern like `--foo` is
   * a legitimate search string there, not a flag, and `assertArgvValue` already owns that half.
   */
  const assertAdapterFlags = (argv: readonly string[]): void => {
    for (const arg of argv.slice(1)) {
      if (arg === '--') break
      if (arg.startsWith('--')) assertAllowedRipgrepFlag(arg)
    }
  }
  return {
    async *searchContent(o) {
      const limit = resolveSearchLimit(o.limit)
      if (o.follow)
        throw new Error('follow is refused: descendant symlink containment audit pending')
      const argv = [
        'rg',
        '--json',
        ...(o.ignoreCase ? ['--ignore-case'] : []),
        ...(o.literal ? ['--fixed-strings'] : []),
        ...(o.glob ? ['--glob', assertArgvValue(o.glob)] : []),
        ...(o.iglob ? ['--iglob', assertArgvValue(o.iglob)] : []),
        ...(o.hidden ? ['--hidden'] : []),
        ...(o.noIgnore ? ['--no-ignore'] : []),
        ...resolveMaxDepthArgv(o.maxDepth),
        '--',
        assertArgvValue(o.pattern),
        assertArgvValue(o.root),
      ]
      assertAdapterFlags(argv)
      const result = await run(argv, o.root, o.signal)
      if (result.failure) {
        if (result.failure.kind === 'no-matches') {
          yield { kind: 'done', complete: true }
          return
        }
        throw toRipgrepError(result.failure)
      }
      let shown = 0
      let overLimit = false
      for (const line of result.out.split('\n')) {
        if (!line) continue
        try {
          const item = JSON.parse(line) as {
            type: string
            data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
          }
          if (
            item.type === 'match' &&
            item.data?.path?.text &&
            item.data.line_number &&
            item.data.lines
          ) {
            if (!wantMore(shown, limit)) {
              overLimit = true
              break
            }
            yield {
              kind: 'item',
              path: item.data.path.text,
              line: item.data.line_number,
              text: item.data.lines.text ?? '',
            }
            shown++
          }
        } catch {
          /* malformed rg diagnostics are an I/O failure in the real adapter */
        }
      }
      yield overLimit
        ? { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown }
        : { kind: 'done', complete: true }
    },
    async *findPaths(o) {
      const limit = resolveSearchLimit(o.limit)
      if (o.follow)
        throw new Error('follow is refused: descendant symlink containment audit pending')
      const argv = [
        'rg',
        '--files',
        '--glob',
        assertArgvValue(o.glob),
        ...(o.iglob ? ['--iglob', assertArgvValue(o.iglob)] : []),
        ...(o.hidden ? ['--hidden'] : []),
        ...(o.noIgnore ? ['--no-ignore'] : []),
        ...resolveMaxDepthArgv(o.maxDepth),
        '--',
        assertArgvValue(o.root),
      ]
      assertAdapterFlags(argv)
      const result = await run(argv, o.root, o.signal)
      if (result.failure) {
        if (result.failure.kind === 'no-matches') {
          yield { kind: 'done', complete: true }
          return
        }
        throw toRipgrepError(result.failure)
      }
      let shown = 0
      let overLimit = false
      for (const path of result.out.split('\n')) {
        if (!path) continue
        if (!wantMore(shown, limit)) {
          overLimit = true
          break
        }
        yield { kind: 'item', path }
        shown++
      }
      yield overLimit
        ? { kind: 'done', complete: false, omitted: 'over-limit', bound: 'limit', shown }
        : { kind: 'done', complete: true }
    },
  }
}
