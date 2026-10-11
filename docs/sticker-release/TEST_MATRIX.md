# Pippi Sticker System — Test Matrix

| Area | Test/evidence | Current result | Gap |
|---|---|---:|---|
| Catalog | `validateStickerCatalog({verifyHashes:true})` | PASS 63/63 | Path traversal and missing-file behavior covered by edge suite |
| Model IDs | exact `pickForModel`, code/topic exclusions, empty candidate set | PASS | — |
| Final envelope | JSON, fenced JSON, leading text, invalid text, three modes | PASS | Malformed output and timeout covered by edge/bot suites |
| Tool loop | tool call then final synthesis; early finish | PASS | Add model timeout and malformed final output |
| Dry-run | no `sendMessage` call; no image delivery | PASS | Verify budgets/persistence remain unchanged |
| Debug | bounded trace object, trace-once state, installed route | PASS | Continue read-only gray observation |
| Group gate | allow configured group, reject other group; explicit all-group switch | PASS | Keep the all-group switch operator-authorized |
| Reply participation gate | deterministic natural/light threshold, weak-message rejection, strong-message admission, no second LLM call | PASS | Calibrate behavior only with real traffic; no manual injection |
| Cooldown | duplicate, group, user, hour/day limits; A→B→A full-window regression | PASS injected clock | Broader failure-release matrix remains below |
| Concurrency | simultaneous reservations | PASS injected store | Add cross-process worker test |
| Persistence | restart retains budgets/cooldown | PASS actual temp-disk child process | Add cross-process contention fixture |
| OneBot echo | existing sender outcome parser; target allowlist → final `group_id` | PASS existing + sticker contract suite | Keep sender as the single delivery implementation |
| Main text fallback | confirmed image failure falls back to text; unknown is not retried; off mode leaves no reservation; model timeout fallback | PASS pure + real `processIncoming` fixture, including local hanging-model timeout | — |
| Calibration | eligible denominator, per-group proposals, recent group/sticker outcomes, rates | PASS deterministic fixture | Measure on deployed shadow/gray traffic |
| Gray observer | bounded GET-only polling, window deltas, intermittent API errors, 100-reply floor, no policy/OneBot mutation | PASS; contract fixture plus deployed-route probes | Run during natural traffic |
| Edge contract | malformed/prompt-shaped output, path traversal, code gate, missing-file catalog, bounded model timeout | PASS local fixture | — |
| Scenario fixture | 40 structured cases, unique IDs, five required categories | PASS contract fixture | — |
| Cancellation | isolated `completeChat` timeout closes in-flight requests and stops retries | PASS temp-store/local-server fixture | Production-scope isolation requires no live writer |
| Source API | auth, closed default, live allowlist validation, all-group enable, off rollback | PASS isolated source server + installed route | Keep rollback payload ready |
| Real group | authorized smoke to `1083681153` | PASS; one image `confirmed_success` | No further manual sends |
| Real-history replay | historical input from `682910196`, `712531032`, `885215108` delivered only to `1083681153` | PASS; `3/3` replies, `0` images | No further manual replay |
| Real gray targets | natural live traffic in `1067117635` (`light`) and `682910196` (`natural`, gate threshold `30`) | IN PROGRESS; configuration verified | Collect enough real final replies for frequency calibration |
| Reply reference semantics | direct @ replies use native QQ reply; natural group replies do not | PASS typecheck + OneBot/extended regression | Applies to normal, image, and fallback delivery paths |
| StickerDebug runtime | production dry-run selects a valid asset, records a dry-run trace, then clears it | PASS; zero OneBot calls | Production debug mode remains off |
| Runtime pressure audit | bounded queues/LLM slots and Codex/background-task health | RISK FOUND; queues clear but background LLM pressure and Codex memory/thread growth observed | Fix task admission and app-server lifecycle before declaring long-term stability |
| All-group gray | natural live traffic with no manual injection | ACTIVE by explicit authorization | Keep observation-only; no manual injection |
| Real-model semantics | `npm run sticker:semantic:real` with Codex `gpt-6-luna` | PASS combined 40/40 within declared scenario ranges after targeted prompt fix; timeout retries recorded | Long-term frequency and human review require gray/shadow traffic |
| Real-history shadow | `tools/replay-real-history-shadow.mjs` with production KB copied to temp store | PASS combined 6/6 replies, 2/6 proposals, 0 image sender calls; two timeout retries passed | Small sample; no real delivery or long-term frequency calibration |
| Build | `npm run build` | PASS | — |
| Desktop deployment | `npm run desktop:build`, local overwrite install, installed route probe | PASS; installed `app.asar` matched build hash | No commit/push performed |
| Regression | `npm run sticker:check` plus repository `npm run check` | PASS | Sticker aggregate and the complete repository regression pass; the stale `osu:roast:verify` reference was removed together with its already-deleted dead implementation |

## Required next fixtures

Add deterministic cases for:

- ordinary greeting → text only;
- clear celebration → text+image or image-only;
- choke/self-deprecation → restrained reaction;
- serious technical/support request → text only;
- tool/error result → required text, optional safe image only;
- invalid ID, missing file, malformed JSON, timeout;
- same group/user concurrent requests;
- two groups sharing no budget;
- restart after reservation and unknown delivery;
- `off`, `dry-run`, and scoped `trace-once`.

