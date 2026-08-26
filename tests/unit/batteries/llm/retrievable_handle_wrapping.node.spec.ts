import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import * as ollama from '@nhtio/adk/batteries/llm/ollama'
import * as litert from '@nhtio/adk/batteries/llm/litert_lm'
import { Retrievable, SpooledArtifact } from '@nhtio/adk/common'
import * as anthropic from '@nhtio/adk/batteries/llm/anthropic_messages'
import * as transformers from '@nhtio/adk/batteries/llm/transformers_js'
import * as openai from '@nhtio/adk/batteries/llm/openai_chat_completions'
import * as webllm from '@nhtio/adk/batteries/llm/webllm_chat_completions'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'

const secret = 'VERY_SECRET_RETRIEVABLE_FULL_BODY_9f7c'
const store = new InMemorySpoolStore()
const artifact = new SpooledArtifact(store.write('retrievable-handle', secret))
const base = new Retrievable({
  id: 'retrievable-handle',
  content: artifact,
  trustTier: 'first-party',
  inline: false,
  createdAt: DateTime.utc(),
  updatedAt: DateTime.utc(),
})
const attrs = (retrievable: Retrievable) => ({
  retrievable,
  attrs: { nonce: retrievable.id, createdAt: retrievable.createdAt.toISO()! },
})

type Adapter =
  | typeof openai
  | typeof anthropic
  | typeof ollama
  | typeof webllm
  | typeof transformers
  | typeof litert
const adapters: Array<[string, Adapter]> = [
  ['openai', openai],
  ['anthropic', anthropic],
  ['ollama', ollama],
  ['webllm', webllm],
  ['transformers.js', transformers],
  ['litert-lm', litert],
]

async function render(adapter: Adapter, trust: Retrievable['trustTier']) {
  const r =
    trust === 'first-party'
      ? base
      : new Retrievable({
          id: base.id,
          content: base.content,
          trustTier: trust,
          inline: false,
          createdAt: base.createdAt,
          updatedAt: base.updatedAt,
        })
  const items = [attrs(r)] as never
  if (trust === 'first-party') return adapter.renderFirstPartyRetrievables(items)
  const deps = { renderUntrustedContent: adapter.renderUntrustedContent }
  return trust === 'third-party-public'
    ? adapter.renderThirdPartyPublicRetrievables(items, deps as never)
    : adapter.renderThirdPartyPrivateRetrievables(items, deps as never)
}

describe('non-inline SpooledArtifact retrievables stay handles in every adapter renderer', () => {
  it.each(adapters)(
    '%s first-party renderer never exposes the backing body',
    async (_name, adapter) => {
      const out = await render(adapter, 'first-party')
      expect(out).not.toContain(secret)
      expect(out).toContain('callId: retrievable-handle')
    }
  )

  it.each(adapters)(
    '%s third-party renderers never expose the backing body',
    async (_name, adapter) => {
      for (const tier of ['third-party-public', 'third-party-private'] as const) {
        const out = await render(adapter, tier)
        expect(out).not.toContain(secret)
        expect(out).toContain('callId: retrievable-handle')
      }
    }
  )

  it('inline=true remains the explicit full-body escape hatch', async () => {
    const inline = new Retrievable({
      id: base.id,
      content: base.content,
      trustTier: base.trustTier,
      inline: true,
      createdAt: base.createdAt,
      updatedAt: base.updatedAt,
    })
    const out = await openai.renderFirstPartyRetrievables([attrs(inline)])
    expect(out).toContain(secret)
  })
})
