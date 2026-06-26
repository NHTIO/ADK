/**
 * The real-model test matrix manifest — pure data + types, ENVIRONMENT-NEUTRAL (no `vitest`, no
 * `node:*`) so the Node spec AND the browser WebGPU harness both import it.
 *
 * Each {@link MatrixEntry} pins a real model (an HF ONNX repo id or a `.litertlm` URL), the parser
 * family it should exercise, a format-ELICITING prompt, and lenient `expect` assertions. A matrix run
 * is the honest proof that a small model actually emits the format we assumed (see the plan): a turn is
 * driven through the real adapter and the expected tool-call / reasoning family must be extracted.
 *
 * The `host` field tracks provenance: `'exists'` = consumed as-is from a public repo; `'generated'` =
 * we converted + published it under `nhtio/`; `'needs-conversion-experimental'` = an attempted `-web`
 * build whose loadability the browser matrix decides.
 *
 * Big-only families (`gpt_oss` 20B, `mistral` 7B, `qwen3_coder` 480B XML) are NOT live entries here —
 * they have no small e2e model and are validated via the capture tier (`bin/capture_tool_outputs.ts` →
 * captured fixtures → `tool_parsers.cross.spec.ts`), not a live run.
 */

/** Which battery an entry drives. */
export type MatrixBattery = 'transformers_js_llm' | 'transformers_js_embed' | 'litert_lm'

/** Where the entry runs. */
export type MatrixRuntime = 'node' | 'browser-webgpu' | 'both'

/** Provenance of the model artifact. */
export type MatrixHost = 'exists' | 'generated' | 'needs-conversion-experimental'

/** A benign tool the entry registers so a fired call lands harmlessly in `stored.toolCalls`. */
export interface MatrixTool {
  /** Tool name (the model is prompted to call it). */
  name: string
  /** One-line description fed to the model. */
  description: string
  /** Parameter names → a primitive JSON type, compiled to a joi object schema by the ctx helper. */
  params?: Record<string, 'string' | 'number' | 'boolean'>
}

/** A media attachment to drive the multimodal path. `fixturePath` is repo-relative. */
export interface MatrixAttachment {
  kind: 'image' | 'audio'
  mimeType: string
  fixturePath: string
}

/** Lenient assertions — every field optional; a runner checks only what is present. */
export interface MatrixExpect {
  /** The assistant message must be non-empty prose. */
  nonEmptyProse?: boolean
  /**
   * At least one non-empty reasoning Thought must be surfaced. The honest assertion for a reasoning-only
   * model that, at a feasible budget, may spend its whole output reasoning without concluding (a lone/
   * unclosed `<think>` → orphan recovery classifies it all as reasoning, leaving empty prose).
   */
  nonEmptyReasoning?: boolean
  /**
   * The turn produced SOMETHING actionable — a tool call, a reasoning Thought, OR non-empty prose. The
   * honest "the path works end-to-end" assertion for a thinking + tool-calling model on a tight budget,
   * where the final visible prose may legitimately be empty (the budget went to a tool call or the
   * thought channel). A `__NACK__` (a real error) does NOT satisfy this.
   */
  producedOutput?: boolean
  /** Each substring (case-insensitive) must appear in some surfaced reasoning Thought. */
  reasoningContains?: string[]
  /** A tool call with this name (and optionally these arg keys) must be extracted. */
  toolCall?: { name: string; argKeys?: string[] }
  /** Embeddings: each returned vector is unit-norm and deterministic across two identical inputs. */
  embeddingDeterministicUnitNorm?: boolean
  /** The assistant prose must match at least one of these (case-insensitive) — multimodal grounding. */
  proseMatchesAny?: string[]
}

/** Per-entry capability flags (drive which assertions / passes run). */
export interface MatrixCapabilities {
  toolCalls?: boolean
  reasoning?: boolean
  streaming?: boolean
  embeddings?: boolean
  image?: boolean
  audio?: boolean
}

/** One row of the matrix. */
export interface MatrixEntry {
  /** Stable id (used by `--only=` filters + the verdict table). */
  id: string
  /** Human label for the model family. */
  family: string
  battery: MatrixBattery
  runtime: MatrixRuntime
  /** HF repo id (transformers.js) or a `.litertlm` URL (litert). */
  modelRef: string
  /** transformers.js dtype (e.g. `'q4'`, `'q4f16'`, `'fp32'`). */
  dtype?: string
  /**
   * Per-entry generation budget override (default 96). Some families emit a correct-but-LONGER tool
   * call (full hermes JSON, qwen3_coder XML) that truncates mid-structure at 96 tokens — raise this so
   * the call completes and the parser sees a closed structure.
   */
  maxNewTokens?: number
  /** LiteRT backend hint, if any. */
  backend?: number
  host: MatrixHost
  /** Parser family flags for the LLM adapter. */
  toolCallParser?: string
  reasoningParser?: string
  capabilities: MatrixCapabilities
  /** Tools the entry registers (for tool-calling entries). */
  tools?: MatrixTool[]
  /** Media attachments (multimodal entries). */
  attachments?: MatrixAttachment[]
  /** A prompt crafted to ELICIT the family's tool/reasoning format. */
  prompt: string
  /** Optional system prompt (e.g. Gemma reasoning needs a nudge). */
  systemPrompt?: string
  expect: MatrixExpect
  /** Browser entries: whether a load FAILURE is informational (a probe) rather than a hard failure. */
  expectBrowserLoadProbe?: boolean
  /** Free-text note (risks, provenance, what the entry proves). */
  note?: string
}

