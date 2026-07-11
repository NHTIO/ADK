// Turn snapshot / replay tooling for the portable agent harness.
//
// WHY: diagnosing a single looping turn by hand-slicing the HTTP dispatch dump is lossy and error-prone
// (it caused three flip-flopped diagnoses in one session). The reliable method is to SNAPSHOT the exact
// state a turn starts from, then REPLAY that same turn through the loop with a fix applied — a true A/B
// isolating one change. A turn's replayable state is (a) everything persisted in the SQLite store at
// turn-start (prior messages / thoughts / tool_calls / memories / standing instructions — the model-facing
// history the turn hydrates from) plus (b) the turn's input text. Everything else (tools, RAG index,
// adapter) is reconstructed identically from code.
//
// The store rows are already flat (TEXT columns; tool_calls.encoded holds the encoder snapshot of artifact
// handles; embeddings are BLOB), so we snapshot by dumping every table and serialising the row map with
// @nhtio/encoder — which round-trips the Uint8Array BLOBs and nulls cleanly (dogfoods the same encoder the
// runtime uses for artifact-handle persistence). Restore repopulates a fresh store by INSERTing the rows
// back verbatim.
import { encode, decode } from '@nhtio/encoder'
import type { Encodable } from '@nhtio/encoder'
import type { AgentExecFn } from '../../../docs/.vitepress/theme/components/agent/agent_kysely_dialect'

// Every table the chat-history facade persists (mirror of node_sqlite_store SCHEMA). kv/rag_chunks are
// excluded: rag_chunks is rebuilt from the on-disk index each run (not turn state), and kv is scratch.
const SNAPSHOT_TABLES = [
  'conversations',
  'messages',
  'memories',
  'standing_instructions',
  'tool_calls',
  'thoughts',
  'media',
] as const

export interface TurnSnapshot {
  /** The turn's input text (what harness.run({text}) was called with). */
  input: string
  /** Thread label + turn index, for provenance / filenames. */
  thread: string
  turn: number
  /** encode()d `{ [table]: Record<string,unknown>[] }` of every persisted row at turn-start. */
  rows: string
}

/** Snapshot the full persisted store state (all history tables) as an encoded string. */
export async function snapshotStoreRows(exec: AgentExecFn): Promise<string> {
  const dump: Record<string, Record<string, unknown>[]> = {}
  for (const table of SNAPSHOT_TABLES) {
    dump[table] = (await exec(`SELECT * FROM ${table}`, [])) as Record<string, unknown>[]
  }
  // Cast is purely to satisfy the compiler: `Record<string, unknown>[]` isn't statically assignable to
  // the recursive Encodable union (the `unknown` value type is the blocker). The values themselves are
  // never in question — @nhtio/encoder encodes essentially anything (primitives, typed arrays, Maps,
  // Errors, Luxon types, even functions), and the runtime already round-trips far richer objects than
  // these flat rows (live ToolCalls with OPFS artifact readers).
  return encode(dump as unknown as Encodable)
}

/** Build a full TurnSnapshot for the turn ABOUT TO RUN (call before harness.run). */
export async function captureTurnSnapshot(
  exec: AgentExecFn,
  thread: string,
  turn: number,
  input: string
): Promise<TurnSnapshot> {
  return { input, thread, turn, rows: await snapshotStoreRows(exec) }
}

/** Restore a snapshot's rows into a FRESH store (INSERT every captured row verbatim). */
export async function restoreStoreRows(exec: AgentExecFn, encodedRows: string): Promise<void> {
  const dump = decode(encodedRows) as Record<string, Record<string, unknown>[]>
  for (const table of SNAPSHOT_TABLES) {
    const rows = dump[table] ?? []
    for (const row of rows) {
      const cols = Object.keys(row)
      if (cols.length === 0) continue
      const placeholders = cols.map(() => '?').join(', ')
      const values = cols.map((c) => row[c] as never)
      await exec(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
        values as never
      )
    }
  }
}
