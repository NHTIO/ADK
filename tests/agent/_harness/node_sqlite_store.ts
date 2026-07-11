// Node-only SQLite backend for the portable agent harness. Provides an `AgentExecFn` over the built-in
// `node:sqlite` (Node 24+), creating the SAME schema the browser's agent_sqlite_worker.ts creates, so the
// entire chat-history facade (agent_store_facade → _getAgentDb) runs unchanged in Node. Wire it via
// `_initAgentStoreWithExec(makeNodeSqliteExec())`.
//
// The browser stores to OPFS via opfs-sahpool in a Worker; here we use an in-memory (':memory:') DB by
// default so each harness run is clean. Pass a file path for persistence across runs.
import { DatabaseSync } from 'node:sqlite'
import type { AgentExecFn } from '../../../docs/.vitepress/theme/components/agent/agent_kysely_dialect'

// Mirror of agent_sqlite_worker.ts SCHEMA (kept in sync by hand; it is small and rarely changes).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model_content TEXT,
  created_at TEXT NOT NULL,
  references_json TEXT,
  attempts_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  model_content TEXT,
  importance REAL,
  created_at TEXT NOT NULL,
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS standing_instructions (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  model_content TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  checksum TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0,
  result_text TEXT,
  model_result_text TEXT,
  encoded TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toolcalls_conv ON tool_calls(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thoughts_conv ON thoughts(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_msg ON thoughts(message_id);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  filename TEXT,
  origin TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_conv ON media(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_msg ON media(message_id);
CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  doc_path TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  model_content TEXT,
  embedding BLOB,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_rag_doc ON rag_chunks(doc_path);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

export interface NodeSqliteStore {
  exec: AgentExecFn
  close: () => void
}

/**
 * Build a `node:sqlite`-backed AgentExecFn + the DB handle. Default `:memory:` (fresh per run).
 * The Kysely dialect issues single statements with positional (`?`) binds and reads rows back as
 * objects — DatabaseSync.prepare().all()/run() match that exactly.
 */
export function makeNodeSqliteStore(filename = ':memory:'): NodeSqliteStore {
  const db = new DatabaseSync(filename)
  db.exec(SCHEMA)
  const exec: AgentExecFn = (sql, parameters) => {
    const stmt = db.prepare(sql)
    // A statement that returns rows (SELECT / RETURNING) supports .all(); a mutation uses .run().
    // DatabaseSync throws on .all() for a non-returning statement, so branch on the leading keyword.
    const returnsRows = /^\s*(select|pragma|with)\b/i.test(sql) || /\breturning\b/i.test(sql)
    const params = parameters as never[]
    if (returnsRows) {
      return Promise.resolve(stmt.all(...params) as Record<string, unknown>[])
    }
    stmt.run(...params)
    return Promise.resolve([])
  }
  return { exec, close: () => db.close() }
}
