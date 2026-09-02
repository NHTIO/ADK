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

/** Optional mutation fixture for adapters that expose filesystem mutators. */
export interface ConformanceMutations {
  /** A fresh disposable path in the selected existing directory, so checks cannot collide with repository files. */
  makeFile(text: string, options?: { directory?: 'default' | 'other' }): Promise<string>
  /** A fresh absent path with an existing parent, allowing rename checks without requiring mkdir. */
  freePath(options?: { directory?: 'default' | 'other' }): Promise<string>
  /** Observe the post-mutation metadata, including entry kind for directory checks. */
  stat(path: string): Promise<{ size: number; version: string; kind: string }>
  /** Read fixture content after a mutation, proving that the operation preserved or wrote the expected text. */
  read(path: string): Promise<string>
  /** Replace fixture content and make the new text observable through a subsequent read. */
  write(path: string, text: string): Promise<void>
  /** Remove a fixture; the optional operation must also resolve when the path is already absent. */
  delete?(path: string): Promise<void>
  /** Move a fixture and overwrite an existing destination, matching the filesystem contract. */
  rename?(from: string, to: string): Promise<void>
  /** Create the requested directory hierarchy and accept an already-existing directory. */
  mkdir?(path: string): Promise<void>
}

/** Result metadata from mutation conformance, including operations that were not exercised. */
export interface SandboxConformanceReport {
  /** Names each skipped mutation group rather than silently presenting it as passed. */
  skipped: string[]
}

const isDone = (value: unknown): value is ListFrame & { kind: 'done' } => {
  if (value === null || typeof value !== 'object' || (value as { kind?: unknown }).kind !== 'done')
    return false
  const frame = value as Record<string, unknown>
  if (frame.complete === true) return Object.keys(frame).length === 2
  if (
    frame.complete === false &&
    frame.omitted === 'unexplored' &&
    frame.bound === 'maxDepth' &&
    typeof frame.atDepth === 'number' &&
    Object.keys(frame).length === 5
  )
    return true
  return (
    frame.complete === false &&
    frame.omitted === 'over-limit' &&
    frame.bound === 'limit' &&
    typeof frame.shown === 'number' &&
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
const rejects = async (operation: () => Promise<unknown>, message: string) => {
  let failed = false
  try {
    await operation()
  } catch {
    failed = true
  }
  assert(failed, message)
}

/** Run protocol and, when supplied, optional filesystem mutation checks. */
export function runSandboxConformance(sources: ConformanceSources): Promise<void>
export function runSandboxConformance(
  sources: ConformanceSources,
  mutations: ConformanceMutations
): Promise<SandboxConformanceReport>
export async function runSandboxConformance(
  sources: ConformanceSources,
  mutations?: ConformanceMutations
): Promise<void | SandboxConformanceReport> {
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

  const skipped: string[] = []
  if (!mutations) return undefined
  if (typeof mutations.delete === 'function') {
    const path = await mutations.makeFile('delete me')
    await mutations.delete(path)
    await rejects(() => mutations.stat(path), 'delete must remove the file')
    await mutations.delete(path)
  } else skipped.push('delete')
  if (typeof mutations.rename === 'function') {
    const source = await mutations.makeFile('rename source')
    const destination = await mutations.makeFile('old destination')
    const { size } = await mutations.stat(source)
    await mutations.rename(source, destination)
    await rejects(() => mutations.stat(source), 'rename must remove its source')
    const renamedMetadata = await mutations.stat(destination)
    assert(renamedMetadata.size === size, 'rename must preserve source size')
    const crossSource = await mutations.makeFile('cross directory', { directory: 'default' })
    const crossDestination = await mutations.freePath({ directory: 'other' })
    await mutations.rename(crossSource, crossDestination)
    await rejects(() => mutations.stat(crossSource), 'cross-directory rename left its source')
    assert(
      (await mutations.read(crossDestination)) === 'cross directory',
      'cross-directory rename lost content'
    )
  } else skipped.push('rename')
  const mkdir = mutations.mkdir
  if (typeof mkdir === 'function') {
    const directory = await mutations.freePath()
    await mkdir(directory)
    const directoryMetadata = await mutations.stat(directory)
    assert(directoryMetadata.kind === 'dir', 'mkdir must create a directory')
    await mkdir(directory)
    const file = `${directory}/round-trip.txt`
    await mutations.write(file, 'round trip')
    assert((await mutations.read(file)) === 'round trip', 'write must round-trip text')
    await rejects(() => mkdir(file), 'mkdir on a file must reject')
  } else skipped.push('mkdir')
  {
    const path = await mutations.makeFile('initial')
    await mutations.write(path, 'round trip')
    assert((await mutations.read(path)) === 'round trip', 'write must round-trip text')
  }
  return { skipped }
}
