import { describe, expect, it } from 'vitest'
import {
  thinkTagReasoningParser,
  harmonyAnalysisReasoningParser,
  gemmaChannelReasoningParser,
  noneReasoningParser,
  createAutoReasoningParser,
  resolveReasoningParser,
} from '@nhtio/adk/batteries/llm/transformers_js'

// ─── per-family extraction ───────────────────────────────────────────────────────────────────────────

describe('reasoning parsers — per-family extraction', () => {
  it('think_tag: <think>…</think> (Qwen3 / DeepSeek-R1)', () => {
    const raw = '<think>The user wants the capital. It is Paris.</think>The capital is Paris.'
    const r = thinkTagReasoningParser(raw)
    expect(r.reasoning).toEqual(['The user wants the capital. It is Paris.'])
    expect(r.cleanedText).toBe('The capital is Paris.')
  })

  it('think_tag: <thinking>…</thinking> variant', () => {
    const raw = '<thinking>hmm</thinking>answer'
    expect(thinkTagReasoningParser(raw).reasoning).toEqual(['hmm'])
  })

  it('harmony_analysis: gpt-oss analysis channel', () => {
    const raw =
      '<|channel|>analysis<|message|>Let me reason about this carefully.<|end|>The answer is 42.'
    const r = harmonyAnalysisReasoningParser(raw)
    expect(r.reasoning).toEqual(['Let me reason about this carefully.'])
    expect(r.cleanedText).toBe('The answer is 42.')
  })

  it('gemma_channel: <|channel>thought\\n…<channel|>', () => {
    const raw = '<|channel>thought\nThinking about Bern weather.<channel|>It is sunny in Bern.'
    const r = gemmaChannelReasoningParser(raw)
    expect(r.reasoning).toEqual(['Thinking about Bern weather.'])
    expect(r.cleanedText).toBe('It is sunny in Bern.')
  })

  it('gemma_channel: empty thought (thinking disabled) yields no reasoning', () => {
    const raw = '<|channel>thought\n<channel|>Just the answer.'
    const r = gemmaChannelReasoningParser(raw)
    expect(r.reasoning).toHaveLength(0)
    expect(r.cleanedText).toBe('Just the answer.')
  })

  it('none: never matches', () => {
    expect(noneReasoningParser('<think>x</think>y').reasoning).toHaveLength(0)
  })
})

// ─── no-match contract ───────────────────────────────────────────────────────────────────────────────

describe('reasoning parsers — no-match contract', () => {
  it('returns { reasoning: [], cleanedText: rawText } on plain prose', () => {
    const raw = 'A plain answer with no reasoning markup.'
    for (const p of [
      thinkTagReasoningParser,
      harmonyAnalysisReasoningParser,
      gemmaChannelReasoningParser,
    ]) {
      const r = p(raw)
      expect(r.reasoning).toHaveLength(0)
      expect(r.cleanedText).toBe(raw)
    }
  })
})

// ─── cross-family isolation ──────────────────────────────────────────────────────────────────────────

describe('reasoning parsers — cross-family isolation', () => {
  it('<think> does not match harmony / gemma', () => {
    const raw = '<think>x</think>y'
    expect(harmonyAnalysisReasoningParser(raw).reasoning).toHaveLength(0)
    expect(gemmaChannelReasoningParser(raw).reasoning).toHaveLength(0)
  })
  it('harmony does not match think_tag / gemma', () => {
    const raw = '<|channel|>analysis<|message|>x<|end|>y'
    expect(thinkTagReasoningParser(raw).reasoning).toHaveLength(0)
    expect(gemmaChannelReasoningParser(raw).reasoning).toHaveLength(0)
  })
})

// ─── auto driver ─────────────────────────────────────────────────────────────────────────────────────

describe('reasoning parsers — auto driver', () => {
  const auto = createAutoReasoningParser()
  it('routes each format', () => {
    expect(auto('<think>a</think>b').reasoning).toEqual(['a'])
    expect(auto('<|channel|>analysis<|message|>c<|end|>d').reasoning).toEqual(['c'])
    expect(auto('<|channel>thought\ne<channel|>f').reasoning).toEqual(['e'])
  })
  it('no-match on plain prose', () => {
    expect(auto('plain').reasoning).toHaveLength(0)
  })
})

describe('resolveReasoningParser', () => {
  it('undefined → auto', () => {
    expect(resolveReasoningParser(undefined)('<think>x</think>y').reasoning).toEqual(['x'])
  })
  it("'none' disables", () => {
    expect(resolveReasoningParser('none')('<think>x</think>y').reasoning).toHaveLength(0)
  })
  it('named → that parser', () => {
    expect(
      resolveReasoningParser('think_tag')('<|channel|>analysis<|message|>x<|end|>').reasoning
    ).toHaveLength(0)
  })
  it('custom fn', () => {
    expect(
      resolveReasoningParser(() => ({ reasoning: ['z'], cleanedText: '' }))('q').reasoning
    ).toEqual(['z'])
  })
})
