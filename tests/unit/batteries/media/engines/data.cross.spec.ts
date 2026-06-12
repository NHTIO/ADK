import { describe, expect, it } from 'vitest'
import { dataEngine } from '../../../../../src/batteries/media/engines/data'
import { createMediaPipeline, MIME } from '../../../../../src/batteries/media'
import { implementsMediaEngine, EMPTY_MIME } from '../../../../../src/batteries/media/contracts'
import type { StepPayload } from '../../../../../src/batteries/media'

/** The deterministic text/data engine + the data.* verbs — pure, cross-env, no fixtures. */

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

const generate = async (to: string): Promise<{ bytes: Uint8Array; mimeType: string }> => {
  const result = await dataEngine().converts![0].convert({
    bytes: new Uint8Array(0),
    mimeType: EMPTY_MIME,
    filename: 'untitled',
    to,
  })
  return result.outputs[0]
}

describe('data engine — generation seeds', () => {
  it('implements the MediaEngine contract', () => {
    expect(implementsMediaEngine(dataEngine())).toBe(true)
  })

  it('empty→json seeds a parseable empty object', async () => {
    const out = await generate('json')
    expect(JSON.parse(decode(out.bytes))).toEqual({})
    expect(out.mimeType).toBe(MIME.JSON)
  })

  it('empty→html seeds a minimal document shell', async () => {
    const out = await generate('html')
    expect(decode(out.bytes)).toContain('<!doctype html>')
    expect(out.mimeType).toBe(MIME.HTML)
  })

  it.each(['txt', 'md', 'csv', 'yaml'])('empty→%s seeds empty text', async (to) => {
    const out = await generate(to)
    expect(decode(out.bytes)).toBe('')
  })
})

describe('data engine — conversions', () => {
  const convertVia = async (
    capabilityIndex: number,
    bytes: Uint8Array,
    mimeType: string,
    to: string
  ) => {
    const result = await dataEngine().converts![capabilityIndex].convert({
      bytes,
      mimeType,
      filename: 'data',
      to,
    })
    return result.outputs[0]
  }

  it('json ⇄ yaml round-trips', async () => {
    const json = encode(JSON.stringify({ a: { b: [1, 2] }, c: 'text' }))
    const yaml = await convertVia(1, json, MIME.JSON, 'yaml')
    expect(yaml.mimeType).toBe(MIME.YAML)
    const back = await convertVia(2, yaml.bytes, MIME.YAML, 'json')
    expect(JSON.parse(decode(back.bytes))).toEqual({ a: { b: [1, 2] }, c: 'text' })
  })

  it('csv ⇄ json both directions (array-of-arrays table shape)', async () => {
    const csv = encode('a,1\nb,2\n')
    const json = await convertVia(3, csv, MIME.CSV, 'json')
    expect(JSON.parse(decode(json.bytes))).toEqual([
      ['a', '1'],
      ['b', '2'],
    ])
    const back = await convertVia(1, json.bytes, MIME.JSON, 'csv')
    expect(decode(back.bytes).trim().split(/\r?\n/)).toEqual(['a,1', 'b,2'])
  })

  it('json → txt pretty-prints', async () => {
    const out = await convertVia(1, encode('{"a":1}'), MIME.JSON, 'txt')
    expect(decode(out.bytes)).toBe('{\n  "a": 1\n}')
  })
})

describe('append + data.* verbs (pipeline)', () => {
  const text = (content: string, ext = 'txt', mime: string = MIME.TXT): StepPayload => ({
    bytes: encode(content),
    mimeType: mime,
    filename: `file.${ext}`,
  })

  it('append adds a line to txt', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(text('line one'), 'append text="line two"')
    expect(decode((result as { payload: StepPayload }).payload.bytes)).toBe('line one\nline two\n')
  })

  it('append on csv builds rows', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(
      text('a,1', 'csv', MIME.CSV),
      'append text="b,2" | append text="c,3"'
    )
    expect(decode((result as { payload: StepPayload }).payload.bytes)).toBe('a,1\nb,2\nc,3\n')
  })

  it('data.set on json creates the path and value', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(text('{}', 'json', MIME.JSON), `data set path=a.b value='42'`)
    const value = JSON.parse(decode((result as { payload: StepPayload }).payload.bytes))
    expect(value).toEqual({ a: { b: 42 } })
  })

  it('data.set on yaml preserves the YAML format', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(
      { bytes: encode('a: 1\n'), mimeType: MIME.YAML, filename: 'f.yaml' },
      `data set path=b value='"two"'`
    )
    const out = decode((result as { payload: StepPayload }).payload.bytes)
    expect(out).toContain('a: 1')
    expect(out).toContain('b: two')
    expect(() => JSON.parse(out)).toThrow() // still YAML, not JSON
  })

  it('data.merge deep-merges a fragment', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(
      text('{"a":{"x":1},"keep":true}', 'json', MIME.JSON),
      `data merge fragment='{"a":{"y":2}}'`
    )
    const value = JSON.parse(decode((result as { payload: StepPayload }).payload.bytes))
    expect(value).toEqual({ a: { x: 1, y: 2 }, keep: true })
  })

  it('data.delete removes a key; missing path fails readably', async () => {
    const mp = await createMediaPipeline()
    const result = await mp.query(text('{"a":1,"b":2}', 'json', MIME.JSON), 'data delete path=a')
    expect(JSON.parse(decode((result as { payload: StepPayload }).payload.bytes))).toEqual({
      b: 2,
    })
    await expect(
      mp.query(text('{"a":1}', 'json', MIME.JSON), 'data delete path=zzz')
    ).rejects.toThrow(/does not exist/)
  })

  it('empty:json | data.set — the create-then-populate chain through the registry', async () => {
    const mp = await createMediaPipeline({ engines: [dataEngine()] })
    const minted = await mp.capabilities.convert({
      bytes: new Uint8Array(0),
      mimeType: EMPTY_MIME,
      filename: 'untitled',
      to: 'json',
    })
    const result = await mp.query(
      {
        bytes: minted.outputs[0].bytes,
        mimeType: minted.outputs[0].mimeType,
        filename: 'untitled.json',
      },
      `data set path=greeting value='"hello"'`
    )
    expect(JSON.parse(decode((result as { payload: StepPayload }).payload.bytes))).toEqual({
      greeting: 'hello',
    })
  })
})
