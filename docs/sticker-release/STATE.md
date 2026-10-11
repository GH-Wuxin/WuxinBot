# Pippi Sticker System — Current State

Updated: 2026-10-11 19:03 (Asia/Shanghai)

## Latest normal reply-gate verification — 2026-10-11 19:03 (Asia/Shanghai)

- Restored a single local participation gate for ordinary unmentioned
  messages in `natural` and `light` groups. It scores message structure,
  question shape, recent group activity, recent Bot attempts, and user policy;
  it never calls an LLM and never selects a sticker.
- Effective defaults are `natural=45` and `light=70`. Existing operator data
  migrated the live natural threshold to `30`; the installed state now exposes
  `replyGateNaturalThreshold=30` and `replyGateLightThreshold=70`, with the
  obsolete `llmReplyGate*` keys removed. @ mentions, active Bot follow-ups,
  hard group limits, and cooldown rules retain their existing precedence.
- The Models page now edits the real persisted keys and explicitly states that
  the gate does not add a second LLM call. The old dead “AI judgment count”
  control was removed.
- `npm run sticker:check`: PASS. `npm run check`: PASS end to end. The
  participation regression now proves weak natural/light messages are refused,
  strong messages pass their respective thresholds, no extra provider request
  is made, and failed delivery still consumes cooldown.
