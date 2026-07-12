import { isError } from '@nhtio/adk/guards'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encode, decode, registerClass, ENCODE_METHOD, DECODE_METHOD } from '@nhtio/encoder'
import {
  decodeArgument,
  encodeArgument,
  setEncoderLoaderForTests,
  type EncoderModule,
} from '../../../../src/batteries/isolation/codec'
import {
  E_ISOLATION_ENCODER_REQUIRED,
  E_ISOLATION_UNENCODABLE,
  isEncoderAvailable,
  registerEncodableClasses,
  transfer,
} from '@nhtio/adk/batteries/isolation'
import type { Encodable } from '@nhtio/encoder'

// The real `@nhtio/encoder` peer is an installed devDependency in this repo, so
// `isEncoderAvailable()`/the default loader resolve it for real (no mock) UNLESS a test overrides
// the loader via `setEncoderLoaderForTests` to simulate "peer not installed" deterministically.
afterEach(() => {
  setEncoderLoaderForTests(undefined) // restore the real default loader after every test
})

describe('isEncoderAvailable()', () => {
  it('resolves true — the real @nhtio/encoder peer is installed in this repo', async () => {
    await expect(isEncoderAvailable()).resolves.toBe(true)
  })
})

describe('encodeArgument() / decodeArgument() — raw tier', () => {
  it('ships an ordinary plain object untouched (same reference — zero clone)', async () => {
    const original = { a: 1, nested: { b: 'two' } }
    const wire = await encodeArgument(original, { label: 'args[0]' })
    expect(wire).toEqual({ enc: 'raw', v: original })
    expect(wire.enc === 'raw' && wire.v).toBe(original) // SAME reference, not a clone
  })

  it('round-trips primitives untouched', async () => {
    for (const value of [42, 'hello', true, null, undefined]) {
      const wire = await encodeArgument(value, { label: 'args[0]' })
      const decoded = await decodeArgument(wire, undefined, 'args[0]')
      expect(decoded).toBe(value)
    }
  })

  it('a bare TypedArray is an opaque leaf — costs O(1) traversal, ships the same reference', async () => {
    const huge = new Float32Array(1_000_000) // large enough that O(bytes) traversal would be slow
    const wire = await encodeArgument(huge, { label: 'args[0]' })
    expect(wire.enc).toBe('raw')
    expect(wire.enc === 'raw' && wire.v).toBe(huge) // same reference — never cloned/descended into
  })

  it('a plain circular reference with NO exotic leaf ships raw without throwing', async () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    const wire = await encodeArgument(circular, { label: 'args[0]' })
    expect(wire.enc).toBe('raw')
    expect(wire.enc === 'raw' && wire.v).toBe(circular)
  })
})

describe('encodeArgument() — path-sentineled raw tier (single exotic leaf in a container)', () => {
  it('encodes ONLY the exotic leaf, leaving siblings as the SAME references (no caller mutation)', async () => {
    const sibling = { untouched: true }
    const onProgress = (): void => {}
    const original = { label: 'job', onProgress, sibling }
    const escalations: Array<{ path: PropertyKey[]; reason: string }> = []
    const wire = await encodeArgument(original, {
      label: 'args[0]',
      onEscalate: (path, reason) => escalations.push({ path, reason }),
    })
    expect(wire.enc).toBe('raw')
    const v = wire.enc === 'raw' ? (wire.v as Record<string, unknown>) : undefined
    expect(v).not.toBe(original) // root was cloned (shallow) along the exotic path
    expect(v!.sibling).toBe(sibling) // untouched sibling: SAME reference
    expect(v!.label).toBe('job')
    expect(v!.onProgress).toEqual({ __nhtio$: expect.any(String) })
    expect(original.onProgress).toBe(onProgress) // caller's original object is untouched
    expect(escalations).toEqual([{ path: ['onProgress'], reason: 'function' }])
  })

  it('decodeArgument rehydrates the sentinel back into a callable function', async () => {
    // The real @nhtio/encoder round-trips a function by serializing its source text and
    // re-evaluating it on decode — it CANNOT preserve a closure over the enclosing lexical scope
    // (that's a fundamental limitation of string-based function serialization, not a bug). So the
    // decoded function is a genuinely new, independently-callable function — it does NOT mutate the
    // original outer-scope `invoked` binding. Confirmed empirically against the installed peer.
    const original = { onProgress: (): string => 'called' }
    const wire = await encodeArgument(original, { label: 'args[0]' })
    const decoded = (await decodeArgument(wire, undefined, 'args[0]')) as {
      onProgress: () => string
    }
    expect(typeof decoded.onProgress).toBe('function')
    expect(() => decoded.onProgress()).not.toThrow()
    expect(decoded.onProgress()).toBe('called')
  })
})

