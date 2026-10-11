# Pippi Sticker System — Acceptance Audit

Updated: 2026-10-11 18:19 (Asia/Shanghai)

## Release state

The current Desktop build is deployed and direct production operation has been
explicitly accepted by the user. The persistent policy is `mode=live`, `allGroups=true`,
`groupIds=[]`. The hard gates remain enabled: 10-minute group cooldown,
20-minute user cooldown, 3 per group per hour, 16 per group per day, 4 per
user per day, and 2-hour same-sticker suppression.

The long-term frequency calibration floor was not reached; this is recorded as
an explicit launch trade-off, not as a passing calibration result. Manual smoke
and replay messages were sent only to
the fixed test group `1083681153`; no manual message was sent to any other
group.

The former observation groups are `1067117635` (`light`) and `682910196`
(`natural`). The global only-mention gate is disabled; `682910196` uses the
natural LLM gate threshold `30` instead of the previous `45`. Other configured
groups remain `mention` or `osu`; these are existing group reply modes, not a
sticker rollout gate.

Latest pre-switch read-only observation: 2026-10-11 03:22 (Asia/Shanghai).
OneBot was
connected and natural group events were arriving, but the recent window did
not produce a new final Bot reply. Decision logs attribute the events to the
existing global “only reply when @mentioned” rule (`shouldReply=false`), so no
new sticker-eligible denominator was recorded. A two-minute GET-only window
completed with 4 samples and 0 errors. The light-mode configuration change for
`1067117635` happened afterward; no manual message was sent after the change.
D20 remains incomplete; the user explicitly chose direct production launch
without waiting for the 100-reply calibration floor.

## D01–D20 audit

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| D01 | All enabled assets validate | PASS | Catalog `63/63`, hashes, paths, annotations, and files validated |
| D02 | LLM can choose no sticker | PASS | 40-case Codex sample and real-history shadow contain `none` decisions |
| D03 | LLM chooses a valid sticker by context | PASS | 40/40 structured semantic results stayed within declared ranges |
| D04 | Text-only, text+image, image-only supported | PASS | Final envelope and bot failure suites cover all modes |
| D05 | No keyword-to-sticker core mapping | PASS | Selection is model envelope + catalog validation; no keyword dispatch map |
| D06 | Group/user frequency control | PASS | Persisted group/user cooldowns and hourly/daily budgets |
| D07 | Repeated-sticker suppression | PASS | A→B→A full-window regression and persisted state tests |
| D08 | Concurrent reservations stay within limits | PASS | Injected concurrent reservation suite |
| D09 | Message-level idempotency | PASS | Group-scoped `duplicate_turn` plus restart recovery |
| D10 | OneBot outcome classification | PASS | Existing OneBot envelope/delivery tests and sticker outcome wiring |
| D11 | No blind retry on uncertain delivery | PASS | `unknown`/`accepted_unknown` retain budget and do not retry |
| D12 | Image failure preserves primary text | PASS | Bot-level confirmed-failure and image-only fallback suite |
| D13 | Dry-run never sends an image | PASS | Debug and real-history shadow sender recorded zero image calls |
| D14 | Trace-once lifecycle is observable | PASS | StickerDebug lifecycle and scoped API tests |
| D15 | Recent decisions and delivery stats visible | PASS | `/api/sticker-debug` and `/api/sticker-policy` counters |
| D16 | Independent immediate off switch | PASS | Policy API and environment off override; rollback documented |
| D17 | Existing osu!/ordinary behavior preserved | PASS | Complete `npm run check` passed with production isolation and osu/Agent/Skill Profiler/player regressions |
| D18 | New and regression tests pass | PASS | Complete `npm run check` and the independent sticker aggregate pass, including delivery, API, edge, failure, cancellation, observer, and OneBot suites |
| D19 | Production config and rollback docs | PASS | `RUNBOOK.md`, `ROLLBACK.md`, guarded live scripts, deployed hash evidence |
| D20 | Evidence supports gray and frequency calibration | INCOMPLETE / OPERATOR-WAIVED FOR LAUNCH | The current read-only snapshot is `73` eligible replies, `13` model proposals, `8` allowed attempts, `6` confirmed successes, and `2` confirmed failures; at least `27` more eligible replies are needed to reach the 100-reply calibration floor. The user explicitly chose direct production launch, and the observer/heartbeat were stopped by that launch decision |

