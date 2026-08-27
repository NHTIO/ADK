#!/usr/bin/env node
// A scripted stand-in for the real `claude` binary, used by wrapper.node.spec.ts to exercise the
// wrapper's own argv construction, env construction, and process-lifecycle handling against a
// REAL child process (OS process-group/signal semantics cannot be exercised by an in-process
// fake). Behavior is driven entirely by environment variables, since `command.claudeBin` is
// spawned directly with a fixed argv the wrapper itself constructs — this fixture never
// interprets its own argv as instructions, only records it for the test to inspect afterward.
//
// Env vars:
//   FAKE_CLAUDE_ARGV_LOG        - file path to write this invocation's argv (JSON array) to, at
//                                 startup, before anything else — so a test can poll for it and
//                                 extract e.g. the `--mcp-config`-embedded bridge URL while this
//                                 process is still running.
//   FAKE_CLAUDE_ENV_LOG         - file path to write this invocation's own `process.env` (JSON
//                                 object) to, at startup — lets a test assert exactly what the
//                                 wrapper's `buildClaudeEnv` actually set on the grandchild.
//   FAKE_CLAUDE_LINES           - JSON array of stream-json line objects to emit on stdout
//                                 immediately at startup, one per line.
//   FAKE_CLAUDE_WAIT_FOR_FILE   - optional path; if set, this process blocks (polling) until the
//                                 file appears before proceeding to FAKE_CLAUDE_LINES_AFTER/exit —
//                                 lets a test hold this process open mid-turn (e.g. with a pending
//                                 tool call) and release it only once it has set up what it needs.
//   FAKE_CLAUDE_LINES_AFTER     - JSON array of lines to emit once FAKE_CLAUDE_WAIT_FOR_FILE's
//                                 file has appeared (or immediately, if that var is unset).
//   FAKE_CLAUDE_EXIT_DELAY_MS   - ms to wait after emitting the after-wait lines before exiting 0.
//                                 Omit together with FAKE_CLAUDE_HANG to exit immediately.
//   FAKE_CLAUDE_HANG            - if set, never exits on its own after emitting every line (used
//                                 to exercise the detached-process-group SIGTERM-kill path).

import { writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, JSON.stringify(argv))
}
if (process.env.FAKE_CLAUDE_ENV_LOG) {
  writeFileSync(process.env.FAKE_CLAUDE_ENV_LOG, JSON.stringify(process.env))
}

const emitLines = (envVar) => {
  const raw = process.env[envVar]
  if (!raw) return
  for (const line of JSON.parse(raw)) {
    process.stdout.write(JSON.stringify(line) + '\n')
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  emitLines('FAKE_CLAUDE_LINES')

  const waitFile = process.env.FAKE_CLAUDE_WAIT_FOR_FILE
  if (waitFile) {
    while (!existsSync(waitFile)) {
      await sleep(20)
    }
  }

  emitLines('FAKE_CLAUDE_LINES_AFTER')

  const exitDelayMs = process.env.FAKE_CLAUDE_EXIT_DELAY_MS
    ? Number(process.env.FAKE_CLAUDE_EXIT_DELAY_MS)
    : 0

  if (process.env.FAKE_CLAUDE_HANG) {
    // Never exit on our own — the test drives teardown via the wrapper's own process-group kill.
    // A bare "do nothing" here would let the event loop drain and exit naturally anyway (nothing
    // else pending), so an explicit interval is the actual keep-alive.
    setInterval(() => {}, 1_000)
    return
  }
  await sleep(exitDelayMs)
  process.exit(0)
}

void main()
