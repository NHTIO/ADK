import { DateTime } from 'luxon'
import { encode, decode } from '@nhtio/encoder'
import { Media } from '../../../src/lib/classes/media'
import { describe, expect, it, beforeAll } from 'vitest'
import { Memory } from '../../../src/lib/classes/memory'
import { Thought } from '../../../src/lib/classes/thought'
import { Message } from '../../../src/lib/classes/message'
import { Identity } from '../../../src/lib/classes/identity'
import { Registry } from '../../../src/lib/classes/registry'
import { ToolCall } from '../../../src/lib/classes/tool_call'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'
import { inMemoryMediaReader, fromWebFile } from '../../../src/lib/helpers/media_readers'
import { E_READER_NOT_DESCRIBABLE, E_NO_READER_RESOLVER } from '../../../src/lib/exceptions/runtime'
import { registerAdkEncodables, registerSpoolReaderResolver } from '../../../src/batteries/encoding'

// The battery wires the decoder (registerClass) + the binding-free reader resolvers. Without this,
// decode() throws on every primitive — so it gates the whole suite.
beforeAll(() => {
  registerAdkEncodables()
})

const roundTrip = <T>(value: T): T => decode(encode(value as never)) as T

describe('encoding round-trip — Tier A value objects', () => {
  it('Tokenizable round-trips (cache is derived, not encoded)', () => {
    const decoded = roundTrip(new Tokenizable('hello tokens'))
    expect(Tokenizable.isTokenizable(decoded)).toBe(true)
    expect(decoded.toString()).toBe('hello tokens')
  })

  it('Registry round-trips its store, including a bigint leaf', () => {
    const r = new Registry({ a: 1, nested: { b: 'two' }, big: 123456789012345678901234567890n })
    const decoded = roundTrip(r)
    expect(Registry.isRegistry(decoded)).toBe(true)
    expect(decoded.get('nested.b')).toBe('two')
    expect(decoded.get('big')).toBe(123456789012345678901234567890n)
  })

  it('Identity round-trips with a nested Tokenizable representation', () => {
    const decoded = roundTrip(new Identity({ identifier: 42, representation: 'Agent Smith' }))
    expect(Identity.isIdentity(decoded)).toBe(true)
    expect(decoded.identifier).toBe(42)
    expect(Tokenizable.isTokenizable(decoded.representation)).toBe(true)
    expect(decoded.representation.toString()).toBe('Agent Smith')
  })

  it('Memory round-trips with Luxon DateTime fields preserved', () => {
    const created = '2024-01-01T00:00:00.000Z'
    const decoded = roundTrip(
      new Memory({
        id: 'mem-1',
        content: 'a recalled fact',
        confidence: 0.8,
        importance: 0.6,
        createdAt: created,
        updatedAt: created,
      })
    )
    expect(Memory.isMemory(decoded)).toBe(true)
    expect(decoded.confidence).toBe(0.8)
    expect(DateTime.isDateTime(decoded.createdAt)).toBe(true)
    expect(decoded.createdAt.toISO()).toBe(DateTime.fromISO(created, { zone: 'utc' }).toISO())
  })

  it('Thought round-trips, including a nested Identity', () => {
    const decoded = roundTrip(
      new Thought({
        id: 'th-1',
        content: 'reasoning trace',
        identity: 'assistant',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(Thought.isThought(decoded)).toBe(true)
    expect(decoded.content.toString()).toBe('reasoning trace')
    expect(Identity.isIdentity(decoded.identity)).toBe(true)
  })

  // An opaque-mode Thought may legitimately have NO prose (a signed-but-textless provider thinking
  // block). Decode re-validates through the constructor, so the emptyable-content rule has to survive
  // the round trip or replay data dies on rehydration.
  it('Thought with EMPTY content round-trips when an opaque replay payload carries the meaning', () => {
    const decoded = roundTrip(
      new Thought({
        id: 'th-empty',
        content: '',
        identity: 'assistant',
        payload: { variant: 'thinking', thinking: '', signature: 'sig-1', prefixFingerprint: 'fp' },
        replayCompatibility: 'anthropic-messages-thinking-v1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(Thought.isThought(decoded)).toBe(true)
    expect(decoded.content.toString()).toBe('')
    expect(decoded.payload).toEqual({
      variant: 'thinking',
      thinking: '',
      signature: 'sig-1',
      prefixFingerprint: 'fp',
    })
    expect(decoded.replayCompatibility).toBe('anthropic-messages-thinking-v1')
  })
})

describe('encoding round-trip — Tier B containers', () => {
  it('text-only Message round-trips with nested Identity + Tokenizable', () => {
    const decoded = roundTrip(
      new Message({
        id: 'msg-1',
        role: 'user',
        content: 'hello, world',
        identity: { identifier: 'u-1', representation: 'Alice' },
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(Message.isMessage(decoded)).toBe(true)
    expect(decoded.content?.toString()).toBe('hello, world')
    expect(Identity.isIdentity(decoded.identity)).toBe(true)
    expect(decoded.identity.representation.toString()).toBe('Alice')
  })

  it('Message carrying an in-memory-backed Media round-trips the whole graph', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const media = Media.userAttachment({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'pixel.png',
      reader: inMemoryMediaReader(bytes),
    })
    const decoded = roundTrip(
      new Message({
        id: 'msg-2',
        role: 'user',
        attachments: [media],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(Message.isMessage(decoded)).toBe(true)
    expect(decoded.attachments).toHaveLength(1)
    expect(Media.isMedia(decoded.attachments[0])).toBe(true)
    expect(decoded.attachments[0].mimeType).toBe('image/png')
  })

  it('Retrievable round-trips with Tokenizable content', () => {
    const decoded = roundTrip(
      new Retrievable({
        id: 'ret-1',
        content: 'retrieved chunk',
        trustTier: 'third-party-public',
        source: 'https://example.com',
        score: 0.9,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      })
    )
    expect(Retrievable.isRetrievable(decoded)).toBe(true)
    expect(decoded.trustTier).toBe('third-party-public')
    expect(decoded.score).toBe(0.9)
  })

  it('ToolCall round-trips with a Tokenizable result and checksum re-validation', () => {
    const original = new ToolCall({
      id: 'tc-1',
      tool: 'echo',
      args: { value: 'hi' },
      checksum: 'placeholder',
      isComplete: true,
      isError: false,
      results: new Tokenizable('echo result'),
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      completedAt: '2024-01-01T00:00:00.000Z',
    })
    const decoded = roundTrip(original)
    expect(ToolCall.isToolCall(decoded)).toBe(true)
    expect(decoded.tool).toBe('echo')
    // The producer-supplied checksum survives verbatim so the constructor's re-validation passes.
    expect(decoded.checksum).toBe(original.checksum)
    expect(Tokenizable.isTokenizable(decoded.results)).toBe(true)
  })
})

describe('encoding round-trip — Tier C artifacts (reader handles)', () => {
  it('SpooledArtifact round-trips as an in-memory handle and re-reads its bytes', async () => {
    const artifact = new SpooledArtifact(new InMemorySpoolReader('line one\nline two'))
    const decoded = roundTrip(artifact)
    expect(SpooledArtifact.isSpooledArtifact(decoded)).toBe(true)
    await expect(decoded.asString()).resolves.toBe('line one\nline two')
  })
})

describe('encoding negative paths', () => {
  it('encoding a fromWebFile-backed Media surfaces E_READER_NOT_DESCRIBABLE', () => {
    const blob = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })
    const media = Media.userAttachment({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'blob.png',
      reader: fromWebFile(blob),
    })
    // The encoder wraps a non-encoder error thrown inside [ENCODE_METHOD]() as the `cause` of its own
    // E_ENCODING_FAILED. Our describable-reader guard is the root cause.
    let caught: unknown
    try {
      encode(media as never)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(E_READER_NOT_DESCRIBABLE)
  })

  it('decoding a reader handle with an unregistered tag throws E_NO_READER_RESOLVER', () => {
    // A custom reader that describes a tag with no registered resolver. Encode captures the handle;
    // decode fails to re-bind it.
    const customReader = {
      line: () => undefined,
      byteLength: () => 0,
      lineCount: () => 0,
      readAll: () => '',
      describe: () => ({ tag: 'spool:does-not-exist', locator: { k: 1 } }),
    }
    const artifact = new SpooledArtifact(customReader)
    const wire = encode(artifact as never)
    // The decoder wraps a non-encoder error thrown inside [DECODE_METHOD]() as the `cause` of its own
    // E_UNDECODABLE_VALUE. Our missing-resolver error is the root cause.
    let caught: unknown
    try {
      decode(wire)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(E_NO_READER_RESOLVER)
  })

  it('TurnGate is deliberately not encodable (no [ENCODE_METHOD] contract)', async () => {
    const { TurnGate } = await import('../../../src/lib/classes/turn_gate')
    const gate = new TurnGate({
      id: 'g-1',
      turnId: 't-1',
      reason: 'waiting',
      payload: { waitingOn: 'approval' },
      createdAt: '2024-01-01T00:00:00.000Z',
    })
    // The honest "no": a live Promise/AbortController has no serialised form, so TurnGate never
    // implements the custom-class contract. Encoding does not round-trip it as a TurnGate.
    const ENCODE_METHOD = Symbol.for('@nhtio/encoder:toEncoded')
    expect((gate as unknown as Record<symbol, unknown>)[ENCODE_METHOD]).toBeUndefined()
    expect(TurnGate.isTurnGate(decode(encode(gate as never)))).toBe(false)
  })
})

describe('encoding round-trip — durable reader with a consumer-registered resolver', () => {
  it('a spool handle round-trips when its tag resolver is registered', async () => {
    // Simulate a durable store: a custom reader that describes a tagged locator, plus a resolver the
    // consumer registers (carrying whatever live binding it needs — here, a plain map).
    const store = new Map<string, string>([['key-1', 'durable body']])
    registerSpoolReaderResolver('spool:test-durable', (locator) => {
      const { key } = locator as { key: string }
      return new InMemorySpoolReader(store.get(key) ?? '')
    })
    const durableReader = {
      line: () => undefined,
      byteLength: () => 0,
      lineCount: () => 0,
      readAll: () => 'durable body',
      describe: () => ({ tag: 'spool:test-durable', locator: { key: 'key-1' } }),
    }
    const decoded = roundTrip(new SpooledArtifact(durableReader))
    expect(SpooledArtifact.isSpooledArtifact(decoded)).toBe(true)
    await expect(decoded.asString()).resolves.toBe('durable body')
  })
})
