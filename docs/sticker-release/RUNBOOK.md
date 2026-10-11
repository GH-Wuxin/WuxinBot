# Pippi Sticker System — Runbook

This is the current operational runbook. Commands must be updated as the
implementation becomes production-ready.

## Inspect source assets

From `G:\QQ-AI-ChatBot`:

```powershell
node --import tsx tools/test-sticker-debug-offline.mjs
```

The command must report catalog `63/63` (or the current manifest count) and
zero missing files, duplicate IDs, or hash mismatches.

## Local validation

```powershell
npm run sticker:check
npm run typecheck
node --check tools/replay-real-history-live-safe.mjs
node --import tsx tools/test-sticker-debug-offline.mjs
npm run sticker:delivery:verify
npm run sticker:bot:failure:verify
npm run sticker:decision:edge:verify
npm run sticker:scenario:verify
npm run sticker:llm:cancellation:verify
npm run sticker:api:verify
```

`npm run sticker:check` is the independent green aggregate for the sticker
scope. The repository-wide `npm run check` also runs unrelated Skill Profiler
checks and may stop before reaching the sticker steps when that pre-existing
baseline failure is present.

Do not treat a source-tree result as a deployment result.

For a real-model semantic sample (external LLM calls; no QQ delivery), use:

```powershell
$env:STICKER_SEMANTIC_TIMEOUT_MS='45000'
$env:STICKER_SEMANTIC_CONCURRENCY='2'
npm run sticker:semantic:real
```

The command writes only scenario IDs, modes, sticker IDs, timings, and
protocol/range results to its evidence file; it does not store full replies.

For a real-history shadow sample with no OneBot delivery, use:

```powershell
$env:SHADOW_SAMPLE_LIMIT='6'
$env:SHADOW_TIMEOUT_MS='45000'
node --import tsx tools/replay-real-history-shadow.mjs
```

This copies the selected production database and knowledge snapshot to a
temporary directory, rewrites source-group context to the fixed test-group
label, runs the normal reply path in `dry-run`, and records only hashes,
lengths, selected IDs, timings, and sender image counts. It never calls QQ.

For a future, separately authorized calibration window, the read-only observer
below can be used. It performs only `GET /api/sticker-policy`; it never
changes policy, invokes an LLM, replays messages, or calls OneBot. It is
currently stopped because production operation was accepted without waiting
for the 100-reply calibration floor:

```powershell
$env:STICKER_GRAY_OBSERVE_MS='600000'
$env:STICKER_GRAY_OBSERVE_INTERVAL_MS='30000'
npm run sticker:gray:observe
```

The default duration is one snapshot (`STICKER_GRAY_OBSERVE_MS=0`). The output
is a bounded JSON evidence file under
`docs/sticker-release/evidence/gray-observation-*.json`, containing only
policy, counters, delivery outcomes, and window deltas. Set
`WUXIN_ADMIN_PASSWORD` when the local API requires it.

The observer marks a window `sufficient` only after at least 100 new
sticker-eligible final replies. Smaller windows are explicitly reported as
`insufficient_evidence` and must not be used to claim frequency calibration.

