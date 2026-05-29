import { describe, expect, it } from 'vitest'
import { Message, SpooledArtifact, isMessage, version } from '@nhtio/adk'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'

describe('@nhtio/adk published package browser smoke check', () => {
  it('loads browser-compatible public entrypoints', () => {
    const message = new Message({
      id: 'smoke-browser-message',
      role: 'assistant',
      content: 'hello from the browser smoke test',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    })

    expect(version).toEqual(expect.any(String))
    expect(isMessage(message)).toBe(true)
    expect(message.identity.identifier).toBe('assistant')
  })

  it('uses browser-compatible storage and artifact primitives', async () => {
    const store = new InMemorySpoolStore()
    const reader = store.write('browser-artifact', 'red\ngreen\nblue')
    const artifact = new SpooledArtifact(reader)

    expect(await artifact.tail(2)).toEqual(['green', 'blue'])
    expect(await artifact.lineCount()).toBe(3)
    expect(await artifact.asString()).toBe('red\ngreen\nblue')
  })
})