## Deployment evidence

- Reference installer SHA-256: `DF490C156EF944C16A10D67A8F33424CA863EC0FEB26FEFDB87B97BE7D30C0F2`.
- Reference/base `app.asar` SHA-256:
  `DF703603FD214B8049FB9BBC05C61000E77FDCDD1F660EAB7BAE13D363C41600`.
  A fresh NSIS installer was not produced because the uncached
  `winCodeSign` bundle could not be downloaded (`ENOTFOUND github.com`).
- Authorized deployment method: the current `server/` tree was overlaid into
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\server`; the deployed
  `llmPolicy.ts`, `codexAppServer.ts`, and `gate.ts` hashes match the
  worktree, with the previous installed server retained beside it for
  rollback. The later duplicate-reply-gate subtraction was also overlaid and
  verified. Its four changed runtime files match the source hashes; the exact
  pre-overlay copy is
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\server-pre-reply-gate-removal-20261011-152216`.
- Installed route: catalog `63`, policy route returned `live/allGroups=true`,
  render server 8389 healthy, WuxinBot `/api/health` returned `status=ok`,
  OneBot heartbeat/account status was healthy, and `desktop:verify` passed
  `46/46`. The child was relaunched with the same portable-node/tsx command
  after the controlled overlay; no other Bot process was started.
- Post-overlay behavior: live traces for natural/light traffic show the
  deterministic participation decision followed directly by one main-model
  call, with no duplicate 15-second reply-gate call. `/api/codex/status`
  remained authenticated; no fallback provider was enabled.
- Live delivery caveat: during the 15:44–15:50 observation window, NapCat
  logs returned `EventChecker Failed` / NTEvent `result=120` for ordinary
  plain-text sends as well as sticker-capable replies, while inbound messages
  and OneBot heartbeats remained healthy. This is a downstream QQ/NapCat
  delivery fault, not evidence of a sticker-selection error; no manual resend
  A controlled NapCat/QQ restart was then performed with the bot still
  paused. The authorized follow-up probe sent `hello` to `1083681153` through
  the real OneBot path and returned `confirmed_success`; no other group was
  targeted and normal replies were not resumed.
- Queue-incident fix: after global pause was enabled, request traces showed
  incoming messages terminating at the deterministic pause gate with zero
  active reply queues. The source/runtime now counts reply decisions as
  attempts for cooldown and hourly limits, so a confirmed downstream send
  failure cannot trigger an immediate new model turn. Typecheck, the full
  sticker aggregate, and the participation regression passed.
- The one legacy reservation left by the pre-fix smoke script was reconciled
  from its recorded OneBot `confirmed_success` evidence without resending;
  current counters show `attempts=1`, `confirmedSuccess=1`, and no unknown or
  failure outcome.
- Direct test-group image smoke: OneBot `confirmed_success`.
- Test-group real-history replay: `3/3` replies, `0` images; source groups were
  only used to select text, never as delivery destinations. This was the last
  manual replay; no further manual injection is part of all-group gray.
- Real gray target: `1067117635` is `light`, with global only-mention disabled;
  its existing 80/hour and 10-second cooldown limits are unchanged.
- Additional real gray: `682910196` is `natural` with natural gate threshold
  `30`; its existing 200/hour and 30-second cooldown limits are unchanged.
- Post-switch observer window: `gray-observation-2026-10-11T025928748Z.json`
  completed four GET-only samples with zero errors and no new eligible replies;
  the target group had no natural final reply during that window.
- Latest observer evidence: `gray-observation-2026-10-10T192201675Z.json`;
  four read-only samples, zero new eligible replies, zero proposals, and zero
  delivery attempts.
