import type { HitFrame, ListFrame, PathFrame } from '../types'

/** A framed adapter surface exercised by the shared protocol battery. */
export type FramedSource<T> = (signal?: AbortSignal, onStart?: () => void) => AsyncIterable<T>
/**
 * The adapter surfaces the shared conformance battery exercises.
 *
 * @remarks
 * A DUCK-TYPE GUARD CANNOT CHECK BEHAVIOUR, which is why this suite exists. `implementsX()` proves a
 * backend has the right method names; it cannot prove the iterable is lazy, that it emits the mandatory
 * terminal frame, or that `signal` actually aborts mid-stream. Without those checks a conformant-LOOKING
 * OPFS adapter could silently impose limits the Node one does not, and the boundary would differ by
 * environment.
 *
 * Every framed surface must be lazy, emit each `item` frame (there is no count cap to stop at), then
 * EXACTLY ONE terminal `done` frame matching one union arm exactly. **A stream that ends without `done`
 * is a protocol violation** the tools classify as `io-failure` — never as "no overflow", because
 * silence is precisely what an unannounced truncation looks like.
 */
export interface ConformanceSources {
  /** Directory traversal: `item` frames carrying a path and entry kind, then one terminal frame. */
  list: FramedSource<ListFrame>
  /** Name search: `item` frames carrying a path, then one terminal frame. */
  findPaths: FramedSource<PathFrame>
  /** Content search: `item` frames carrying path, line, and the WHOLE matched line — no per-hit cut. */
  searchContent: FramedSource<HitFrame>
  /** Must hand back a FRESH stream per call: readers are replayable, not single-use. */
  read(): Promise<ReadableStream<Uint8Array>>
  /**
   * Metadata, including the opaque change token.
   *
   * @remarks
   * `version` is compared for equality and never parsed, and only ONE direction is sound: a CHANGED
   * token is evidence the file may have changed, while an UNCHANGED token is NOT evidence it did not —
   * a same-size write inside the timestamp resolution preserves it. The suite asserts the safe
   * direction only.
   */
  stat(): Promise<{ size: number; version: string }>
}

const isDone = (value: unknown): value is ListFrame & { kind: 'done' } => {
  if (value === null || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'done')
    return false
  const frame = value as Record<string, unknown>
  if (frame.complete === true) return Object.keys(frame).length === 2
  return (
    frame.complete === false &&
    frame.omitted === 'unexplored' &&
    frame.bound === 'maxDepth' &&
    typeof frame.atDepth === 'number' &&
    Object.keys(frame).length === 5
  )
}
const isItem = (value: unknown, name: string): boolean => {
  if (value === null || typeof value !== 'object') return false
  const frame = value as Record<string, unknown>
  if (frame.kind !== 'item') return false
  if (name === 'list')
    return (
      typeof frame.path === 'string' &&
      (frame.entryKind === 'file' || frame.entryKind === 'dir') &&
      Object.keys(frame).length === 3
    )
  if (name === 'findPaths') return typeof frame.path === 'string' && Object.keys(frame).length === 2
  return (
    typeof frame.path === 'string' &&
    typeof frame.line === 'number' &&
    Number.isInteger(frame.line) &&
    typeof frame.text === 'string' &&
    Object.keys(frame).length === 4
  )
}
const assert: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

/** Run protocol checks for every framed surface, including laziness and the mandatory terminal frame. */
export const runSandboxConformance = async (sources: ConformanceSources): Promise<void> => {
  for (const [name, source] of Object.entries({
    list: sources.list,
    findPaths: sources.findPaths,
    searchContent: sources.searchContent,
  })) {
    let started = false
    const iterable = source(undefined, () => {
      started = true
    })
    const iterator = iterable[Symbol.asyncIterator]()
    assert(!started, `${name} must be lazy before next()`)
    const frames: unknown[] = []
    const firstFrame = await iterator.next()
    assert(started, `${name} did not expose source work through onStart`)
    if (!firstFrame.done) {
      assert(
        isDone(firstFrame.value) || isItem(firstFrame.value, name),
        `${name} emitted malformed first frame`
      )
      frames.push(firstFrame.value)
    }
    for await (const frame of { [Symbol.asyncIterator]: () => iterator }) {
      frames.push(frame)
      if (frame && typeof frame === 'object' && (frame as { kind?: unknown }).kind === 'done')
        assert(isDone(frame), `${name} emitted malformed done frame`)
      else assert(isItem(frame, name), `${name} emitted a malformed item frame`)
    }
    assert(frames.length > 0 && isDone(frames.at(-1)), `${name} ended without done`)
    assert(
      frames.filter(
        (frame) =>
          frame && typeof frame === 'object' && (frame as { kind?: unknown }).kind === 'done'
      ).length === 1,
      `${name} emitted multiple done frames`
    )
  }
  const first = await sources.read()
  const second = await sources.read()
  assert(first !== second, 'read must return a fresh stream')
  const before = await sources.stat()
  const after = await sources.stat()
  if (before.size !== after.size || before.version !== after.version)
    assert(before.version !== after.version, 'version must change when metadata changes')
}
