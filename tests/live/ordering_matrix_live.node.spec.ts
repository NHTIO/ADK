/**
 * The WIRE half of the ordering-guard audit: for each rule, does the vendor agree the shape it
 * forbids is actually forbidden?
 *
 * The offline half (`tests/unit/batteries/validation/ordering_audit.cross.spec.ts`) proves the
 * corpus is a valid instrument — each violating leg trips its own rule and nothing else. This spec
 * takes the same legs to real models and records what happens.
 *
 * GATED on `TEST_ORDERING_MATRIX=1`; it costs real dispatches against a scoped LB key.
 *
 * EACH CELL SPEAKS ITS OWN NATIVE API. The first run of this matrix sent everything through one
 * OpenAI-compatible endpoint, which made several results meaningless: a gateway fronting a
 * non-OpenAI vendor must translate the request into that vendor's shape, and those translations
 * perform the very normalisations the rules check for (merging consecutive same-role turns for
 * Converse, injecting the thoughtSignature sentinel for Gemini). Those cells measured the
 * gateway's repair and reported it as the vendor tolerating a violation. Now a Converse cell
 * assembles through the Converse battery with `alternationPolicy: 'reject'`, and a Gemini cell
 * through the Gemini battery with `thoughtSignatureSentinel: false` — so the shape the rule forbids
 * reaches the vendor UNREPAIRED, which is the only way its verdict means anything.
 *
 * WHAT MAKES THIS AN HONEST MEASUREMENT
 *
 *  - The assembled request is captured and its role sequence asserted against what the scenario
 *    intended BEFORE the verdict counts, so a cell whose shape drifted is voided rather than
 *    silently measuring something else.
 *  - Verdicts are FOUR-valued. A 200 whose generation is empty is recorded as `empty`, not a pass.
 *    Transport failures are `void`: never a pass, never a fail.
 *  - A FAILING step 1 is a publishable result: if a vendor accepts the shape a rule forbids, the
 *    rule is unjustified and that is the finding. This spec RECORDS dispositions and asserts only
 *    the invariants that must hold for the run to mean anything.
 */
import { isError } from '@nhtio/adk/guards'
import { describe, expect, it } from 'vitest'
import { scenarioById } from '../_fixtures/ordering'
import { assembleNative } from '../_fixtures/ordering/native_dispatch'
import { MATRIX, classifyLeg, satisfies } from '../_fixtures/ordering/matrix'
import type { OrderingLeg, OrderingScenario } from '../_fixtures/ordering'
import type { CellResult, LegResult, MatrixCell } from '../_fixtures/ordering/matrix'

const env = (k: string): string | undefined =>
  typeof process !== 'undefined' ? process.env?.[k] : undefined

const RUN = env('TEST_ORDERING_MATRIX') === '1'
const LB_BASE = (env('TEST_ORDERING_BASE_URL') ?? '').replace(/\/v1$/, '')
const LB_KEY = env('TEST_ORDERING_API_KEY')
/** AWS Bedrock API key (`ABSK…`) — goes DIRECT to Bedrock, bypassing the LB entirely. */
const BEDROCK_KEY = env('TEST_ORDERING_BEDROCK_API_KEY')
const BEDROCK_BASE =
  env('TEST_ORDERING_BEDROCK_BASE_URL') ?? 'https://bedrock-runtime.us-east-1.amazonaws.com'
