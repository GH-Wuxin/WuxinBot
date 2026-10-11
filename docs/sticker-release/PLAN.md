# Pippi Sticker System — Implementation Plan

## P0 — audit and baseline

Status: complete for the current source/runtime audit.

- inventory the current manifest, annotations, assets, model contract, debug
  module, bot integration, OneBot delivery, persistence, and trace paths;
- record the existing dirty worktree and tests without overwriting user work;
- keep this directory as the recovery source for later turns.

Exit evidence: `STATE.md`, `TEST_MATRIX.md`, and the six release documents are
accurate and the current baseline commands have been run.

## P1 — asset catalog

Status: complete for the current 63 validated assets.

- retain one manifest and annotation source;
- verify ID uniqueness, file existence/readability, dimensions, hashes, path
  containment, and excluded assets;
- expose only validated assets to model selection.

## P2 — model decision contract

Status: complete for the current 40-case real-model semantic sample; continued
quality calibration still belongs to gray/shadow operation.

- retain the final JSON envelope `{reply, sticker_id}`;
- make `null` the default and preserve ordinary text on parse failure;
- verify tool-loop final synthesis cannot bypass the envelope;
- add explicit tests for none, text+image, image-only, invalid ID, malformed
  JSON, prompt-injection-shaped output, and tool-result/error contexts.
- run the real Codex model against all 40 scenarios and fix the observed
  tool-completion confirmation false positive.

## P3 — persistent frequency gate

Status: implemented core sticker frequency gate and the single local
participation gate; not yet production-ready until live sampling and the
remaining external calibration evidence pass.

- [x] replace the current process-local group map with persisted, bounded state;
- [x] add global switch, allowlisted groups, per-group and per-user cooldowns,
  hourly/daily limits, repeated-sticker cooldown, and an atomic reservation;
- [x] use an injectable clock in tests;
- [x] default to `off`; test-group live mode must be explicit;
- [x] add an explicit `allGroups` switch so all-group gray cannot be enabled
  accidentally by an empty allowlist;
- [x] record the eligible-reply denominator before image delivery and expose
  bounded per-group/proposal/allow/success calibration metrics.
- [x] restore natural/light participation thresholds without a second LLM
  preflight request; migrate the old threshold keys and remove the dead UI
  control.

## P4 — reliable delivery

Status: implemented for the sticker branch; broader repository failure
injection evidence remains.

- [x] keep the existing OneBot sender and CQ escaping;
- [x] propagate the actual OneBot outcome into sticker accounting and traces;
- [x] reserve before send, consume budgets conservatively for unknown outcomes,
  and never resend an uncertain sticker;
- [x] finish integration/failure-injection proof for primary text fallback.

## P5 — debug and observability

Status: complete for the current source/runtime deployment; all-group gray is
active only under explicit operator authorization.

- [x] connect live decisions to StickerDebug lifecycle;
- [x] expose policy, bounded counters, and delivery outcomes through protected
  local API surfaces;
- [x] verify source API authentication, closed default, live allowlist rejection,
  live enablement, and off rollback in an isolated server process;
- [x] add eligible-reply/proposal counters;
- [x] add a bounded read-only gray observer that records window deltas without
  mutating policy or invoking delivery;
- [x] add an observer contract test for GET-only behavior, intermittent API
  errors, and the 100-reply calibration floor;
- [x] verify the deployed route after the explicitly authorized source
  deployment; installed `/api/sticker-debug` and `/api/sticker-policy` both
  report the closed default and the full `63/63` catalog.
- [x] make dry-run and trace-once scope-safe for source-runtime requests.

## P6 — behavior evaluation

Status: fixture-level real-model evaluation passed after the targeted prompt
fix; authorized all-group gray observation is active and frequency calibration
is still pending.

- [x] create at least 40 structured context cases and expected behavior ranges;
- [x] keep at least 40 structured cases under a schema/coverage contract;
- [x] run Codex `gpt-6-luna` against the 40 cases; combined full-run and
  targeted timeout retries were `40/40` within the declared ranges, with the
  tool-completion false positive fixed in the prompt;
- run mock protocol tests separately from real-model semantic tests;
- run the manual smoke/history replay only against `1083681153`; these samples
  are complete and must not be repeated against real groups;
- observe the authorized all-group gray path without manual injection;
- measure eligible replies, model proposals, allowed sends, delivery outcomes,
  and text/image mode.

## P7 — regression and failure injection

Status: sticker-specific acceptance complete; the repository-wide regression
run passes production isolation, the former Skill Profiler identity fixtures,
Agent V2, player profile/recent-profile fixtures, runtime safety, storage
recovery, OneBot, and the sticker suites. The stale `osu:roast:verify` package
reference was removed because its entire dead one-line-review implementation
had already been deleted.

- retain the passing missing-file and cancellation fixtures; malformed-model,
  timeout, path/code-gate, and disabled-mode fixtures now pass;
- retain the passing sticker gate, restart, concurrency, missing-file,
  cancellation, OneBot error,
  accepted-unknown, and primary-text-fallback fixtures;
- run targeted checks, build, and the repository regression set.
- keep `npm run sticker:check` as the independent green aggregate when an
  unrelated repository check stops before the sticker steps.

## P8/P9 — gray release and runbook

Status: the user has explicitly ended the gray-observation phase and accepted
direct production operation. The sticker policy remains `live` with
`allGroups=true`; the source server is deployed through the verified unpacked
Desktop tree. The bounded observer and its heartbeat are stopped. Statistical
frequency calibration was not completed and is no longer an operational
release gate by that decision. A fresh NSIS installer is still pending a
locally cached/proxied `winCodeSign` tool.

- [x] ship closed by default;
- [x] build the current source and deploy its server tree into the installed
  Desktop runtime with an adjacent rollback copy;
- [x] verify installed debug/policy routes in the closed state before rollout;
- [x] run a real-history shadow sample through the full reply path in dry-run;
  the combined six-sample result was `6/6` replies, `2/6` sticker proposals,
  and zero image sender calls.
- keep manual smoke/history replay scoped to `1083681153`;
- preserve the existing group reply modes; they are ordinary group policy, not
  a sticker rollout gate;
- keep the live counters and bounded logs available for post-launch monitoring;
- do not treat the incomplete 100-reply gray calibration floor as satisfied;
- document deployment, observation, frequency calibration, immediate off,
  and code/config rollback.