describe('encodeArgument() — whole-argument exotic value (bare function/Error)', () => {
  it('encodes a bare function passed directly as the whole argument', async () => {
    const fn = (x: number): number => x * 2
    const wire = await encodeArgument(fn, { label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
    const decoded = (await decodeArgument(wire, undefined, 'args[0]')) as (x: number) => number
    expect(decoded(21)).toBe(42)
  })

  it('encodes a bare Error passed directly as the whole argument', async () => {
    // NOTE: the real @nhtio/encoder's built-in Error handling (with no custom registration, which
    // the isolation battery deliberately never does — zero core-coupling) does NOT preserve the
    // original Error subclass or its `.name` on round-trip: a decoded TypeError comes back as a
    // plain `Error` with `.name === 'Error'`. Confirmed empirically against the installed peer. This
    // is exactly why the isolation battery's OWN protocol-level error crossing
    // (`toWireError`/`fromWireError` in codec.ts, `wireErrorToError` in protocol.ts) never relies on
    // this raw encoder round-trip for fidelity — it always carries baseline `message`/`name`/`stack`
    // as plain strings and reconstructs from those. This test documents the raw encoder's actual
    // (subclass-losing) behavior at the `encodeArgument`/`decodeArgument` layer.
    const err = new TypeError('bad input')
    const wire = await encodeArgument(err, { label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
    const decoded = await decodeArgument(wire, undefined, 'args[0]')
    expect(decoded).toBeInstanceOf(Error)
    expect(decoded).not.toBeInstanceOf(TypeError)
    expect((decoded as Error).message).toBe('bad input')
    expect((decoded as Error).name).toBe('Error')
  })
})

describe('encodeArgument() — custom-class round-trip via the REAL @nhtio/encoder', () => {
  class Point {
    constructor(
      public x: number,
      public y: number
    ) {}
    [ENCODE_METHOD](): Encodable {
      return { x: this.x, y: this.y }
    }
    static [DECODE_METHOD](data: Encodable): Point {
      const { x, y } = data as { x: number; y: number }
      return new Point(x, y)
    }
  }

  beforeAll(() => {
    registerClass(Point)
  })

  it('round-trips a registered custom-encodable class instance as the whole argument', async () => {
    const point = new Point(3, 4)
    const wire = await encodeArgument(point, { label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
    const decoded = await decodeArgument(wire, undefined, 'args[0]')
    expect(decoded).toBeInstanceOf(Point)
    expect((decoded as Point).x).toBe(3)
    expect((decoded as Point).y).toBe(4)
  })

  it('round-trips a registered custom-encodable buried inside a container (path-sentineled)', async () => {
    const original = { label: 'job', origin: new Point(0, 0) }
    const wire = await encodeArgument(original, { label: 'args[0]' })
    const decoded = (await decodeArgument(wire, undefined, 'args[0]')) as { origin: Point }
    expect(decoded.origin).toBeInstanceOf(Point)
    expect(decoded.origin.x).toBe(0)
  })

  it("registerEncodableClasses() is sugar over @nhtio/encoder's registerClass", async () => {
    class Vector {
      constructor(public dx: number) {}
      [ENCODE_METHOD](): Encodable {
        return { dx: this.dx }
      }
      static [DECODE_METHOD](data: Encodable): Vector {
        return new Vector((data as { dx: number }).dx)
      }
    }
    await registerEncodableClasses([Vector])
    const decoded = decode(encode(new Vector(9) as never))
    expect(decoded).toBeInstanceOf(Vector)
  })
})

describe('encodeArgument() — circular + exotic leaf throws E_ISOLATION_UNENCODABLE', () => {
  it('throws when a circular reference co-exists with an exotic (function) leaf', async () => {
    const circular: Record<string, unknown> = { onProgress: () => {} }
    circular.self = circular
    await expect(encodeArgument(circular, { label: 'args[0]' })).rejects.toThrow(
      E_ISOLATION_UNENCODABLE
    )
  })
})

describe('encodeArgument() — encoder-absent simulation', () => {
  it('throws E_ISOLATION_ENCODER_REQUIRED for a whole-argument exotic value with no encoder', async () => {
    setEncoderLoaderForTests(async () => undefined)
    const fn = (): void => {}
    await expect(encodeArgument(fn, { label: 'args[0]' })).rejects.toThrow(
      E_ISOLATION_ENCODER_REQUIRED
    )
  })

  it('throws E_ISOLATION_ENCODER_REQUIRED for a path-sentineled exotic leaf with no encoder', async () => {
    setEncoderLoaderForTests(async () => undefined)
    const original = { onProgress: () => {} }
    await expect(encodeArgument(original, { label: 'args[0]' })).rejects.toThrow(
      E_ISOLATION_ENCODER_REQUIRED
    )
  })

  it('a plain value with NO exotic leaf still ships raw fine with no encoder', async () => {
    setEncoderLoaderForTests(async () => undefined)
    const wire = await encodeArgument({ a: 1 }, { label: 'args[0]' })
    expect(wire.enc).toBe('raw')
  })

  it('isEncoderAvailable() reflects the simulated absence', async () => {
    setEncoderLoaderForTests(async () => undefined)
    await expect(isEncoderAvailable()).resolves.toBe(false)
  })

  it('registerEncodableClasses() throws E_ISOLATION_ENCODER_REQUIRED when classes are listed but no encoder', async () => {
    setEncoderLoaderForTests(async () => undefined)
    class Unused {}
    await expect(registerEncodableClasses([Unused])).rejects.toThrow(E_ISOLATION_ENCODER_REQUIRED)
  })

  it('registerEncodableClasses() is a no-op (never touches the loader) for an empty list', async () => {
    setEncoderLoaderForTests(async () => undefined)
    await expect(registerEncodableClasses([])).resolves.toBeUndefined()
  })
})

describe('encodeArgument() — injected fake EncoderModule (deterministic escalation control)', () => {
  const fakeEncoder = (): EncoderModule => ({
    encode: (v) => `FAKE:${JSON.stringify(v)}`,
    decode: (s) => JSON.parse(s.slice('FAKE:'.length)),
    registerClass: () => {},
    isCustomEncodable: () => false,
    isError: (v) => isError(v),
  })

  it('escalates a value the fake encoder classifies as custom-encodable', async () => {
    const custom = { __marker: 'custom' }
    setEncoderLoaderForTests(async () => ({
      ...fakeEncoder(),
      isCustomEncodable: (v) => v === custom,
    }))
    const wire = await encodeArgument(custom, { label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
  })
})

describe('encodeArgument() / decodeArgument() — "raw" mode skips traversal entirely', () => {
  it('ships a bare function AS-IS (untouched) when mode is "raw" — no escalation attempted', async () => {
    const fn = (): void => {}
    const wire = await encodeArgument(fn, { label: 'args[0]', mode: 'raw' })
    expect(wire).toEqual({ enc: 'raw', v: fn })
    const decoded = await decodeArgument(wire, 'raw', 'args[0]')
    expect(decoded).toBe(fn)
  })

  it('a sentinel-shaped-but-unrelated object is still treated as a real sentinel and fails to decode', async () => {
    // `isNhtioSentinel`'s detection is PURELY STRUCTURAL — any object shaped like
    // `{ __nhtio$: string }` (a single key, string-valued) is unconditionally treated as a real
    // encoded sentinel and handed to `encoder.decode()`, regardless of `mode` (mode only matters for
    // the `nhtio` tier / BYO codec, not for this raw-tier sentinel check) and regardless of whether
    // the string is genuinely encoder output. A lookalike therefore does NOT pass through untouched —
    // it throws E_ISOLATION_UNENCODABLE (wrapping the encoder's own decode failure). Confirmed
    // empirically against the installed peer.
    const lookalike = { __nhtio$: 'not-actually-encoded' }
    const wire = await encodeArgument(lookalike, { mode: 'raw', label: 'args[0]' })
    await expect(decodeArgument(wire, 'raw', 'args[0]')).rejects.toThrow(E_ISOLATION_UNENCODABLE)
  })

  it('an ordinary (non-sentinel-shaped) object passes through untouched in "raw" mode', async () => {
    const ordinary = { plain: true, nested: { n: 1 } }
    const wire = await encodeArgument(ordinary, { mode: 'raw', label: 'args[0]' })
    const decoded = await decodeArgument(wire, 'raw', 'args[0]')
    expect(decoded).toBe(ordinary) // same reference — raw mode never traverses/clones
  })
})

describe('encodeArgument() / decodeArgument() — "encoded" mode whole-value encode', () => {
  it('whole-value encodes even an otherwise-plain object', async () => {
    const value = { a: 1, b: [1, 2, 3] }
    const wire = await encodeArgument(value, { mode: 'encoded', label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
    const decoded = await decodeArgument(wire, 'encoded', 'args[0]')
    expect(decoded).toEqual(value)
  })

  it('throws E_ISOLATION_ENCODER_REQUIRED in "encoded" mode with no encoder available', async () => {
    setEncoderLoaderForTests(async () => undefined)
    await expect(encodeArgument({ a: 1 }, { mode: 'encoded', label: 'args[0]' })).rejects.toThrow(
      E_ISOLATION_ENCODER_REQUIRED
    )
  })
})

describe('encodeArgument() / decodeArgument() — BYO codec (injected { encode, decode })', () => {
  it('whole-value encodes/decodes via the injected codec, bypassing traversal + the encoder peer entirely', async () => {
    setEncoderLoaderForTests(async () => undefined) // prove the BYO path never touches the peer
    const byoCodec = {
      encode: (v: unknown) => `BYO:${JSON.stringify(v)}`,
      decode: (s: string) => JSON.parse(s.slice('BYO:'.length)),
    }
    const value = { fn: () => {}, plain: 1 } // would normally need the encoder for `fn`
    const wire = await encodeArgument(value, { mode: byoCodec, label: 'args[0]' })
    expect(wire.enc).toBe('nhtio')
    expect((wire as { v: string }).v.startsWith('BYO:')).toBe(true)
    const decoded = await decodeArgument(wire, byoCodec, 'args[0]')
    expect(decoded).toEqual({ plain: 1 }) // the function was dropped by BYO's own JSON encoding — expected
  })

  it('supports an async BYO codec', async () => {
    const byoCodec = {
      encode: async (v: unknown) => `ASYNC:${JSON.stringify(v)}`,
      decode: async (s: string) => JSON.parse(s.slice('ASYNC:'.length)),
    }
    const wire = await encodeArgument({ n: 7 }, { mode: byoCodec, label: 'args[0]' })
    const decoded = await decodeArgument(wire, byoCodec, 'args[0]')
    expect(decoded).toEqual({ n: 7 })
  })
})

describe('transfer() marker', () => {
  it("unwraps into the WireValue's `transfer` field, shipping the value raw", async () => {
    const buf = new ArrayBuffer(8)
    const marked = transfer(buf, [buf])
    const wire = await encodeArgument(marked, { label: 'args[0]' })
    expect(wire.enc).toBe('raw')
    expect(wire.enc === 'raw' && wire.v).toBe(buf)
    expect(wire.enc === 'raw' && wire.transfer).toEqual([buf])
  })

  it('is transparent when buried inside a plain container (no exotic leaf otherwise)', async () => {
    const buf = new ArrayBuffer(4)
    const original = { payload: transfer(buf, [buf]) }
    const wire = await encodeArgument(original, { label: 'args[0]' })
    // The transfer marker is inside a container, not the whole arg — since ArrayBuffer is an opaque
    // leaf (never classified exotic), the whole container ships raw untouched; the marker unwrap only
    // triggers at `toRawWireValue`'s top-level check, which this case does not hit. Document that here.
    expect(wire.enc).toBe('raw')
  })
})

describe('registerEncodableClasses() — real peer, non-empty list', () => {
  it('registers a class such that @nhtio/encoder itself round-trips it afterward', async () => {
    class Tag {
      constructor(public label: string) {}
      [ENCODE_METHOD](): Encodable {
        return { label: this.label }
      }
      static [DECODE_METHOD](data: Encodable): Tag {
        return new Tag((data as { label: string }).label)
      }
    }
    await registerEncodableClasses([Tag])
    const roundTripped = decode(encode(new Tag('x') as never))
    expect(roundTripped).toBeInstanceOf(Tag)
    expect((roundTripped as Tag).label).toBe('x')
  })
})
