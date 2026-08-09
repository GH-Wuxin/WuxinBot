# Agent Replay Harness Phase C2.1 checkpoint

Date: 2026-08-09
C2 baseline: `054f2d9343e6922b12e9de55aa8918dcc44fb02a`

## Status

Phase C2.1 infrastructure is implemented. The fixed-seed smoke stopped on its first candidate finding as required. Phase C2.2 has not started; production Thinking remains disabled and no deployment occurred.

No production Agent runtime file under `server/` was modified. C2.1 only extends the offline Replay Harness, scenario parser, trace/oracle layer, stateful generator, campaign CLI, deterministic fixtures and verifiers.

## Fault model

The stateful generator independently composes three dimensions:

- behavior: `normal`, `final_batch`, `retry_destructive`, `bounded_failures`;
- injected Promise settlement: `immediate`, `late`, `duplicate`, `reordered`;
- outer turn control: `none`, `abort`, `timeout`.

This produces explicit compound profiles such as `final_batch+duplicate+none`, `retry_destructive+late+none`, and `normal+late+abort` rather than one-off Boolean fixtures.

The deterministic scheduler controls only when the injected fake LLM/tool Promise attempts to resolve or reject. It records logical ticks and settlement attempts. It does not implement planner state, tool-loop state, retries, termination, or any other Agent transition; those remain the real `runToolLoop` implementation.

Duplicate and reordered resolver attempts use native Promise settlement. Only the accepted attempt executes the scripted result/effect producer. This proves harness ordering and single-settlement behavior, not generic idempotency inside arbitrary production tools.

## Oracle self-tests

The C2.1 verifier covers:

- all 48 behavior × settlement × control profiles parse and build deterministically;
- stateful command composition;
- stable logical tick and same-tick FIFO ordering;
- late-activity oracle positive and negative controls;
- destructive-effect identity oracle positive and negative controls;
- final + duplicate settlement skips the remainder of a real runtime batch;
- reordered duplicate resolver accepts once and records one business effect;
- delayed failures still terminate through real capped synthesis.

The separate targeted verifier uses real Promise, `AbortController`, and timers for a small number of ordering probes. It does not claim that the symbolic scheduler proves Node's event loop or production network races.

## First candidate and smoke stop

Command:

```powershell
npm run agent:campaign:c2 -- --json
```

Result:

- seed: `20260811`;
- requested: `1000`;
- completed before first finding: `3`;
- fast-check path: `2:2:1`;
- shrinks: `2`;
- finding: `RT_ABORT_NO_LATE_EFFECT`;
- detail: `business_effect at seq 9 after abort terminal`;
- fingerprint: `c0568b365ab1765d2cb7d75beef34e22411d5b55104ac18e1781eb3b633b8363`;
- production DB unchanged: `true`.

The remaining 997 cases and the 10k campaign were not run.

Long-term replay truth and evidence:

- `tools/fixtures/agent-runtime/c2/scenario.min.json`;
- `tools/fixtures/agent-runtime/c2/trace.json`;
- `tools/fixtures/agent-runtime/c2/evidence.json`.

## Classification

The minimized scenario starts one real `runToolLoop` tool execution, accepts a harness outer abort at logical tick 1, and settles the already-started tool at tick 4. The runtime then observes the business effect and tool result and starts another LLM generation before settling normally behind the already-accepted outer terminal.

The targeted real-async probe reproduces the same ordering with an actual Promise, `AbortController`, and timers. This rules out a symbolic scheduler bookkeeping artifact.

Classification: **production architectural candidate, conditional on an outer turn timeout/abort contract**.

- It is not a harness bug: all post-control activity is emitted by the real `runToolLoop` dependency calls.
- It is not an invalid desired invariant: once a caller accepts an outer terminal, late business activity must not mutate that ended turn.
- It is not yet an active QQ-path known violation: current `server/bot.ts` directly awaits `runToolLoop`, and `runToolLoop` accepts no `AbortSignal`. The harness control models a prospective outer terminal rather than an existing production caller seam.

No production cancellation fix is included. A future decision must define the actual caller-level timeout/abort contract, propagation into `runToolLoop`, and tool-specific cancellation/idempotency boundaries before promoting this candidate.

## Recovery boundary

Do not enter C2.2 while this candidate is awaiting user review. Do not enable production Thinking, fix unrelated candidates, deploy, or reinterpret the two existing whole-repository baseline failures as C2 regressions.
