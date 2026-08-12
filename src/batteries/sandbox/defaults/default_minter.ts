/** Pure default artifact-format registry for sandbox query results. */
import { extensionMimeResolver } from './extension_mime'
import { SpooledArtifact, SpooledJsonArtifact, SpooledMarkdownArtifact } from '@nhtio/adk/common'
import type { SpooledArtifactConstructor } from '@nhtio/adk/common'
import type { ArtifactMinter } from '@nhtio/adk/batteries/sandbox/contracts/artifact_minter'

/** A format declaration accepted by the default minter. */
export type ArtifactFormat = {
  /** Stable identifier for the format. */
  id: string
  /** MIME types handled by the format. */
  mime: string[]
  /** Filename extensions handled by the format. */
  extensions: string[]
  /** Lazy constructor loader; it is called only after the format is selected. */
  ctor: () => Promise<unknown>
}

const builtInFormats: ArtifactFormat[] = [
  {
    id: 'json',
    mime: ['application/json'],
    extensions: ['json'],
    ctor: async () => SpooledJsonArtifact,
  },
  {
    id: 'markdown',
    mime: ['text/markdown'],
    extensions: ['md', 'markdown'],
    ctor: async () => SpooledMarkdownArtifact,
  },
]

/** A pure minter with optional, lazily loaded consumer formats. */
export class DefaultArtifactMinter implements ArtifactMinter {
  readonly #formats: readonly ArtifactFormat[]

  constructor(formats: readonly ArtifactFormat[] = []) {
    this.#formats = [...builtInFormats, ...formats]
  }

  /** Return format metadata without invoking any constructor thunk. */
  async formats(): Promise<ArtifactFormat[]> {
    return this.#formats.map((format) => ({
      ...format,
      mime: [...format.mime],
      extensions: [...format.extensions],
    }))
  }

  /** Resolve the constructor for a MIME type; unknown types use the base artifact. */
  async constructorForMime(mime: string | undefined): Promise<SpooledArtifactConstructor> {
    const normalized = mime?.toLowerCase().split(';')[0].trim()
    const format = this.#formats.find((entry) =>
      entry.mime.some((item) => item.toLowerCase() === normalized)
    )
    if (format === undefined) return SpooledArtifact
    try {
      const resolved = await format.ctor()
      return isArtifactConstructor(resolved) ? resolved : SpooledArtifact
    } catch {
      return SpooledArtifact
    }
  }

  /** Resolve the constructor from a MIME type, then an extension, without validating content. */
  async constructorForPath(path: string, mime?: string): Promise<SpooledArtifactConstructor> {
    const detected =
      mime ?? (await extensionMimeResolver({ path, peek: async () => new Uint8Array(0) }))
    return this.constructorForMime(detected)
  }
}

/** The shared default registry. Its format thunks remain lazy until selected. */
export const defaultArtifactMinter = new DefaultArtifactMinter()

/** Select the default artifact constructor for a path. */
export const artifactConstructorForPath = (path: string, mime?: string) =>
  defaultArtifactMinter.constructorForPath(path, mime)

/** Select a constructor from a caller-provided minter, never throwing on bad metadata. */
export const constructorFromMinter = async (
  minter: ArtifactMinter,
  mime: string | undefined
): Promise<SpooledArtifactConstructor> => {
  try {
    const normalized = mime?.toLowerCase().split(';')[0].trim()
    const formats = await minter.formats()
    const format = formats.find((entry) =>
      entry.mime.some((candidate) => candidate.toLowerCase() === normalized)
    )
    if (format === undefined) return SpooledArtifact
    const resolved = await format.ctor()
    return isArtifactConstructor(resolved) ? resolved : SpooledArtifact
  } catch {
    return SpooledArtifact
  }
}

const isArtifactConstructor = (value: unknown): value is SpooledArtifactConstructor =>
  SpooledArtifact.isSpooledArtifactConstructor(value)
