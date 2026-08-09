# Agent Replay / Stateful Fuzz Phase D evidence report

Date: 2026-08-09
Phase D baseline: `837c0d7fde45e3bc1036f4ac73f7c6fef10a5bee`
Status: **PAUSED ON FIRST NEW CANDIDATE**

## Executive result

The formal campaign was configured for 10,000 cases with fixed seed `20260813`. It stopped after the third completed C2 case, before running the remaining 9,997 cases, because it found a new candidate invariant violation:

- invariant: `RT_EFFECT_IDEMPOTENCY`;
- profile: `retry_destructive+immediate+none`;
- fast-check counterexample path: `2:1`;
- verified generator re-entry path: `2`;
- shrinks: 1;
- detail: `duplicate business effect at seq 11`;
- fingerprint: `155ccb693bf272f27fd6b19bffdead0e76dac8aec264243d2f51d7659544248a`;
- production DB unchanged during campaign: `true`.

The campaign was not expanded, C1 formal execution was not started, and the requested whole-repository final gate was not run. This is intentional: Phase D requires an immediate pause on the first new candidate.

No production runtime code was changed, no production seam was added, production Thinking remains disabled, Adaptive Reasoning Phase 2 was not entered, and nothing was deployed.

## Architecture and test boundary

The harness still wraps the real `runToolLoop`:

- scripted LLM responses are dependency input only;
- the fake executor responds only when the real runtime calls it;
- planner iterations, tool execution order, retry-by-next-model-turn, final handling, usage, and terminal state remain production control flow;
- actor, target, constraints, facts, claims, and business-effect identities remain oracle sidecars;
- deterministic settlement scheduling controls fake Promise settlement order only;
- actual Promise/Abort/timer fixtures cover a small targeted subset of real async ordering;
- no result claims equivalence to all Node event-loop, network, QQ, or external-tool races.

Replay is isolated with a temporary `DATA_DIR`, blocked `fetch`, injected LLM/tool boundaries, and strict production DB hashing. Scenario/trace/generator versions remain 1.

## Invariant registry at pause

### Enforced and passing in representative replay

- `RT_FINAL_NO_LLM`
- `RT_FINAL_NO_TOOL`
- `RT_FINAL_NO_EFFECT`
- `RT_DIRECT_EMIT_ONCE`
- `RT_DIRECT_LEAD_LIMIT`
- `RT_REQUIRED_ONCE`
- `RT_BOUNDED_LOOP`
- `RR_MONOTONIC_LOOP`
- `HARNESS_ISOLATED`
- `TRACE_DETERMINISTIC`
- `RT_TOOL_COUNT_EXACT`

`RT_TOOL_COUNT_EXACT` remains an enforced regression: the historical unsafe-result undercount is fixed, and the checked-in regression still observes executor=1 / `toolCallsMade=1`.

### Validated architectural candidates

#### `RT_ABORT_NO_LATE_EFFECT`

- current known production exposure: none known;
- current `server/bot.ts` has no outer turn abort/timeout seam around `runToolLoop`;
- checked-in scenario, trace, evidence, and targeted real-async ordering remain reproducible;
- it is not a current production failure gate.

Activation condition: any future turn-level cancellation, outer timeout, or `AbortSignal` production change must reopen the candidate and define cancellation propagation across the caller, active LLM request, `runToolLoop`, tool executor, and side-effect commit boundary. Partial cancellation support is not acceptable.

#### `RT_EFFECT_IDEMPOTENCY` — new Phase D finding

Classification: **validated architectural candidate**.

The minimized real-runtime sequence is:

1. planner calls `destructive_retry`;
2. the injected executor records business effect key `destructive-operation`, then returns `ok=false`;
3. the real runtime records `previousToolFailed` and permits the next planner turn;
4. the next scripted planner calls the same operation again;
5. the executor records the same business-effect identity a second time;
6. the oracle reports the duplicate at trace sequence 11.

This is not a harness bug: both tool calls originate from the real loop, and the harness records effects only when its injected executor is actually invoked. It is not an invalid invariant: a logical destructive operation must not commit twice merely because the result after the first commit was reported as failed.

It is not currently classified as a production violation. The production LLM schema is presently query-oriented (`query_osu`, `get_player_skill`), and the guard does not expose a general destructive operation. The recommendation path writes cooldown/history only after recommendation generation succeeds; persistence failure is swallowed rather than converted into an `ok=false` retry signal. Tool-call audit records may repeat, but they are telemetry rather than the destructive logical effect modeled by this invariant.

Current production exposure: **none known**.

Activation conditions requiring this candidate to be reopened or promoted:

- a mutating/destructive tool is exposed to the ordinary planner;
- an existing tool can commit an irreversible business effect and then return `ok=false` or throw;
- callers add automatic tool retry outside the current model-driven next turn;
- the same logical operation can cross a timeout/retry boundary without a stable operation key and idempotency check.

No production fix was attempted.

## Code-path evidence