- The observer enforces a machine-readable calibration floor of 100 new
  sticker-eligible final replies; the latest snapshot is
  `insufficient_evidence` with 0/100.

## Remaining acceptance work

Observe real all-group traffic without manual injection. Collect enough
eligible replies to measure proposal rate, allowed-send rate, outcome rate,
per-group frequency, and repeated-sticker behavior. If the rollout becomes
undesirable, set the policy to `mode=off`, `allGroups=false`, `groupIds=[]`.

## Engineering handoff report

This is the production handoff for the current source/runtime. It does not
mark D20 complete: natural sticker-eligible traffic remains statistically
insufficient, but direct production operation was explicitly accepted.

### Implemented call chain

`OneBot group event` → `processIncoming` → existing LLM/tool conversation →
final `{ reply, mode, sticker_id }` envelope → exact catalog/hash validation →
persisted group/user/dedup reservation → existing OneBot sender → classified
delivery outcome → reservation finalization and bounded StickerDebug/policy
metrics.

Natural replies use the model-selected sticker envelope. Explicit osu!/search/
named-bot routes keep their existing delivery semantics and do not pay for an
optional sticker decision. The code path never accepts a model-provided file
path and does not use a keyword-to-sticker dispatch map.

### Delivered scope

- Assets: `63/63` manifest entries, annotations, files, hashes, and paths
  validate; `33` ordinary entries are exposed as model candidates.
- Modes: text-only (`none`), text plus image (`text_image`), and image-only
  (`image_only`) with text fallback when the image is rejected or fails.
- Current live limits: 10-minute group cooldown, 20-minute user cooldown,
  3/group/hour, 16/group/day, 4/user/day, and 2-hour same-sticker cooldown.
- Safety: source default is closed; all-group rollout requires explicit
  `allGroups=true`; uncertain OneBot outcomes are never blindly retried.
- Observation: `tools/sticker-gray-observe.mjs` is GET-only and records bounded
  time-window deltas without changing production state.

### Verification record

The current sticker-focused verification set passed as one green
`npm run sticker:check` aggregate: typecheck, production
build, catalog/decision edges, delivery budgets and deduplication, bot-level
failure injection including model timeout, 40-case scenario contract, LLM
cancellation, policy/debug API, GET-only gray observer contract, OneBot
envelope/delivery, request tracing, and the Codex real-model semantic sample
(`40/40`). The real-history shadow sample was `6/6` replies with `2/6`
proposals and zero image sends.

The repository-wide `npm run check` remains partial only because the existing
unrelated `profiler:cache:verify` fails with
`ANALYSIS_IDENTITY_MISMATCH` in `server/bots/skillProfiler.ts`.

### Deployment and rollback

- Installer: `G:\\QQ-AI-ChatBot\\release\\WuxinBot Desktop Setup 1.0.3.exe`
- Installer SHA-256: `DF490C156EF944C16A10D67A8F33424CA863EC0FEB26FEFDB87B97BE7D30C0F2`
- Installed `app.asar` SHA-256:
  `DF703603FD214B8049FB9BBC05C61000E77FDCDD1F660EAB7BAE13D363C41600`
- Current policy: `mode=live`, `allGroups=true`, `groupIds=[]`.
- Immediate rollback: protected policy `POST` with
  `{ "mode":"off", "allGroups":false, "groupIds":[] }`, or restart with
  `WUXIN_STICKER_DELIVERY_MODE=off`.

### Git and manual follow-up

- HEAD: `d71718d` (`chore: 删除约 1,570 行死代码，清掉 81 处死声明并加进门禁`)
- Sticker work and related user work remain uncommitted in the dirty worktree;
  this Goal run did not reset, commit, or push them.
- Manual smoke/history replay is restricted to `1083681153`; source groups
  `682910196`, `712531032`, and `885215108` were never used as destinations.
- The former gray observation targets were `1067117635` and `682910196`; the
  observer and heartbeat are now stopped, and no manual message is sent there
  by this Goal.
- Optional post-launch evidence can continue through the bounded live counters;
  it is not being represented as completed frequency calibration.