- The four changed server files and the rebuilt UI were overlaid into the
  installed unpacked runtime. Server hashes match the source; the deployment
  backup is
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\pre-reply-gate-restored-20261011-190004`.
- Read-only installed verification reports `globalPaused=true`, OneBot online,
  `activeProcessing=0`, and zero foreground queues. No real QQ message was
  sent by this change or its verification.

## Latest verification — 2026-10-11 18:19 (Asia/Shanghai)

- Removed the stale `osu:roast:verify` entry from `package.json`. The historical
  cleanup commit intentionally deleted both `server/osu/oneLineReview.ts` and
  its verifier, but left the package gate behind; restoring that dead code was
  not appropriate.
- `npm run check`: PASS end to end after the minimal package-gate fix. This
  includes typecheck/build, osu and Agent V2 paths, profiler/player fixtures,
  evidence, runtime safety, store recovery, API/OneBot, sticker delivery and
  failure suites, the 40-case sticker contract, cancellation, observer,
  prompt snapshots, and console verification.
- The full regression initially exposed that the new natural-failure silence
  also suppressed private-message failure notices. `server/bot.ts` now keeps
  the notice for private conversations while retaining silence for natural
  group participation and the notice for direct `@` group requests.
- The targeted `health-delivery` and `sticker-bot-failure` suites pass, and the
  installed `server/bot.ts` matches the source hash
  `A818FD6DBA360FEFDDB2EDE7F0452AE8CE860D6AD4902A89F256BD4EECB1AE95`.
  The pre-overlay copy is retained at
  `server-pre-private-failure-notice-20261011-181520`.
- WuxinBot was restarted after the test-only stop. Read-only health reports
  `globalPaused=true`, `activeProcessing=0`, empty foreground queues, and
  OneBot connected/online/fresh heartbeat. No QQ message was sent by this
  verification cycle.
- The current read-only policy snapshot is `73` eligible replies, `13`
  proposals, `8` allowed attempts, `6` confirmed successes, and `2`
  confirmed failures. D20 therefore still needs at least `27` more natural
  eligible replies and remains incomplete. The runtime currently has seven
  detached profile/image background tasks active; this remains an operational
  risk to review before lifting the pause.

## Latest incident resolution — 2026-10-11 16:24–16:59 (Asia/Shanghai)

- The global reply pause was kept enabled while the downstream send incident
  was investigated. After the controlled NapCat/QQ restart and the authorized
  real send to the fixed smoke group `1083681153` returned
  `confirmed_success`, normal replies were restored through the persisted
  `/api/settings` switch. No history replay or manual injection was used for
  any non-smoke group.
- The live control API now reports `globalPaused=false`, status `正常运行`,
  OneBot connected/account online/fresh heartbeat, and zero active reply
  queues after the observation window.
- A short post-resume window processed two real inbound requests: health
  counters moved from zero to two send calls with zero new send failures;
  eligible sticker replies moved from `64` to `66`, while sticker proposals
  and delivery counters did not change. This confirms the ordinary reply path
  can resume without immediately recreating the queue burst or the observed
  `result=120` failure.
- The same read-only follow-up showed the foreground queues returning to zero
  and no new foreground LLM failures. Detached profile/image work still has a
  backlog (24 active background records at the 16:37 snapshot) and one
  background admission slot; a recent image-summary capacity rejection remains
  visible as the last decision error. It did not block the two foreground
  replies in this window, but it remains a separate capacity risk and was not
  hidden by changing the sticker gate.
- The failed-delivery participation fix remains deployed: a `shouldReply=true`
  decision consumes cooldown even when downstream delivery fails. This is the
  reason a transient OneBot failure cannot cause every following message to
  enter the model queue.
- The production sticker policy remains `live/allGroups=true` under the
  previously authorized direct-operation decision. D20 long-run calibration is
  still explicitly incomplete; the current evidence is a recovery smoke probe
  plus a short live observation, not a 100-reply statistical calibration.
- After that short window, a fifth ordinary send at 16:39:14 failed again.
  The NapCat log identifies the same `EventChecker Failed` /
  `NodeIKernelMsgService/sendMsg` / `result: 120` response, this time while
  replying to a real message in `1067117635`. The bot was immediately paused
  again at 16:40. A separate direct plain-text probe to the authorized smoke
  group `1083681153` returned OneBot `status=ok, retcode=0`, so the downstream
  path is not completely dead; the failure is intermittent or context/group
  dependent and is not resolved by treating one successful probe as proof of
  stability.
- A follow-up `get_group_member_info` check changed the attribution: at the
  exact failure time, Pippi's `shut_up_timestamp` in `1067117635` was
  `2026-10-11T08:39:42Z`, while the failed send was at `08:39:14Z`. Pippi was
  therefore muted for the whole failed-send interval. Every configured group
  was then checked; all other mute states were zero and this one had expired.
  After unpausing, three read-only observation samples over 24 seconds showed
  zero active queues, zero new send failures, and zero recent LLM failures.
  The earlier evidence does not prove a NapCat-wide send outage.
- `server/health.ts` now retains the bounded confirmed-failure reason in the
  local health response. The deployed runtime was restarted with the persisted
  pause state and reports OneBot online with empty foreground queues. Its
  pre-change file is retained at the adjacent
  `server-pre-health-error-observability-*` rollback directory.
- A later unmuted live observation processed one additional real inbound
  request: one confirmed send, zero new send failures, zero recent LLM
  failures, and queues returned to zero before the next sample. The following
  sample had one new request in flight and still no delivery failure.
- Detached profile/image work continues to accumulate behind its bounded LLM
  admission (60 active background records at 17:03, 34 profile-labelled and
  14 image-summary-labelled, with zero recorded background failures). This is
  a separate resource/backlog risk; it has not been changed or conflated with
  the sticker delivery result.
- `npm run sticker:check` was rerun after the observer-contract timing fix and
  passed end to end: typecheck, production build, participation regression,
  OneBot envelope/delivery, request trace, duplicate-window/budget/restart
  delivery contract, bot failure injection, decision edges, 40-case scenario,
  cancellation, protected API, and read-only observer verification.
- At the user's direction, the global pause was re-enabled before changing
  failure presentation. `server/bot.ts` now sends the existing failure notice
  only when `replyToCurrentMessage=true` (a direct @ request); a natural
  participation failure writes the trace/health/usage failure record and stays
  silent in QQ. The regression fixture covers both branches and reports
  `naturalFailure: silent; direct @ failure notice retained`.
- The changed `bot.ts` and `health.ts` were deployed to the unpacked Desktop
  runtime with matching SHA-256 hashes. Rollback copy:
  `server-pre-natural-failure-silence-20261011-172350`. Post-deployment health
  reports `globalPaused=true`, OneBot connected/online/fresh heartbeat, zero
  active queues, and zero send/LLM failures.
- Current post-deployment policy counters are `73` eligible replies, `13`
  model proposals, `6` confirmed successes, and `2` historical confirmed
  failures; the snapshot has `5` background records and no active foreground
  work. No manual message was sent while the pause was held.
- During a controlled pause-only full-regression run, the production process
  was stopped and restarted without touching NapCat or Desktop. After removing
  the stale `osu:roast:verify` package reference and preserving private-message
  failure notices, `npm run check` completed successfully. The WuxinBot process
  was restored afterward with the persisted global pause; no QQ message was
  sent.

## Current phase

P0 audit complete. P1 is complete for the current 63 assets. The targeted
pre-gray delivery acceptance and deterministic software fixtures are complete.
The current source has been built, installed, and verified through the
production Desktop route. The user has ended the gray-observation phase and
explicitly accepted direct production operation with the existing
`live/allGroups=true` sticker policy. The earlier `result=120` send failure
was correlated with a temporary group mute. The independent global pause
switch is currently on at the user's direction while the new failure-notice
behavior is held for review.
The read-only observer and its heartbeat are stopped. Manual
smoke/replay remains restricted to the fixed test group `1083681153`; no
manual injection is used for real groups. The 40-case Codex semantic sample
passes its declared behavior ranges after one targeted prompt correction. The
100-reply gray frequency calibration floor was not reached and is recorded as
an explicit launch trade-off, not as a passing result. The delivery layer now
distinguishes direct @ replies from natural group participation: only the
former gets a native QQ reply reference.

The former observation groups are `1067117635` (`light`) and `682910196`
(`natural`). Their existing group reply modes remain unchanged because they
are ordinary group policy, not a sticker rollout switch. The smoke/replay
group remains `1083681153` and remains `mention`.

The former observation policy used traffic-driven polling rather than a fixed
timer. `682910196` uses the natural reply gate threshold `30` (the previous
global natural threshold was `45`); this lowers reply opportunities' entry
threshold without changing the hard sticker delivery cooldowns or
daily/hourly safety limits. `712531032` remains excluded from manual testing,
and `1083681153` remains smoke-only. No manual messages or history replays are
sent to real groups. The heartbeat named “Pippi 表情包灰度流量观察” and the
local observer process were stopped at the user's direction.

Latest pre-switch read-only observation: 2026-10-11 03:22 (Asia/Shanghai).
OneBot remained
connected and natural group events were arriving, but the recent window had no
new final Bot replies. Decision logs attribute the events to the existing
global “only reply when @mentioned” rule (`shouldReply=false`), so there was no
new sticker-eligible traffic. The latest two-minute GET-only observer window
had four samples and zero errors. The later `1067117635` light-mode switch was
configuration-only; no manual message was sent.

## Verified facts

- Worktree branch: `main`.
- HEAD at audit start: `d71718d chore: 删除约 1,570 行死代码，清掉 81 处死声明并加进门禁`.
- Worktree contains user changes and uncommitted sticker work; no reset, clean,
  commit, or push was performed by this goal run. Deployment was explicitly
  authorized and completed locally; no real-group message was sent by the
  deployment verification.
- Sticker manifest validation with full hashes: `63/63`, no missing files,
  duplicate IDs, missing annotations, or hash mismatches.
- Model-visible candidate count: `33`; code/status-only entries are excluded.
- `npm run typecheck`: PASS.
- `npm run sticker:check`: PASS (exit code 0). This aggregate reran typecheck,
  Vite build, StickerDebug offline, OneBot envelope/delivery, request trace,
  the full duplicate-window/budget/restart/target-group delivery contract,
  bot-level failure injection, decision edges, all 40 scenario contracts, LLM
  cancellation, protected API routes, and the GET-only gray observer contract.
- `node --import tsx tools/llm-gate-verify.mjs`: PASS. Natural and light group
  decisions no longer issue a duplicate LLM preflight call or write
  `reply-gate` usage events.
- `npm run desktop:verify`: PASS, `46/46` tests. This covers Desktop config
  migration/override persistence, legacy tsx launch normalization, ownership
  and PID reuse, stop/shutdown/restart isolation, startup timeout handling,
  foreign listener protection, IPC/API bridge guards, and opted-out close
  behavior.
- `node --import tsx tools/test-sticker-debug-offline.mjs`: PASS. It covers
  malformed/leading JSON parsing, exact-ID selection, dry-run no-send, tool-loop
  final synthesis, three final modes, allowlisted group, persisted cooldown,
  user cooldown, restart state, concurrent budget reservation, duplicate
  suppression, and wrong-group rejection.
- `npm run build`: PASS.
- The earlier installer remains at
  `G:\\QQ-AI-ChatBot\\release\\WuxinBot Desktop Setup 1.0.3.exe` with SHA-256
  `DF490C156EF944C16A10D67A8F33424CA863EC0FEB26FEFDB87B97BE7D30C0F2`.
  A fresh `desktop:build` run rebuilt the unpacked application but its NSIS
  final step tried to fetch the uncached `winCodeSign` bundle from GitHub and
  failed with `ENOTFOUND github.com`; it did not replace that old installer.
  The authorized deployment therefore overlaid the verified current
  `server/` tree directly into `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked`
  and kept a rollback copy of the previous installed server.
- The installed production route was verified with the managed WuxinBot
  process: `/api/sticker-debug` and `/api/sticker-policy` return HTTP 200,
  catalog `63/63`, policy `live/allGroups=true`, and the installed render
  server listens on 8389. Desktop now loads the installed root and
  `startOnOpen=true`; `stopOnClose=false` remains unchanged.
- Production group configuration was explicitly updated for the real gray
  target: `1067117635` → `light`, global `onlyMentionMode=false`; all other
  configured groups remain `mention` or `osu`, and `1083681153` remains
  `mention`.
- The first post-switch two-minute observer window completed with four samples,
  zero errors, and zero new sticker-eligible replies; no manual message was
  sent.
- A long read-only observer was started from the source worktree with PID
  `103168`, outputting to
  `docs/sticker-release/evidence/gray-observation-runtime-20261011.json`.
  It polls only `GET /api/sticker-policy` every 30 seconds for at most one
  hour, never calls an LLM, changes policy, replays history, or sends QQ
  messages. At start, the live counter window contained only `13` eligible
  replies, so calibration is correctly still `insufficient_evidence`.
- The source worktree now removes the duplicate natural/light LLM reply gate
  and the short-lived gate circuit entirely. Deterministic participation
  checks remain in `decideReply`; natural/light messages enter the main reply
  model directly. Source typecheck, participation regression, and the full
  sticker aggregate pass. On 2026-10-11 15:22–15:32 (Asia/Shanghai), the
  four changed runtime files were overlaid into the installed server and
  matched the source hashes. The pre-overlay files are retained at
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\server-pre-reply-gate-removal-20261011-152216`.
- Post-overlay runtime verification: `/api/health` returned `status=ok`,
  OneBot was connected with a fresh heartbeat and an online account, and
  `/api/codex/status` remained authenticated. Live request traces for
  `1067117635` show `轻度参与模式，交给主回复模型` followed by a single
  `model_call_started`; there is no duplicate reply-gate model call. The
  Desktop process did not auto-relaunch the child after the controlled stop,
  so WuxinBot was relaunched with the same portable-node/tsx entry command;
  no other Bot process was started or touched.
