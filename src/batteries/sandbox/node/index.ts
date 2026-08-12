/**
 * @module @nhtio/adk/batteries/sandbox/node
 *
 * NODE-ONLY backends for the sandbox battery — the SRT policy enforcer, the in-process policy
 * evaluator, and the ripgrep-backed searcher.
 *
 * @remarks
 * **This subpath is deliberately NOT re-exported from `@nhtio/adk/batteries/sandbox`.** `srt_enforcer`
 * imports `node:child_process` and `fs_node` imports `node:fs`/`node:path`, so folding this barrel into
 * the main one would break the browser build and the portability suite. (`search_ripgrep` has no
 * `node:*` import of its own — it spawns THROUGH the enforcer — but it belongs here because it is
 * meaningless without one.) Reach for it explicitly:
 *
 * ```ts
 * import { srtEnforcer } from '@nhtio/adk/batteries/sandbox/node'
 * ```
 *
 * The OS boundary lives here and nowhere else. `srtEnforcer` is the ONLY place the ADK-to-SRT policy
 * mapping exists — if a second translation appears anywhere, the "ADK-owned types" firewall is
 * nominal and no non-SRT enforcer can implement the contract. `fs_node` is the in-process evaluator
 * used by the tools that run OUR code (`open_file*`, `stage_file`, `save_media`, `list_directory`);
 * it reproduces SRT's derived rules AND its profile-injected mandatory denies, because a gap there
 * lets `save_media` write paths the shell tool is refused. Only the shell and search paths get real
 * OS enforcement — SRT restricts spawned children, not this process.
 *
 * Attribution: the sandbox is Anthropic's `@anthropic-ai/sandbox-runtime` (Apache-2.0), consumed as
 * an optional peer.
 */
export * from './fs_node'
// NOT `export *`: `releaseSrtOwnershipForTests` deliberately invalidates the ownership invariant and
// must not be part of the published surface — a consumer calling it could make a live ADK-owned session
// look foreign to the next construction. It stays reachable for a direct module import, which is how
// the tests use it.
export { srtEnforcer, mapPolicy, type SrtEnforcerOptions } from './srt_enforcer'
export * from './search_ripgrep'
