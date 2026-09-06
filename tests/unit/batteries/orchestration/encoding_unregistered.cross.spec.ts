import { describe, it, expect } from 'vitest'
import { encode, decode } from '@nhtio/encoder'
import { NodeRef } from '../../../../src/batteries/orchestration/encoding'

/**
 * `registerOrchestrationEncodables()` must run before any `decode()`. Encoding works without it;
 * decoding does not. The property under test is that this fails LOUDLY and names the type, rather
 * than silently yielding a plain object — a `NodeRef` that decoded to `{node, select}` would be a
 * staged reference quietly demoted to a literal, and a resolver would then read it as a value.
 */
describe('decoding an ADK reference without registering first', () => {
  it('encodes fine, then throws on decode naming the type it cannot rebuild', () => {
    const wire = encode(new NodeRef('n1', 'first') as never)
    expect(typeof wire).toBe('string')

    // Loud, and specific about what is missing — a message an operator can act on.
    expect(() => decode(wire)).toThrowError(/custom:NodeRef/)
  })

  it('does not silently return a look-alike record instead', () => {
    // The failure mode this exists to exclude: a half-built value that passes structural checks
    // but is not a reference, so `NodeRef.isNodeRef` says false while the shape says true.
    let decoded: unknown = 'not-attempted'
    try {
      decoded = decode(encode(new NodeRef('n1', 'first') as never))
    } catch {
      decoded = 'threw'
    }
    expect(decoded).toBe('threw')
  })
})
