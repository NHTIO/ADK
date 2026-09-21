import { validator } from '@nhtio/validation'
import { encode, decode } from '@nhtio/encoder'
import { Tool } from '../../../src/lib/classes/tool'
import { Media } from '../../../src/lib/classes/media'
import { describe, it, expect, beforeAll } from 'vitest'
import { Memory } from '../../../src/lib/classes/memory'
import { Message } from '../../../src/lib/classes/message'
import { Thought } from '../../../src/lib/classes/thought'
import { Registry } from '../../../src/lib/classes/registry'
import { Identity } from '../../../src/lib/classes/identity'
import { ToolCall } from '../../../src/lib/classes/tool_call'
import { Tokenizable } from '../../../src/lib/classes/tokenizable'
import { Retrievable } from '../../../src/lib/classes/retrievable'
import { ToolRegistry } from '../../../src/lib/classes/tool_registry'
import { registerAdkEncodables } from '../../../src/batteries/encoding'
import { SpooledArtifact } from '../../../src/lib/classes/spooled_artifact'
import { inMemoryMediaReader } from '../../../src/lib/helpers/media_readers'
import { InMemorySpoolReader } from '../../../src/batteries/storage/in_memory'

// Audit for issue #38: a LIVE encodable instance (e.g. an `Identity` handed off the runtime to a
// storage callback) re-wrapped into a fresh primitive used to throw `E_ENCODING_FAILED`. Root cause:
// a Joi `validator.object` schema CLONES whatever it validates, producing a look-alike with the right
// prototype but NO private `#` fields (the constructor never ran) — so `[ENCODE_METHOD]` threw reading
// a private. Any primitive that nests a live instance THROUGH a `validator.object` field was a
// candidate. The fix is a custom-passthrough branch (mirroring `Tokenizable.schema`) that returns the
// live instance verbatim. This spec exercises every "live nested instance -> constructor" vector on
// the encodable surface so a regression on ANY of them is caught, not just the Identity case that
// surfaced the bug.
beforeAll(() => registerAdkEncodables())

const ts = '2024-01-01T00:00:00.000Z'

/** Assert a value encodes without throwing — the issue-#38 symptom is an `E_ENCODING_FAILED` throw. */
const encodesOK = (label: string, v: unknown) => {
  expect(() => encode(v as never), `${label} should encode`).not.toThrow()
}

