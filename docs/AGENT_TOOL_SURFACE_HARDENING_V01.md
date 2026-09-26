# AGENT_TOOL_SURFACE_HARDENING_V01

Checkpoint: `490bb863a90fb5629182751923867cb094f38bf6`（working tree，未 commit / 未 push）

Audit scope: the LLM-facing tool surface and the executor boundary behind it —
`capabilityCatalog.ts` → `agentCapabilities.ts` / `registry.ts` → `guard.ts` →
`executor.ts`, including the textual DSML fallback path and the offline replay
harness.

## Per-item classification

| Item | Finding | Classification |
| --- | --- | --- |
| A1 `match` agent-callable | `match` was in the `query_osu` enum while its executor writes `osuMatchListeners`, creates a long-lived `MatchListener` and starts continuous polling with later group pushes. That violates the Agent readonly contract. | **CONFIRMED_BUG** — fixed |
| A2 tool-call hard bound | `maxIterations=5` only bounded LLM rounds; nothing bounded calls per response or per turn, so a single 100-call `tool_calls` batch would execute all 100. No production incident observed. | **HARDENING** — implemented |
| A3 silently-ignored params | `recent + bp_rank`, `profile + bp_start/bp_end`, `recent + compact` passed the guard and were then ignored by the executor. Out-of-enum `bot` values were silently coerced to `wuxin_internal`. | **CONFIRMED_BUG** — fixed |
| A4 schema/runtime drift | `bp_start` schema said "最多 20 张" while guard/runtime allowed 100; `bot` description said beatmap queries "忽略 bot" while the catalog/guard now reject it; `username`/`mods` lexical gates existed only in the guard. | **CONFIRMED_CONTRACT_MISMATCH** — fixed |
| A5 `previousToolFailed` | Was `lastToolFailed = !result.ok` per call, so a fail→success batch let the next planner see `false`. The reasoning-router rule (`tool_failure_recovery`) is "any tool failed since the last planner decision". | **CONFIRMED_BUG** — fixed |
| A6 rollout/sideEffects | All remaining callable capabilities are `sideEffects:'readonly'` and `rollout:'all'`; rollout/owner_canary is metadata only, not enforcement. No live violation existed. | **HARDENING** — audit gate + verifier added, no speculative enforcement built |
| DSML parity | Textual `<invoke>` calls already flowed through exposed-name filtering + `validateOperation`; A2 now applies the same 4/8 budget to parsed DSML. | **HARDENING** — verified, no route change needed |

## Tool surface before / after

| | Before | After |
| --- | --- | --- |
| LLM tools (internal registry) | `query_osu`, `get_player_skill` | `query_osu`, `get_player_skill` (unchanged) |
| `query_osu.capability.enum` | 12 values incl. `match` | 11 values: `bp`, `bp_type`, `recent`, `info`, `profile`, `ppplus`, `skill`, `recommend`, `beatmap_lookup`, `pp_calc`, `leaderboard` |
| `match` via Agent guard | accepted → `matchManager` write path | rejected: `无效的查询类型: match` |
| `match` command-side | `!ml` → `executeInternalBotCommand` | unchanged — `internalCapabilitySupported('match') === true`, `INTERNAL_CAPABILITIES` still contains it |
| Dormant tools | `query_external_bot` / `query_bot` / `list_bots` / `get_recent_score` never in LLM schema | unchanged |

Implementation notes for A1:

- `CAPABILITY_CATALOG.match.callable = false` with the readonly-contract reason in the catalog itself.
- `AGENT_CAPABILITY_META` now covers **all** catalog capabilities, deriving `callable`
  from the catalog, so `match` is audited instead of disappearing from the meta table.
- `guard.ts` already rejected non-callable capabilities via `isCallableCapability`;
  no guard change was needed for the capability name itself.
- `registry.ts` keeps `INTERNAL_CAPABILITIES` derived from `capabilityNames()` (all 12),
  so the `!ml` command route is untouched.

## A2 hard-cap specification

Constants in `server/bots/executor.ts`:

```ts
export const AGENT_MAX_TOOL_CALLS_PER_RESPONSE = 4;
export const AGENT_MAX_TOOL_CALLS_PER_TURN = 8;
```

