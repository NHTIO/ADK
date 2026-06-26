// Unit coverage for the transformers.js custom model-source seam (0d). Pure + env-neutral (no peer
// import, no network), so it runs in BOTH the node and browser vitest projects — proving the resolver
// logic is identical cross-env, which is the whole point of the dual-env `env.customCache` mechanism.

import { describe, expect, it, vi } from 'vitest'
import {
  parseResourceKey,
  modelSourceToCache,
  installModelSource,
  withModelSource,
} from '@nhtio/adk/batteries/llm/transformers_js'

const HOST = 'https://huggingface.co/'

describe('parseResourceKey', () => {
  it('reverses the canonical remote-URL template into {repo, filename}', () => {
    expect(
      parseResourceKey(
        `${HOST}onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/vision_encoder_fp16.onnx`
      )
    ).toEqual({
      repo: 'onnx-community/gemma-4-E2B-it-ONNX',
      filename: 'onnx/vision_encoder_fp16.onnx',
    })
  })

  it('handles a nested repo + top-level file', () => {
    expect(parseResourceKey(`${HOST}Xenova/bge-small-en-v1.5/resolve/main/config.json`)).toEqual({
      repo: 'Xenova/bge-small-en-v1.5',
      filename: 'config.json',
    })
  })

  it('handles a non-main revision', () => {
    expect(parseResourceKey(`${HOST}some/repo/resolve/v2.0/tokenizer.json`)).toEqual({
      repo: 'some/repo',
      filename: 'tokenizer.json',
    })
  })

  it('returns undefined for the local-path probe (no remote host) → falls through', () => {
    expect(parseResourceKey('/local/models/some/repo/config.json')).toBeUndefined()
    expect(parseResourceKey('some/repo/config.json')).toBeUndefined()
  })

  it('honours a custom remoteHost', () => {
    expect(
      parseResourceKey('https://mirror.example.com/my/repo/resolve/main/file.bin', {
        remoteHost: 'https://mirror.example.com/',
      })
    ).toEqual({ repo: 'my/repo', filename: 'file.bin' })
  })
})

describe('modelSourceToCache', () => {
  it('wraps a Uint8Array hook result into a Response with the bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const cache = modelSourceToCache(async () => bytes)
    const res = await cache.match(`${HOST}a/b/resolve/main/config.json`)
    expect(res).toBeInstanceOf(Response)
    const got = new Uint8Array(await (res as Response).arrayBuffer())
    expect([...got]).toEqual([1, 2, 3, 4])
  })

  it('passes a string result through verbatim (path/URL redirect)', async () => {
    const cache = modelSourceToCache(async () => '/opfs/a/b/config.json')
    expect(await cache.match(`${HOST}a/b/resolve/main/config.json`)).toBe('/opfs/a/b/config.json')
  })

  it('returns undefined when the hook returns undefined (fall through to HF)', async () => {
    const cache = modelSourceToCache(async () => undefined)
    expect(await cache.match(`${HOST}a/b/resolve/main/config.json`)).toBeUndefined()
  })

  it('falls through (undefined) when the hook throws — never aborts the load', async () => {
    const cache = modelSourceToCache(async () => {
      throw new Error('opfs read failed')
    })
    expect(await cache.match(`${HOST}a/b/resolve/main/config.json`)).toBeUndefined()
  })

  it('does not call the hook for an unparseable (local) key', async () => {
    const hook = vi.fn(async () => new Uint8Array([9]))
    const cache = modelSourceToCache(hook)
    expect(await cache.match('/local/a/b/config.json')).toBeUndefined()
    expect(hook).not.toHaveBeenCalled()
  })

  it('passes the parsed {repo, filename} to the hook so per-submodule sourcing works', async () => {
    const seen: Array<{ repo: string; filename: string }> = []
    const cache = modelSourceToCache(async (req) => {
      seen.push(req)
      return undefined
    })
    await cache.match(`${HOST}org/model/resolve/main/onnx/vision_encoder.onnx`)
    await cache.match(`${HOST}org/model/resolve/main/onnx/decoder_model_merged.onnx`)
    expect(seen).toEqual([
      { repo: 'org/model', filename: 'onnx/vision_encoder.onnx' },
      { repo: 'org/model', filename: 'onnx/decoder_model_merged.onnx' },
    ])
  })
})

interface FakeEnv {
  useCustomCache: boolean
  customCache: unknown
  remoteHost?: string
  remotePathTemplate?: string
}

const makeEnv = (): FakeEnv => ({
  useCustomCache: false,
  customCache: null,
  remoteHost: HOST,
  remotePathTemplate: '{model}/resolve/{revision}/',
})

describe('installModelSource', () => {
  it('sets useCustomCache + customCache and restores the prior values', () => {
    const env = makeEnv()
    const restore = installModelSource(env as never, async () => undefined)
    expect(env.useCustomCache).toBe(true)
    expect(env.customCache).toBeDefined()
    restore()
    expect(env.useCustomCache).toBe(false)
    expect(env.customCache).toBeNull()
  })
})

describe('withModelSource', () => {
  it('installs the hook for the duration of load() then restores, and the load can read via env', async () => {
    const env = makeEnv()
    const bytes = new Uint8Array([5, 6, 7])
    let observedInside: { use: boolean; served?: unknown } = { use: false }

    const result = await withModelSource(
      env as never,
      async () => bytes,
      async () => {
        // Simulate the loader reaching for a file through env.customCache while the hook is active.
        const cache = env.customCache as { match: (k: string) => Promise<unknown> }
        const served = await cache.match(`${HOST}a/b/resolve/main/model.onnx`)
        observedInside = { use: env.useCustomCache, served }
        return 'loaded'
      }
    )

    expect(result).toBe('loaded')
    expect(observedInside.use).toBe(true)
    expect(observedInside.served).toBeInstanceOf(Response)
    // restored afterwards
    expect(env.useCustomCache).toBe(false)
    expect(env.customCache).toBeNull()
  })

  it('restores env even when load() throws', async () => {
    const env = makeEnv()
    await expect(
      withModelSource(
        env as never,
        async () => undefined,
        async () => {
          throw new Error('load boom')
        }
      )
    ).rejects.toThrow('load boom')
    expect(env.useCustomCache).toBe(false)
    expect(env.customCache).toBeNull()
  })

  it('serializes concurrent loads so they never observe each other on the global env', async () => {
    const env = makeEnv()
    const order: string[] = []
    const mk = (tag: string, ms: number) =>
      withModelSource(
        env as never,
        async () => undefined,
        async () => {
          order.push(`start:${tag}`)
          // env must reflect THIS call's install while it runs.
          expect(env.useCustomCache).toBe(true)
          await new Promise((r) => setTimeout(r, ms))
          order.push(`end:${tag}`)
          return tag
        }
      )
    const [a, b] = await Promise.all([mk('A', 20), mk('B', 1)])
    expect(a).toBe('A')
    expect(b).toBe('B')
    // Serialized: A fully completes before B starts (no interleave).
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B'])
    expect(env.useCustomCache).toBe(false)
  })
})
