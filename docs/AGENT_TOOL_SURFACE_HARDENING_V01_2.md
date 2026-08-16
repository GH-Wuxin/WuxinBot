# AGENT_TOOL_SURFACE_HARDENING_V01_2 — NAMED BOT CONSTRAINT CHECK

> Updated by `AGENT_TOOL_SURFACE_HARDENING_V01_2_1.md`: recent selector
> parity is now strictly enforced — only `yumu`/`kanon` remain Agent-visible
> recent bot selectors; `hydrant`/`lazybot` named requests degrade explicitly
> instead of being silently mapped to the yumu bridge.

Single-edge audit: after `query_osu.bot` was correctly scoped to
`capability=recent`, does `bot.ts` silently drop an explicit user named-bot
constraint on non-recent osu data requests? No Agent capability expansion was
done. Working tree only — no commit, no push.

## Finding: silent constraint loss existed

Before this pass, `bot.ts` attached `bot` only for `recent` and then simply
proceeded with the deterministic `query_osu` for every other capability. A user
saying `用猫猫查我 BP1` therefore had the `namedBotRequest` (kanon) detected
but never surfaced: the request executed as a plain Wuxin internal `query_osu`
with no message explaining that the bot selection was not applicable.

This violated the invariant: **an explicit named-bot constraint must either be
actually used, or the user must be explicitly told it was degraded — never
silently discarded.**

## Minimal production fix (`server/bot.ts` only)

- `recent + named bot` — only supported selectors are attached:
  `osuDataIntent.args.bot = namedBotRequest.botId` for `yumu` (→ `!r`
  bridge) and `kanon` (→ `!re` bridge). `hydrant`/`lazybot` named requests
  degrade with an explicit notice (see V01_2_1).
- `non-recent + named bot` — `bot` is NOT attached (guard would reject it and
  it would not be consumed), but a deterministic notice is sent and persisted
  before the internal result:

  > `[系统] 你点名的「猫猫」暂不支持在“BP 查询”中指定；本次查询已降级为 Wuxin 内部数据，结果照常给出。`

- No `query_bot` / `query_external_bot` exposure was introduced.
- `query_osu.bot` remains scoped to `recent` only in the catalog/schema/guard.

## Reproduction evidence (three required examples)

Verifier: `tools/agent-named-bot-constraint-verify.mjs` (58 checks in the
V01_2_1 revision).

### `用猫猫查我 BP1`

- `detectRequiredOsuTool` → `query_osu { capability:'bp', bp_rank:1 }`
  (capability is **bp**, not recent).
- `detectNamedBotRequest` → `{ botId:'kanon', botName:'猫猫' }`.
- Final requiredTool args (real `toolCallLogs`): `capability:'bp'`, **no `bot`**
  (guard would reject `bot+bp`; executor would ignore it).
- Actual executor: Wuxin internal `query_osu/bp` (unbound fixture reaches the
  internal player-target error, proving internal execution).
- User semantics: first message is the explicit downgrade notice naming 「猫猫」,
  then the internal result/error follows. No silent loss.
- Invariant: `validateOperation(query_osu/bp, bot=kanon)` → rejected.

### `用 LazyBot 查我的玩家信息`

- `detectRequiredOsuTool` → `query_osu { capability:'info' }`.
- `detectNamedBotRequest` → `{ botId:'lazybot', botName:'LazyBot' }`.
- requiredTool args: `capability:'info'`, no `bot`; internal executor runs.
- User semantics: explicit 「LazyBot」 downgrade notice + internal result.
- Invariant: `validateOperation(query_osu/info, bot=lazybot)` → rejected.

### `用雨沐查我 recent`

- `detectRequiredOsuTool` → `query_osu { capability:'recent' }`.
- `detectNamedBotRequest` → `{ botId:'yumu', botName:'雨沐' }`.
- Final requiredTool args (real audit): `capability:'recent', bot:'yumu'`.
- Actual executor: real synthetic local bridge sees exactly one **yumu** bridge
  connection (kanon delta 0).
- User semantics: normal recent result, **no** downgrade notice.
- Invariant: `validateOperation(query_osu/recent, bot=yumu)` → accepted.

## Four-bot matrix (all verified through real processIncoming + bridge servers)

| Phrase | bot | capability | bot attached? | actual bridge | downgrade notice? |
| --- | --- | --- | --- | --- | --- |
| 用猫猫查我 recent | kanon | recent | yes | kanon | no |
| 用雨沐查我 recent | yumu | recent | yes | yumu | no |
| 用消防栓查我 recent | hydrant | recent | no | internal yumu route | yes, names 消防栓 |
| 用 LazyBot 查我 recent | lazybot | recent | no | internal yumu route | yes, names LazyBot |
| 用猫猫查我 BP1 | kanon | bp | no | Wuxin internal | yes, names 猫猫 |
| 用雨沐查我 BP1 | yumu | bp | no | Wuxin internal | yes, names 雨沐 |
| 用消防栓查我 BP1 | hydrant | bp | no | Wuxin internal | yes, names 消防栓 |
| 用 LazyBot 查我 BP1 | lazybot | bp | no | Wuxin internal | yes, names LazyBot |
| 用 LazyBot 查我的玩家信息 | lazybot | info | no | Wuxin internal | yes, names LazyBot |

Every case additionally asserts: `osuDataIntent` detected, `namedBotRequest`
detected, real `toolCallLogs` argument shape, guard accept/reject expectation,
and no wrong bridge family was contacted.

## Hard invariants re-asserted

- LLM schema still exposes only `query_osu` + `get_player_skill`; `query_bot` /
  `query_external_bot` are absent.
- `query_osu.bot` schema enum is `['yumu','kanon']` (only truly supported
  recent selectors) and is scoped to `capability=recent`.
- `bot` is not broadened back to capabilities whose executor ignores it.

## Mandatory regression (all green)

- `agent-named-bot-constraint-verify.mjs` — 58/58 (V01_2_1 revision).
- `named-bot-sandbox-verify.mjs` — 9/9.
- `processIncoming-deterministic-route-verify.mjs` — 10/10.
- `agent-tool-surface-hardening-verify.mjs` — 211/211.
- `agent-tool-surface-hardening-cross-run-verify.mjs` — 19/19.
- `bot-harness-verify.mjs` — pass.
- `npm run check` — typecheck + build + sanity + security, pass.
- `git diff --check` — clean.

## Commit readiness

**READY_TO_COMMIT** (once a commit is authorized). No commit, no push performed.
