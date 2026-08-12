import { Media } from '../../common'
import { E_SANDBOX_FAILED, E_SANDBOX_NOT_INITIALIZED } from './exceptions'
import type { SandboxEpoch } from './types'
import type { SandboxFileSystem } from './contracts/file_system'
import type { MediaKind, MediaReader, MediaTrustTier } from '../../common'

/** The capability needed to decide whether a sandbox handle is still alive. */
export type SandboxEpochIsLive = (epoch: SandboxEpoch) => boolean

/** Arguments for {@link createSandboxMediaReader}. */
export interface SandboxMediaReaderOptions {
  /** The filesystem capability belonging to the sandbox handle. */
  fileSystem: SandboxFileSystem
  /** The already translated backend path. */
  path: string
  /** The epoch held by the sandbox handle when this reader was issued. */
  epoch: SandboxEpoch
  /** Predicate owned by the sandbox manager; this reader never issues or invalidates epochs. */
  isEpochLive: SandboxEpochIsLive
}

const assertLive = (options: SandboxMediaReaderOptions): void => {
  if (!options.isEpochLive(options.epoch)) throw new E_SANDBOX_NOT_INITIALIZED(['sandbox handle'])
}

const statRegularFile = async (options: SandboxMediaReaderOptions) => {
  assertLive(options)
  const metadata = await options.fileSystem.stat(options.path)
  if (metadata.kind !== 'file') {
    throw new E_SANDBOX_FAILED([
      `Sandbox path is not a regular file (kind: ${metadata.kind}): ${options.path}`,
    ])
  }
  return metadata
}

/**
 * Create a non-describable, replayable reader over a sandbox file.
 *
 * @remarks
 * Every operation checks the owning epoch, stats the path, and refuses anything whose filesystem
 * kind is not `file` before opening it. Every stream call then asks the injected filesystem for a
 * fresh stream; this reader deliberately has no byte cap and does not import a host filesystem.
 * The reader omits `describe()` because approval-bound sandbox capabilities must not cross a
 * serialisation boundary.
 *
 * @param options - The sandbox filesystem, translated path, epoch, and liveness predicate.
 * @returns A file-backed {@link MediaReader}.
 */
export const createSandboxMediaReader = (options: SandboxMediaReaderOptions): MediaReader => ({
  async stream(): Promise<ReadableStream<Uint8Array>> {
    await statRegularFile(options)
    assertLive(options)
    return options.fileSystem.read(options.path)
  },
  async byteLength(): Promise<number> {
    const metadata = await statRegularFile(options)
    assertLive(options)
    return metadata.size
  },
})

/** Arguments for {@link createSandboxMedia}. */
export interface SandboxMediaOptions extends SandboxMediaReaderOptions {
  /** Media modality assigned by the stage operation. */
  kind: MediaKind
  /** MIME type resolved by the stage operation. */
  mimeType: string
  /** Model-visible source filename. */
  filename: string
  /** Configuration-supplied provenance tier. */
  trustTier: MediaTrustTier
  /** Optional provenance label retained on the Media value. */
  source?: string
}

/**
 * Construct the staged media value returned by a mutating sandbox operation.
 *
 * @remarks
 * The shipped Media factories supply the conservative modality hazard and keep the trust-tier
 * choice explicit at this call site. The reader remains deliberately non-describable.
 *
 * @param options - File-reader and media labelling options.
 * @returns A staged {@link Media} value.
 */
export const createSandboxMedia = (options: SandboxMediaOptions): Media => {
  const args = {
    kind: options.kind,
    mimeType: options.mimeType,
    filename: options.filename,
    source: options.source,
    reader: createSandboxMediaReader(options),
  }
  switch (options.trustTier) {
    case 'first-party':
      return Media.toolGenerated(args)
    case 'third-party-public':
      return Media.retrievedPublic(args)
    case 'third-party-private':
      return Media.retrievedPrivate(args)
  }
}
