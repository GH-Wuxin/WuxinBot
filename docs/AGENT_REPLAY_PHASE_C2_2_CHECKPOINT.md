# Agent Replay Harness Phase C2.2 checkpoint

Date: 2026-08-09
C2.2 baseline: `5c467f72fbe9ff0bee455de0ee47b734a4652cfa`

## Status

Phase C2.2 is complete. Fast / Thinking counterfactual replay is fully offline, uses scripted responses, and executes both variants through the real `runToolLoop` via the existing Replay Harness.

No production file under `server/` was modified. Production Thinking was not enabled, no real LLM or business API was called, Adaptive Reasoning Phase 2 was not entered, and nothing was deployed.

The original untracked `docs/recommend-semantic-consistency-audit.md` remains untouched and is not part of this checkpoint.

## Runtime and reasoning boundary

`replayScenario` accepts one new harness-only option, `scriptedReasoningMode`. It overrides only the Shadow Reasoning decision recorded by the injected router:

- Fast records `fast / rule / fast_default`;
- Thinking records `thinking / rule / structured_fact_compare`.

The override is never sent to `completeChat`, the SDK, or a production model. It does not enable the production Thinking request parameter. The LLM and tool adapters remain deterministic offline scripts; all Agent state transitions, tool batching, iteration accounting, and termination still come from the real `runToolLoop`.

The result therefore validates runtime behavior under different scripted reasoning decisions. It does not predict or prove the answer quality of a real Fast or Thinking model.

## Versioned fixture and output

Long-term source fixture:

- `tools/fixtures/agent-runtime/counterfactual/fast-thinking.json`

Versions:

- `counterfactualSchemaVersion = 1`;
- `scenarioSchemaVersion = 1`;
- `traceSchemaVersion = 1`;
- `generatorVersion = 1`.

CLI:

```powershell
npm run agent:counterfactual
```

The CLI outputs, for both variants:

- tool sequence and actual tool call count;
- observed target;
- terminal state;
- Shadow reasoning decisions;
- simulated token usage and latency;
- invariant outcomes and cross-variant differences;
- deterministic fingerprint.

Golden result:

| Metric | Fast | Thinking | Difference |
|---|---:|---:|---:|
| Tool sequence | `lookup_profile` | `lookup_profile → lookup_detail` | changed |
| Tool calls | 1 | 2 | +1 |
| Target | `player-one` | `player-one` | unchanged |
| Terminal | result | result | response text differs |
| Simulated tokens | 230 | 450 | +220 |
| Simulated reasoning tokens | 0 | 180 | +180 |
| Simulated latency | 35 ms | 170 ms | +135 ms |

All enforced and candidate invariants pass in both variants. There are no invariant outcome differences and no campaign finding. Golden fingerprint:

`ebfed4d42b94100b0e55855b25ff3e68e8d34cf8060987486ded45021f3a3582`

## Oracle self-tests and smoke

The C2.2 verifier checks:

- incompatible counterfactual and Replay versions are rejected;
- invariant comparison reports pass/fail or level changes but does not misclassify detail-only changes as contract differences;
- both variants replay twice to identical normalized traces through the real runtime;
- all requested comparison fields match the golden contract;
- a 25-case fixed offline smoke remains deterministic and candidate-free;
- the production DB hash is byte-identical before and after the isolated C2.2 run.

No candidate was found, so no shrink artifact was created. If a future run finds one, campaign expansion must stop before classification and evidence preservation; no production bug should be fixed from the campaign path itself.

## RT_ABORT_NO_LATE_EFFECT registry status

Classification: **validated architectural candidate**.

- Current known production exposure: **none known**.
- Current `server/bot.ts` has no outer abort/timeout seam around `runToolLoop`.
- It remains neither repaired nor promoted to a known production violation.
- No partial `AbortSignal` support was added in C2.2.
- Any future production change that introduces turn-level cancellation, timeout, or `AbortSignal` must reopen this candidate and define a complete cancellation propagation contract across caller, `runToolLoop`, active LLM requests, tool execution, and business-side-effect commit boundaries.

The C2.1 symbolic and targeted async fixtures remain evidence of the architectural ordering risk only. They do not claim an active QQ-path violation under the current caller contract.

## Verification

- TypeScript: pass;
- Phase B: 20/20;
- Phase C1: 6/6;
- Phase C2.1: 8/8;
- Phase C2.1 targeted async: pass, existing architectural candidate reproduced;
- Phase C2.2: 5/5, smoke 25, no finding;
- Reasoning Router: 49/49;
- C2.2 strict production DB hash guard: unchanged;
- `git diff --check`: pass;
- whole repository: 64/65.

Current whole-repository baseline failure:

- `bp-rank-verify.mjs`: `event-text BP1 fallback must complete`.

`kb-verify.mjs` passed in this run. No bp-rank or knowledge-base code was changed. During the long whole-repository run, the already-running bot continued to write the production DB; individual isolation verifiers explicitly attributed those concurrent writes to `server/index.ts`. The C2.2 verifier's own strict before/after guard passed inside its isolated execution window.

## Recovery boundary

This checkpoint ends Phase C2.2. Do not infer permission to enable production Thinking, enter Adaptive Reasoning Phase 2, repair `RT_ABORT_NO_LATE_EFFECT`, modify other candidates, or deploy.
