# Agent Replay Phase B checkpoint

Date: 2026-08-09

Pre-checkpoint HEAD: `807ae92904fdd166b94c20ced774c90f0b14b6d6`

## Included scope

- Minimal production seam: `ToolLoopOptions.executeToolCallFn`, defaulting to the real executor.
- Offline replay CLI, versioned scenario/trace schemas, scripted adapters, invariant oracles and deterministic fixtures.
- Harness integrity gates, deterministic/redacted traces, fetch tripwire, temporary `DATA_DIR` and production DB hash guard.
- Node 22 verifier runner fix and locked `fast-check@4.9.0` development dependency.
- No property/stateful campaign and no Phase C implementation.

## Phase B acceptance baseline

- `npm run typecheck`: pass.
- `node --import tsx tools/agent-runtime-verify.mjs`: 20/20 pass on Node 20 and portable Node 22.14.0.
- Reasoning Router: 49/49 pass.
- Recommendation cooldown consistency: 14/14 pass.
- LLM timeout/abort: 15/15 pass.
- `npm run agent:replay`: deterministic final fixture pass; production DB unchanged.
- `npm run verify-all`: **58/60 pass**.

The two full-suite failures predate and are outside the Phase B change set:

1. `bp-rank-verify.mjs`: `event-text BP1 fallback must complete`.
2. `kb-verify.mjs`: `g4 python golden reference runs`; neither `python` nor `py` is available in the verification environment.

Do not reinterpret those two failures as Replay Harness regressions without a separate deterministic repro.

## Recovery boundary

The long-term replay source is a minimized scenario JSON, not a seed alone. Phase C must preserve automatic shrink output as `scenario.min.json` and must stop campaign expansion on the first candidate violation until it is classified as a harness bug, invalid invariant, or real production candidate.
