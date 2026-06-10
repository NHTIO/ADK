import { Media } from '../../src/lib/classes/media'
import { isError } from '../../src/lib/utils/guards'
import { inMemoryMediaReader } from '../../src/lib/helpers/media_readers'
import type { Tool } from '../../src/lib/classes/tool'
import type { DispatchContext } from '../../src/lib/contracts/dispatch_context'

/**
 * Builds a duck-typed {@link DispatchContext} stub rich enough for media-tool unit tests:
 * seeded `turnMessages` (with attachments) and `turnToolCalls` Sets for the resolver/list
 * scans, plus a `storeMediaBytes` conduit backed by `inMemoryMediaReader`.
 */
export interface MediaCtxStubOptions {
  /** Media attached to a synthetic user message. */
  attachments?: Media[]
  /** Media carried as a synthetic prior tool-call result. */
  toolResults?: Media[]
  /** Optional waitFor implementation (for gate tests). */
  waitFor?: (raw: unknown) => Promise<unknown>
}

/** The bytes captured by the stub's storeMediaBytes, keyed by id. */
export interface MediaCtxStub {
  ctx: DispatchContext
  stored: Map<string, Uint8Array>
}

/** Build a Media over in-memory bytes, for seeding stubs. */
export const mediaOf = (
  bytes: Uint8Array,
  mimeType: string,
  filename: string,
  id?: string
): Media =>
  Media.userAttachment({
    ...(id ? { id } : {}),
    kind: mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('audio/')
        ? 'audio'
        : 'document',
    mimeType,
    filename,
    reader: inMemoryMediaReader(bytes),
  })

/**
 * Create the enriched dispatch-context stub.
 *
 * @param options - Seeded attachments, tool results, and an optional gate.
 * @returns The stub context plus the byte store it writes into.
 */
export const makeMediaCtxStub = (options: MediaCtxStubOptions = {}): MediaCtxStub => {
  const stored = new Map<string, Uint8Array>()
  const turnMessages = new Set(
    options.attachments && options.attachments.length > 0
      ? [{ attachments: options.attachments }]
      : []
  )
  const turnToolCalls = new Set(
    options.toolResults && options.toolResults.length > 0 ? [{ results: options.toolResults }] : []
  )
  const ctx = {
    id: 'turn-1',
    emitToolExecutionStart: () => {},
    emitToolExecutionEnd: () => {},
    turnMessages,
    turnToolCalls,
    abortSignal: new AbortController().signal,
    storeMediaBytes: async (id: string, bytes: string | Uint8Array) => {
      const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      stored.set(id, u8)
      return inMemoryMediaReader(u8)
    },
    ...(options.waitFor ? { waitFor: options.waitFor } : {}),
  } as unknown as DispatchContext
  return { ctx, stored }
}

/** Discriminated outcome of invoking a media tool: string, Media, Media[], or a throw. */
export type MediaToolOutcome =
  | { kind: 'string'; out: string }
  | { kind: 'media'; media: Media }
  | { kind: 'media-list'; media: Media[] }
  | { kind: 'threw'; errorName: string; message: string; error: unknown }

/**
 * Invoke a media tool's executor against a stub context and classify the outcome.
 *
 * @param tool - The forged tool.
 * @param ctx - A stub from {@link makeMediaCtxStub}.
 * @param args - The tool args.
 * @returns The classified outcome.
 */
export const callMediaTool = async (
  tool: Tool,
  ctx: DispatchContext,
  args: unknown
): Promise<MediaToolOutcome> => {
  try {
    const out = await tool.executor(ctx)(args)
    if (Media.isMedia(out)) return { kind: 'media', media: out }
    if (Array.isArray(out) && out.every((m) => Media.isMedia(m))) {
      return { kind: 'media-list', media: out as Media[] }
    }
    return { kind: 'string', out: out as string }
  } catch (error) {
    const errorName =
      error && typeof error === 'object' && 'constructor' in error
        ? (error as { constructor: { name: string } }).constructor.name
        : 'Error'
    const message = isError(error) ? error.message : String(error)
    return { kind: 'threw', errorName, message, error }
  }
}
