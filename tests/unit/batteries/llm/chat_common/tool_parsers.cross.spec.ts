import { describe, expect, it } from 'vitest'
import {
  hermesToolCallParser,
  gemmaToolCallParser,
  gptOssToolCallParser,
  pythonicToolCallParser,
  barePythonicToolCallParser,
  looseKeyedToolCallParser,
  llama3JsonToolCallParser,
  mistralToolCallParser,
  qwen3CoderToolCallParser,
  phiToolCallParser,
  noneToolCallParser,
  createAutoToolCallParser,
  resolveToolCallParser,
  type ToolCallParserContext,
} from '@nhtio/adk/batteries/llm/transformers_js'

const CTX: ToolCallParserContext = { toolNames: ['get_weather', 'get_time', 'search'] }

// ─── per-family extraction (real captured formats) ───────────────────────────────────────────────────

describe('tool parsers — per-family extraction', () => {
  it('hermes: <tool_call>{json}</tool_call>', () => {
    const raw =
      'Let me check.\n<tool_call>{"name": "get_weather", "arguments": {"city": "NYC"}}</tool_call>'
    const r = hermesToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'NYC' } }])
    expect(r.cleanedText).toBe('Let me check.')
  })

  it('hermes: parallel calls', () => {
    const raw =
      '<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call><tool_call>{"name":"get_time","arguments":{}}</tool_call>'
    const r = hermesToolCallParser(raw, CTX)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]).toEqual({ name: 'get_time', arguments: {} })
  })

  it('gemma: <|tool_call>call:NAME{key:<|"|>val<|"|>}<tool_call|> (template form)', () => {
    const raw = 'Sure.<|tool_call>call:get_weather{city:<|"|>Bern<|"|>}<tool_call|>'
    const r = gemmaToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Bern' } }])
    expect(r.cleanedText).toBe('Sure.')
  })

  it('gemma: bare call:NAME{key:value} (decoder-STRIPPED runtime form — real E2B output)', () => {
    // What a real onnx-community/gemma-4-E2B-it-ONNX run emits (special tokens removed, value unquoted).
    const raw = 'call:get_weather{city:Paris}'
    const r = gemmaToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: stripped form preserves numeric + boolean scalars as JSON types', () => {
    const raw = 'call:set_temp{value:21, active:true}'
    const r = gemmaToolCallParser(raw, { toolNames: ['set_temp'] })
    expect(r.calls).toEqual([{ name: 'set_temp', arguments: { value: 21, active: true } }])
  })

  it('gemma: a digit-LED but non-numeric bare value (UUID callId) is quoted, not dropped', () => {
    // Raw-captured from Gemma-4 E2B on LiteRT-web reading a forged artifact handle. The bare value
    // `1f173d33-2585-…` STARTS with a digit but is NOT a JSON number — the old `^[\d-]` guard left it
    // unquoted (`{"callId":1f173d33-…}`), JSON.parse failed, the call was dropped, it leaked as prose,
    // and the model re-emitted the identical `artifact_head` call forever (the duplicate-call gate
    // never fired because nothing parsed). The fix matches a COMPLETE JSON number instead.
    const raw = 'call:artifact_head{callId:1f173d33-2585-6720-a37e-7238969a2236,n:10}'
    const r = gemmaToolCallParser(raw, { toolNames: ['artifact_head'] })
    expect(r.calls).toEqual([
      {
        name: 'artifact_head',
        arguments: { callId: '1f173d33-2585-6720-a37e-7238969a2236', n: 10 },
      },
    ])
  })

  it('gemma: single-key UUID callId (artifact_cat) parses (the value is a digit-led non-number)', () => {
    const raw = 'call:artifact_cat{callId:1f173d33-2585-6720-a37e-7238969a2236}'
    const r = gemmaToolCallParser(raw, { toolNames: ['artifact_cat'] })
    expect(r.calls).toEqual([
      { name: 'artifact_cat', arguments: { callId: '1f173d33-2585-6720-a37e-7238969a2236' } },
    ])
  })

  it('gemma: NESTED args + curly smart quotes (real E4B provide_answer — captured verbatim)', () => {
    // Raw-captured from Gemma-4 E4B on LiteRT-web answering a doc question. The OLD single-level
    // `\{[^{}]*\}` regex dropped this whole call (nested `sources:[{…}]`), so a CORRECT, grounded,
    // cited answer leaked as prose and read like a failure/abstention. The arg block nests an array of
    // objects and uses curly `<|“|>`/`<|”|>` delimiter tokens + bare `“ ”` string glyphs throughout.
    const raw =
      '<|tool_call>call:provide_answer{answer:<|“|>The TurnRunner executes the agent’s turn ' +
      'lifecycle.<|”|>,sources:[{path: “/the-loop/turn-runner”, title: “Turn Runner”},' +
      '{path: “/api/turn_runner”, title: “Class: TurnRunner”}]}<tool_call|>'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer', 'say_i_dont_know'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer: 'The TurnRunner executes the agent’s turn lifecycle.',
          sources: [
            { path: '/the-loop/turn-runner', title: 'Turn Runner' },
            { path: '/api/turn_runner', title: 'Class: TurnRunner' },
          ],
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: nested args also parse in the decoder-STRIPPED bare form (no wrapper, straight quotes)', () => {
    const raw = 'call:provide_answer{answer:"Done.",sources:[{path:"/x",title:"X"}]}'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: { answer: 'Done.', sources: [{ path: '/x', title: 'X' }] },
      },
    ])
  })

  it('gemma: top-level key assigned with `=` instead of `:` (real E2B provide_answer — captured verbatim)', () => {
    // Live capture (Gemma-4 E2B, WebGPU, 2026-06-30): the model emitted a well-formed provide_answer
    // call but used `answer=` (EQUALS) for the top-level key while `sources`/`path` used `:`. The `=`
    // meant the key was never quoted, the object failed JSON.parse, and the whole cited answer leaked as
    // prose. normaliseGemmaKeySeparators rewrites the structural `=` to `:` so it parses. Straight quotes
    // throughout — the curly quotes seen in the rendered bubble were the docs markdown processor, NOT the
    // model (verified against the raw generation trace).
    const raw =
      '<|tool_call>call:provide_answer{answer="ADK is an execution chassis you assemble yourself, ' +
      'meaning you own the implementation details like tools and storage mapping.",' +
      'sources:[{path:"/assembly/Division of Ownership"},{path:"/assembly/The Chassis Contract"},' +
      '{path:"/assembly/byo-llm-2"}]}<tool_call|>'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer:
            'ADK is an execution chassis you assemble yourself, meaning you own the implementation ' +
            'details like tools and storage mapping.',
          sources: [
            { path: '/assembly/Division of Ownership' },
            { path: '/assembly/The Chassis Contract' },
            { path: '/assembly/byo-llm-2' },
          ],
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: an `=` INSIDE a string value is NOT treated as a key separator', () => {
    // Guard: the `=`→`:` normalisation must be quote-aware. A value containing `=` (here a code snippet)
    // must survive untouched — only a structural `identifier=` in key position is rewritten.
    const raw =
      'call:provide_answer{answer:"Set it with const x = new TurnRunner().",sources:[{path:"/x"}]}'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer: 'Set it with const x = new TurnRunner().',
          sources: [{ path: '/x' }],
        },
      },
    ])
  })

  it('gemma: wrapped form with the OUTER `}` OMITTED — `…}]<tool_call|>` (real E4B output)', () => {
    // The decisive live-captured shape: the model closes the nested `sources` array+objects but DROPS the
    // outer object `}` and lets `<tool_call|>` terminate the call (3 `{`, 2 `}`). The wrapped-form
    // boundary falls back to the wrapper tail and closeUnbalancedJson repairs the missing closer. Values
    // also carry markdown backticks + a literal apostrophe, which must survive inside the string.
    // A real multi-paragraph answer also carries LITERAL newlines (a `\n\n` between paragraphs), which
    // JSON.parse rejects inside a string unless escaped — canonicaliseGemmaStrings escapes them.
    const raw =
      '<|tool_call>call:provide_answer{answer:<|"|>The `TurnRunner` runs the agent\'s turn ' +
      'lifecycle.\n\nSee the docs.<|"|>,sources:[{path: "/api/turn_runner.html", ' +
      'title: "Class: TurnRunner", "section": "Methods"},' +
      '{path: "/the-loop/turn-runner.html", title: "Turn Runner"}]<tool_call|>'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer: "The `TurnRunner` runs the agent's turn lifecycle.\n\nSee the docs.",
          sources: [
            { path: '/api/turn_runner.html', title: 'Class: TurnRunner', section: 'Methods' },
            { path: '/the-loop/turn-runner.html', title: 'Turn Runner' },
          ],
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: PREFIX-LESS bare form `NAME{…}` with no `call:` lead, gated on toolNames (real E2B/E4B)', () => {
    // Raw-captured: `say_i_dont_know{reason: "…"}` — the model dropped the `call:` lead entirely. Gated
    // on toolNames so a stray `word{` in prose can't false-match; an offered tool name opens the call.
    const raw =
      'say_i_dont_know{reason: "The available tools do not contain a general-purpose arithmetic tool."}'
    const r = gemmaToolCallParser(raw, {
      toolNames: ['provide_answer', 'say_i_dont_know'],
    })
    expect(r.calls).toEqual([
      {
        name: 'say_i_dont_know',
        arguments: {
          reason: 'The available tools do not contain a general-purpose arithmetic tool.',
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: prefix-less form does NOT fire without a toolNames gate (prose safety)', () => {
    // `config{retries: 3}` looks like a prefix-less call but is just prose — no gate ⇒ no claim.
    const raw = 'set the config{retries: 3} as needed'
    expect(gemmaToolCallParser(raw, { toolNames: [] }).calls).toEqual([])
    // …and even WITH a gate, a non-offered name is not claimed.
    expect(gemmaToolCallParser(raw, { toolNames: ['say_i_dont_know'] }).calls).toEqual([])
  })

  it('gemma: bare (unquoted) enum-ARRAY elements — `tools_to_use:[search_docs_semantic]` (real make_plan)', () => {
    // Live-captured verbatim from the in-browser planner: a `make_plan` call whose `tools_to_use` is an
    // array of BARE identifiers and whose `steps` are `<|"|>…<|"|>`-delimited strings. The key branch
    // (needs a following `:`) and the scalar-value branch (needs a leading `:`) both MISS an array
    // element — so `[search_docs_semantic]` stayed unquoted → invalid JSON → the whole planner call
    // failed to parse and leaked as prose. quoteBareGemmaTokens now quotes bare array elements too.
    const raw =
      'call:make_plan{answer_kind:doc_cited,tools_to_use:[search_docs_semantic],steps:[<|"|>Search ' +
      'the @nhtio/adk documentation for the core thesis or main goal of the library.<|"|>,<|"|>Analyze ' +
      'the search results to extract the most relevant passage describing the core thesis.<|"|>]}<tool_call|>'
    const r = gemmaToolCallParser(raw, {
      toolNames: ['make_plan', 'search_docs_semantic', 'provide_answer'],
    })
    expect(r.calls).toEqual([
      {
        name: 'make_plan',
        arguments: {
          answer_kind: 'doc_cited',
          tools_to_use: ['search_docs_semantic'],
          steps: [
            'Search the @nhtio/adk documentation for the core thesis or main goal of the library.',
            'Analyze the search results to extract the most relevant passage describing the core thesis.',
          ],
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: bare array elements — multi-element + empty + number arrays all stay well-typed', () => {
    // Multi-element enum array (each bare id quoted), an EMPTY array (no element branch fires), and a
    // numeric array (digits are JSON-ready, so they must stay UNquoted — not stringified).
    const multi = gemmaToolCallParser(
      'call:make_plan{answer_kind:doc_cited,tools_to_use:[search_docs_semantic,search_docs_keyword,provide_answer]}',
      { toolNames: ['make_plan'] }
    )
    expect(multi.calls[0]?.arguments).toEqual({
      answer_kind: 'doc_cited',
      tools_to_use: ['search_docs_semantic', 'search_docs_keyword', 'provide_answer'],
    })
    const empty = gemmaToolCallParser('call:make_plan{answer_kind:greeting,tools_to_use:[]}', {
      toolNames: ['make_plan'],
    })
    expect(empty.calls[0]?.arguments).toEqual({ answer_kind: 'greeting', tools_to_use: [] })
    const nums = gemmaToolCallParser('call:rank{scores:[1,2,3]}', { toolNames: ['rank'] })
    expect(nums.calls[0]?.arguments).toEqual({ scores: [1, 2, 3] })
  })

  it('gemma: TRIPLE-QUOTE value opener — `provide_answer{answer:"""# …}` (real E2B — captured verbatim)', () => {
    // Live capture (Gemma-4 E2B, WebGPU, 2026-07-01): the model opened the `answer` value with a
    // Python-style TRIPLE quote `"""`. The old canonicaliser toggled string-state on EACH of the three
    // quotes → `answer:""` (empty string) + `#…` garbage → JSON.parse failed → the whole cited answer was
    // dropped and leaked as malformed prose (which then threw downstream: E_LLM_EXECUTION_EXECUTOR_ERROR).
    // A run of consecutive quote delimiters must collapse to a SINGLE opening quote.
    const raw =
      '<|tool_call>call:provide_answer{answer:"""# Comprehensive Overview of @nhtio/adk\n\n' +
      'The library provides a framework for building AI systems.""",sources:[{path:"/assembly",title:"Assembly"}]}<tool_call|>'
    const r = gemmaToolCallParser(raw, { toolNames: ['provide_answer'] })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer:
            '# Comprehensive Overview of @nhtio/adk\n\nThe library provides a framework for building AI systems.',
          sources: [{ path: '/assembly', title: 'Assembly' }],
        },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('gemma: `<|"|>`-delimited elements inside a make_plan array + steps (real E2B — captured verbatim)', () => {
    // Live capture (2026-07-01): make_plan emitted `<|"|>`-wrapped string elements inside `tools_to_use`
    // AND `steps` arrays. Each `<|"|>` is a decoder-leaked quote delimiter and must canonicalise to a
    // normal quoted string element — not unbalance the array scan.
    const raw =
      'call:make_plan{answer_kind:doc_cited,answer_scope:brief,' +
      'tools_to_use:[<|"|>search_docs_semantic<|"|>],' +
      'steps:[<|"|>Search the docs for the core loop.<|"|>,<|"|>Synthesize the answer.<|"|>]}'
    const r = gemmaToolCallParser(raw, { toolNames: ['make_plan'] })
    expect(r.calls[0]?.arguments).toEqual({
      answer_kind: 'doc_cited',
      answer_scope: 'brief',
      tools_to_use: ['search_docs_semantic'],
      steps: ['Search the docs for the core loop.', 'Synthesize the answer.'],
    })
  })

  it('gemma: TRUNCATED provide_answer (long answer overran the output cap — unterminated string, no closers)', () => {
    // Live capture (Gemma-4 E2B, WebGPU, 2026-07-01): a broad "give me an overview" request produced a
    // long `provide_answer{answer:"""# …` whose body overran the output-token cap — the generation ended
    // MID-VALUE with no closing `"""`, no `}`, no `<tool_call|>`. collectGemmaCalls used to DROP such a
    // call (brace scan fails, no wrapper tail), so the truncated answer leaked and the turn threw
    // E_LLM_EXECUTION_EXECUTOR_ERROR. Now: consume to end-of-string, closeUnbalancedJson closes the
    // dangling string + missing brace, and the partial answer COMMITS instead of taking the turn down.
    const wrapped = gemmaToolCallParser(
      '<|tool_call>call:provide_answer{answer:"""# Overview\n\nThe library provides a framework for building apps and it kept going until it was cut',
      { toolNames: ['provide_answer'] }
    )
    expect(wrapped.calls).toHaveLength(1)
    expect(wrapped.calls[0]?.name).toBe('provide_answer')
    expect(String(wrapped.calls[0]?.arguments.answer)).toContain('# Overview')
    expect(String(wrapped.calls[0]?.arguments.answer)).toContain('cut')

    // Same for the decoder-stripped bare head.
    const bare = gemmaToolCallParser('call:provide_answer{answer:"""Body text that was truncated', {
      toolNames: ['provide_answer'],
    })
    expect(bare.calls).toHaveLength(1)
    expect(String(bare.calls[0]?.arguments.answer)).toContain('Body text that was truncated')
  })

  it('gemma: truncation fallback does NOT swallow trailing prose after a properly-closed call', () => {
    // Guard: the end-of-string fallback only fires when the brace scan genuinely fails. A well-formed
    // closed call must parse exactly and leave the trailing prose alone (not absorb it into the args).
    const r = gemmaToolCallParser(
      'call:provide_answer{answer:"Done.",sources:[{path:"/x"}]} and here is trailing prose.',
      { toolNames: ['provide_answer'] }
    )
    expect(r.calls).toEqual([
      { name: 'provide_answer', arguments: { answer: 'Done.', sources: [{ path: '/x' }] } },
    ])
  })

  it('gpt_oss: harmony commentary channel', () => {
    const raw =
      '<|channel|>commentary to=functions.get_weather <|constrain|>json<|message|>{"city":"SF"}<|call|>'
    const r = gptOssToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'SF' } }])
  })

  it('pythonic: [name(k=v), ...] with callee guard', () => {
    const raw = "[get_weather(city='San Francisco', metric='celsius'), get_time()]"
    const r = pythonicToolCallParser(raw, CTX)
    expect(r.calls).toEqual([
      { name: 'get_weather', arguments: { city: 'San Francisco', metric: 'celsius' } },
      { name: 'get_time', arguments: {} },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('pythonic: surfaces an unknown callee (authorization is downstream, not the parser)', () => {
    // The `[fn(args)]` whole-output shape disambiguates structurally; it is NOT an allowlist. Whether a
    // tool is permitted is the consumer/dispatch decision, so an unknown callee is reported, not dropped.
    const raw = "[not_a_real_tool(x='y')]"
    expect(pythonicToolCallParser(raw, CTX).calls).toEqual([
      { name: 'not_a_real_tool', arguments: { x: 'y' } },
    ])
  })

  it('bare_pythonic: NAME(k=v) without [ ] wrapper, gated on toolNames', () => {
    // Real onnx-community/gemma-4-E2B-it-ONNX output: a single pythonic call with NO list wrapper,
    // a leading "/", and SMART QUOTES around the args (the format the flagship hit live).
    const raw =
      '/provide_answer(answer=“A dispatch ends in exactly one terminal signal.”, sources=[“/the-loop/llm-dispatch”])'
    const r = barePythonicToolCallParser(raw, {
      toolNames: ['provide_answer', 'say_i_dont_know'],
    })
    expect(r.calls).toEqual([
      {
        name: 'provide_answer',
        arguments: {
          answer: 'A dispatch ends in exactly one terminal signal.',
          sources: ['/the-loop/llm-dispatch'],
        },
      },
    ])
  })

  it('bare_pythonic: gate rejects a bare call to an unoffered tool (prose safety)', () => {
    // Without the [ ] structural signal, the callee∈toolNames gate is what prevents incidental
    // prose like "see configure(x)" from false-positiving.
    const raw = 'You can call configure(option="x") to set it up.'
    expect(barePythonicToolCallParser(raw, CTX).calls).toEqual([])
  })

  it('bare_pythonic: empty toolNames declines (no gate ⇒ no claim)', () => {
    const raw = 'provide_answer(answer="hi", sources=["/x"])'
    expect(barePythonicToolCallParser(raw, { toolNames: [] }).calls).toEqual([])
  })

  it('loose_keyed: bare `name` line + `key: value` lines (the Gemma-4 E2B/LiteRT live form)', () => {
    // Raw-captured verbatim from Gemma-4 E2B on LiteRT-web: the model ignores every structured grammar
    // and emits the bare tool name then `arg: value` lines.
    const raw = 'say_i_dont_know\nreason: The documentation does not contain a definition for that.'
    const r = looseKeyedToolCallParser(raw, { toolNames: ['provide_answer', 'say_i_dont_know'] })
    expect(r.calls).toEqual([
      {
        name: 'say_i_dont_know',
        arguments: { reason: 'The documentation does not contain a definition for that.' },
      },
    ])
    expect(r.cleanedText).toBe('')
  })

  it('loose_keyed: coerces scalar arg types (number/bool) and strips quotes', () => {
    const raw = 'set_temp\ncity: "Paris"\ndegrees: 21\nmetric: true'
    const r = looseKeyedToolCallParser(raw, { toolNames: ['set_temp'] })
    expect(r.calls[0]).toEqual({
      name: 'set_temp',
      arguments: { city: 'Paris', degrees: 21, metric: true },
    })
  })

  it('loose_keyed: gate — first line must be EXACTLY a known tool name (prose safety)', () => {
    // A heading-with-colon or prose must not be misread as a call.
    expect(looseKeyedToolCallParser('Note:\nreason: just a note', CTX).calls).toEqual([])
    expect(looseKeyedToolCallParser('Here is what I found\nsource: /x', CTX).calls).toEqual([])
  })

  it('loose_keyed: bare name with NO key:value lines is too weak to claim', () => {
    expect(
      looseKeyedToolCallParser('say_i_dont_know', { toolNames: ['say_i_dont_know'] }).calls
    ).toEqual([])
  })

  it('loose_keyed: empty toolNames declines (no gate ⇒ no claim)', () => {
    expect(looseKeyedToolCallParser('say_i_dont_know\nreason: x', { toolNames: [] }).calls).toEqual(
      []
    )
  })

  it('llama3_json: bare {name, parameters}', () => {
    const raw = '{"name": "search", "parameters": {"q": "hello"}}'
    const r = llama3JsonToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'search', arguments: { q: 'hello' } }])
    expect(r.cleanedText).toBe('')
  })

  it('llama3_json: surfaces JSON whose name is not a registered tool (authorization is downstream)', () => {
    // Structural disambiguation only — a whole-output object with a string `name` is a call. Allowing or
    // rejecting an unknown tool is the dispatch layer's job (it replies "Tool not found: …").
    const raw = '{"name": "totally_fake", "parameters": {}}'
    expect(llama3JsonToolCallParser(raw, CTX).calls).toEqual([
      { name: 'totally_fake', arguments: {} },
    ])
  })

  it('llama3_json: un-fences a ```json {name, arguments} ``` block (real Qwen2.5-Coder-0.5B form)', () => {
    const raw =
      '```json\n{\n  "name": "get_weather",\n  "arguments": {\n    "city": "Oslo"\n  }\n}\n```'
    const r = llama3JsonToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Oslo' } }])
  })

  it('mistral: [TOOL_CALLS] + JSON array', () => {
    const raw = '[TOOL_CALLS] [{"name": "get_time", "arguments": {}}]'
    const r = mistralToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_time', arguments: {} }])
  })

  it('qwen3_coder: per-parameter XML', () => {
    const raw =
      '<tool_call><function=get_weather><parameter=city>Tokyo</parameter></function></tool_call>'
    const r = qwen3CoderToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Tokyo' } }])
  })

  it('phi: functools[{name, arguments}] (Phi-4-mini)', () => {
    const raw = 'functools[{"name": "get_weather", "arguments": {"city": "Paris"}}]'
    const r = phiToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Paris' } }])
    expect(r.cleanedText).toBe('')
  })

  it('phi: parallel calls + leading/trailing prose', () => {
    const raw =
      'Sure thing. functools[{"name":"get_weather","arguments":{"city":"NYC"}}, {"name":"get_time","arguments":{}}] done'
    const r = phiToolCallParser(raw, CTX)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[1]).toEqual({ name: 'get_time', arguments: {} })
    expect(r.cleanedText).toBe('Sure thing.  done')
  })

  it('phi: tolerates a bracket inside a string argument (balanced scan)', () => {
    const raw = 'functools[{"name":"search","arguments":{"q":"a [bracket] in text"}}]'
    const r = phiToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'search', arguments: { q: 'a [bracket] in text' } }])
  })

  it('none: never matches', () => {
    const raw = '<tool_call>{"name":"get_weather","arguments":{}}</tool_call>'
    expect(noneToolCallParser(raw, CTX).calls).toHaveLength(0)
  })
})

