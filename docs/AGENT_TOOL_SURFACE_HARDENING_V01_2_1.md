# AGENT_TOOL_SURFACE_HARDENING_V01_2_1 — RECENT NAMED-BOT EXECUTOR PARITY

Single-edge audit: prove what `capability=recent + bot` actually does for each
Agent-visible selector, and eliminate silent selector substitution. Working
tree only — no commit, no push.

## Finding

Before this pass the report claimed:

- `kanon → kanon bridge` — true.
- `yumu → yumu bridge` — true.
- `hydrant/lazybot → yumu compatibility bridge` — the executor did this
  **silently** (`botId === 'kanon' ? 'kanon' : 'yumu'`). Both values produced
  an identical yumu backend call with no user-visible degradation, i.e. they
  were indistinguishable from `bot:'yumu'`. That is silent substitution, not a
  supported selector.

## Decision

Keep the contract honest and minimal:

- **Truly supported selectors** are only `yumu` (`!r` bridge) and `kanon`
  (`!re` bridge). These are the only values exposed in `query_osu.bot.enum`
  and accepted by `guard.ts`.
- **Unsupported named bots** (`hydrant`, `lazybot`) on `recent` are handled in
  the deterministic routing layer with an explicit downgrade notice; `bot` is
  NOT attached to `requiredTool`, and the internal default recent route
  produces the result:

  > `[系统] 你点名的「消防栓」暂不支持在“最近成绩”中指定；本次查询已降级为 Wuxin 内部数据，结果照常给出。`

- No `query_bot` / `query_external_bot` exposure was introduced.
- `bot` was not broadened back to any capability whose executor ignores it.

## Per-selector proof (real processIncoming + synthetic bridge servers + real toolCallLogs)

| requested bot | Agent-visible enum? | requiredTool bot | actual backend/bridge observed | downgrade notice? |
| --- | --- | --- | --- | --- |
| `yumu` | yes | `yumu` | yumu bridge, delta yumu=1, kanon=0 | no |
| `kanon` | yes | `kanon` | kanon bridge, delta kanon=1, yumu=0 | no |
| `hydrant` | no (named transport only) | absent | internal recent route → yumu bridge | yes, names 消防栓 |
| `lazybot` | no (named transport only) | absent | internal recent route → yumu bridge | yes, names LazyBot |

Every row additionally asserts `detectRequiredOsuTool` → `capability=recent`
and `detectNamedBotRequest` → the requested bot id.

Guard evidence:

- `validateOperation(query_osu recent, bot=yumu)` → accepted.
- `validateOperation(query_osu recent, bot=kanon)` → accepted.
- `validateOperation(query_osu recent, bot=hydrant)` → rejected.
- `validateOperation(query_osu recent, bot=lazybot)` → rejected.

Schema evidence: `query_osu.parameters.properties.bot.enum === ['yumu','kanon']`,
description explicitly says only those two are selectors and other named bots
are degraded with a notice.

## Production changes

- `server/bots/capabilityCatalog.ts` — added `RECENT_BOT_SELECTOR_IDS =
  ['yumu','kanon']`; `bot.schemaEnum` and description use it.
- `server/bots/guard.ts` — validates `bot` against
  `RECENT_BOT_SELECTOR_IDS` (hydrant/lazybot rejected).
- `server/bot.ts` — named-bot deterministic routing attaches `bot` only for
  supported `recent` selectors; every other named-bot data request sends and
  persists the explicit downgrade notice. LLM system prompt updated to state
  the same contract.
- `tools/agent-named-bot-constraint-verify.mjs` — split recent matrix into
  supported selectors (real bridge proof) and unsupported selectors (explicit
  degradation proof); schema enum invariant updated.
- `tools/agent-tool-surface-hardening-verify.mjs` — explicit
  `recent+hydrant/lazybot` rejection cases and supported-selector schema
  assertion.
- `tools/capability-single-source-verify.mjs` — baseline enum/description
  updated.
- `docs/AGENT_TOOL_SURFACE_HARDENING_V01_2.md` — corrected the
  `用猫猫查我 BP1` row to show `capability='bp'`, and updated the recent
  matrix/invariants to the final V01_2_1 contract.

## Mandatory regression (all green)

- `agent-named-bot-constraint-verify.mjs` — 58/58.
- `agent-tool-surface-hardening-verify.mjs` — 211/211.
- `agent-tool-surface-hardening-cross-run-verify.mjs` — 19/19.
- `named-bot-sandbox-verify.mjs` — 9/9.
- `bot-harness-verify.mjs` — pass.
- `npm run check` — typecheck + build + sanity + security, pass.
- `git diff --check` — clean.

## Commit readiness

**READY_TO_COMMIT** (once a commit is authorized). No commit, no push performed.
