# research/

Reproducibility artifacts for the token-thrift context-management evaluation — the
head-to-head (h2h) matrix and supporting probes behind `docs/the-loop/token-thrift.md`.
These are R&D scripts, not shipped product code and not part of the package build.

## What's here

- `h2h_rerun.mjs`, `h2h_scrub_threads.mjs`, `h2h_peek.mjs`, `judge_committee.mjs` — the
  5-cell x 3-arm (thrift/compact/naive) head-to-head matrix: run cells, re-run
  contaminated threads in isolation, peek at live status, and judge finished arms.
- `corpus_run.mjs`, `floor_calibrate.mjs`, `verify_capacity.mjs`, `verify_rhetorical.mjs`,
  `verify_stale_bleed.mjs` — corpus/regression runners and point verifications used
  while building the context-management gates.
- `_stress_run.mjs`, `_stress_threads.mjs`, `_t12_run.mjs`, `_t12_threads.mjs`,
  `_adversarial_edge_threads.mjs`, `_adversarial_hostile_threads.mjs` — stress and
  adversarial thread runners feeding the same corpus harness.
- `probe_worker_engine.mjs`, `smoke_litert_worker.mjs`, `_probe/` — Worker-isolation
  probes for the LiteRT-LM engine (build via `_probe/litert-probe.vite.config.mts`,
  drive via `probe_worker_engine.mjs`).

## Environment variables

- `ADK_LB_BASE` — base URL for the nht OpenAI/Ollama-compatible load balancer used by
  the h2h scripts. Falls back to `~/.pi/agent/models.json` provider `nht` if unset.
- `TEST_OLLAMA_*` (`TEST_OLLAMA_BASE_URL`, `TEST_OLLAMA_API_KEY`, `TEST_OLLAMA_MODEL`,
  `TEST_OLLAMA_ENCODING`) — Ollama/LB transport config consumed by the Node corpus
  harness (`tests/agent/stress_corpus.node.spec.ts`).
- `TEST_OLLAMA_AGENT=1` — enables the gated real-model agent specs these scripts spawn
  via vitest.
- `H2H_TAG`, `H2H_DIR`, `H2H_CELL` — scope a `judge_committee.mjs` run to a specific
  cell/tag/output directory.

## Outputs

Reports, dumps, and judge logs are written to `/tmp/h2h2/` (per-cell, per-arm JSONL
files: `<tag>_<arm>_report.jsonl`, `<tag>_<arm>_dump.jsonl`, plus scrub/backup variants).
