import { Disk } from 'flydrive'
import { resolve } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { FSDriver } from 'flydrive/drivers/fs'
import { makeFixtureRunner } from '../../_fixtures/runner'
import { calculateTool } from '@nhtio/adk/batteries/tools/math'
import { SpooledArtifact, SpooledJsonArtifact } from '@nhtio/adk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scriptedExecutor } from '../../_fixtures/scripted_executor'
import { statsDescribeTool } from '@nhtio/adk/batteries/tools/statistics'
import { FlydriveSpoolReader, FlydriveSpoolStore } from '@nhtio/adk/batteries/storage/flydrive'

// Each test suite gets its own subdirectory under tmp/ so parallel-running specs cannot
// collide. The FSDriver writes here; the directory is wiped before and after the suite.
const TMP_ROOT = resolve(__dirname, '../../../tmp/test-flydrive-functional')

const makeDisk = (subdir: string): Disk =>
  new Disk(
    new FSDriver({
      location: resolve(TMP_ROOT, subdir),
      visibility: 'public',
    })
  )

beforeAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
  await mkdir(TMP_ROOT, { recursive: true })
})

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

describe('flydrive store through TurnRunner', () => {
  it('persists a calculator tool result to disk and reads it back as a SpooledArtifact', async () => {
    const store = new FlydriveSpoolStore(makeDisk('calculator-end-to-end'))
    const exec = scriptedExecutor(
      [
        { toolCalls: [{ tool: 'calculate', args: { expression: '2 + 2' } }] },
        { message: 'It is 4.', ack: true },
      ],
      store
    )
    const { run, events } = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    // The runner finished cleanly
    expect(events.filter((e) => e.kind === 'turnEnd')).toHaveLength(1)

    // Reading the persisted bytes back via the flydrive-backed store reproduces the
    // calculator's "Result: 4" line.
    const reader = await store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledArtifact(reader!)
    const lines = await artifact.cat()
    expect(lines.some((l) => /Result:\s*4/.test(l))).toBe(true)
  })

  it('persists a JSON-artifact tool result (statsDescribeTool) and decodes through SpooledJsonArtifact', async () => {
    const store = new FlydriveSpoolStore(makeDisk('stats-json-artifact'))
    const exec = scriptedExecutor(
      [
        {
          toolCalls: [{ tool: 'stats_describe', args: { numbers: [10, 20, 30, 40, 50] } }],
        },
        { ack: true },
      ],
      store
    )
    const { run } = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: exec,
      tools: [statsDescribeTool],
    })

    await run()

    const reader = await store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledJsonArtifact(reader!, 'json')
    const lines = await artifact.cat()
    const parsed = JSON.parse(lines.join('\n')) as Record<string, unknown>
    expect(parsed.count).toBe(5)
    // `mean` is emitted as a precision-formatted BigNumber string; `median` stays a number.
    expect(parsed.mean).toBe('30')
    expect(parsed.median).toBe(30)
  })

  it('honours a per-store streamThresholdBytes override (force streaming mode end-to-end)', async () => {
    const store = new FlydriveSpoolStore(makeDisk('streaming-mode'), {
      streamThresholdBytes: 0, // force streaming mode for every reader handed out
    })
    const exec = scriptedExecutor(
      [{ toolCalls: [{ tool: 'calculate', args: { expression: '3 * 7' } }] }, { ack: true }],
      store
    )
    const { run } = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    // We can't directly observe the mode, but the reader must still produce the same content
    // as eager mode would.
    const reader = await store.read('tc-i0-1')
    expect(reader).toBeDefined()
    const artifact = new SpooledArtifact(reader!)
    const lines = await artifact.cat()
    expect(lines.some((l) => /Result:\s*21/.test(l))).toBe(true)
  })

  it('keyPrefix isolates concurrent turns sharing the same disk', async () => {
    const disk = makeDisk('keyprefix-isolation')
    const storeA = new FlydriveSpoolStore(disk, { keyPrefix: 'turn-a/' })
    const storeB = new FlydriveSpoolStore(disk, { keyPrefix: 'turn-b/' })

    const execA = scriptedExecutor(
      [{ toolCalls: [{ tool: 'calculate', args: { expression: '1 + 1' } }] }, { ack: true }],
      storeA
    )
    const execB = scriptedExecutor(
      [{ toolCalls: [{ tool: 'calculate', args: { expression: '5 + 5' } }] }, { ack: true }],
      storeB
    )

    const handleA = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: execA,
      tools: [calculateTool],
    })
    const handleB = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: execB,
      tools: [calculateTool],
    })

    await Promise.all([handleA.run(), handleB.run()])

    const readerA = await storeA.read('tc-i0-1')
    const readerB = await storeB.read('tc-i0-1')
    expect(readerA).toBeDefined()
    expect(readerB).toBeDefined()
    const linesA = await new SpooledArtifact(readerA!).cat()
    const linesB = await new SpooledArtifact(readerB!).cat()
    expect(linesA.some((l) => /Result:\s*2(?!\d)/.test(l))).toBe(true)
    expect(linesB.some((l) => /Result:\s*10\b/.test(l))).toBe(true)

    // And the underlying disk really has both keys
    expect(await disk.exists('turn-a/tc-i0-1')).toBe(true)
    expect(await disk.exists('turn-b/tc-i0-1')).toBe(true)
  })

  it('handle.store on the fixture runner is the FlydriveSpoolStore the executor was built with', async () => {
    const store = new FlydriveSpoolStore(makeDisk('handle-store'))
    const exec = scriptedExecutor([{ ack: true }], store)
    const { store: handleStore } = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: exec,
    })
    expect(handleStore).toBe(store)
    // And it's a FlydriveSpoolStore, not the default InMemorySpoolStore fallback.
    expect(handleStore).toBeInstanceOf(FlydriveSpoolStore)
  })

  it('a fresh FlydriveSpoolReader (without going through the store) reads the same bytes', async () => {
    const disk = makeDisk('reader-directly')
    const store = new FlydriveSpoolStore(disk)
    const exec = scriptedExecutor(
      [{ toolCalls: [{ tool: 'calculate', args: { expression: '9 * 9' } }] }, { ack: true }],
      store
    )
    const { run } = makeFixtureRunner<FlydriveSpoolStore>({
      executorCallback: exec,
      tools: [calculateTool],
    })

    await run()

    // Instead of going through store.read, construct a reader directly against the underlying
    // disk to prove the persisted-on-disk shape is consumer-readable without the store helper.
    const reader = new FlydriveSpoolReader(disk, 'tc-i0-1')
    const artifact = new SpooledArtifact(reader)
    const lines = await artifact.cat()
    expect(lines.some((l) => /Result:\s*81/.test(l))).toBe(true)
  })
})
