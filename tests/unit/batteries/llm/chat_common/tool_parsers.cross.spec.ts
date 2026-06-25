import { describe, expect, it } from 'vitest'
import {
  hermesToolCallParser,
  gemmaToolCallParser,
  gptOssToolCallParser,
  pythonicToolCallParser,
  llama3JsonToolCallParser,
  mistralToolCallParser,
  qwen3CoderToolCallParser,
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

  it('gemma: <|tool_call>call:NAME{key:<|"|>val<|"|>}<tool_call|>', () => {
    const raw = 'Sure.<|tool_call>call:get_weather{city:<|"|>Bern<|"|>}<tool_call|>'
    const r = gemmaToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'get_weather', arguments: { city: 'Bern' } }])
    expect(r.cleanedText).toBe('Sure.')
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

  it('pythonic: rejects unknown callee (false-positive guard)', () => {
    const raw = "[not_a_real_tool(x='y')]"
    expect(pythonicToolCallParser(raw, CTX).calls).toHaveLength(0)
  })

  it('llama3_json: bare {name, parameters} with callee guard', () => {
    const raw = '{"name": "search", "parameters": {"q": "hello"}}'
    const r = llama3JsonToolCallParser(raw, CTX)
    expect(r.calls).toEqual([{ name: 'search', arguments: { q: 'hello' } }])
    expect(r.cleanedText).toBe('')
  })

  it('llama3_json: rejects JSON whose name is not a real tool', () => {
    const raw = '{"name": "totally_fake", "parameters": {}}'
    expect(llama3JsonToolCallParser(raw, CTX).calls).toHaveLength(0)
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
  })

  it('returns no-match on plain prose', () => {
    const r = auto('Just a normal answer.', CTX)
    expect(r.calls).toHaveLength(0)
    expect(r.cleanedText).toBe('Just a normal answer.')
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
