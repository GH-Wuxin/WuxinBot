# Agent Replay Harness Phase C1 checkpoint

Date: 2026-08-09
Phase B base commit: `fe1490f8eadc6bf748565938d92024ebb03f5d99`

## Status

Phase C1 is implemented and recoverable. Phase C2 has not started.

The C1 pipeline is:

```text
versioned semantic stateful commands
  -> real replayScenario/runToolLoop
  -> enforced and candidate invariant oracle
  -> fast-check automatic shrink
  -> scenario.min.json
  -> read from disk
  -> deterministic replay twice
  -> evidence.json
```

The generator and oracle are sidecars around the real `runToolLoop`; they do not implement a second Agent runtime. The C1 campaign remains offline and uses injected scripted LLM/tool boundaries, a temporary `APPDATA`, a fetch tripwire, and the production DB hash guard.

## Formal 1,000-case smoke

Command:

```powershell
node --import tsx tools/agent-runtime-campaign.ts --json
```

Result:

- seed: `20260809`
- requested runs: `1000`
- completed before first finding: `5`
- fast-check counterexample path: `4:1`
- shrinks: `1`
- status: `violation`
- production DB unchanged: `true`

The campaign correctly stopped on the first candidate finding. It did not expand to C2 or a 10k campaign.

## Candidate evidence

Finding: `RT_TOOL_COUNT_EXACT`

The minimized real-runtime trace observes one business tool call with an unsafe result. `runToolLoop` returns `toolCallsMade=0`, so the candidate reports:

```text
reported 0, observed 1
```

Classification: `provisional_real_production_candidate`.

This phase does not fix the production behavior or promote the candidate to an enforced contract. Human confirmation is still required before any separate production change.

Long-term replay truth:

- `tools/fixtures/agent-runtime/c1/scenario.min.json`
- `tools/fixtures/agent-runtime/c1/evidence.json`

Replay:

```powershell
npm run agent:replay -- tools/fixtures/agent-runtime/c1/scenario.min.json
```

The replay exits successfully because candidate violations are diagnostic, while its oracle output contains:

```text
DIAG [candidate] RT_TOOL_COUNT_EXACT: reported 0, observed 1
```

## Verification baseline

Focused checks:

- TypeScript: pass
- Phase B Agent Replay verifier: 20/20
- Phase C1 verifier: 5/5
- formal minimized scenario: stable disk replay, identical normalized traces
- production DB guard: unchanged

Whole repository:

```text
59/61 passed
```

The two failures are the same pre-existing baseline failures recorded before C1:

1. `bp-rank-verify.mjs`: `event-text BP1 fallback must complete`
2. `kb-verify.mjs`: `g4 python golden reference runs` (no `python`/`py` executable in the verifier environment)

C1 introduced no additional whole-repository verifier failure.

## Files belonging to C1

- `tools/agent-runtime/generator.ts`
- `tools/agent-runtime/campaign.ts`
- `tools/agent-runtime-campaign.ts`
- `tools/agent-runtime-c1-verify.mjs`
- `tools/fixtures/agent-runtime/c1/scenario.min.json`
- `tools/fixtures/agent-runtime/c1/evidence.json`
- `package.json`
- `tsconfig.json`
- this checkpoint

The unrelated untracked file `docs/recommend-semantic-consistency-audit.md` was deliberately left untouched and must not be included in a C1 checkpoint commit.

## Next decision

Do not start C2 from this checkpoint. First review and explicitly classify the `RT_TOOL_COUNT_EXACT` finding as one of:

- harness bug;
- invalid invariant;
- confirmed production candidate.

If confirmed, decide in a separate task whether to fix the unsafe-result accounting behavior and update the deterministic fixture expectations. Only after C1 is considered complete should compound faults, symbolic late/duplicate/reorder settlement, counterfactual replay, or a 10k campaign be considered.
