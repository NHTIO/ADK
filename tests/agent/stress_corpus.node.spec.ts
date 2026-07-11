// Full stress-corpus pass (STRESS_THREADS: 94 turns / 14 threads) through the REAL flagship loop against the
// Ollama battery, with REAL RAG grounding from the on-disk ask-adk-index.json. Node equivalent of the browser
// bin/corpus_run.mjs. Behaviours are weight-independent (see memory portable_node_ollama_harness), so this
// triages loop bugs fast; confirm survivors in-browser.
//
// Run: TEST_OLLAMA_AGENT=1 npx vitest run tests/agent/stress_corpus.node.spec.ts   (long — 94 real turns)
//      TEST_OLLAMA_AGENT=1 ADK_THREAD="T7:" npx vitest run tests/agent/stress_corpus.node.spec.ts  (one thread)
// Report → /tmp/corpus_node_report.jsonl ; per-dispatch dump → /tmp/corpus_node_dispatch.jsonl
import { resolve } from 'node:path'
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isError } from '@nhtio/adk/guards'

// web-serialization (via @nhtio/swarm, pulled by agent_rag) touches `self` at module load.
;(globalThis as unknown as { self?: unknown }).self ??= globalThis

// agent_rag fetches `${BASE_URL}ask-adk-index.json` (BASE_URL='/' in node). Serve from disk; pass the rest
// (Ollama /api/chat, HF model files) through to the real fetch.
const REPO = resolve(__dirname, '../..')
const INDEX_PATH = resolve(REPO, 'docs/public/ask-adk-index.json')
const realFetch = globalThis.fetch.bind(globalThis)
;(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
  input: unknown,
  init: unknown
) => {
  const url =
    typeof input === 'string' ? input : ((input as { url?: string })?.url ?? String(input))
  if (url.endsWith('ask-adk-index.json')) {
    return new Response(readFileSync(INDEX_PATH, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return realFetch(input as never, init as never)
}) as never

// Endpoint config. Defaults to the local Ollama daemon; override via TEST_OLLAMA_BASE_URL /
// TEST_OLLAMA_MODEL / TEST_OLLAMA_API_KEY to point at a hosted Ollama-compatible endpoint (e.g. the
// gemini-3-flash-preview capability-tier swap). TEST_OLLAMA_ENCODING / TEST_OLLAMA_PARSER pick the
// token-count encoding + fallback parser family for the target model (default 'gemma').
const OLLAMA = process.env.TEST_OLLAMA_BASE_URL || 'http://localhost:11434'
const OLLAMA_MODEL = process.env.TEST_OLLAMA_MODEL || 'gemma4:e2b-it-qat'
const OLLAMA_API_KEY = process.env.TEST_OLLAMA_API_KEY || undefined
const OLLAMA_ENCODING = (process.env.TEST_OLLAMA_ENCODING || 'gemma') as never
const OLLAMA_PARSER = (process.env.TEST_OLLAMA_PARSER || 'gemma') as never
// ADK_ADAPTER selects the battery adapter backing the harness: 'ollama' (default, local + LB
// Ollama-compat) or 'openai' (the OpenAI Chat Completions battery — for a model served over the LB's
// OpenAI-compatible surface, e.g. gemini-flash-latest, exercising the REAL OpenAI battery path).
const ADAPTER = (process.env.ADK_ADAPTER || 'ollama') as 'ollama' | 'openai'
// Dispatch-level retry on transport flakes (429/502/503/504) — absorbs an LB hiccup at the transport
// layer so it never contaminates a turn's strategy measurement (the qwen lesson). Off by default
// (maxAttempts:1); the head-to-head sets ADK_RETRY_ATTEMPTS=4 for the LB cells.
const RETRY_ATTEMPTS = Number(process.env.ADK_RETRY_ATTEMPTS) || 1
// Forces reasoning mode on OpenAI-compat providers that gate it behind this request-body param (e.g.
// GLM-5.2 on DigitalOcean emits no reasoning_content at all without it). Only meaningful when
// ADK_ADAPTER=openai; the Ollama battery has no equivalent knob (see ollama_adapter_factory notes).
const REASONING_EFFORT = (process.env.ADK_REASONING_EFFORT || undefined) as
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | undefined
const IS_REMOTE = !!process.env.TEST_OLLAMA_BASE_URL
const RUN = process.env.TEST_OLLAMA_AGENT === '1'
const THREAD_FILTER = process.env.ADK_THREAD || null

async function ollamaUp(): Promise<boolean> {
  // A hosted endpoint may not expose /api/tags (and needs auth) — assume reachable and let the first
  // dispatch surface any error. Only probe the local daemon.
  if (IS_REMOTE) return true
  try {
    const tagsRes = await realFetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) })
    return tagsRes.ok
  } catch {
    return false
  }
}