- Read-only live observation after the overlay reached `43` eligible replies,
  `10` model proposals, `4` allowed/confirmed sticker deliveries, and a
  `9.30%` confirmed-success rate at the 15:44 snapshot. The profile API at
  15:48 reported an active profile user with `3` queued updates and `4`
  tracked users; background work had `36` active records while its dedicated
  admission remained `1` active plus `4` waiting. This is evidence that the
  background profile/image work is still progressing, not evidence that the
  100-reply calibration floor is complete.
- The same live window exposed a downstream delivery fault: WuxinBot's
  health counters showed `9` confirmed sends and `11` confirmed failures, and
  NapCat logs through 15:50 returned `EventChecker Failed` with NTEvent
  `result=120` for ordinary plain-text messages as well as sticker-capable
  replies. OneBot remained connected and continued receiving messages. No
  manual resend or QQ/NapCat restart was performed; this must not be
  misattributed to sticker selection. A controlled NapCat/QQ restart was
  subsequently performed at 16:18 while global pause remained enabled.
- Authorized recovery probe at 16:24: `tools/sticker-live-send-test.mjs`
  sent the catalog sticker `hello` through the real OneBot HTTP path to the
  fixed test group `1083681153` and returned `confirmed_success`; the
  reservation ledger was finalized. No other group was targeted and no normal
  reply flow was resumed.