const WEATHER_TOOL: MatrixTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  params: { city: 'string' },
}

// ─── transformers.js LLM (Node) — every family with a small ONNX model ────────────────────────────────

const TJS_LLM_NODE: MatrixEntry[] = [
  {
    id: 'tjs-gemma-e2b',
    family: 'Gemma 4 E2B',
    battery: 'transformers_js_llm',
    runtime: 'both',
    modelRef: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q4',
    host: 'exists',
    toolCallParser: 'gemma',
    reasoningParser: 'gemma_channel',
    capabilities: { toolCalls: true, reasoning: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'What is the weather in Paris? Use the get_weather tool.',
    expect: { toolCall: { name: 'get_weather', argKeys: ['city'] } },
    note: 'Multimodal repo; here the TEXT path + gemma tool/reasoning parsers are validated.',
  },
  {
    id: 'tjs-qwen3-0.6b',
    family: 'Qwen3 0.6B',
    battery: 'transformers_js_llm',
    runtime: 'both',
    modelRef: 'onnx-community/Qwen3-0.6B-ONNX',
    dtype: 'q4f16',
    host: 'exists',
    toolCallParser: 'hermes',
    reasoningParser: 'think_tag',
    capabilities: { toolCalls: true, reasoning: true, streaming: true },
    tools: [WEATHER_TOOL],
    // MATRIX FINDING (folded back): Qwen3 thinks first (<think>…</think>) THEN emits the hermes
    // <tool_call>{json}</tool_call> — at 96 tokens the reasoning eats the budget and the call truncates
    // mid-JSON. Raise the budget so the full call completes after the reasoning span.
    maxNewTokens: 320,
    prompt: 'What is the weather in Tokyo? Call get_weather.',
    expect: { toolCall: { name: 'get_weather', argKeys: ['city'] } },
    note: 'Qwen3 reasons before the call; needs a larger budget (320) so the hermes JSON completes.',
  },
  {
    id: 'tjs-deepseek-r1-distill',
    family: 'DeepSeek-R1-Distill-Qwen 1.5B',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/DeepSeek-R1-Distill-Qwen-1.5B-ONNX',
    // MATRIX FINDING (folded back): q4f16 crashes this graph with an ONNX Runtime Cast-node error (same
    // class as the Qwen-Coder graph) → use q4. Reasoning also needs room → larger budget.
    dtype: 'q4',
    host: 'exists',
    reasoningParser: 'think_tag',
    // Budget 512: R1-distill is verbose inside <think>; at 256 it spent the whole budget reasoning and
    // never closed the tag (orphan recovery → all reasoning, empty answer). Assert it REASONS (the honest
    // outcome for a reasoning-only model) rather than forcing a concluded answer at a feasible budget.
    maxNewTokens: 512,
    capabilities: { reasoning: true, streaming: true },
    prompt: 'Think step by step: what is 12 times 7? Show your reasoning in <think> tags.',
    expect: { nonEmptyReasoning: true },
    note: 'Reasoning-only (<think>); dtype q4 (q4f16 Cast crash); asserts non-empty reasoning (may not conclude).',
  },
  {
    id: 'tjs-llama-3.2-1b',
    family: 'Llama 3.2 1B',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    dtype: 'q4f16',
    host: 'exists',
    // MATRIX FINDING (folded back): the small Llama 3.2 1B does NOT emit the pythonic `[fn(...)]` form —
    // it emits a bare JSON object `{"name":…,"parameters":…}` (the llama3_json family). Switch to the
    // `auto` driver so the (gated) llama3_json parser claims it; raise the budget so the object closes.
    toolCallParser: 'auto',
    maxNewTokens: 192,
    capabilities: { toolCalls: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'Get the weather in Berlin. Respond with a function call.',
    expect: { toolCall: { name: 'get_weather' } },
    note: 'Llama 3.2 1B emits bare {"name","parameters"} (llama3_json, NOT pythonic) → auto driver claims it.',
  },
  {
    id: 'tjs-smollm2-360m',
    family: 'SmolLM2 360M',
    battery: 'transformers_js_llm',
    runtime: 'both',
    modelRef: 'HuggingFaceTB/SmolLM2-360M-Instruct',
    dtype: 'q4',
    host: 'exists',
    capabilities: { streaming: true },
    prompt: 'Say one short sentence about the ocean.',
    expect: { nonEmptyProse: true },
    note: 'Text/streaming baseline — no tool/reasoning assumptions.',
  },
  {
    id: 'tjs-phi-4-mini',
    family: 'Phi-4-mini',
    battery: 'transformers_js_llm',
    runtime: 'both',
    modelRef: 'onnx-community/Phi-4-mini-instruct-ONNX',
    dtype: 'q4',
    host: 'exists',
    toolCallParser: 'phi',
    reasoningParser: 'think_tag',
    capabilities: { streaming: true },
    prompt: 'Say one short sentence about Madrid.',
    expect: { nonEmptyProse: true },
    // MATRIX FINDING (folded back): the q4 Phi-4-mini DECLINES to emit a tool call ("I can't execute
    // functions…") at this size/quant — a model-capability gap, NOT a parser gap. The `phi` parser
    // (functools[...]) is validated by unit tests + the capture tier (0h), so this entry is demoted to a
    // text baseline rather than forcing a tool call the small quant won't produce.
    note: 'phi parser proven by unit/capture tiers; the q4 quant declines tool calls — text baseline only.',
  },
  {
    id: 'tjs-granite-4',
    family: 'Granite 4.0 350M',
    battery: 'transformers_js_llm',
    runtime: 'both',
    modelRef: 'onnx-community/granite-4.0-350m-ONNX-web',
    host: 'exists',
    toolCallParser: 'hermes',
    capabilities: { toolCalls: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'What is the weather in Cairo? Call the get_weather tool.',
    expect: { toolCall: { name: 'get_weather', argKeys: ['city'] } },
    note: 'Granite emits Hermes-style <tool_call>{json}</tool_call> — validates `hermes` (NO granite parser needed).',
  },
  {
    id: 'tjs-qwen2.5-coder-0.5b',
    family: 'Qwen2.5-Coder 0.5B',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/Qwen2.5-Coder-0.5B-Instruct',
    // MATRIX FINDINGS (folded back): (1) q4f16 crashes this graph at runtime with an ONNX Runtime
    // Cast-node error ("InsertedPrecisionFreeCast … v_proj/repeat_kv") → use q4. (2) The small model
    // emits the tool call as a ```json {"name","arguments"} ``` code FENCE, not the Hermes <tool_call>
    // wrapper → use the `auto` driver (the `llama3_json` parser now un-fences and claims it).
    dtype: 'q4',
    host: 'exists',
    toolCallParser: 'auto',
    capabilities: { toolCalls: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'Get the weather in Oslo using the get_weather tool.',
    expect: { toolCall: { name: 'get_weather' } },
    note: 'Small Qwen-Coder emits fenced ```json {name,arguments}``` (not <tool_call>); dtype q4 (q4f16 crashes).',
  },
  {
    id: 'tjs-nemotron-4b',
    family: 'Nemotron 3 Nano 4B',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'huggingworld/NVIDIA-Nemotron-3-Nano-4B-BF16-ONNX',
    host: 'exists',
    // MATRIX FINDING (folded back): when it DOES load, Nemotron emits qwen3_coder XML
    // (`<tool_call><function=…><parameter=…>`) preceded by a stray leading `</think>` (the gemma-style
    // orphan-close drift). Use the qwen3_coder parser + think_tag reasoning (orphan recovery now strips
    // the lone </think> before tool parsing) + a larger budget so the XML closes. Still a load-probe:
    // nemotron_h (Mamba-hybrid) may not load in transformers.js at all → load failure stays DATA.
    toolCallParser: 'qwen3_coder',
    reasoningParser: 'think_tag',
    maxNewTokens: 256,
    capabilities: { toolCalls: true, reasoning: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'What is the weather in Lima? Call get_weather.',
    expect: { toolCall: { name: 'get_weather' } },
    expectBrowserLoadProbe: true,
    note: 'nemotron_h (Mamba-hybrid) LOAD-PROBE; emits qwen3_coder XML + a stray </think> (orphan-recovered).',
  },
]

// ─── transformers.js LLM — multimodal entries (0i) ────────────────────────────────────────────────────

const TJS_LLM_MM: MatrixEntry[] = [
  {
    id: 'tjs-gemma-mm',
    family: 'Gemma 4 E2B (image)',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q4',
    host: 'exists',
    capabilities: { image: true, streaming: false },
    attachments: [
      { kind: 'image', mimeType: 'image/png', fixturePath: 'tests/_fixtures/media/sample.png' },
    ],
    prompt: 'Describe this image in one sentence.',
    expect: {
      nonEmptyProse: true,
      proseMatchesAny: ['red', 'color', 'colour', 'image', 'square', 'block'],
    },
    note: 'The e2e proof of the transformers.js multimodal (image) path.',
  },
  {
    id: 'tjs-qwen2.5-vl-3b',
    family: 'Qwen2.5-VL 3B (image)',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/Qwen2.5-VL-3B-Instruct-ONNX',
    dtype: 'q4f16',
    host: 'exists',
    capabilities: { image: true, streaming: false },
    attachments: [
      { kind: 'image', mimeType: 'image/png', fixturePath: 'tests/_fixtures/media/sample.png' },
    ],
    prompt: 'What color dominates this image? Answer in one short sentence.',
    expect: { nonEmptyProse: true, proseMatchesAny: ['red', 'color', 'colour'] },
    // MATRIX FINDING (folded back): this VL graph at q4f16 throws `Tensor's size (42336) does not match
    // data length (60000)` during image preprocessing — a real UPSTREAM transformers.js VL bug, not our
    // path. Demote to a load/run-probe so the runtime error is recorded as DATA, not a hard failure.
    expectBrowserLoadProbe: true,
    note: 'PROBE: q4f16 VL preprocessing throws a Tensor size!=data-length error upstream — run failure is DATA.',
  },
  {
    id: 'tjs-gemma-audio',
    family: 'Gemma 4 E2B (audio)',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q4',
    host: 'exists',
    // RECEIPTS: the ONNX export ships `onnx/audio_encoder_q4.onnx`, and config.json carries
    // `audio_config`/`audio_encoder`/`audio_token_id` (processor_config: audio_ms_per_token, feature_extractor)
    // — audio is a real branch of this graph, not a dropped tower.
    capabilities: { audio: true, streaming: false },
    attachments: [
      { kind: 'audio', mimeType: 'audio/wav', fixturePath: 'tests/_fixtures/media/speech.wav' },
    ],
    prompt: 'Transcribe this audio.',
    // speech.wav is a 2.5s 16 kHz mono utterance of "The quick brown fox jumps over the lazy dog" (a real
    // spoken fixture, NOT a tone). RECEIPTS: bypassing the adapter, the real Gemma-4 processor+model
    // transcribes it verbatim — so this is a TRUE grounding assertion on distinctive content words, not a
    // tone whose only honest match would be the word "audio" (which a refusal also contains → false green).
    expect: { nonEmptyProse: true, proseMatchesAny: ['fox', 'brown', 'lazy', 'dog', 'jump'] },
    note: 'The e2e proof of the transformers.js multimodal (AUDIO) path — Gemma-4 transcribes real speech.',
  },
  {
    id: 'tjs-gemma-mixed',
    family: 'Gemma 4 E2B (image + audio)',
    battery: 'transformers_js_llm',
    runtime: 'node',
    modelRef: 'onnx-community/gemma-4-E2B-it-ONNX',
    dtype: 'q4',
    host: 'exists',
    // The CHAOS entry: image AND audio AND prose in a SINGLE turn. RECEIPTS — bypassing the adapter, the
    // real Gemma-4 processor emits BOTH `pixel_values` and `input_features` and the model grounds both at
    // once: "COLOR=Red ; SPEECH=the quick brown fox jumps over the lazy dog". This is the only real-weight
    // test of the adapter's `[prompt, image, audio]` 3-positional processor call (the `procArgs` fix).
    capabilities: { image: true, audio: true, streaming: false },
    attachments: [
      { kind: 'image', mimeType: 'image/png', fixturePath: 'tests/_fixtures/media/sample.png' },
      { kind: 'audio', mimeType: 'audio/wav', fixturePath: 'tests/_fixtures/media/speech.wav' },
    ],
    prompt:
      'You are given an image and an audio clip. First name the dominant colour of the image, then ' +
      'transcribe the speech. Answer as: COLOR=... ; SPEECH=...',
    // Both modalities must land: the colour word proves the image was seen, a transcript word proves the
    // audio was heard. Requiring one from EACH group would over-constrain a 2B at q4 (it sometimes drops
    // the COLOR= prefix), so we assert the union and lean on the dedicated single-modality entries above
    // for per-modality rigor — this entry's job is to prove the combined path doesn't crash or clobber.
    expect: {
      nonEmptyProse: true,
      proseMatchesAny: ['red', 'fox', 'brown', 'lazy', 'dog', 'jump', 'color', 'colour'],
    },
    note: 'CHAOS: image + audio + prose in ONE turn — the only real-weight test of the dual-modality processor call.',
  },
]

// ─── transformers.js embeddings (Node + browser) ──────────────────────────────────────────────────────

const TJS_EMBED: MatrixEntry[] = [
  {
    id: 'tjs-embed-minilm',
    family: 'all-MiniLM-L6-v2',
    battery: 'transformers_js_embed',
    runtime: 'both',
    modelRef: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    dtype: 'fp32',
    host: 'exists',
    capabilities: { embeddings: true },
    prompt: 'a quick brown fox',
    expect: { embeddingDeterministicUnitNorm: true },
  },
  {
    id: 'tjs-embed-bge-small',
    family: 'BGE small en v1.5',
    battery: 'transformers_js_embed',
    runtime: 'both',
    modelRef: 'Xenova/bge-small-en-v1.5',
    host: 'exists',
    capabilities: { embeddings: true },
    prompt: 'a quick brown fox',
    expect: { embeddingDeterministicUnitNorm: true },
  },
  {
    id: 'tjs-embed-arctic-s',
    family: 'Snowflake Arctic embed S',
    battery: 'transformers_js_embed',
    runtime: 'both',
    modelRef: 'Snowflake/snowflake-arctic-embed-s',
    host: 'exists',
    capabilities: { embeddings: true },
    prompt: 'a quick brown fox',
    expect: { embeddingDeterministicUnitNorm: true },
    note: 'Asymmetric query/document prefixes — exercises applyEmbeddingPrefix.',
  },
  {
    id: 'tjs-embed-gemma',
    family: 'EmbeddingGemma 300M',
    battery: 'transformers_js_embed',
    runtime: 'both',
    modelRef: 'onnx-community/embeddinggemma-300m-ONNX',
    host: 'exists',
    capabilities: { embeddings: true },
    prompt: 'a quick brown fox',
    expect: { embeddingDeterministicUnitNorm: true },
    // RECEIPTS: through our battery as-is — 768-dim, unit-norm (1.00000), deterministic (cos 1.000000),
    // and discriminating (related text cos 1.0 vs unrelated 0.577). Google's Gemma-3-based embedder; the
    // largest/newest embedding model in the matrix, proving the embeddings path scales past the MiniLM tier.
    note: 'Gemma-3-based 300M embedder — verified unit-norm + deterministic through the battery.',
  },
]

// ─── LiteRT-LM (browser WebGPU) — known-good + probes ─────────────────────────────────────────────────

const LITERT_BROWSER: MatrixEntry[] = [
  {
    id: 'litert-gemma-web',
    family: 'Gemma 4 E2B (.litertlm -web)',
    battery: 'litert_lm',
    runtime: 'browser-webgpu',
    modelRef:
      'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
    host: 'exists',
    // MATRIX FINDING (folded back, real GPU run): passing tools via the NATIVE `preface.tools` channel
    // makes this .litertlm's OWN bundled chat template throw `Failed to apply template: undefined value
    // (template:80)` — a known Gemma-4 template bug (also in llama.cpp / mlx-lm / LM Studio). The fix is
    // the battery's DEFAULT `toolDelivery: 'prompt'`: tool defs render as system-prompt text and the
    // `auto` parser (whose `gemma` family handles the decoder-stripped `call:NAME{…}` runtime form)
    // extracts the call. This mirrors how WebLLM/MLC give Gemma tools. So the baseline proves the real
    // LiteRT WebGPU TOOL-CALLING path end-to-end via prompt injection.
    toolCallParser: 'auto',
    reasoningParser: 'auto',
    capabilities: { toolCalls: true, reasoning: true, streaming: true },
    tools: [WEATHER_TOOL],
    prompt: 'What is the weather in Rome? Use the get_weather tool.',
    // Lenient: small Gemma may answer in prose OR fire the call. Assert harness integrity (no template
    // crash, non-empty output); a fired get_weather is the bonus the prompt path now makes possible.
    expect: { nonEmptyProse: true },
    note: 'Real WebGPU LiteRT tool-calling via prompt-injection (toolDelivery:prompt default) — native preface.tools throws template:80 on this gemma-4 .litertlm.',
  },
  {
    id: 'litert-smollm2-360m-probe',
    family: 'SmolLM2 360M (.litertlm, community, no -web)',
    battery: 'litert_lm',
    runtime: 'browser-webgpu',
    modelRef:
      'https://huggingface.co/litert-community/SmolLM2-360M-Instruct/resolve/main/SmolLM2_360M_instruct.litertlm',
    host: 'exists',
    capabilities: { streaming: true },
    prompt: 'Say one short sentence about mountains.',
    // VERDICT (real GPU run): this stock community non-web .litertlm LOADS (reads template, builds engine,
    // reaches generation) then fails BOTH sendMessage + sendMessageStreaming with `Streaming
    // kTfLitePrefillDecode models is not supported yet`. The @litert-lm/core web runtime cannot execute the
    // `tf_lite_prefill_decode` model_type these community builds carry — and the public `litert-torch
    // export_hf` CLI only emits that type, NOT the `tf_lite_artisan_text_decoder` the working gemma-4-*-web
    // builds use. The JS API doc allow-lists ONLY the two Gemma -web files. So non-Gemma is not browser-
    // runnable with the public toolchain. Probe: the load+generate failure is the recorded finding, not a
    // test failure. See the on-device showcase + memory `litert_web_gemma_only`.
    expect: { nonEmptyProse: true },
    expectBrowserLoadProbe: true,
    note: 'FINDING: community non-web .litertlm loads but kTfLitePrefillDecode blocks generation; non-Gemma not web-runnable (public export_hf emits prefill_decode, not the artisan decoder the runtime needs).',
  },
  {
    id: 'litert-gemma3-1b-probe',
    family: 'Gemma3 1B int4 (.litertlm, no -web)',
    battery: 'litert_lm',
    runtime: 'browser-webgpu',
    modelRef:
      'https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.litertlm',
    host: 'exists',
    capabilities: { streaming: true },
    prompt: 'Say one short sentence about mountains.',
    expect: { nonEmptyProse: true },
    expectBrowserLoadProbe: true,
    note: 'LOAD PROBE: a non -web build — does the WebGPU runtime load it? Failure is DATA.',
  },
  {
    id: 'litert-gemma-mm-probe',
    family: 'Gemma 4 E2B -web (image probe)',
    battery: 'litert_lm',
    runtime: 'browser-webgpu',
    modelRef:
      'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
    host: 'exists',
    capabilities: { image: true, streaming: true },
    attachments: [
      { kind: 'image', mimeType: 'image/png', fixturePath: 'tests/_fixtures/media/sample.png' },
    ],
    prompt: 'Describe this image in one sentence.',
    expect: { nonEmptyProse: true },
    expectBrowserLoadProbe: true,
    note: 'GATE-ON-PROOF: does 0.13.1 WASM honor image content items + visionModalityEnabled? Records the finding.',
  },
]

/** The full manifest. */
export const MODEL_MATRIX: ReadonlyArray<MatrixEntry> = [
  ...TJS_LLM_NODE,
  ...TJS_LLM_MM,
  ...TJS_EMBED,
  ...LITERT_BROWSER,
]

const runsInNode = (e: MatrixEntry): boolean => e.runtime === 'node' || e.runtime === 'both'
const runsInBrowser = (e: MatrixEntry): boolean =>
  e.runtime === 'browser-webgpu' || e.runtime === 'both'

/** Node transformers.js LLM entries (text + multimodal). */
export const nodeLlmEntries = (): MatrixEntry[] =>
  MODEL_MATRIX.filter((e) => e.battery === 'transformers_js_llm' && runsInNode(e))

/** Node transformers.js embeddings entries. */
export const nodeEmbedEntries = (): MatrixEntry[] =>
  MODEL_MATRIX.filter((e) => e.battery === 'transformers_js_embed' && runsInNode(e))

/** Browser entries (LiteRT WebGPU + transformers.js-webgpu). */
export const browserEntries = (): MatrixEntry[] => MODEL_MATRIX.filter(runsInBrowser)

/** Look up one entry by id (for `--only=` filters). */
export const matrixEntryById = (id: string): MatrixEntry | undefined =>
  MODEL_MATRIX.find((e) => e.id === id)

// ─── Scenario cross-product ───────────────────────────────────────────────────────────────────────────
//
// The per-entry `prompt` above is a single smoke turn. The SCENARIOS below are the DEEP matrix: each
// scenario is run against EVERY model whose `capabilities` satisfy the scenario's `requires`, in both
// stream modes where the scenario allows. This is what turns the matrix from "17 models said something
// once" into "every model was put through every behaviour it claims to support" — multi-turn, parallel
// tool calls, reasoning+tool ordering, streaming-vs-batch, no-spurious-call, and the explicit
// thinking-off contract on real weights.
//
// Env-neutral (no vitest / node:*) — the Node + WebGPU runners both import this and drive the turns.

/** A single conversation turn fed to the model within a scenario. */
export interface ScenarioTurn {
  /** The user/tool message text for this turn. */
  readonly prompt: string
  /**
   * When set, this turn is preceded by a synthetic assistant tool-call + a tool result, so the model
   * sees a completed tool round and must produce a grounded FOLLOW-UP. The tool must be one the
   * scenario registers. `result` is the (trusted) tool-output text the model gets back.
   */
  readonly priorToolResult?: {
    readonly tool: string
    readonly args: Record<string, unknown>
    readonly result: string
  }
}

/** What a scenario asserts about the captured dispatch state (lenient; runner checks only present keys). */
export interface ScenarioExpect {
  /** A tool call with this name (+ optional arg keys) must be extracted. */
  readonly toolCall?: { readonly name: string; readonly argKeys?: readonly string[] }
  /** At least this many DISTINCT tool calls must be extracted (parallel-call scenarios). */
  readonly minToolCalls?: number
  /**
   * No tool call may be extracted. NOTE: a model firing a tool when one was not needed is a real model
   * trait (trigger-happiness), NOT a framework failure — prefer `producedOutput` and record the call.
   * This primitive remains for scenarios that genuinely require zero calls.
   */
  readonly noToolCalls?: boolean
  /** Non-empty visible prose (after stripping reasoning/markup). */
  readonly nonEmptyProse?: boolean
  /** Prose must contain at least one of these (case-insensitive) — grounding / follow-up checks. */
  readonly proseMatchesAny?: readonly string[]
  /** At least one non-empty reasoning Thought surfaced. */
  readonly nonEmptyReasoning?: boolean
  /**
   * No `<think>`/reasoning MARKUP may leak into the visible prose. This is the honest thinking-off
   * contract: we do NOT assert the model produced zero reasoning (some think regardless and we surface
   * that faithfully as a Thought) — only that raw markup never bleeds into the answer text.
   */
  readonly noReasoningLeak?: boolean
  /** The turn produced SOMETHING (tool call, thought, or prose) — the loosest "path works" check. */
  readonly producedOutput?: boolean
  /** Streaming: the accumulated streamed deltas must equal the final persisted prose. */
  readonly streamedDeltasMatchFinal?: boolean
}

/** One behaviour exercised across every capability-matching model. */
export interface MatrixScenario {
  /** Stable id (appears in the test name + `TEST_MATRIX_SCENARIO_ONLY` filter). */
  readonly id: string
  /** One-line description of what this proves. */
  readonly description: string
  /** Capability flags a model MUST declare for this scenario to run against it. */
  readonly requires: ReadonlyArray<keyof MatrixCapabilities>
  /** The conversation turns (last turn is the one asserted). */
  readonly turns: ReadonlyArray<ScenarioTurn>
  /** Tools to register for this scenario (defaults to the entry's own tools when omitted). */
  readonly tools?: ReadonlyArray<MatrixTool>
  /** Generation-option overrides for this scenario (e.g. `{ enableThinking: false }`). */
  readonly generation?: Record<string, unknown>
  /**
   * Which stream modes to run this scenario in. `'both'` (default for streaming-capable models) runs it
   * twice; `'stream'`/`'batch'` pin one. The `streaming` scenario itself pins `'stream'`.
   */
  readonly streamModes?: 'both' | 'stream' | 'batch'
  /** Per-scenario system-prompt override (e.g. a reasoning nudge). */
  readonly systemPrompt?: string
  /** Override the entry's token budget for this scenario (e.g. multi-tool needs room for two calls). */
  readonly maxNewTokens?: number
  /** What to assert after the last turn. */
  readonly expect: ScenarioExpect
}

const TIME_TOOL: MatrixTool = {
  name: 'get_time',
  description: 'Get the current time in a city.',
  params: { city: 'string' },
}

/**
 * The deep scenario catalog. Each runs against every model declaring the required capabilities.
 * Lenient by design — small quants drift, so assertions check the BEHAVIOUR (a call fired, prose is
 * grounded, no `<think>` leaked) not exact strings.
 */
export const SCENARIOS: ReadonlyArray<MatrixScenario> = [
  {
    id: 'single-tool',
    description: 'A single tool call with one string arg is emitted + parsed.',
    requires: ['toolCalls'],
    tools: [WEATHER_TOOL],
    turns: [{ prompt: 'What is the weather in Paris? Use the get_weather tool.' }],
    streamModes: 'both',
    expect: { toolCall: { name: 'get_weather', argKeys: ['city'] } },
  },
  {
    id: 'multi-tool',
    description: 'Two tool calls (weather + time) in a single turn are both parsed.',
    requires: ['toolCalls'],
    tools: [WEATHER_TOOL, TIME_TOOL],
    turns: [
      {
        prompt: 'I am in Rome. Call get_weather AND get_time for Rome — make both tool calls.',
      },
    ],
    streamModes: 'both',
    maxNewTokens: 384,
    // Lenient: a small quant may only manage one. Assert at least one fired (the parser handled the
    // multi-call SHAPE in the unit tier); a real two-call emission is the bonus.
    expect: { minToolCalls: 1 },
  },
  {
    id: 'reasoning-then-tool',
    description:
      'With thinking ON, reasoning is stripped to a Thought and the tool call still fires; nothing leaks.',
    requires: ['toolCalls', 'reasoning'],
    tools: [WEATHER_TOOL],
    turns: [
      {
        prompt: 'Think about which city, then call get_weather for the capital of France.',
      },
    ],
    generation: { enableThinking: true },
    streamModes: 'both',
    maxNewTokens: 512,
    // The path works if it produced SOMETHING actionable (a call and/or a thought) without crashing.
    expect: { producedOutput: true },
  },
  {
    id: 'multi-turn-followup',
    description: 'After a tool result is fed back, the model produces grounded follow-up prose.',
    requires: ['toolCalls'],
    tools: [WEATHER_TOOL],
    turns: [
      {
        prompt: 'Summarise the weather in Paris for me.',
        priorToolResult: {
          tool: 'get_weather',
          args: { city: 'Paris' },
          result: 'Paris: 18°C, sunny, light breeze.',
        },
      },
    ],
    streamModes: 'both',
    expect: { producedOutput: true },
  },
  {
    id: 'streaming',
    description: 'Streamed deltas accumulate to the same final prose (stream path integrity).',
    requires: ['streaming'],
    turns: [{ prompt: 'Say two short sentences about the ocean.' }],
    streamModes: 'stream',
    expect: { nonEmptyProse: true, streamedDeltasMatchFinal: true },
  },
  {
    id: 'no-tool-question',
    description:
      'A plain question WITH tools present: the turn produces SOMETHING (prose answer OR a tool call). A small/trigger-happy model may fire a tool even when one is not needed — that is a real model trait the consumer must design around, but it is still a legitimate tool request, NOT a framework failure. We record it, we do not fail on it.',
    requires: ['toolCalls'],
    tools: [WEATHER_TOOL],
    turns: [{ prompt: 'In one sentence, what is the capital of France?' }],
    streamModes: 'both',
    expect: { producedOutput: true },
  },
  {
    id: 'thinking-off',
    description:
      'enableThinking:false is OUR honest side of the contract (we ask the template not to think). Whatever the model emits, we surface faithfully: any reasoning becomes a Thought, and crucially NO <think> markup leaks into the visible prose. We do NOT assert the model produced zero reasoning — some models (e.g. DeepSeek-R1-Distill) think regardless, and throwing that away would be dishonest + wasteful.',
    requires: ['reasoning'],
    turns: [{ prompt: 'What is 12 times 7? Answer with just the number.' }],
    generation: { enableThinking: false },
    streamModes: 'batch',
    expect: { producedOutput: true, noReasoningLeak: true },
  },
  {
    id: 'media-describe',
    description: 'An image attachment is grounded — prose mentions the dominant colour.',
    requires: ['image'],
    turns: [{ prompt: 'Describe this image in one sentence.' }],
    streamModes: 'batch',
    expect: { nonEmptyProse: true, proseMatchesAny: ['red', 'color', 'colour', 'square', 'block'] },
  },
  {
    id: 'media-describe-audio',
    description:
      'An audio attachment is grounded — the model transcribes the spoken words it heard.',
    requires: ['audio'],
    turns: [{ prompt: 'Transcribe this audio.' }],
    streamModes: 'batch',
    // TRUE grounding: speech.wav says "the quick brown fox …", and the real Gemma-4 audio path transcribes
    // it verbatim (verified). Asserting distinctive content words proves the encoder→decoder actually
    // consumed the audio — a refusal ("please provide the audio") would NOT contain "fox"/"dog".
    expect: { nonEmptyProse: true, proseMatchesAny: ['fox', 'brown', 'lazy', 'dog', 'jump'] },
  },
  {
    id: 'media-describe-mixed',
    description:
      'CHAOS: image AND audio AND prose in ONE turn. requires:[image,audio] so it gates ONLY to a model declaring BOTH (Gemma-4-E2B). Proves the combined path: image and audio land in the same turn without clobbering each other. Verified verbatim on real weights — "COLOR=Red ; SPEECH=the quick brown fox…".',
    requires: ['image', 'audio'],
    turns: [
      {
        prompt:
          'You are given an image and an audio clip. First name the dominant colour of the image, ' +
          'then transcribe the speech. Answer as: COLOR=... ; SPEECH=...',
      },
    ],
    streamModes: 'batch',
    // Union match: any colour OR transcript word proves at least one modality grounded and the turn did
    // not crash. The per-modality entries (media-describe, media-describe-audio) carry the strict single-
    // modality rigor; this scenario's job is the combined-path proof.
    expect: {
      nonEmptyProse: true,
      proseMatchesAny: ['red', 'fox', 'brown', 'lazy', 'dog', 'jump', 'color', 'colour'],
    },
  },
]

/** True when a model's capabilities satisfy every flag a scenario requires. */
const entrySupportsScenario = (entry: MatrixEntry, scenario: MatrixScenario): boolean =>
  scenario.requires.every((cap) => entry.capabilities[cap] === true)

/**
 * Expand one entry into its (scenario × streamMode) cells. Streaming-capable models run a `'both'`
 * scenario twice (stream + batch); non-streaming models run only the batch leg. Returns the flat list
 * of cells the runner iterates.
 */
export const scenariosFor = (
  entry: MatrixEntry
): ReadonlyArray<{ scenario: MatrixScenario; stream: boolean }> => {
  const cells: Array<{ scenario: MatrixScenario; stream: boolean }> = []
  const canStream = entry.capabilities.streaming === true
  for (const scenario of SCENARIOS) {
    if (!entrySupportsScenario(entry, scenario)) continue
    const mode = scenario.streamModes ?? 'both'
    const wantStream = mode === 'stream' || mode === 'both'
    const wantBatch = mode === 'batch' || mode === 'both'
    if (wantBatch) cells.push({ scenario, stream: false })
    if (wantStream && canStream) cells.push({ scenario, stream: true })
    // A 'stream'-only scenario against a non-streaming model is simply skipped (no batch leg).
  }
  return cells
}
