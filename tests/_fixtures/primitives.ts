import { DateTime } from 'luxon'
import { validator } from '@nhtio/validation'
import { Tool } from '../../src/lib/classes/tool'
import { ToolCall } from '../../src/lib/classes/tool_call'
import { Tokenizable } from '../../src/lib/classes/tokenizable'
import { ArtifactTool } from '../../src/lib/classes/artifact_tool'
import { SpooledArtifact } from '../../src/lib/classes/spooled_artifact'
import { InMemorySpoolStore } from '../../src/batteries/storage/in_memory'
import type { RawTool } from '../../src/lib/classes/tool'
import type { RawToolCall } from '../../src/lib/classes/tool_call'
import type { RawArtifactTool } from '../../src/lib/classes/artifact_tool'

/**
 * Builds a minimally-valid {@link Tool} suitable for use as a registry entry, merge input,
 * etc. The handler is a no-op that returns `'ok'`. Override any field via the partial.
 */
export const makeTool = (overrides: Partial<RawTool> = {}): Tool => {
  const raw: RawTool = {
    name: 'sample',
    description: 'a sample tool',
    inputSchema: validator.object({ q: validator.string().optional() }),
    handler: async () => 'ok',
    ...overrides,
  }
  return new Tool(raw)
}

/**
 * Builds a minimally-valid {@link ArtifactTool} suitable for use as a registry entry. The
 * handler returns the literal string `'ok'`. Override any field via the partial — including
 * `ephemeral` and `onCollision` (the two fields most likely to vary in tests).
 */
export const makeArtifactTool = (overrides: Partial<RawArtifactTool> = {}): ArtifactTool => {
  const raw: RawArtifactTool = {
    name: 'sample_artifact_tool',
    description: 'a sample artifact tool',
    inputSchema: validator.object({ callId: validator.string().required() }),
    handler: () => 'ok',
    ...overrides,
  }
  return new ArtifactTool(raw)
}

/**
 * Builds a {@link SpooledArtifact} backed by a fresh {@link InMemorySpoolStore}. Returns the
 * artifact along with the underlying reader and store so tests can introspect persisted bytes.
 *
 * @remarks
 * The bytes are written under a deterministic `callId` (passed as the second argument, default
 * `'fixture-call'`) so multiple calls in the same test don't collide. Pass a different `callId`
 * per call if you need several artifacts on the same store.
 */
export const makeSpooledArtifact = async (
  bytes: string,
  callId: string = 'fixture-call',
  ArtifactCtor: typeof SpooledArtifact = SpooledArtifact
): Promise<{ artifact: SpooledArtifact; store: InMemorySpoolStore; callId: string }> => {
  const store = new InMemorySpoolStore()
  const reader = await store.write(callId, bytes)
  return { artifact: new ArtifactCtor(reader), store, callId }
}

/**
 * Builds a fully-formed {@link ToolCall} for use in tests that need entries in
 * `DispatchContext.turnToolCalls`. The `results` field accepts either a
 * {@link SpooledArtifact} (normal tool calls) or a {@link Tokenizable} (artifact-tool calls).
 *
 * @remarks
 * Defaults: `id = 'tc-1'`, `tool = 'sample'`, `args = {}`, `checksum = id`, `isComplete = true`,
 * `isError = false`, `fromArtifactTool = false`, temporal fields = now. Override anything via the
 * partial.
 */
export const makeToolCall = (
  results: SpooledArtifact | Tokenizable,
  overrides: Partial<RawToolCall> = {}
): ToolCall => {
  const now = DateTime.now()
  const id = overrides.id ?? 'tc-1'
  const raw: RawToolCall = {
    id,
    tool: 'sample',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results,
    fromArtifactTool: false,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  }
  return new ToolCall(raw)
}