describe('encoding — live nested instance through a constructor (issue #38)', () => {
  // Regression for the AI-review finding on the issue-#38 fix: the live-instance passthrough must
  // trust a genuine brand, not a `constructor.name` match. `Identity.isIdentity` intentionally falls
  // back to a name comparison for cross-realm reach, so a hand-rolled look-alike satisfies it — but a
  // look-alike carries no real private fields and must NOT bypass field validation.
  it('a constructor.name="Identity" look-alike does NOT bypass validation', () => {
    const WellFormed = class {
      identifier = 'x'
      representation = new Tokenizable('x')
    }
    Object.defineProperty(WellFormed, 'name', { value: 'Identity' })
    const lookalike = new WellFormed() as unknown as Identity

    // A well-formed look-alike is reconstructed into a REAL Identity via rawIdentitySchema, not
    // retained verbatim — and the resulting primitive still encodes losslessly.
    const th = new Thought({
      id: 't',
      content: 'c',
      identity: lookalike,
      createdAt: ts,
      updatedAt: ts,
    })
    expect(th.identity).not.toBe(lookalike)
    expect(Identity.isIdentity(th.identity)).toBe(true)
    expect(th.identity.identifier).toBe('x')
    encodesOK('Thought<reconstructed look-alike>', th)
  })

  it('a malformed "Identity" look-alike is REJECTED, not retained', () => {
    const Malformed = class {
      identifier = 5
      representation = { junk: true }
    }
    Object.defineProperty(Malformed, 'name', { value: 'Identity' })
    const bad = new Malformed() as unknown as Identity
    // Its garbage `representation` fails rawIdentitySchema, so construction throws rather than
    // retaining an unvalidated husk that would later produce invalid serialized state.
    expect(
      () => new Thought({ id: 't', content: 'c', identity: bad, createdAt: ts, updatedAt: ts })
    ).toThrow()
  })

  it('a FOREIGN/cross-realm Identity husk is rebuilt into a local instance, not retained', () => {
    // A second copy of the package in the dep tree (or any Joi clone of a genuine foreign Identity)
    // yields an object that carries an `Identity`-named prototype — so `Identity.isIdentity` accepts
    // it via the prototype/name fallback — but has NO private fields, because our constructor never
    // ran and it is not in our WeakSet brand. Left as-is it would throw on `[ENCODE_METHOD]`. The
    // schema must rebuild it into a genuine local Identity after field validation.
    const husk = Object.create(Identity.prototype) as Identity
    Object.defineProperty(husk, 'identifier', { value: 'assistant', enumerable: true })
    Object.defineProperty(husk, 'representation', {
      value: new Tokenizable('assistant'),
      enumerable: true,
    })
    expect(Identity.isIdentity(husk)).toBe(true)
    const th = new Thought({ id: 't', content: 'c', identity: husk, createdAt: ts, updatedAt: ts })
    expect(th.identity).not.toBe(husk)
    expect(Identity.isIdentity(th.identity)).toBe(true)
    expect(th.identity.identifier).toBe('assistant')
    expect(th.identity.representation.toString()).toBe('assistant')
    encodesOK('Thought<rebuilt foreign husk>', th)
  })

  it('live Tokenizable representation -> Identity', () => {
    const liveRep = new Identity({ identifier: 'x', representation: 'Rep' }).representation
    const id = new Identity({ identifier: 'y', representation: liveRep })
    expect(id.representation.toString()).toBe('Rep')
    encodesOK('Identity<liveTokenizable>', id)
  })

  it('live Tokenizable content -> Memory', () => {
    const liveTok = new Memory({
      id: 'm',
      content: 'fact',
      confidence: 0.5,
      importance: 0.5,
      createdAt: ts,
      updatedAt: ts,
    }).content
    const mem = new Memory({
      id: 'm2',
      content: liveTok,
      confidence: 0.5,
      importance: 0.5,
      createdAt: ts,
      updatedAt: ts,
    })
    expect(mem.content.toString()).toBe('fact')
    encodesOK('Memory<liveTokenizable>', mem)
  })

  it('live Tokenizable content -> Message', () => {
    const liveTok = new Message({
      id: 'a',
      role: 'user',
      content: 'hi',
      createdAt: ts,
      updatedAt: ts,
    }).content!
    const msg = new Message({
      id: 'b',
      role: 'user',
      content: liveTok,
      createdAt: ts,
      updatedAt: ts,
    })
    expect(msg.content!.toString()).toBe('hi')
    encodesOK('Message<liveTokenizable>', msg)
  })

  it('live Tokenizable content -> Thought', () => {
    const liveTok = new Thought({ id: 'a', content: 'reason', createdAt: ts, updatedAt: ts })
      .content
    const th = new Thought({ id: 'b', content: liveTok, createdAt: ts, updatedAt: ts })
    expect(th.content.toString()).toBe('reason')
    encodesOK('Thought<liveTokenizable>', th)
  })

  it('live Identity -> Thought and Message (the reported case)', () => {
    const liveId = new Thought({
      id: 'a',
      content: 'c',
      identity: 'assistant',
      createdAt: ts,
      updatedAt: ts,
    }).identity
    encodesOK(
      'Thought<liveIdentity>',
      new Thought({ id: 'b', content: 'c', identity: liveId, createdAt: ts, updatedAt: ts })
    )
    encodesOK(
      'Message<liveIdentity>',
      new Message({
        id: 'c',
        role: 'assistant',
        content: 'c',
        identity: liveId,
        createdAt: ts,
        updatedAt: ts,
      })
    )
  })

  it('live Tokenizable content -> Retrievable', () => {
    const liveTok = new Retrievable({
      id: 'r',
      content: 'body',
      trustTier: 'first-party',
      createdAt: ts,
      updatedAt: ts,
    }).content
    const r = new Retrievable({
      id: 'r2',
      content: liveTok as Tokenizable,
      trustTier: 'first-party',
      createdAt: ts,
      updatedAt: ts,
    })
    encodesOK('Retrievable<liveTokenizable>', r)
  })

  it('live SpooledArtifact content -> Retrievable', () => {
    const art = new SpooledArtifact(new InMemorySpoolReader('spooled body'))
    const r = new Retrievable({
      id: 'r3',
      content: art,
      trustTier: 'first-party',
      createdAt: ts,
      updatedAt: ts,
    })
    encodesOK('Retrievable<liveSpooledArtifact>', r)
  })

  it('live Tokenizable / SpooledArtifact / Media results -> ToolCall', () => {
    const tok = new Tokenizable('result text')
    const art = new SpooledArtifact(new InMemorySpoolReader('artifact'))
    const media = Media.userAttachment({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'p.png',
      reader: inMemoryMediaReader(new Uint8Array([1, 2, 3])),
    })
    const base = {
      id: 't',
      tool: 'x',
      args: {},
      checksum: 'c',
      isComplete: true,
      isError: false,
      createdAt: ts,
      updatedAt: ts,
      completedAt: ts,
    }
    encodesOK('ToolCall<Tokenizable>', new ToolCall({ ...base, results: tok }))
    encodesOK('ToolCall<SpooledArtifact>', new ToolCall({ ...base, results: art }))
    encodesOK('ToolCall<Media>', new ToolCall({ ...base, results: media }))
    encodesOK('ToolCall<Media[]>', new ToolCall({ ...base, results: [media] }))
    encodesOK('ToolCall<SpooledArtifact[]>', new ToolCall({ ...base, results: [art] }))
  })

  it('live Media -> Message.attachments', () => {
    const media = Media.userAttachment({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'p.png',
      reader: inMemoryMediaReader(new Uint8Array([9, 9])),
    })
    const msg = new Message({
      id: 'm',
      role: 'user',
      content: 'see',
      attachments: [media],
      createdAt: ts,
      updatedAt: ts,
    })
    encodesOK('Message<liveMedia attachment>', msg)
  })

  it('live Tool -> ToolRegistry, including a decoded Tool re-registered', () => {
    const tool = new Tool({
      name: 'echo',
      description: 'echoes',
      inputSchema: validator.object({ x: validator.string() }),
      handler: async () => 'ok',
      meta: { owner: 'team' },
    })
    encodesOK('ToolRegistry<liveTool>', new ToolRegistry([tool]))
    const reg = decode(encode(new ToolRegistry([tool]) as never)) as unknown as ToolRegistry
    const decodedTool = reg.all()[0]
    encodesOK('ToolRegistry<decodedTool>', new ToolRegistry([decodedTool]))
  })

  // The decode path rebuilds nested instances LIVE and feeds them to the parent constructor. If any
  // parent cloned-and-dropped, re-encoding the decoded graph would throw — so a double round-trip is
  // the strongest single check across the whole surface.
  it('decode then RE-ENCODE succeeds for every nesting parent', () => {
    const cases: Array<[string, unknown]> = [
      ['Identity', new Identity({ identifier: 7, representation: 'Agent' })],
      [
        'Memory',
        new Memory({
          id: 'm',
          content: 'fact',
          confidence: 0.5,
          importance: 0.5,
          createdAt: ts,
          updatedAt: ts,
        }),
      ],
      [
        'Message',
        new Message({
          id: 'b',
          role: 'assistant',
          content: 'hi',
          identity: { identifier: 1, representation: 'A' },
          createdAt: ts,
          updatedAt: ts,
        }),
      ],
      [
        'Thought',
        new Thought({
          id: 'b',
          content: 'reason',
          identity: { identifier: 1, representation: 'A' },
          createdAt: ts,
          updatedAt: ts,
        }),
      ],
      [
        'Retrievable',
        new Retrievable({
          id: 'r',
          content: 'body',
          trustTier: 'first-party',
          createdAt: ts,
          updatedAt: ts,
        }),
      ],
      [
        'ToolCall',
        new ToolCall({
          id: 't',
          tool: 'x',
          args: {},
          checksum: 'c',
          isComplete: true,
          isError: false,
          results: new Tokenizable('r'),
          createdAt: ts,
          updatedAt: ts,
          completedAt: ts,
        }),
      ],
      ['Registry', new Registry({ a: 1, nested: { b: 'two' } })],
    ]
    for (const [label, v] of cases) {
      const once = decode(encode(v as never))
      expect(() => encode(once as never), `${label}: re-encode after decode`).not.toThrow()
    }
  })
})