test.runIf(RUN)(
  'stress corpus: full 94-turn pass, real loop via Ollama + real RAG',
  async () => {
    if (!(await ollamaUp())) {
      console.log('[skip] Ollama not reachable at ' + OLLAMA)
      return
    }
    const { appendFileSync, writeFileSync } = await import('node:fs')
    const REPORT = process.env.ADK_CORPUS_REPORT || '/tmp/corpus_node_report.jsonl'
    const DUMP = process.env.ADK_DISPATCH_DUMP || '/tmp/corpus_node_dispatch.jsonl'
    // TRACE dump (opt-in): the per-dispatch ThriftTrace — before/after tokens per bucket — so we can read
    // EXACTLY what the subtractive pass measured and shed, instead of inferring from the wire. Set ADK_TRACE_DUMP.
    const TRACE = process.env.ADK_TRACE_DUMP || null
    if (TRACE) writeFileSync(TRACE, '')
    writeFileSync(REPORT, '')
    writeFileSync(DUMP, '')

    const { STRESS_THREADS } = (await import(
      // @ts-expect-error — untyped .mjs test fixture; shape asserted by the cast below
      '../../research/_stress_threads.mjs'
    )) as {
      STRESS_THREADS: Array<{ name: string; turns: string[] }>
    }
    const runtime = await import('../../docs/.vitepress/theme/components/agent/agent_runtime')
    const store = await import('../../docs/.vitepress/theme/components/agent/agent_swarm_store')
    const adk = await import('../../docs/.vitepress/theme/components/agent/agent_adk')
    const rag = await import('../../docs/.vitepress/theme/components/agent/agent_rag')
    const keyword =
      await import('../../docs/.vitepress/theme/components/agent/agent_keyword_search')
    const { makeNodeSqliteStore } = await import('./_harness/node_sqlite_store')
    const { makeOllamaAdapterFactory } = await import('./_harness/ollama_adapter_factory')
    const { makeOpenAiAdapterFactory } = await import('./_harness/openai_adapter_factory')
    const { buildNodeAdkBundle } = await import('./_harness/node_adk_bundle')
    const { buildNodeKeywordIndex } = await import('./_harness/node_keyword_index')

    adk._initAgentRuntimeFromBundle(buildNodeAdkBundle())
    const nodeDb = makeNodeSqliteStore()
    store._initAgentStoreWithExec(nodeDb.exec)

    // Keyword search (search_docs_keyword) is browser-only in the flagship (@localSearchIndex virtual module).
    // Load VitePress's emitted local-search index from disk so it works in Node too — byte-faithful to the
    // browser searchbox. Best-effort: if the chunk isn't built yet, log and continue (that tool will throw as
    // before on those turns). Requires a prior `pnpm docs:build`.
    try {
      keyword._setKeywordIndex(await buildNodeKeywordIndex(REPO))
      console.log('[corpus] keyword search wired from VitePress index')
    } catch (e) {
      console.log(`[corpus] keyword search NOT wired: ${isError(e) ? e.message : e}`)
    }

    // The flagship embedder (agent_embedder.loadExtractor) hardcodes env.useBrowserCache=true on EVERY load
    // (browser path); that throws in Node ("Browser cache is not available"). It re-sets the flag each call,
    // so a plain assignment is overwritten — PIN it false via a no-op setter, and enable the FS cache. Same
    // transformers.js singleton the embedder imports.
    const tf = (await import('@huggingface/transformers')) as unknown as {
      env: { useBrowserCache: boolean; useFSCache: boolean }
    }
    tf.env.useFSCache = true
    Object.defineProperty(tf.env, 'useBrowserCache', {
      get: () => false,
      set: () => {},
      configurable: true,
    })

    console.log('[corpus] booting RAG index…')
    await rag.ensureRagIndex()
    console.log('[corpus] RAG ready')

    let dispatchSeq = 0
    const SPOOL = process.env.ADK_SPOOL_DUMP || '/tmp/corpus_node_spool.jsonl'
    writeFileSync(SPOOL, '')
    // Shared taps + retry, adapter-agnostic. The retry config is honored by both factories (each maps it
    // to its battery's RetryConfig): a flaked dispatch retries with backoff, the turn stays intact.
    const onDispatch = (d: Record<string, unknown>): void =>
      appendFileSync(DUMP, JSON.stringify({ ...d, gSeq: dispatchSeq++ }) + '\n')
    const onSpoolWrite = (o: Record<string, unknown>): void =>
      appendFileSync(SPOOL, JSON.stringify({ ...o, atDispatch: dispatchSeq }) + '\n')
    const retry = { maxAttempts: RETRY_ATTEMPTS, baseDelayMs: 800, maxDelayMs: 30_000 }
    const factory =
      ADAPTER === 'openai'
        ? makeOpenAiAdapterFactory({
            model: OLLAMA_MODEL,
            baseURL: OLLAMA,
            apiKey: OLLAMA_API_KEY,
            tokenEncoding: OLLAMA_ENCODING,
            retry,
            ...(REASONING_EFFORT ? { reasoningEffort: REASONING_EFFORT } : {}),
            onDispatch: onDispatch as never,
            onSpoolWrite: onSpoolWrite as never,
          })
        : makeOllamaAdapterFactory({
            model: OLLAMA_MODEL,
            baseURL: OLLAMA,
            apiKey: OLLAMA_API_KEY,
            tokenEncoding: OLLAMA_ENCODING,
            localToolCallParser: OLLAMA_PARSER,
            retry,
            onDispatch: onDispatch as never,
            onSpoolWrite: onSpoolWrite as never,
          })

    // ADK_THREAD_CAPS: JSON map { "<threadPrefix>": <maxTurnIndexInclusive> } to run a SUBSET of threads,
    // each stopped after its capped turn. Used for the targeted A/B of the 12 diagnosed turns (10 loopers +
    // 3 overflow, T3#0 shared): run each affected thread only THROUGH its deepest target turn, giving that
    // turn its correct prior-turn context without paying for the whole 94.
    const caps: Record<string, number> | null = process.env.ADK_THREAD_CAPS
      ? (JSON.parse(process.env.ADK_THREAD_CAPS) as Record<string, number>)
      : null
    const threads = caps
      ? STRESS_THREADS.filter((t) => caps[t.name.split(':')[0]] !== undefined)
      : THREAD_FILTER
        ? STRESS_THREADS.filter((t) => t.name.includes(THREAD_FILTER))
        : STRESS_THREADS
    const capFor = (t: { name: string }): number => {
      const c = caps?.[t.name.split(':')[0]]
      return c === undefined ? Infinity : c
    }
    const totalTurns = threads.reduce((n, t) => n + Math.min(t.turns.length, capFor(t) + 1), 0)
    console.log(
      `[corpus] ${threads.length} threads, ${totalTurns} turns${caps ? ' (capped subset)' : ''}`
    )

    const rows: Array<{
      thread: string
      turn: number
      prompt: string
      answer: string
      refused: boolean
      error: string | null
      settled: boolean
      dispatches: number
      gates: string[]
      ms: number
    }> = []

    for (const thread of threads) {
      await (store as { clearAllData?: () => Promise<void> }).clearAllData?.().catch(() => {})
      const gates: string[] = []
      const harness = new runtime.AgentHarness(
        'gemma-e2b',
        {
          onGate: (g) => gates.push(g.gate),
          ...(TRACE
            ? {
                onTrace: (t: {
                  buckets: Array<{
                    bucket: string
                    beforeTokens: number
                    afterTokens: number
                    afterCount: number
                  }>
                  budget: number
                  totalAfter: number
                  fits: boolean
                }) => {
                  // Dump EVERY bucket's after-tokens so we can compare the pass's per-bucket measurement
                  // against the battery guard's per-bucket breakdown (the overflow error) and pin any mismatch.
                  const perBucket: Record<string, number> = {}
                  for (const b of t.buckets) perBucket[b.bucket] = b.afterTokens
                  appendFileSync(
                    TRACE,
                    JSON.stringify({
                      thread: thread.name.split(':')[0],
                      budget: t.budget,
                      totalAfter: t.totalAfter,
                      fits: t.fits,
                      perBucket,
                    }) + '\n'
                  )
                },
              }
            : {}),
        },
        // autoGateVerdict:false — this headless harness has no dialog to answer the navigate-permission
        // TurnGate (ctx.waitFor in navigate_to_page). Without it, a model that reaches for navigate_to_page
        // (observed: kimi-k2.5) deadlocks the whole run on that one dispatch. Auto-DENY: the tool returns
        // "user declined navigation", the turn continues, and the gate still records via onGate.
        { adapterFactory: factory, autoGateVerdict: false }
      )
      // FIDELITY: the web dialog pushes its budget into the harness before the first turn
      // (agent_dialog.vue → setContextWindow/setMaxTokens with DEFAULT_WINDOW=8192,
      // DEFAULT_MAX_TOKENS=512). The harness must do the same or it runs on the runtime's bare
      // #maxTokens=2048 initializer — a 4× larger reply reserve that starves the input budget
      // (6144 vs the web's 7680) and manufactures context-overflow turns the browser never sees.
      // Overridable via ADK_WINDOW / ADK_MAX_TOKENS to sweep the budget (e.g. the "more output rope =
      // more hangs" experiment: hold window, vary maxTokens 512→1024→2048 and watch the error rate).
      // Defaults preserve the web-faithful 8192/512.
      harness.setContextWindow(Number(process.env.ADK_WINDOW) || 8192)
      harness.setMaxTokens(Number(process.env.ADK_MAX_TOKENS) || 512)
      // ADK_THINKING=1 turns the model's reasoning channel ON (default OFF, the flagship default). The
      // other rope lever for the "more rope = more hangs" A/B — reasoning tokens are exactly where a
      // small model wanders off the answer shape.
      if (process.env.ADK_THINKING === '1') harness.setEnableThinking(true)
      // ADK_NO_SYNTHETIC_THOUGHTS=1 stops the flagship injecting its synthetic plan/nudge/cite thoughts into
      // the MODEL prompt (they still emit to the UI). Needed for a model whose chat template treats a
      // trailing-assistant turn as complete and emits an immediate stop (qwen3-coder-next: the synthetic
      // thoughts render as assistant messages and land last → 1-token empty stop → dispatch spin). Default
      // off (Gemma relies on them). See setInjectSyntheticThoughts.
      if (process.env.ADK_NO_SYNTHETIC_THOUGHTS === '1') harness.setInjectSyntheticThoughts(false)
      // ADK_CONTEXT_STRATEGY selects the head-to-head arm: 'thrift' (default, the real system) | 'compact'
      // (faithful Claude Code auto-compaction baseline) | 'naive' (FIFO-drop floor). Same model/corpus/window
      // across arms — only context management differs. See harness.setContextStrategy / #contextStrategy.
      const strat = process.env.ADK_CONTEXT_STRATEGY
      if (strat === 'compact' || strat === 'naive' || strat === 'thrift') {
        harness.setContextStrategy(strat)
      }
      const lastTurn = Math.min(thread.turns.length - 1, capFor(thread))
      for (let i = 0; i <= lastTurn; i++) {
        const text = thread.turns[i]
        const dBefore = dispatchSeq
        const gBefore = gates.length
        const t0 = Date.now()
        let res: {
          answer?: string
          refused?: boolean
          error?: string
          oom?: boolean
          contextOverflow?: boolean
          windowTooSmall?: boolean
          contextPoisoned?: boolean
        }
        try {
          res = await harness.run({ text })
        } catch (e) {
          res = { answer: '', refused: false, error: isError(e) ? e.message : String(e) }
        }
        // SETTLED = a genuinely committed clean answer: non-empty text, not refused, no error, and NONE
        // of the failure flags (oom / contextOverflow / windowTooSmall / contextPoisoned). This is the
        // real completion signal the metrics use — distinct from the old "!error" inference which counted
        // an empty-but-error-free turn as done. Applies identically to every arm.
        const settled =
          !!res.answer?.trim() &&
          !res.refused &&
          !res.error &&
          !res.oom &&
          !res.contextOverflow &&
          !res.windowTooSmall &&
          !res.contextPoisoned
        const row = {
          thread: thread.name,
          turn: i,
          prompt: text,
          answer: res.answer ?? '',
          refused: !!res.refused,
          error: res.error ?? null,
          settled,
          dispatches: dispatchSeq - dBefore,
          gates: [...new Set(gates.slice(gBefore))],
          ms: Date.now() - t0,
        }
        rows.push(row)
        appendFileSync(REPORT, JSON.stringify(row) + '\n')
        const flag = row.error ? 'ERR' : row.refused ? 'REF' : row.answer.trim() ? 'ok ' : 'EMPTY'
        console.log(
          `[${flag}] ${thread.name.split(':')[0]}#${i} d=${row.dispatches} ${Math.round(row.ms / 1000)}s :: ${row.answer.replace(/\n/g, ' ').slice(0, 90)}`
        )
      }
      await (harness as { dispose?: () => Promise<void> }).dispose?.().catch(() => {})
    }
    nodeDb.close()

    const tot = rows.length
    const empty = rows.filter((r) => !r.answer.trim() && !r.error).length
    const err = rows.filter((r) => r.error).length
    const ref = rows.filter((r) => r.refused).length
    const big = rows.filter((r) => r.dispatches >= 10).sort((a, b) => b.dispatches - a.dispatches)
    console.log(
      `\n=== SUMMARY ${tot} turns: ${tot - empty - err} answered, ${empty} empty, ${err} error, ${ref} refused ===`
    )
    console.log('=== high-dispatch turns (>=10) — candidate loops ===')
    for (const r of big.slice(0, 20))
      console.log(
        `  ${r.dispatches}d  ${r.thread.split(':')[0]}#${r.turn}  gates=[${r.gates.join(',')}]  ${r.prompt.slice(0, 55)}`
      )
    // CONTEXT-MANAGEMENT TOKEN COST (head-to-head token-cost axis). thrift's context mgmt is pure (0 model
    // calls); the compact arm records each summariser dispatch on __agentCompactionCost. Sum it + write a
    // sidecar so the judge/analysis has the per-arm context-mgmt overhead (thrift/naive = 0, compact = Σ).
    const compactionCost = (
      (
        globalThis as unknown as {
          __agentCompactionCost?: Array<{ inTok: number; outTok: number }>
        }
      ).__agentCompactionCost ?? []
    ).reduce(
      (acc: { calls: number; inTok: number; outTok: number }, c) => ({
        calls: acc.calls + 1,
        inTok: acc.inTok + c.inTok,
        outTok: acc.outTok + c.outTok,
      }),
      { calls: 0, inTok: 0, outTok: 0 }
    )
    console.log(
      `=== context-mgmt overhead (strategy=${process.env.ADK_CONTEXT_STRATEGY ?? 'thrift'}): ` +
        `${compactionCost.calls} summariser dispatches, ${compactionCost.inTok} in + ${compactionCost.outTok} out tok ===`
    )
    writeFileSync(
      REPORT.replace(/\.jsonl$/, '') + '.ctxcost.json',
      JSON.stringify(
        { strategy: process.env.ADK_CONTEXT_STRATEGY ?? 'thrift', ...compactionCost },
        null,
        2
      )
    )
    console.log(`\nreport: ${REPORT}\ndump: ${DUMP}`)

    // The run itself is the artifact; assert only that it produced a row per turn (no hard behavioural gate here).
    expect(rows.length).toBe(totalTurns)
  },
  // Effectively no timeout (24h): a full 94-turn Ollama pass is long and must not be truncated. 0 is treated
  // as "use default" by vitest, so use a large finite value instead.
  24 * 60 * 60_000
)