- real ordinary tool execution: `server/bots/executor.ts:2426`;
- failed result becomes next-turn recovery state: `server/bots/executor.ts:2433`;
- no general runtime operation key exists in `ToolLoopOptions` or `ToolResult`;
- actual schema builder: `server/bots/registry.ts:153`;
- exposed query tool definitions: `server/bots/registry.ts:163` and `server/bots/registry.ts:223`;
- strict operation allowlist: `server/bots/guard.ts:12` and `server/bots/guard.ts:119`;
- recommendation persistence occurs after successful candidate generation: `server/bots/executor.ts:1828`.

## Replay, shrink, fault injection, and counterfactual capability

- versioned `scenario.min.json` is the long-term replay truth;
- enforced/candidate oracles are evaluated against normalized real-runtime traces;
- C1 and C2 use fast-check stateful commands and automatic shrink;
- C2 composes behavior, settlement, and outer-control fault dimensions;
- late, duplicate, reordered, abort, timeout, final-batch, bounded-failure, and destructive-retry profiles remain available;
- Fast/Thinking scripted counterfactual replay compares tool sequence/count, target, terminal state, reasoning decisions, simulated tokens/latency, and invariant outcomes without enabling production Thinking;
- candidate persistence writes scenario, normalized trace, evidence, classification fingerprint, seed, shrink path, and generator re-entry path.

The custom artifact path metadata was corrected during Phase D so `minimalReproduction`, `scenarioPath`, and `tracePath` point to the actual Phase D files rather than the older C2.1 fixture.

## Deterministic reproduction

The Phase D evidence verifier proves:

- the same minimized scenario produces byte-identical normalized traces across two runs;
- seed `20260813` plus generator re-entry path `2` regenerates the same semantic minimized scenario and shrinks again to `2:1` under generator version 1;
- the persisted trace matches fresh replay;
- the classification fingerprint matches fresh recomputation;
- normalized trace contains no absolute path, UUID, 13-digit timestamp, random localhost port, or raw timestamp field;
- the `RT_TOOL_COUNT_EXACT` regression remains enforced/pass;
- the `RT_ABORT_NO_LATE_EFFECT` fixture remains a stable non-gating architectural candidate.

Important fast-check detail: with the current `fc.commands` arbitrary, directly supplying the full reported shrink path `2:1` executes zero cases. The verified auxiliary replay input is the original case path `2`, which deterministically shrinks back to `2:1`. Both fields are preserved; `scenario.min.json` remains the authoritative replay source.

## Evidence files

- `tools/fixtures/agent-runtime/phase-d/new-finding/c2/scenario.min.json`
- `tools/fixtures/agent-runtime/phase-d/new-finding/c2/trace.json`
- `tools/fixtures/agent-runtime/phase-d/new-finding/c2/evidence.json`
- `tools/agent-runtime-phase-d-verify.mjs`

## Exact reproduction commands

Formal stopped campaign:

```powershell
npm run agent:campaign:c2 -- --seed 20260813 --runs 10000 --hard-limit-ms 60000 --artifact-dir tools/fixtures/agent-runtime/phase-d/new-finding/c2 --acknowledge-validated-abort-candidate --json
```

Generator re-entry and shrink reproduction:

```powershell
npm run agent:campaign:c2 -- --seed 20260813 --runs 10000 --path 2 --hard-limit-ms 10000 --artifact-dir tools/fixtures/agent-runtime/phase-d/replay-check --acknowledge-validated-abort-candidate --json
```

Authoritative scenario replay:

```powershell
npm run agent:replay -- tools/fixtures/agent-runtime/phase-d/new-finding/c2/scenario.min.json --json
```

Evidence verification:

```powershell
node --import tsx tools/agent-runtime-phase-d-verify.mjs
```

## Current blind spots

- scripted tools prove runtime control flow, not the internal idempotency of every production tool;
- there is no generic production operation key or effect ledger;
- current oracles cannot infer semantic equivalence of arbitrary natural-language operations;
- symbolic scheduling does not prove all real Node/OS/network races;
- QQ end-to-end delivery and external bot side effects remain outside `runToolLoop` replay;
- no turn-level cancellation contract exists;
- scripted Fast/Thinking variants do not predict real-model answer quality;
- the formal 10,000-case campaign did not complete after the mandatory first-candidate stop.

## Most valuable future extensions — not implemented

1. Define operation identity and idempotency requirements before exposing any mutating planner tool.
2. Add targeted production-tool fixtures for commit-then-fail behavior and classify each tool's retry safety.
3. Resolve the `fc.commands` full shrink-path replay limitation or persist a library-native replay token in addition to the authoritative scenario.
4. After human disposition of `RT_EFFECT_IDEMPOTENCY`, resume the same fixed-seed 10,000-case campaign without weakening the oracle.
5. Only after a separate design review, define complete turn-level cancellation propagation for `RT_ABORT_NO_LATE_EFFECT`.

## Pause boundary

Phase D is paused pending human review of `RT_EFFECT_IDEMPOTENCY`. Do not run the remaining campaign, repair production code, promote the candidate, enter Adaptive Reasoning Phase 2, or deploy without a new instruction.