Evidence basis: production replay fixtures and seams observe 0–2 settled calls per
turn (recommend/bp chains, direct leads). 4/8 keeps every legitimate chain while
bounding a malicious 100-call response. The constants are exported so the verifier
locks the values.

Semantics:

- `toolCallsMade` counts **executed-and-settled** calls only. Skipped calls never
  touch `executeToolCallFn`.
- Per batch allowance = `min(4, 8 - toolCallsMade)`.
- Every skipped call gets a synthetic tool message:
  `[系统] 达到工具调用上限（单轮响应|本轮总计），此调用未执行。`
  so every `assistant.tool_calls[i]` still has exactly one `tool` result and the
  final synthesis prompt sees balanced history.
- Once either cap is tripped (`hardCapReached=true`), the loop `break`s directly to
  final synthesis; synthesis is called with `tools` omitted.
- `console.warn` telemetry emits calls/executed/skipped and which cap tripped.
- `ToolLoopResult` gains `toolCallsSkippedByCap` and `hardCapReached` (0/`false` on
  non-overflow paths that return them).
- A trusted `directContent` collected earlier in the overflowing batch is preserved
  verbatim; the synthesis lead never re-renders it.
- `requiredTool` deterministic routing executes exactly one call and is intentionally
  outside this budget (one-call-by-construction).

## A3 parameter applicability matrix

`guard.ts` now enforces catalog `allowedFor` in both directions (beatmap-family
params on player capabilities, player-family params on beatmap capabilities, and
intra-player-family scoping), so a present-but-wrong-capability parameter is
rejected — never silently ignored.

| Param | Schema exposed | Schema caps | Allowed with | Executor consumption | Wrong-capability behavior |
| --- | --- | --- | --- | --- | --- |
| `username` | yes | `maxLength 128` | all player capabilities | `executeInternalBotCommand(..., username)` | rejected on beatmap caps |
| `bot` | yes | enum `yumu/kanon/hydrant/lazybot` | all player capabilities | selects internal renderer bot | rejected on beatmap caps; out-of-enum value rejected (was silently coerced) |
| `bp_rank` | yes | int 1–100 | `bp` only | `resolveBpQuerySelection` single BP | rejected on every other capability (was accepted+ignored for `recent` etc.) |
| `bp_start` | yes | int 1–100 | `bp` only | `resolveBpQuerySelection` range start | rejected elsewhere; range size ≤ 100 enforced |
| `bp_end` | yes | int 1–100 | `bp` only | `resolveBpQuerySelection` range end | rejected elsewhere |
| `beatmap_id` | yes | int ≥ 1 | `beatmap_lookup`/`pp_calc`/`leaderboard` (required) | consumed by all three beatmap executors | missing → rejected; on player caps → rejected |
| `mods` | yes | `maxLength 16`, pattern `^[A-Za-z]*$` | all beatmap capabilities | `parseModsString` → lookup attributes / pp calc / leaderboard | rejected on player caps |
| `accuracy` | yes | number 0.01–100 | `pp_calc` | `runPpCalc` | rejected on every other capability |
| `combo` | yes | int ≥ 0 | `pp_calc` | `runPpCalc` | rejected elsewhere |
| `misses` | yes | int 0–999 | `pp_calc` | `runPpCalc` | rejected elsewhere |
| `limit` | yes | int 1–50 | `leaderboard` | `runLeaderboard` `scores.slice(0, limit)` | rejected elsewhere |
| `compact` | **no** (intentionally) | — | `bp` only | compact BP rendering at ≥10 rows | rejected on wrong player capability (fix), beatmap caps |

Canonical guard results verified:

- Reject: `recent+bp_rank`, `profile+bp_start`, `recommend+accuracy`,
  `pp_calc+limit`, `leaderboard+misses`, `recent+mods`, `recent+beatmap_id`,
  `recent+compact`, `beatmap_lookup+username`, `beatmap_lookup+bp_start`,
  `leaderboard+accuracy`, `leaderboard+bot`, invalid `bot`, unknown keys, and all
  out-of-range values.
