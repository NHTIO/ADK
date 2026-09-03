/**
 * Shared corpus material, derived from REAL CCRA review traffic on the LLM load balancer.
 *
 * PROVENANCE. Every shape here was taken from actual requests the CCRA review panel put on the
 * wire (selected by the review prompt's own tool vocabulary — `finish_review` for peer seats,
 * `submit_focus_areas` for the scout). Roles, tool names, turn depth, message ordering and the
 * two nudge/echo mechanisms are reproduced as observed. What is NOT reproduced verbatim is the
 * reviewed source code: diff bodies and file contents are replaced with short synthetic stand-ins,
 * because a corpus fixture should carry the SHAPE that drives ordering behaviour, not megabytes of
 * someone's codebase. Identifiers (MR numbers, branch names, file paths) are redacted to neutral
 * equivalents. What matters to an ordering rule — who spoke, in what order, carrying what metadata
 * — is preserved exactly.
 *
 * Real requests run 40KB–2.7MB across 20–200+ messages. These corpora keep the STRUCTURE and
 * compress the CONTENT, so a scenario stays a one-feature delta instead of a 200-message haystack
 * where a wire disagreement could have any of a dozen causes.
 */
import { msg, state, tc, thk, type OrderingTurnState } from './types'

// ─── Vocabulary observed in real CCRA traffic ─────────────────────────────────

/** Read-only investigation tools the review seats actually call. */
export const CCRA_TOOLS = {
  getFileDiff: 'get_file_diff',
  readFile: 'read_file',
  searchRepo: 'search_repo',
  artifactCat: 'artifact_cat',
  gitBlame: 'git_blame',
  /** The panel's terminal action; taking no arguments is enforced by the real tool. */
  finishReview: 'finish_review',
} as const

/** The review task the panel is actually given, condensed to one line. */
export const REVIEW_PROMPT =
  'Review the changed hunks in this merge request and report any correctness defects.'

/** A tool result, shortened. Real ones are whole file ranges; only the SHAPE matters here. */
const DIFF_RESULT = '@@ -12,7 +12,9 @@ export const parseRetryAfter = (raw: string): number => {'

// ─── The base turn: one investigation step, as the panel actually performs it ──

/**
 * The shape of a healthy CCRA turn: the seat is asked to review, reasons about where to look,
 * calls a read-only tool, and the turn ends ON THE TOOL RESULT so the model can continue.
 *
 * Observed tails on healthy responses were dominated by `assistant→tool→assistant→tool` — they
 * end on a tool result, never on a trailing assistant message.
 */
export const healthyReviewTurn = (): OrderingTurnState =>
  state(
    [msg('m1', 'user', 1, REVIEW_PROMPT)],
    [thk('t1', 2, 'The retry-after parser changed; check the overflow path.')],
    [
      tc('c1', 3, {
        tool: CCRA_TOOLS.getFileDiff,
        args: { path: 'src/retry.ts' },
        result: DIFF_RESULT,
      }),
    ]
  )

// ─── The two nudge mechanisms, reproduced verbatim in structure ───────────────

/**
 * CCRA's pathological-pattern notice. Fired when a seat repeats near-identical tool calls; the
 * harness appends a `user` notice AND re-appends the SAME TEXT as a trailing assistant thought.
 *
 * This duplication is the mechanism worth capturing: the request then ends `user → assistant`,
 * with the assistant turn containing nothing the model has not just been told.
 *
 * Observed: `P(empty generation | this marker present)` = 139/5442 = 2.55%, against a 0.95% base
 * rate across CCRA traffic — 2.7x enrichment.
 */
export const PATHOLOGICAL_NOTICE =
  'The last 3 calls to artifact_cat used near-identical arguments. Continuing requires ' +
  'declare_investigation_progress with why_repeating, looking_for, and stop_when.'

/**
 * CCRA's prose-echo nudge. Fired when a seat writes prose without calling a tool; the harness
 * re-appends that prose as a trailing assistant thought.
 *
 * Observed: `P(empty generation | this marker present)` = 78/932 = 8.37% — 8.8x base rate, the
 * strongest single predictor of an empty generation found in the traffic.
 */
export const PROSE_ECHO =
  'Let me get the rest of that file to find the class definition. ' +
  'I will use the artifact_cat tool with the correct parameters:'

/**
 * A turn ending `… → user(notice) → assistant(echo)` — the exact shape that precedes an empty
 * generation in production. The model is asked to continue after its own turn, having just been
 * handed back its own words.
 */
export const trailingEchoTurn = (echo: string = PROSE_ECHO): OrderingTurnState =>
  state(
    [
      msg('m1', 'user', 1, REVIEW_PROMPT),
      msg(
        'm2',
        'user',
        4,
        echo === PROSE_ECHO ? 'You wrote prose but called no tool.' : PATHOLOGICAL_NOTICE
      ),
      msg('m3', 'assistant', 5, echo),
    ],
    [],
    [
      tc('c1', 3, {
        tool: CCRA_TOOLS.artifactCat,
        args: { callId: 'call-1', start: 1, end: 60 },
        result: DIFF_RESULT,
      }),
    ]
  )

/** The same turn with the echo removed, so it ends on the tool result instead. */
export const trailingEchoRemovedTurn = (): OrderingTurnState =>
  state(
    [msg('m1', 'user', 1, REVIEW_PROMPT)],
    [],
    [
      tc('c1', 3, {
        tool: CCRA_TOOLS.artifactCat,
        args: { callId: 'call-1', start: 1, end: 60 },
        result: DIFF_RESULT,
      }),
    ]
  )
