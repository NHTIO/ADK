# Delegation notes — what actually constrains a work-package job

Written after three failed dispatches and two wrong diagnoses. Read this before dispatching.

## The constraint is OUTPUT volume, not input volume

Commit `3d4aafd` justified extracting `shared-contracts.md` with a prompt-size theory: that
pointing a delegatee at the 3,177-line / 225KB design plan exhausted its context before it wrote
code. **That rationale was wrong**, and this note is the correction — the commit message stands in
the history, so the record needs fixing here rather than pretending it said something else.

What the evidence actually shows:

| Job | Read | Asked to write | Result |
|---|---|---|---|
| `orch-wp01` | 225KB plan + 9KB spec | 11 files | exit 0, **nothing written** |
| `orch-wp01-b` | same | 11 files | exit 0, **nothing written** |
| `orch-wp01-c` | 73KB contracts + spec | 11 files | wedged, nothing written |
| `probe-read-73k` | **73KB contracts** | 1 tiny file | read fine, counted 74 exports |
| `probe-write-code` | 2KB example | 1 small file | correct, idiomatic output |
| `orch-wp01-types` | 73KB contracts | **1 file** | 1,156 lines, 74 exports, correct |

A probe read the whole 73KB contracts file and answered accurately about its contents, so reading
is not the limit. Every success wrote **one** file; every failure was asked for **eleven**. The
model's output cap (~16K) is the binding constraint, and overrunning it produces a silent exit 0
with zero files — reported by the delegator as `completed successfully`.

## Rules that follow

1. **One file per job.** A work package is a unit of ownership, not a unit of dispatch. WP 01
   became ~11 sequential jobs; expect the same ratio elsewhere. This creates no ownership conflict,
   since file ownership is already one-WP-per-file.
2. **Never trust a terminal status as proof of work.** `status: completed` with
   `agentMessageCount: 0` and no `finalMessage` is a null result. Check the filesystem.
3. **Verify each delivered file by EXECUTION before committing it.** A delegatee will happily write
   a comment asserting "verified against the real classes: 14/15/7" because the prompt said so — it
   has no way to know, and a wrong assertion reads exactly as confident as a right one.
4. **`shared-contracts.md` is still the right file to point at** — not because the full plan is too
   big to read, but because it is the normative slice, and a delegatee reading design narrative may
   redesign rather than transcribe.

## Diagnosis discipline

Both wrong theories came from reasoning about the *inputs* while the answer was in the *outputs*.
The cheap check that would have settled it immediately: compare what luna successfully produced
against what each job was asked to produce. Probes are the wire; retries on a theory teach nothing.
