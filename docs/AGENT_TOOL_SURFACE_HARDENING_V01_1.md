# AGENT_TOOL_SURFACE_HARDENING_V01_1 — PRECOMMIT EDGE CHECK

Scope: no new functionality. This pass only proves/closes edge cases left open by
V01, before a potential commit. Working tree only — no commit, no push.

## 1. `AGENT_MAX_TOOL_CALLS_PER_TURN` is a user-turn budget, not a per-loop budget

Confirmed bug in V01: the limit was charged inside one `runToolLoop` invocation,
but `bot.ts`'s recommendation hard guard can invoke a **second**
`runToolLoop(requiredTool=recommend)` after the first. Two loops could therefore
execute up to 16 tool calls.

Minimal shared-budget fix:

- `ToolLoopOptions.toolCallsExecutedBeforeLoop?: number` — prior calls already
  charged to the same user turn.
- `ToolLoopResult.toolCallsMadeThisTurn?: number` — total executed calls across
  all loops of this turn.
- In `runToolLoop`, the batch allowance is now
  `min(4, 8 - (priorCalls + executedThisLoop))`.
- If `requiredTool` is requested while the turn budget is already exhausted, the
  deterministic call is **refused before execution and before any LLM call**:
  `工具调用已达上限，这次查询没有执行，请稍后再试。`
  (`toolCallsMade=0`, `toolCallsSkippedByCap=1`, `hardCapReached=true`).
- `bot.ts` carries `turnToolCallsMade` between its two `runToolLoop` calls.

Blackbox evidence (`tools/agent-tool-surface-hardening-cross-run-verify.mjs`,
19 checks):

- Executor seam: first loop executes 4+4=8; second
  `requiredTool=recommend` loop with `toolCallsExecutedBeforeLoop=8` executes
  zero, makes zero LLM calls, returns the safe refusal text.
- Real `processIncoming` blackbox: text `你觉得我适合打什么图` is deliberately
  non-deterministic for the primary classifier but triggers
  `hasFallbackRecommendIntent`. A mock LLM returns 4+4 guard-rejected tool calls
  and then a suspicious recommendation reply. The recommendation hard guard
  fires, but the forced recommend call does **not** cross `executeToolCall`.
  Observed through real audit logs: 8 `recent` audit rows, 0 `recommend` rows,
  3 LLM rounds (third is final synthesis), user receives the safe refusal.

## 2. `match` metadata: stateful, not readonly

`CAPABILITY_CATALOG.match` had `callable:false` but still claimed
`sideEffects:'readonly'`. Its executor writes `osuMatchListeners`, creates a
long-lived listener and continuously polls/pushes — that is stateful.

Fix:

- `CapabilityDescriptor.sideEffects` is now `'readonly' | 'stateful'`.
- `match` is `sideEffects:'stateful'`.
- `AGENT_CAPABILITY_META` derives the value from the catalog.
- Audit rule unchanged and now provable: **callable ⇒ readonly**
  (`NON_READONLY_AGENT_CAPABILITY` fires only for callable entries; command-only
  `stateful` is allowed).
- Verifier asserts `match.sideEffects === 'stateful'`, all callable entries are
  `readonly`, and the registry audit is clean.

## 3. Parameter contract: no valid enum value may be accepted-but-ignored

- `bot` is only actually consumed by `executeInternalBotCommand` for
  `capability=recent` (kanon → `!re`, others → yumu-compatible route). It was
  previously accepted for every player capability and silently ignored by
  bp/profile/info/ppplus/skill/recommend/bp_type, and rejected on beatmap caps.
- Fix: `bot.allowedFor = ['recent']` with schema text "仅 capability=recent
  使用…；其他查询类型请勿填写". Guard now rejects `bot` on every non-recent
  capability (beatmap and player alike) because the catalog family scoping is
  enforced both ways.
- `bot.ts` now attaches a named bot to deterministic `requiredTool` **only when
  capability is `recent`**, so the named-bot data route for `bp` etc. still runs
  the internal query without carrying a parameter the executor would ignore.
  (`named-bot-sandbox-verify` passes: `用猫猫查一下我的bp1` →
  `wuxin_internal` binding error path.)