const ONLY = (env('TEST_ORDERING_ONLY') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/** Gap between dispatches; cells share credentials and unpaced bursts trip the LB auto-cooldown. */
const PACE_MS = Number(env('TEST_ORDERING_PACE_MS') ?? '1500')
/** Backoff before retrying a transport void; long enough to outlast a short cooldown. */
const VOID_BACKOFF_MS = Number(env('TEST_ORDERING_VOID_BACKOFF_MS') ?? '20000')

const GATED = RUN && LB_BASE.length > 0 && LB_KEY !== undefined

const cells = MATRIX.filter(
  (c) => c.via === 'lb' && (ONLY.length === 0 || ONLY.includes(c.scenario))
)

/** Where a cell's surface actually lives, and which credential reaches it. */
const endpointFor = (cell: MatrixCell): { base: string; key: string | undefined } => {
  // Bedrock has no HTTP passthrough on the LB (its translator uses the AWS SDK), so a Converse
  // cell goes direct to AWS with the Bedrock key — which also removes the gateway from the path.
  if (cell.surface === 'bedrock_converse') return { base: BEDROCK_BASE, key: BEDROCK_KEY }
  if (cell.surface === 'gemini_generate_content') return { base: `${LB_BASE}/gemini`, key: LB_KEY }
  // Bedrock Mantle: AWS's OpenAI-compatible inference endpoint, reached through the LB's
  // `/bedrock-mantle/*` passthrough. Unlike Converse it FORWARDS the body rather than reshaping it
  // per vendor, so a verdict here is about the model rather than a translator.
  if (cell.surface === 'bedrock_mantle') return { base: `${LB_BASE}/bedrock-mantle`, key: LB_KEY }
  // Some Mantle model families are served under an `/openai/v1` PREFIX rather than the bare `/v1`
  // — xai.grok-* among them. The catalog has no field expressing which, so it is per-model
  // configuration, and the unprefixed path answers with "isn't supported on this route".
  if (cell.surface === 'bedrock_mantle_openai') {
    return { base: `${LB_BASE}/bedrock-mantle/openai`, key: LB_KEY }
  }
  return { base: LB_BASE, key: LB_KEY }
}

/** Dispatch one leg through its own native surface. */
const dispatchLeg = async (cell: MatrixCell, leg: OrderingLeg): Promise<LegResult> => {
  const { body, url, wireRoles } = await assembleNative(cell, leg)
  const { base, key } = endpointFor(cell)
  let status = 0
  let errorText: string | undefined
  let json: Record<string, unknown> = {}

  try {
    const res = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    status = res.status
    const text = await res.text()
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      errorText = text.slice(0, 300)
    }
    if (status >= 400) {
      errorText = JSON.stringify(json.error ?? json.message ?? errorText ?? '').slice(0, 300)
    }
  } catch (err) {
    status = 0
    errorText = isError(err) ? err.message.slice(0, 200) : String(err)
  }

  // Each surface reports generation differently; normalise to (content, toolCall, tokens, reason).
  let hasContent = false
  let hasToolCall = false
  let completionTokens: number | undefined
  let finishReason: string | undefined

  if (cell.surface === 'bedrock_converse') {
    const blocks = ((
      json.output as { message?: { content?: Array<Record<string, unknown>> } } | undefined
    )?.message?.content ?? []) as Array<Record<string, unknown>>
    hasContent = blocks.some((b) => typeof b.text === 'string' && String(b.text).trim().length > 0)
    hasToolCall = blocks.some((b) => b.toolUse !== undefined)
    completionTokens = (json.usage as { outputTokens?: number } | undefined)?.outputTokens
    finishReason = json.stopReason as string | undefined
  } else if (cell.surface === 'gemini_generate_content') {
    const cand = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0]
    const parts = ((cand?.content as { parts?: Array<Record<string, unknown>> } | undefined)
      ?.parts ?? []) as Array<Record<string, unknown>>
    hasContent = parts.some(
      (p) => p.thought !== true && typeof p.text === 'string' && String(p.text).trim().length > 0
    )
    hasToolCall = parts.some((p) => p.functionCall !== undefined)
    completionTokens = (json.usageMetadata as { candidatesTokenCount?: number } | undefined)
      ?.candidatesTokenCount
    finishReason = cand?.finishReason as string | undefined
  } else if (cell.surface === 'ollama') {
    // Native /api/chat returns a single `message`, with reasoning on `thinking` and generation
    // stats as flat `eval_count`.
    const m = (json.message ?? {}) as Record<string, unknown>
    hasContent = typeof m.content === 'string' && m.content.trim().length > 0
    hasToolCall = Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
    completionTokens = typeof json.eval_count === 'number' ? json.eval_count : undefined
    finishReason = json.done_reason as string | undefined
  } else {
    const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0]
    const msg = (choice?.message ?? {}) as Record<string, unknown>
    hasContent = typeof msg.content === 'string' && msg.content.trim().length > 0
    hasToolCall = Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length > 0
    completionTokens = (json.usage as { completion_tokens?: number } | undefined)?.completion_tokens
    finishReason = choice?.finish_reason as string | undefined
  }

  return {
    verdict: classifyLeg(status, completionTokens, hasContent, hasToolCall, errorText),
    status,
    completionTokens,
    finishReason,
    error: errorText,
    assembledRoles: wireRoles,
  }
}

/**
 * Dispatch, retrying a result that is not yet evidence.
 *
 * Two cases get a second look:
 *
 *  - `void` — a transport failure is not evidence either way, so discarding a cell over one
 *    transient 503 throws away a measurement we can simply take again.
 *  - `empty` on a leg the corpus predicted would be ACCEPTED — measured non-deterministic on the
 *    Gemini family: the identical request returns visible text on one call and none on the next
 *    (1 of 3 empty on gemini-2.5-flash-lite, 2 of 3 on gemma-4 at a starved budget). Reporting the
 *    unlucky draw would turn sampling noise into `compliant-fails`, i.e. a claim that the shape the
 *    rule demands does not work. Best-of-N is only applied where an empty CONTRADICTS the
 *    prediction; a leg predicted `empty` is never retried into acceptance, so the retry cannot
 *    manufacture the outcome the audit is looking for.
 */