If `/api/health` reports recent LLM failures, inspect the Codex path without
changing providers:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/codex/status
Invoke-RestMethod http://127.0.0.1:8787/api/codex/rate-limits
```

Natural-reply gate timeouts fail closed and open a short in-memory circuit for
the same provider/model fingerprint. This prevents every incoming group
message from waiting through the same transient `thread/start` failure; it
does not send a reply or activate a fallback provider.

## Safe operation modes

The intended production controls are:

- `off`: no automatic sticker decision or delivery;
- `dry-run`: decide and trace, but never call OneBot for a sticker;
- `trace-once`: trace one scoped request, then return to `off`.

The current source environment variables are temporary compatibility controls;
the protected policy API is the intended operator surface. The current
deployment is direct production: `live` with the explicitly authorized
`allGroups: true` switch. The 100-reply gray calibration floor was not
reached and must not be reported as passed. Manual history replay remains
restricted to the fixed smoke group `1083681153`. The former observation
groups `1067117635` (`light`) and `682910196` (`natural`, natural gate
threshold `30`) retain their existing group reply modes; those modes are not a
sticker rollout switch. All other groups retain their existing `mention`/`osu`
modes.

## Authorized test-group replay

Use only:

```text
G:\QQ-AI-ChatBot\tools\replay-real-history-live-safe.mjs
```

It fixes the destination to `1083681153`, selects source text only from
`682910196`, `712531032`, and `885215108`, asserts the destination before each
request, and reports image/segment counts. Never reconstruct the event with a
source-group variable in the `group_id` field.

Do not use this replay tool for the real gray groups `1067117635` and
`682910196`; those groups are observation-only and must receive only normal
user traffic.

## Debug API (source version)

The current source exposes protected local routes under `/api/sticker-debug`:

- `GET /api/sticker-debug`
- `POST /api/sticker-debug/mode` with `off`, `dry-run`, or `trace-once` and a
  narrow `groupId` or `userId` scope;
- `DELETE /api/sticker-debug/traces`;
- `POST /api/sticker-debug/dry-run` with an exact `stickerId`.

These routes were verified in the installed source build after deployment. The
initial deployment probe verified the closed default and catalog `63/63`; the
current running route reports catalog `63/63` with the authorized
`live/allGroups=true` policy. Do not stream or tail the live
`db-decisions.json` on Windows; inspect it through the API or a short-lived
copied snapshot so a diagnostic reader cannot hold the atomic replacement
target open.

## Sticker policy API (source version)

The protected local API exposes the effective policy and bounded counters:

- `GET /api/sticker-policy`
- `POST /api/sticker-policy`

Example closed-by-default policy:

```json
{
  "mode": "off",
  "allGroups": false,
  "groupIds": [],
  "groupCooldownSec": 600,
  "userCooldownSec": 1200,
  "hourlyLimit": 3,
  "dailyLimit": 16,
  "userDailyLimit": 4,
  "duplicateStickerCooldownSec": 7200
}
```

To enable a gray test scope, set `mode` to `live` and provide an explicit
`groupIds` array. For the explicitly authorized all-group rollout, set
`allGroups: true`; this is a separate, deliberate switch and does not treat an
empty `groupIds` array as all groups. The API rejects live mode unless either
the allowlist is non-empty or `allGroups` is true.
The route is protected by the existing local admin-password middleware.

## Immediate rollback

The persistent policy is now the primary switch. For an emergency process-level
override, set `WUXIN_STICKER_DELIVERY_MODE=off` and restart the service. The
environment override is intentionally stronger than a saved live policy.

## Deployment evidence boundary

Before enabling gray mode, record:

1. the source commit/build SHA;
2. typecheck, build, and the sticker verification commands above;
3. a successful `GET /api/sticker-debug` on the installed build showing the
   source route, catalog, and `delivery` counters;
4. a successful policy read showing `mode: off` before the allowlist is
   enabled.

The 2026-10-11 deployment evidence is recorded in `STATE.md`. The prior
installer/app.asar hashes are retained as the rollback/reference build; the
fresh NSIS final step could not run because the uncached `winCodeSign` tool
would require a GitHub download. The authorized deployment instead overlaid
the current `server/` tree into the installed `app.asar.unpacked` directory
and verified the deployed source hashes. Direct production is active under
`live/allGroups=true`; long-term frequency calibration was intentionally left
incomplete by the operator's launch decision.

The observer was verified on the deployed route with both a one-snapshot run
and a three-snapshot read-only window; both returned `live/allGroups=true` and
made zero configuration or delivery calls.

Any command that can call the real OneBot image sender additionally requires
the explicit process guard below:

```powershell
$env:WUXIN_STICKER_LIVE_AUTHORIZED='1'
```

Without that variable, `sticker-live-send-test.mjs` and
`replay-real-history-live-safe.mjs` refuse to run. This guard is independent of
the policy API and does not enable live delivery by itself.