- The 207-check hardening verifier now contains an exhaustive matrix:
  every exposed parameter × every callable capability must be exactly
  accepted-or-rejected by catalog `allowedFor`/`requiredFor`, plus the
  unexposed `compact` × every callable capability. Explicit regressions cover
  `pp_calc+bot`, `beatmap_lookup+bot`, `leaderboard+bot`, `recommend+bot`,
  `profile+bot`, `bp+bot`.

## 4. Mods contract: "成对双字母组合" is now enforced literally

- Runtime (`parseModsString`) tokenizes two-letter pairs; no single-letter osu!std
  mod exists. The honest contract is even-length concatenated pairs, so the
  guard and schema now use `^([A-Za-z]{2})*$` with `maxLength: 16`.
- Odd lengths (`H`, `HDD`) and spaces (`HD DT`) are rejected;
  `HD`, `HDHR`, `HDDT` remain accepted.
- Verifier locks both the schema pattern and the guard accept/reject behavior.

## 5. First `agent-runtime-verify` exit 2 — classification

Recorded as:

> **UNCLASSIFIED_TRANSIENT_TEST_PROCESS_FAILURE**

- Observed once in the previous pass: the CLI subprocess check inside
  `agent-runtime-verify` reported `AssertionError: valid fixture`, `2 !== 0`,
  while the identical fixture passed when invoked directly and passed on
  immediate rerun of the whole verifier.
- It does **not** match the repository's known Node24 teardown flake signature
  (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`, exit
  `3221226505`), so it is not attributed to that baseline.
- It did not recur in the V01_1 run: `agent-runtime-verify` passed end-to-end
  (20 checks, `productionDbUnchanged=true`).

## 6. Mandatory verification (all green)

- `tools/agent-tool-surface-hardening-cross-run-verify.mjs` — **19/19**:
  cross-run executor budget + real `processIncoming` blackbox (audit-log
  evidence: 8 recent, 0 recommend).
- `tools/agent-tool-surface-hardening-verify.mjs` — **207/207**: original
  V01 surface/cap/DSML/sticky/A6/drift coverage, now extended with exhaustive
  parameter matrix, valid-bot rejection, mods odd/even and match-stateful.
- `tools/capability-single-source-verify.mjs` — 33/33.
- `tools/agent-capability-verify.mjs` — 35/35 (callable ⇒ readonly,
  command-only stateful, match stateful).
- `tools/query-osu-policy-verify.mjs` — 63/63.
- `tools/reasoning-router-verify.mjs`, `bot-harness-verify.mjs`,
  `natural-chat-delivery-verify.mjs`, `processIncoming-deterministic-route-verify.mjs`,
  `quick-router-verify.mjs`, `named-bot-sandbox-verify.mjs`,
  `quick-bridge-p02-recent-verify.mjs`, `agent-tool-count-contract-verify.mjs`,
  `agent-runtime-verify.mjs` (20 checks), `agent-runtime-c1-verify.mjs`,
  `agent-runtime-c2-verify.mjs` — all pass.
- Core replay fixtures (7) — all `AGENT REPLAY PASS` /
  `productionDbUnchanged=true`.
- `npm run check` — typecheck + vite build + sanity + security, pass.
- `git diff --check` — clean.

## 7. Files changed in this edge pass

- `server/bot.ts` — shared `turnToolCallsMade` between the two runToolLoop
  calls; named-bot `bot` injection only for `recent`.
- `server/bots/executor.ts` — `toolCallsExecutedBeforeLoop` /
  `toolCallsMadeThisTurn`; requiredTool budget refusal; shared-budget cap math.
- `server/bots/capabilityCatalog.ts` — `sideEffects:'stateful'` for `match`;
  `bot` scoped to `recent`; mods pattern `^([A-Za-z]{2})*$`.
- `server/bots/agentCapabilities.ts` — `readonly | stateful` meta type derived
  from catalog; audit keeps callable ⇒ readonly.
- `server/bots/guard.ts` — mods even-pair lexical gate (bot applicability is
  already driven by the catalog).
- `tools/agent-tool-surface-hardening-verify.mjs` — extended to 207 checks.
- `tools/agent-tool-surface-hardening-cross-run-verify.mjs` — new blackbox.
- `tools/agent-capability-verify.mjs`, `tools/capability-single-source-verify.mjs`
  — updated contracts.

## 8. Commit readiness

**READY_TO_COMMIT** (once a commit is authorized). No commit, no push performed.