const dispatchWithRetry = async (
  cell: MatrixCell,
  leg: OrderingLeg,
  predicted: string
): Promise<LegResult> => {
  let attempt = await dispatchLeg(cell, leg)
  for (let i = 0; i < 2; i++) {
    const retryVoid = attempt.verdict === 'void'
    const retryFlakyEmpty = attempt.verdict === 'empty' && predicted === 'accepted'
    if (!retryVoid && !retryFlakyEmpty) break
    await new Promise((r) => setTimeout(r, retryVoid ? VOID_BACKOFF_MS : PACE_MS))
    attempt = await dispatchLeg(cell, leg)
  }
  return attempt
}

const results: CellResult[] = []

// SEQUENTIAL, deliberately. Cells share credentials — every bedrock model routes through one — so
// parallel dispatch stacks concurrent requests onto a single upstream. On the first full run that
// pushed the credential's own 5xx ratio past the LB auto-cooldown threshold mid-matrix
// (`cooldown: ratio:5xx`, window 3/6) and six cells came back `503 No available credential`: the
// matrix DoS'd itself and voided its own measurements.
const suite = GATED ? describe.sequential : describe.skip

suite('ordering-guard audit — live wire matrix', () => {
  describe.sequential.each(
    cells.map((c) => [`${c.scenario} → ${c.family} [${c.surface}]`, c] as const)
  )('%s', (_label, cell) => {
    const scenario = scenarioById(cell.scenario) as OrderingScenario

    it('dispatches both legs natively and records the wire verdict', async () => {
      expect(scenario).toBeDefined()

      const violating = await dispatchWithRetry(cell, scenario.violating, scenario.violating.wire)
      await new Promise((r) => setTimeout(r, PACE_MS))
      const compliant = await dispatchWithRetry(cell, scenario.compliant, scenario.compliant.wire)
      await new Promise((r) => setTimeout(r, PACE_MS))

      // The assembled shape must be non-empty, or the cell measured nothing.
      expect(violating.assembledRoles?.length).toBeGreaterThan(0)
      expect(compliant.assembledRoles?.length).toBeGreaterThan(0)

      const step1 = satisfies(scenario.violating.wire, violating.verdict)
      const step2 = satisfies(scenario.compliant.wire, compliant.verdict)

      // ORDER MATTERS. `compliant-fails` is checked BEFORE `justified`: if the shape the rule
      // DEMANDS does not dispatch, the rule cannot be justified no matter what the violating leg
      // did — a rule you cannot satisfy is broken even when the vendor also rejects its violation.
      const disposition: CellResult['disposition'] =
        violating.verdict === 'void' || compliant.verdict === 'void'
          ? 'inconclusive'
          : !step2
            ? 'compliant-fails'
            : step1
              ? 'justified'
              : 'unjustified'

      results.push({ cell, violating, compliant, disposition })

      console.log(
        `  ${cell.scenario} / ${cell.family} [${cell.surface}] ${cell.model}\n` +
          `    roles(violating): ${violating.assembledRoles?.join('→')}\n` +
          `    violating: ${violating.verdict} (HTTP ${violating.status}, out=${violating.completionTokens ?? '?'}, finish=${violating.finishReason ?? '-'})` +
          `${violating.error ? `\n      err=${violating.error}` : ''}\n` +
          `    compliant: ${compliant.verdict} (HTTP ${compliant.status}, out=${compliant.completionTokens ?? '?'}, finish=${compliant.finishReason ?? '-'})` +
          `${compliant.error ? `\n      err=${compliant.error}` : ''}\n` +
          `    => ${disposition.toUpperCase()}`
      )

      // A cell is only INVALID if neither leg reached the provider. Everything else is data.
      expect(violating.verdict === 'void' && compliant.verdict === 'void').toBe(false)
    }, 240_000)
  })

  it('summarises the matrix', () => {
    const by = (d: CellResult['disposition']) => results.filter((r) => r.disposition === d)

    console.log(
      `\n══ ORDERING AUDIT SUMMARY (native surfaces) ══\n` +
        `  justified       ${by('justified').length}  (vendor rejects what the rule forbids)\n` +
        `  unjustified     ${by('unjustified').length}  (vendor ACCEPTS it — the rule is unfounded)\n` +
        `  compliant-fails ${by('compliant-fails').length}  (the shape the rule DEMANDS does not work)\n` +
        `  inconclusive    ${by('inconclusive').length}  (transport void)\n` +
        by('unjustified')
          .map((r) => `    UNJUSTIFIED: ${r.cell.scenario} / ${r.cell.family} [${r.cell.surface}]`)
          .join('\n')
    )
    expect(results.length).toBeGreaterThan(0)
  })
})