// ─── no-match returns input verbatim ─────────────────────────────────────────────────────────────────

describe('tool parsers — no-match contract', () => {
  it('every parser returns { calls: [], cleanedText: rawText } on plain prose', () => {
    const raw = 'The weather in NYC is sunny and 72 degrees.'
    for (const p of [
      hermesToolCallParser,
      gemmaToolCallParser,
      gptOssToolCallParser,
      pythonicToolCallParser,
      llama3JsonToolCallParser,
      mistralToolCallParser,
      qwen3CoderToolCallParser,
      phiToolCallParser,
    ]) {
      const r = p(raw, CTX)
      expect(r.calls).toHaveLength(0)
      expect(r.cleanedText).toBe(raw)
    }
  })
})

// ─── cross-family no-false-positive ──────────────────────────────────────────────────────────────────

describe('tool parsers — cross-family isolation', () => {
  it('hermes output does NOT match pythonic / llama3_json / mistral / qwen3_coder', () => {
    const hermes = '<tool_call>{"name":"get_weather","arguments":{"city":"NYC"}}</tool_call>'
    expect(pythonicToolCallParser(hermes, CTX).calls).toHaveLength(0)
    expect(llama3JsonToolCallParser(hermes, CTX).calls).toHaveLength(0)
    expect(mistralToolCallParser(hermes, CTX).calls).toHaveLength(0)
    expect(qwen3CoderToolCallParser(hermes, CTX).calls).toHaveLength(0)
  })

  it('pythonic output does NOT match hermes / llama3_json', () => {
    const pythonic = "[get_weather(city='NYC')]"
    expect(hermesToolCallParser(pythonic, CTX).calls).toHaveLength(0)
    expect(llama3JsonToolCallParser(pythonic, CTX).calls).toHaveLength(0)
  })

  it('llama3_json output does NOT match hermes / pythonic / mistral', () => {
    const json = '{"name":"search","parameters":{"q":"x"}}'
    expect(hermesToolCallParser(json, CTX).calls).toHaveLength(0)
    expect(pythonicToolCallParser(json, CTX).calls).toHaveLength(0)
    expect(mistralToolCallParser(json, CTX).calls).toHaveLength(0)
  })

  it('qwen3_coder output is NOT misread by hermes as JSON', () => {
    const qwen =
      '<tool_call><function=get_weather><parameter=city>Tokyo</parameter></function></tool_call>'
    // Hermes greedily matches <tool_call>…</tool_call> but the body is not JSON → declines.
    expect(hermesToolCallParser(qwen, CTX).calls).toHaveLength(0)
  })

  it('phi output (functools[...]) does NOT match hermes / mistral / pythonic', () => {
    const phi = 'functools[{"name":"get_weather","arguments":{"city":"NYC"}}]'
    expect(hermesToolCallParser(phi, CTX).calls).toHaveLength(0)
    expect(mistralToolCallParser(phi, CTX).calls).toHaveLength(0) // requires [TOOL_CALLS], absent
    expect(pythonicToolCallParser(phi, CTX).calls).toHaveLength(0)
  })

  it('phi does NOT claim mistral output (no functools token)', () => {
    const mistral = '[TOOL_CALLS] [{"name":"get_time","arguments":{}}]'
    expect(phiToolCallParser(mistral, CTX).calls).toHaveLength(0)
  })
})

