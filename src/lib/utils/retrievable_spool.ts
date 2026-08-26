import { Tokenizable } from '../classes/tokenizable'
import { Retrievable } from '../classes/retrievable'
import { SpooledArtifact } from '../classes/spooled_artifact'
import type { SpoolReader } from '../contracts/spool_reader'
import type { ConduitBytes } from '../contracts/dispatch_context'

export interface RetrievableSpoolContext {
  storeRetrievableBytes: (id: string, bytes: ConduitBytes) => SpoolReader | Promise<SpoolReader>
  turnRetrievables: Set<Retrievable>
}

export const computeTextHints = (text: string): { byteLength: number; lineCount: number } => ({
  byteLength: new TextEncoder().encode(text).byteLength,
  lineCount: text.length === 0 ? 0 : text.split('\n').length,
})

export async function autoSpoolRetrievable(
  ctx: Pick<RetrievableSpoolContext, 'storeRetrievableBytes'>,
  v: Retrievable
): Promise<Retrievable> {
  if (!Tokenizable.isTokenizable(v.content) || v.content.dynamic || v.inline) return v
  const text = v.content.toString()
  const hints = computeTextHints(text)
  const reader = await ctx.storeRetrievableBytes(v.id, text)
  const Ctor = v.artifactConstructor?.() ?? SpooledArtifact
  const artifact = new Ctor(reader)
  if (typeof (artifact as { _setSizeHints?: unknown })._setSizeHints === 'function') {
    artifact._setSizeHints(hints)
  }
  // Do not spread the instance: its derived enumerable `sizeUnknown` getter is not a
  // RawRetrievable field and strict validation intentionally rejects it.
  return new Retrievable({
    id: v.id,
    content: artifact,
    trustTier: v.trustTier,
    source: v.source,
    kind: v.kind,
    score: v.score,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    inline: v.inline,
    artifactConstructor: v.artifactConstructor,
  })
}

export async function normalizeRetrievables(ctx: RetrievableSpoolContext): Promise<void> {
  const records = await Promise.all(
    [...ctx.turnRetrievables].map((r) => autoSpoolRetrievable(ctx, r))
  )
  ctx.turnRetrievables.clear()
  for (const record of records) ctx.turnRetrievables.add(record)
}

export function assertUniqueRetrievableIds(recs: ReadonlyArray<Pick<Retrievable, 'id'>>): void {
  const seen = new Set<string>()
  for (const record of recs) {
    if (seen.has(record.id)) throw new Error(`Duplicate retrievable id: ${record.id}`)
    seen.add(record.id)
  }
}