- Allow: `bp+bp_rank`, `bp+bp_start/bp_end` (1–100, optional `compact`),
  `recent/recommend+username+bot`, `beatmap_lookup+beatmap_id+mods`,
  `pp_calc+beatmap_id+accuracy/combo/misses/mods`, `leaderboard+beatmap_id+limit/mods`.

## A4 schema/runtime drift fixes

| Drift | Authoritative side | Change |
| --- | --- | --- |
| `bp_start` description "最多 20 张" vs runtime 100 | runtime | description now "最多 100 张" |
| `bot` description "谱面类查询忽略 bot" vs guard rejects | guard/catalog | description now "谱面类查询不使用"; guard enforces enum |
| bp params described as generic player params but only `bp` consumes them | executor | `allowedFor:['bp']` + descriptions "仅 capability=bp 使用"; guard enforces |
| `username` guard limit 128 absent from schema | guard | catalog/schema `maxLength: 128` |
| `mods` guard limits (≤16, letters only) absent from schema | guard | catalog/schema `maxLength: 16`, `pattern: ^[A-Za-z]*$` |
| `mods` description "可选" imprecise | executor | "仅 beatmap_lookup / pp_calc / leaderboard 使用" |

## A5 `previousToolFailed` semantics

Evidence: `reasoningRouter.resolveReasoningMode` maps `tool_planner.previousToolFailed`
to `{level:'max', reasonCode:'tool_failure_recovery'}` — i.e. "a tool failure
needs recovery thinking", not "only the single most recent call failed".

Implementation:

```ts
// at each planner round, before reasoningInput():
const previousToolFailed = lastToolFailed;  // sticky since last planner
lastToolFailed = false;                     // consume/reset for this round
...
// after each executed call:
lastToolFailed = lastToolFailed || !result.ok;  // batch/turn-level sticky
```

So fail→success in one batch ⇒ the next planner still sees `true`; a later
all-success batch ⇒ the planner after it sees `false`. Verifier:
`planners = [false, true, false]` across fail→success / success / no-tools rounds.

## A6 rollout / sideEffects status

- `rollout` and `sideEffects` are **metadata/documentation**, not runtime
  enforcement. No enforcement code was added (no speculative builder changes).
- All catalog entries are `sideEffects:'readonly'`; all **callable** entries are
  `rollout:'all'`.
- `auditAgentCapabilityRegistry()` now fails future drift with
  `OWNER_CANARY_WITHOUT_ENFORCEMENT` if anyone marks a callable capability
  `owner_canary` before enforcement exists, and
  `NON_READONLY_AGENT_CAPABILITY` if a callable capability stops being readonly.
- The new verifier asserts audit-clean + all-callable `rollout==='all'`.

## DSML / textual fallback parity

- Textual `<invoke>` parsing is unchanged: only names present in the current
  round's `tools` schema are routed; unexposed names are dropped and malformed
  markup fails closed.
- Parsed DSML calls go through the same `executeToolCall`/`validateOperation`
  path, so `capability=recent, bp_rank=5` in DSML is rejected exactly like the
  structured form (audit + `TOOL_ARGUMENT_UNRESOLVED` telemetry preserved).
- A2's budget is applied after DSML parsing, so a 5-invoke DSML response executes
  4 and skips 1 with balanced synthetic tool results.

## Verifier / replay / regression evidence

New verifier: `tools/agent-tool-surface-hardening-verify.mjs`
(63 checks, all pass). Covers: exact exposed names/enum, `match` rejection +
command-side survival, reject/allow matrix incl. caps, hard cap 1/4/5/100 calls,
multi-round cumulative overflow (8 executed, 2 skipped), direct payload before
overflow preserved, failure+overflow, sticky `previousToolFailed`, DSML cap/guard
parity, A6 audit, A4 drift.

Updated existing verifiers:

- `tools/capability-single-source-verify.mjs` — new post-hardening baseline:
  callable enum excludes `match`, executor inventory still includes it,
  descriptions/caps (`100`, `maxLength`, `pattern`) match the catalog.
- `tools/agent-capability-verify.mjs` — validates callable entries and asserts
  command-only entries are guard-rejected; asserts `match` not callable.