// ─── auto driver precedence ──────────────────────────────────────────────────────────────────────────

describe('tool parsers — auto driver', () => {
  const auto = createAutoToolCallParser()

  it('routes each family output to the right parser', () => {
    expect(
      auto('<tool_call>{"name":"get_time","arguments":{}}</tool_call>', CTX).calls[0].name
    ).toBe('get_time')
    expect(
      auto('<|tool_call>call:get_weather{city:<|"|>NYC<|"|>}<tool_call|>', CTX).calls[0]
    ).toEqual({
      name: 'get_weather',
      arguments: { city: 'NYC' },
    })
    expect(auto('[get_time()]', CTX).calls[0].name).toBe('get_time')
    expect(auto('{"name":"search","parameters":{"q":"x"}}', CTX).calls[0].name).toBe('search')
    expect(
      auto('functools[{"name":"get_weather","arguments":{"city":"NYC"}}]', CTX).calls[0].name
    ).toBe('get_weather')
  })

  it('returns no-match on plain prose', () => {
    const r = auto('Just a normal answer.', CTX)
    expect(r.calls).toHaveLength(0)
    expect(r.cleanedText).toBe('Just a normal answer.')
  })

  it('routes the loose-keyed Gemma/LiteRT form to loose_keyed (no earlier family false-claims it)', () => {
    const raw = 'say_i_dont_know\nreason: not in the docs'
    const r = auto(raw, { toolNames: ['say_i_dont_know', 'provide_answer'] })
    expect(r.calls).toEqual([{ name: 'say_i_dont_know', arguments: { reason: 'not in the docs' } }])
    expect(r.cleanedText).toBe('')
  })

  it('first-wins by priority: hermes beats a bare-JSON misread', () => {
    // A hermes-wrapped call whose inner JSON is also a bare object — hermes (priority 1) claims it.
    const raw = '<tool_call>{"name":"search","arguments":{"q":"x"}}</tool_call>'
    const r = auto(raw, CTX)
    expect(r.calls).toEqual([{ name: 'search', arguments: { q: 'x' } }])
    expect(r.cleanedText).toBe('')
  })
})

// ─── resolveToolCallParser ───────────────────────────────────────────────────────────────────────────

describe('resolveToolCallParser', () => {
  it('undefined → auto', () => {
    expect(
      resolveToolCallParser(undefined)(
        '<tool_call>{"name":"get_time","arguments":{}}</tool_call>',
        CTX
      ).calls
    ).toHaveLength(1)
  })
  it("'none' → never matches", () => {
    expect(
      resolveToolCallParser('none')(
        '<tool_call>{"name":"get_time","arguments":{}}</tool_call>',
        CTX
      ).calls
    ).toHaveLength(0)
  })
  it('named → that family only', () => {
    const hermes = resolveToolCallParser('hermes')
    expect(hermes('[get_time()]', CTX).calls).toHaveLength(0)
    expect(
      hermes('<tool_call>{"name":"get_time","arguments":{}}</tool_call>', CTX).calls
    ).toHaveLength(1)
  })
  it('custom fn → used verbatim', () => {
    const custom = resolveToolCallParser(() => ({
      calls: [{ name: 'x', arguments: {} }],
      cleanedText: '',
    }))
    expect(custom('anything', CTX).calls[0].name).toBe('x')
  })
})