- Incident response at 16:05–16:13: global pause was written through
  `/api/settings` and verified in request traces; normal incoming messages
  now finish as `机器人处于全局暂停状态` with zero active reply queues and no
  model reply work. The pause-health synchronization and persisted-pause
  restoration were deployed in `server/index.ts`.
- Root cause of the queue burst: after the duplicate natural/light LLM gate was
  removed, participation correctly avoided a second model call but the rate
  gate still used only successful `assistant` rows. NapCat `result=120`
  failures therefore made every later message look as if no reply had ever
  happened. The gate now counts recent `shouldReply=true` decisions as reply
  attempts and uses the latest attempt for cooldown, so a failed downstream
  send still suppresses another model turn. `npm run sticker:check` and the
  new participation regression both pass. Runtime hashes for `bot.ts`,
  `bot/gate.ts`, and `index.ts` match the source; rollback copy:
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\server-pre-participation-cooldown-20261011-160554`.
- Read-only Codex diagnostics after deployment: `/api/codex/status` returned
  an authenticated ChatGPT account on the Pro plan; `/api/codex/rate-limits`
  returned `usedPercent=10`, `ordinaryUsageAllowed=true`, and
  `rateLimitReachedType=null`. Credits are `0` but no rate limit was reached.
  The recent `thread/start` timeout evidence therefore points to transient
  app-server startup/concurrency latency rather than an exhausted account or
  an accidental DeepSeek fallback.
- `npm run sticker:delivery:verify`: PASS. It covers the full duplicate
  window A→B→A regression, group-scoped `duplicate_turn`, confirmed-failure
  release, unknown/accepted-unknown/unfinished-reservation budget
  consumption, expired reservation pruning, a real temp-disk child-process
  restart, target-group allowlist → OneBot `group_id` consistency, and
  image-only fallback behavior.
- `npm run sticker:bot:failure:verify`: PASS. A local OpenAI-compatible mock
  drives the real `processIncoming` path through both an allowlist rejection
  and a confirmed image-send failure; closed mode is also covered. Each
  retains exactly one required text fallback, the confirmed failure is
  finalized without an image retry, and an unknown outcome is not retried while
  retaining its budget record. The same suite now also covers a hanging-model
  timeout: one system fallback, zero sticker reservations, and no sticker
  denominator increment.
- `npm run sticker:decision:edge:verify`: PASS. It covers malformed and
  prompt-injection-shaped output, path-traversal/unknown IDs, code-gated IDs,
  an empty model candidate set, full catalog validation, a disposable
  missing-file catalog, and a bounded real LLM timeout against a local hanging
  server.
- `npm run sticker:scenario:verify`: PASS. The behavior fixture contains 40
  unique cases across osu positive/negative, ordinary chat, bot events, and
  must-not-sticker categories. This validates fixture structure only; it is not
  a substitute for real-model semantic review.
- `npm run sticker:llm:cancellation:verify`: PASS. In an isolated temporary
  store, the real `completeChat` path issued two expected attempts, then
  settled without later retries and closed every in-flight request.
- `npm run sticker:api:verify`: PASS. A temporary source `server/index.ts`
  process verified admin authentication, closed-by-default policy, rejection
  of live mode without an allowlist, live enablement for `1083681153`, and
  immediate rollback to `off`.
- `npm run sticker:check`: PASS. The independent sticker aggregate completed
  typecheck, build, offline debug, OneBot envelope/delivery, request tracing,
  delivery contract, bot failure injection, decision edges, scenarios,
  cancellation, policy API, and gray observer contract without relying on the
  unrelated repository-wide Skill Profiler stage.
- `node --check tools/sticker-gray-observe.mjs` and
  `npm run sticker:gray:observe`: PASS against the deployed route. A one-shot
  probe and a three-snapshot probe used only `GET /api/sticker-policy`, both
  observed `live/allGroups=true`, and recorded zero configuration or delivery
  calls. Evidence is under
  `docs/sticker-release/evidence/gray-observation-*.json`.
- `npm run sticker:gray:observer:verify`: PASS. The isolated contract fixture
  proves all requests are GET-only, `100/100` eligible replies is the first
  `sufficient` window, `0/100` remains `insufficient_evidence`, and an
  intermittent API error does not discard later successful samples.
- Direct @ versus natural delivery regression: PASS. Typecheck, OneBot echo,
  delivery, and the extended `onebot-verify` assertions confirm that a direct
  @ reply gets `[CQ:reply]` (automatically at the OneBot delivery boundary),
  while a natural group reply stays unquoted. The full `onebot-verify` business
  assertions pass; its final isolation verdict remains inconclusive when the
  live production writer changes the protected snapshot.
- StickerDebug runtime check: PASS. Production `POST /api/sticker-debug/dry-run`
  selected `hello`, produced a `dry_run` trace with `sendSkipped`, and a local
  trace clear returned zero traces afterward. No OneBot send was made. The
  offline debug suite and isolated API suite also pass; production debug mode
  remains `off`.
- Source-only runtime-pressure mitigation: PASS in isolation. `llmPolicy.ts`
  now gives detached memory/profile work one background slot and bounded
  waiting capacity, while foreground admission keeps priority. `health-
  accounting-verify.mjs` confirms the background cap and foreground access.
  `codexAppServer.ts` now recycles an idle app-server after a timeout or 32
  WuxinBot turns; `health-runtime-verify.mjs` confirms timeout-triggered child
  recycling. These changes are installed in the currently running Desktop
  instance and were verified through its managed WuxinBot process below.
- Post-fix source verification: `npm run typecheck`, `npm run build`,
  `health-accounting-verify.mjs`, and `health-runtime-verify.mjs` all PASS.
- `npm run sticker:semantic:real`: PASS for the current Codex `gpt-6-luna`
  sample when combining the 40-case run after the prompt fix with two
  individually retried timeout cases: all `40/40` results were structured,
  selected only catalog IDs, and stayed within each scenario's declared mode
  and text-preservation range. The first run exposed one real semantic issue:
  the tool event “图片渲染完成，结果已经发出” selected `received`; the final
  reply instruction now explicitly keeps tool/system completion confirmations
  at `none` unless they carry genuine extra emotional value. A targeted rerun
  then returned `none`. Evidence is under
  `docs/sticker-release/evidence/real-model-codex-after-prompt-fix-20261011.json`
  and the retry evidence files. This is fixture-level evidence, not gray
  frequency calibration or a substitute for human review of live conversation.
- `tools/replay-real-history-shadow.mjs`: PASS in the full reply path using
  six historical samples from `682910196`, `712531032`, and `885215108`, with
  the production knowledge snapshot copied into a disposable store. Combined
  evidence was `6/6` replies, `2/6` model sticker proposals, and `0` image
  sender calls. Two initial 45-second Codex timeouts were retried at 60
  seconds and both completed; no OneBot request or QQ message was made. The
  evidence stores only input hashes/lengths, IDs, timings, and counts under
  `docs/sticker-release/evidence/real-history-shadow-20261011-with-kb.json`
  and its timeout-retry companion.
- Existing `tools/llm-timeout-cancellation-verify.mjs`: 15/15 behavioral
  assertions passed, but its production-scope isolation verdict was
  `INCONCLUSIVE` because a live `server/index.ts` writer changed the protected
  production snapshot. It is not used as a mandatory check step for that
  reason.
- `node --import tsx tools/onebot-envelope-verify.mjs`: PASS.
- `node --import tsx tools/onebot-delivery-verify.mjs`: PASS.
- `node --import tsx tools/request-trace-verify.mjs`: PASS.
- `npm run profiler:cache:verify`: PASS after correcting its fixture to request
  the declared `HR` context instead of `NM`; no Skill Profiler business code
  was changed. A subsequent `npm run check` passed through that stage and
  stopped at `agent-runtime-v2-process-verify` with the explicit
  `RESULT=INCONCLUSIVE` production-isolation verdict because the live
  `server/index.ts` writer was still running. This is not evidence that the
  production database changed; the verifier deliberately refuses to claim a
  clean no-writer proof while Desktop is live.
- A direct authorized OneBot smoke sent `hello` only to the fixed test group
  `1083681153` and returned `confirmed_success`.
- The corrected safe live replay sent three real-model replies only to
  `1083681153`; all three were text-only. The source groups
  (`682910196`, `712531032`, `885215108`) were used only as historical input,
  never as delivery destinations.
- The installed Desktop runtime exposes the protected sticker routes and
  contains the current source integration. Sticker delivery is currently
  `live/allGroups=true` under explicit user authorization; no further manual
  gray messages are being injected.
- Real-send safety guard: both `sticker-live-send-test.mjs` and
  `replay-real-history-live-safe.mjs` now refuse to run unless the operator
  explicitly sets `WUXIN_STICKER_LIVE_AUTHORIZED=1`. The guard was verified
  with both commands and no OneBot call was made.
- Provider smoke: Codex `gpt-6-luna` returned a structured protocol result;
  DeepSeek `deepseek-v4-pro` chat timed out; OpenAI-compatible was not
  configured. No fallback was enabled. The diagnostic process was interrupted
  after reporting results because the DeepSeek timeout left an open handle;
  this did not write production usage data.
- Authorized runtime deployment: the NSIS rebuild produced a fresh unpacked
  tree but its final signed-installer step attempted to download the missing
  `winCodeSign` tool from GitHub and failed with `ENOTFOUND github.com`. No
  dependency was downloaded. The previous generated unpacked tree was moved
  to `release/win-unpacked-pre-local-rebuild-20261011-122253` for rollback;
  the current server source was then copied into
  `G:\\WuxinBot Desktop\\resources\\app.asar.unpacked\\server`, with all
  212 source files and the key runtime files hash-matching the working tree.
  The old installed server remains at the adjacent
  `server-pre-runtime-deploy-20261011-123108` backup.
- Managed Desktop verification: `desktop-runtime.json` no longer overrides
  WuxinBot to `G:\\QQ-AI-ChatBot`; WuxinBot is now auto-started from the
  installed unpacked root, while `stopOnClose=false` remains unchanged.
  Desktop logs show the installed project root and the WuxinBot wrapper is a
  child of the Desktop process. The deployed health endpoint returned `ok`,
  `/api/sticker-policy` returned `live/allGroups=true`, and
  `/api/sticker-debug` returned `off`, catalog `63/63`, and zero traces.
  Twelve consecutive health probes then completed with `0` failures and a
  maximum latency of `87 ms`; no Codex descendant or `node_repl` remained in
  the installed WuxinBot tree at the clean observation point.
- The first post-deploy observation found stale semantic/replay test trees
  from the prior investigation still running since the previous day; they
  were explicitly terminated by their test-root PIDs. They were not Desktop
  or WuxinBot processes. After cleanup, the managed runtime returned to
  healthy responses; transient LLM failures remain visible as a warning
  (`4` recent Codex timeouts), but the API, OneBot heartbeat, store locks, and
  bounded LLM admission are healthy.

## Current implementation

- `server/bot/stickers/index.ts` owns manifest loading, validation, model
  candidates, exact-ID selection, and CQ helper behavior.
- `server/bot/stickers/finalReply.ts` owns the `{reply, sticker_id}` final
  envelope and bounded parser.
- `server/bot/stickers/debug.ts` owns bounded in-memory dry-run/trace objects.
- `server/bot/stickers/delivery.ts` now owns a bounded persisted reservation
  ledger using the existing store lock. It defaults to off, supports explicit
  group allowlists, group/user cooldowns, hourly/daily/user-day budgets,
  repeated-sticker suppression across the full duplicate window,
  group-scoped message-id deduplication, injected clocks, an explicit
  `allGroups` rollout switch, and OneBot outcome finalization. Only
  `confirmed_failure` releases budget; unknown, accepted
  unknown, and unfinished reservations remain conservative budget records until
  they age out.
- `server/bot/stickers/replyDelivery.ts` owns the two pure final-branch seams
  that guarantee an image-only gate rejection or confirmed image failure keeps
  a minimal text reply, while unknown outcomes are not retried.
- Eligible-reply statistics are recorded before image delivery, with bounded
  per-group counters and derived recent group/sticker outcome views and rates.
- Statistics persistence is best-effort: a metrics write failure emits a
  request trace but cannot block the normal reply.
- `tools/sticker-delivery-contract-verify.mjs` is the focused pre-gray
  acceptance suite and is wired into `npm run check`.
- `tools/sticker-bot-failure-injection-verify.mjs` is the offline bot-level
  failure-injection suite and is wired into `npm run check`.
- `tools/sticker-decision-edge-verify.mjs` is the model/asset/timeout edge
  suite and is wired into `npm run check`.
- `tools/sticker-scenario-contract-verify.mjs` validates the 40-case behavior
  fixture and is wired into `npm run check`.
- `tools/sticker-llm-cancellation-verify.mjs` validates the isolated LLM
  cancellation boundary and is wired into `npm run check`.
- `tools/sticker-api-route-verify.mjs` validates the source policy/debug routes
  in a temporary server process and is wired into `npm run check`.
- `tools/sticker-real-model-semantic-verify.mjs` runs the same 40-case fixture
  through the configured Codex provider in a disposable data directory and
  records only bounded semantic/protocol evidence; it is exposed as
  `npm run sticker:semantic:real` but is intentionally not part of the
  deterministic `npm run check` chain.
- `tools/replay-real-history-shadow.mjs` runs selected real-history contexts
  through the normal reply path against a disposable database and dry-run
  sender, without calling OneBot.
- `tools/sticker-gray-observe.mjs` polls the protected policy route with GET
  only and computes bounded counter deltas for a read-only gray observation
  window; it never changes policy or sends messages. It reports
  `insufficient_evidence` until a window contains at least 100 new
  sticker-eligible final replies.
- `tools/sticker-gray-observer-verify.mjs` is the isolated contract test for
  the read-only observer and is wired into `npm run check`.
- Real-send scripts require an explicit process-level authorization variable in
  addition to the closed policy/allowlist gate.
- `server/bot.ts` validates the model-selected ID after reply rewriting,
  supports `none`, `text_image`, and `image_only`, connects live StickerDebug
  traces, and finalizes sticker reservations from actual OneBot outcomes.
- `server/index.ts` exposes protected `/api/sticker-policy` and includes policy,
  counters, and bounded delivery state in `/api/sticker-debug`.
- Source API verification uses `WUXIN_RENDER_PORT` for an isolated render
  socket; the production default remains port `8389`.
- `server/store.ts` supplies closed-by-default persisted sticker policy defaults.
- `server/bot.ts` keeps the deterministic participation boundary and sends
  natural/light messages directly to the main reply model; the former
  duplicate `llmReplyGate`/`gateCircuit` path is removed.
- `server/onebot.ts` already classifies OneBot outcomes and must remain the
  single delivery implementation.

## Files changed or added in the dirty worktree

Sticker-related additions include:

- `server/bot/stickers/`
- `tools/test-sticker-debug-offline.mjs`
- `tools/sticker-provider-smoke.mjs`
- `tools/sticker-live-send-test.mjs`
- `tools/replay-real-group-to-test.mjs`
- `tools/replay-real-history-live-safe.mjs`
- `tools/sticker-delivery-contract-verify.mjs`
- `tools/sticker-bot-failure-injection-verify.mjs`
- `tools/sticker-decision-edge-verify.mjs`
- `tools/sticker-scenario-contract-verify.mjs`
- `tools/sticker-real-model-semantic-verify.mjs`
- `tools/replay-real-history-shadow.mjs`
- `tools/sticker-llm-cancellation-verify.mjs`
- `tools/sticker-api-route-verify.mjs`
- `tools/sticker-gray-observe.mjs`
- `tools/sticker-gray-observer-verify.mjs`

Other modified files predate or overlap broader user work and must be preserved:
`.public-export`, `server/bot/owner/router.ts`, `server/bot/ownerCommands.ts`,
`server/bot/quickRouter.ts`, `server/bots/executor.ts`,
`server/bots/guard.ts`, `server/bots/registry.ts`, `server/bots/types.ts`,
`server/index.ts`, and `server/osu/commands.ts`.

## Known risks

1. Eligible-reply and proposal metrics now cover the natural final-reply
   branch; all-group live frequency calibration has started but is not yet
   statistically sufficient.
2. The legacy unfinished reservation from the pre-fix direct smoke script was
   reconciled from its recorded OneBot `confirmed_success` evidence without a
   resend; current delivery counters now include one confirmed success.
3. Sticker-specific bot-level failure injection, malformed output, model
   timeout, missing-file handling, and isolated cancellation are covered;
   broader repository-level failure fixtures remain.
4. The 40-case real-model sample establishes fixture-level behavior ranges but
   does not establish long-term semantic quality, live frequency, or human
   acceptance across real conversations.
5. The Desktop preference is now `startOnOpen=true` for the explicitly
   authorized WuxinBot deployment; `stopOnClose=false` remains preserved so
   closing the console does not stop the managed Bot tree.
6. Runtime audit at 2026-10-11 03:47 UTC found a high-priority capacity risk:
   OneBot and inbound/reply queues were healthy, but background image-summary
   and relationship-profile tasks occupied the LLM admission slots while
   `thread/start` timeouts accumulated (`104` recent LLM failures). The live
   WuxinBot Node child measured about 1,004 MB private memory and the Codex App
   Server child about 806 MB private memory with 546 threads. This is strong
   evidence of background-task/model-process pressure, not yet a proven single
   root cause; no process was killed or restarted during the audit.
7. At approximately 03:47–03:48 UTC the local control API reproduced a
   blocking symptom: port `8787` remained listening, but repeated GET requests
   to `/api/health`, `/api/sticker-policy`, and `/api/sticker-debug` returned no
   headers within 5–8 seconds. The Node process was still alive and sampled at
   roughly 5% CPU, so this is not simply a CPU saturation report. The control
   plane was not restarted during the observation. Treat this as an active
   production reliability finding until the event-loop/synchronous-I/O and
   Codex/background-task interaction is isolated.
8. A later read-only sample still found port `8787` timing out and the live
   Node child at roughly 2.1 GB private memory, with the Codex child around
   916 MB. That historical incident triggered the authorized restart and
   source deployment above. The fresh managed sample is materially smaller
   (about `367–541 MB` private during active requests, then about `399 MB`
   with one idle Codex child), with `0` store-lock timeouts and healthy probes;
   keep observing because this is a runtime observation, not proof of a
   long-term memory plateau.
9. The signed NSIS installer itself is not newly produced because the local
   machine has no cached `winCodeSign` bundle and GitHub DNS was unavailable.
   The installation is nevertheless running from the verified deployed
   unpacked tree; a future distributable installer build must use a locally
   cached signing tool or an explicitly configured proxy/mirror.
10. The installed runtime has observed Codex `thread/start`/capacity timeouts
    in live traffic. The deployed source fix removes the duplicate 15-second
    reply-gate call instead of adding another circuit; the main reply call can
    still fail independently. The post-overlay traces now confirm that the
    main reply path is entered directly for natural/light traffic. The current
    the latest pre-pause live snapshot is `64` eligible replies, `12` model
    proposals, `6` allowed attempts, `4` confirmed successes, and `2`
    confirmed failures; D20 is still unproven.
11. During the 2026-10-11 gray observation, a stale diagnostic PowerShell
    process (PID `107932`, started at 11:45 local time) kept
    `db-decisions.json` open after a `Get-Content` probe. Windows consequently
    rejected the production store's atomic replacement with `EPERM`, causing
    otherwise completed inbound requests to be recorded as failed before any
    OneBot reply. Only that confirmed diagnostic process was terminated; no
    WuxinBot or Desktop process was touched. After the handle was released,
    new requests stopped producing `EPERM`, the first live `sendMessage` call
    returned `confirmed_success`, and the sticker counters reached
    `eligibleReplies=14`, `selected=2`, `confirmedSuccess=2`.
12. The post-overlay 15:44–15:50 live window still has a profile/background
    backlog and intermittent LLM capacity pressure. The later ordinary
    OneBot `result=120` failure was reproduced while `1067117635` had a live
    `shut_up_timestamp`; it has not recurred in the short unmuted observation
    window. If it recurs while unmuted, re-open the NapCat/QQ investigation;
    no sticker-specific retry or extra gate should be added to mask it.
13. After the Wuxin-side WebSocket reconnect, OneBot again reported an online
    account and fresh heartbeat. A controlled NapCat/QQ restart was performed
    at 16:18 and the account/heartbeat recovered; the subsequent authorized
    test-group probe returned `confirmed_success`. One later real-group send
    returned `result=120`, but the target group was muted until 28 seconds
    after that attempt. Normal replies were restored after the mute expired;
    the short unmuted observation was clean, but it is not yet long-run
    delivery stability evidence.

## Next concrete operation

The deterministic sticker fixtures, authorized source deployment, runtime
restart, NapCat recovery, and test-group-only manual smoke/replay are complete.
The duplicate reply-gate subtraction and failed-send cooldown fix are live;
the newly deployed failure-notice split is also live. The bot is currently
globally paused at the user's direction. Keep the pause in place; do not raise
concurrency, enable a fallback provider, or inject history into real groups.
If `result=120` reappears after a later resume while the bot is not muted,
preserve the health error, group mute status, and NapCat log before considering
another restart.
Do not inject manual history replays into real groups, and do not leave
semantic/replay test runners active alongside the production Desktop.
Diagnostic probes must not stream or tail the live `db-decisions.json` file;
inspect it through the API or a short-lived copied snapshot so a reader cannot
hold the Windows replacement target open. The deployed runtime can be rolled
back by restoring
the adjacent server backup or by setting `mode=off`, `allGroups=false`, and
`groupIds=[]`.