- `tools/agent-runtime-c1-verify.mjs` — unsafe-inclusive campaign reduced to
  `maxCommands: 4` so generated scripts stay inside the 4/8 production budget;
  overflow is covered by the dedicated executor-seam verifier.

Commands run (all green):

- `npm run typecheck`
- `npm run check` (typecheck + vite build + sanity + security)
- `node --import tsx tools/agent-tool-surface-hardening-verify.mjs`
- `node --import tsx tools/capability-single-source-verify.mjs`
- `node --import tsx tools/agent-capability-verify.mjs`
- `node --import tsx tools/query-osu-policy-verify.mjs`
- `node --import tsx tools/agent-tool-count-contract-verify.mjs`
- `node --import tsx tools/reasoning-router-verify.mjs`
- `node --import tsx tools/natural-chat-delivery-verify.mjs`
- `node --import tsx tools/bot-harness-verify.mjs`
- `node --import tsx tools/processIncoming-deterministic-route-verify.mjs`
- `node --import tsx tools/quick-router-verify.mjs`
- `node --import tsx tools/bp-range-route-verify.mjs`
- `node --import tsx tools/match-verify.mjs`
- `node --import tsx tools/external-exposure-verify.mjs`
- `node --import tsx tools/agent-runtime-verify.mjs`
- `node --import tsx tools/agent-runtime-c1-verify.mjs`
- `node --import tsx tools/agent-runtime-c2-verify.mjs`
- `node --import tsx tools/agent-runtime-c2-targeted-verify.mjs`
- `node --import tsx tools/agent-runtime-phase-d-verify.mjs`
- `git diff --check`

Replay fixtures (production-seam replay, not copied loops), each
`AGENT REPLAY PASS` with `productionDbUnchanged=true`:

- `tools/fixtures/agent-runtime/scenario.min.json`
- `tools/fixtures/agent-runtime/direct-lead.json`
- `tools/fixtures/agent-runtime/c1/scenario.min.json`
- `tools/fixtures/agent-runtime/c1/regression-multi-tool.json`
- `tools/fixtures/agent-runtime/c1/regression-tool-throw.json`
- `tools/fixtures/agent-runtime/c2/scenario.min.json`
- `tools/fixtures/agent-runtime/phase-d/new-finding/c2/scenario.min.json`

Note: the first combined verifier run hit one transient CLI-spawn failure inside
`agent-runtime-verify` (`valid fixture` exit 2); the identical command passed on
immediate rerun and the fixture replays directly and via every replay verifier.

## Production files changed

- `server/bots/capabilityCatalog.ts` — `match.callable=false`; `allowedFor`
  corrected for `bot`/bp params/`mods`/`compact`; bp description 100; bot
  description; `maxLength`/`pattern` schema fields and emitter.
- `server/bots/agentCapabilities.ts` — meta covers all catalog names with derived
  `callable`/`rollout`; audit adds owner-canary and readonly enforcement-mismatch
  violations for callable entries.
- `server/bots/guard.ts` — `bot` enum validation; intra-player-family
  `allowedFor` enforcement (`recent+bp_rank` etc. now rejected).
- `server/bots/executor.ts` — A2 constants/accounting/overflow handling/break;
  A5 sticky `lastToolFailed`; result fields.
- `tools/capability-single-source-verify.mjs`, `tools/agent-capability-verify.mjs`,
  `tools/agent-runtime-c1-verify.mjs` — baseline/campaign updates.
- `tools/agent-tool-surface-hardening-verify.mjs` — new acceptance gate.

## Git status (no commit, no push)

```
 M server/bots/agentCapabilities.ts
 M server/bots/capabilityCatalog.ts
 M server/bots/executor.ts
 M server/bots/guard.ts
 M tools/agent-capability-verify.mjs
 M tools/agent-runtime-c1-verify.mjs
 M tools/capability-single-source-verify.mjs
?? tools/agent-tool-surface-hardening-verify.mjs
?? docs/AGENT_TOOL_SURFACE_HARDENING_V01.md
```

Untracked and intentionally untouched: `.private/`,
`docs/REPOSITORY_HYGIENE_AUDIT.md`, `docs/recommend-semantic-consistency-audit.md`,
`docs/trunk-source-boundary-audit.md`.
