# WUXINBOT_PROMPT_REVIEW_AUDIT_V01

Status: **AUDIT ONLY — NO BEHAVIOR CHANGE**

Audit date: 2026-08-17
Primary code base: `G:\QQ-AI-ChatBot` (branch `fix/onebot-connection-lifecycle`, HEAD recorded in §H)
Runtime data: `%APPDATA%\Wuxin\db.json` (read-only; secrets never copied into artifacts)

Artifacts:

- `docs/WUXINBOT_PROMPT_REVIEW_AUDIT_V01.md` (this file)
- `tmp/prompt_review_audit_v01/runtime_call_graph.json`
- `tmp/prompt_review_audit_v01/prompt_reconstruction.json`
- `tmp/prompt_review_audit_v01/prompt_budget.json`
- `tmp/prompt_review_audit_v01/prompt_budget_summary.json`
- `tmp/prompt_review_audit_v01/rule_inventory.json`
- `tmp/prompt_review_audit_v01/duplication_matrix.json`
- `tmp/prompt_review_audit_v01/contradiction_audit.json`
- `tmp/prompt_review_audit_v01/single_source_audit.json`
- `tmp/prompt_review_audit_v01/review_metrics.json`
- `tmp/prompt_review_audit_v01/db_metrics.json`
- `tmp/prompt_review_audit_v01/latency.json`
- `tmp/prompt_review_audit_v01/golden_manifest.json`

Two audit helper scripts are also under `tmp/prompt_review_audit_v01/`; they are read-only and were run once.

---

## A. Runtime architecture

### A.1 Entry

`server/bot.ts processIncomingInner` is the real request entry:

```text
OneBot event
  -> oneBotToInternal normalize
  -> self / external-bot filter
  -> /w command -> handleOwnerCommand (deterministic; analyze uses analyzer pipeline)
  -> quickRouter deterministic commands
  -> decideReply deterministic gates + optional LLM reply-gate (natural/light modes)
  -> buildPrompt (system + history + user)
  -> if tools enabled: append tool availability note; buildBotToolSchemas(query_osu, get_player_skill)
  -> runToolLoop (LLM planner/lead, max 4 iterations / 8 tool calls per turn)
     or callLLM once
  -> sanitizeReply
  -> conditional rewriteNormalReply (second LLM)
  -> optional level-up phrase injection
  -> segment / merge-forward / direct tool delivery
```

### A.2 Main LLM call graph (normal group message, natural/light mode)

| # | Call site | Model | Trigger | Messages/tools | Frequency |
|---|---|---|---|---|---|
| 0 | `gate.ts llmReplyGate` | `db.settings.model` | only `natural`/`light` after deterministic checks | one `user` prompt only (mean 346 prompt tokens, n=647) | conditional |
| 1 | `bot.ts callLLM` or `executor.ts runToolLoop` | `overrideModel` else `db.settings.model` | reply accepted | `buildPrompt` system + history + user; tool note appended; tools `query_osu`, `get_player_skill` when internal bots enabled | always |
| 2 | `executor.ts runToolLoop` internal iterations | same | tool_calls returned | same message list + assistant/tool messages; tools resent unless direct payload | 0–4 iterations |
| 3 | `reply.ts rewriteNormalReply` | `db.settings.model` | `!longForm && isWeirdReply(reply)` | rewrite system 370 chars + current speaker + original reply | conditional (rate not logged) |
| 4 | `bot.ts` level-up phrase | `db.settings.model` | level-up event queued | short level-up prompt | rare/async |
| 5 | `memory.ts` / `groupProfile.ts` / `relationshipProfile.ts` | current model | background thresholds | profile-specific prompts | conditional background |

Normal-chat call count: 0–7 LLM calls per accepted turn, typically 1 (no tools, no gate, no rewrite) or 1+gate; tool path adds up to 4 loop calls and possibly one rewrite.

### A.3 Slash-command path

`/w...` is intercepted before `buildPrompt`:

- `/w osu analyze` → `server/osu/commands.ts runAnalysis` (analyze pipeline below)
- other `/w` commands → owner/command registry handlers, mostly deterministic (no normal persona prompt)

The legacy fixture still captures a "command" system prompt for `/w`, but in the real runtime that prompt is unreachable for `/w` (recorded as `DEAD_OR_UNREACHABLE`, rule R052).

### A.4 osu analyze generation/review graph

```text
collectPlayerData (deterministic; 3 fetch attempts)
  -> generateAnalysisSectionComments: 1–3 generation LLM calls
       + repairFailedText LLM per hard-invalid section (same OSU_REVIEW_MODEL)
  -> generateConclusion: 1–3 generation LLM calls + optional repair LLM
  -> deterministic validateAnalysisReport
  -> reviewFullReport: 1–2 independent reviewer LLM calls
       verdicts parsed (8 sections)
       hard REJECT -> applyReviewerHardFallbacks (deterministic fact fallback; NO LLM rewrite)
       invalid/unavailable -> reviewLog only
```

Models: generator and reviewer are both `deepseek-v4-flash` (`OSU_ANALYSIS_MODEL` / `OSU_REVIEW_MODEL` in `server/osu/commands.ts`).

### A.5 Review decision graph

- **What enters review**: every successfully assembled non-fallback analysis report (`ENABLE_RUNTIME_LLM_FACT_REVIEW=true`).
- **Reviewer model**: `deepseek-v4-flash`, temperature 0, max_tokens 2048, timeout 60s, requestMaxRetries 0.
- **Reviewer sees**: reviewer system (fact-checker rules + `knowledgeContext`), `verified_facts`, the full assembled report, and the perspective line. It does **not** see chat history, tools, or the original generator prompt.
- **Decision**: per-section `PASS`/`REJECT`. Parser defaults missing kind to `hard`; the prompt asks for `kind=hard` only, so the `quality` branch is currently **dead** (0 quality REJECT in 63 analyses).
- **On hard REJECT**: deterministic section/conclusion fallback replaces the component; unknown section label degrades whole report. No LLM rewrite, max 2 reviewer attempts, then log-only.
- **Failure handling**: reviewer unavailable/invalid verdicts → log only, report unchanged.

---

## B. Prompt budget

### B.1 Static reconstruction (exact chars/bytes; tokens ESTIMATED)

Reconstruction was executed with the real `buildPrompt` code and a synthetic, redacted DB fixture (KB disabled except E).

| Path | system chars | system bytes | user message chars | user overhead vs input | history chars (synthetic) | total chars (excl. tool schema) |
|---|---:|---:|---:|---:|---:|---:|
| A normal chat | 6,072 | 15,222 | 396 | 356 (facts/identity) | 38 | 6,506 |
| B osu question, no tool | 6,207 | 15,519 | 396 | 356 | 38 | 6,641 |
| C natural-language tool trigger | 6,207 | 15,519 | 398 | 356 | 38 | 6,643 |
| D slash command static fixture | 5,675 | 13,659 | 409 | 356 | 38 | 6,122 (runtime bypasses this path) |
| E KB hit | 6,666 | 16,615 | 400 | 356 | 38 | 7,104 |
| F serious | 5,064 | 12,280 | 400 | 356 | 38 | 5,502 |
| G owner | 6,073 | 15,219 | 429 | 357 | 38 | 6,540 |

Tool path add-on when internal bots enabled (resent on every planner call while tools are exposed):

- tool availability note appended to system: **1,401 chars**
- `query_osu` schema JSON: **2,965 chars / 4,689 bytes**
- `get_player_skill` schema JSON: **330 chars / 512 bytes**
- total tool schema per call: **3,295 chars / 5,201 bytes**

KB injection budget: per-route plan 400–900 chars per collection, global text budget **1,500 chars** (`KB_TOTAL_TEXT_BUDGET`); observed audit hit injected 295 chars, +594 chars with fences.

### B.2 Bucket decomposition (A normal chat, exact chars)

| Bucket | Chars |
|---|---:|
| PERSONA (PIPPI_CORE) | 3,208 |
| CORE_SYSTEM (PIPPI_OSU_CORE_KNOWLEDGE) | 955 |
| FACT_BOUNDARIES | 636 |
| BANTER (casual only) | 1,018 |
| SCENE_RULES | 127 |
| RUNTIME_CONTEXT | 92 |
| user-message facts/identity overhead | 356 |
| history (synthetic) | 38 |
| **static overhead excl. user text/history** | **6,428 chars** |

### B.3 Token accounting

- **No exact provider tokenizer was available in this environment.** All token figures below are labelled accordingly.
- Exact provider prompt tokens from production `db.usageEvents` for events without a newer `kind` (chat/main path): n=749, mean **6,747**, p50 **6,405**, p90 **13,803**, p95 **14,945**, max **24,355**.
- Other persisted kinds: `memory` mean 5,748; `reply-gate` mean 346; `relationship` mean 1,662; `group-profile` mean 4,510; `image-memory-summary` mean 1,564.
- Static reconstruction estimate for a minimal-history normal chat: ~6.5k chars. CJK-heavy heuristic 0.6–1.0 token/char gives **≈3.9k–6.5k tokens ESTIMATED for static fixed content only**. The observed production p50 6,405 tokens is whole-prompt input (including history/user input) and is reported separately from any static overhead claim.
- Tool path estimated prompt tokens: base 6.6k chars + 1.4k tool note + tool schema 3.3k chars, plus accumulated tool results; per planner call likely **≈6k–11k prompt tokens** before tool results (ESTIMATED).
- Review path: reviewer system static 1,128 chars (placeholder knowledge context) + `verified_facts` + full report. Real reports are p50 **2,503 chars**, p90 **2,795**, max **3,196**. Reviewer user content therefore ≈2.6k–3.2k chars plus facts. Exact reviewer prompt tokens are **UNKNOWN** (no per-label usage event is recorded for analyze calls).
- Rewrite path: +370-char rewrite system + current speaker + original reply, max_tokens 180, temperature 0.25.

### B.4 The two numbers asked

1. **Normal-message fixed/static bot-added content**: static reconstruction (synthetic minimal history) is **≈6,428 chars** = system 6,072 chars + fixed user-side facts/identity ≈356 chars. This is the only quantity that may be called "Bot 自带固定附加内容".
2. **Provider-observed whole-prompt tokens**: production `db.usageEvents` (chat/main path) has n=749, mean **6,747**, p50 **6,405**, p90 **13,803**, p95 **14,945**, max **24,355**. These are the complete request input tokens, including history and the user's real message. Without a provider tokenizer and a bucket-level rebuild they **must not** be expressed as "Bot 自带 6,405 tokens".
2. **Review effective-change rate**: see §E. Not 1–2%; this reviewer changed **10 of 63 eligible analyses (15.87%)**, all via deterministic fact fallback after hard REJECT.

---

## C. Rule audit

Atomic rule inventory: **55 rules** in `rule_inventory.json`.

Counts by status tag:

- `MUST_KEEP` 20; `SAFETY` 16; `TOOL_ROUTING` 22; `PRODUCT_BEHAVIOR` 11; `PERSONA` 4
- `LEGACY_REVIEW` 7; `QUALITY_REVIEW` 1
- duplicate flags: `DUPLICATE` 2 + `PARTIAL_DUPLICATE` 4
- `SHADOW_COPY` 5
- `DEAD_OR_UNREACHABLE` 2
- `UNKNOWN_OWNER` 0
- cross-rule conflicts recorded: 8 candidates in `contradiction_audit.json`

Top repeated rule groups (largest sources of repetition):

1. "osu 数据必须调用工具、禁止编数字/编 BID/猜 bp_type" — repeated in code routing, persona, system tool note, tool schema, capability catalog, KB summaries, analyzer reviewer.
2. "推荐必须 recommend 且最终带标题+BID" — code hard guard + persona + system tool note + tool schema + KB.
3. "bp_type 确定性路由" — code + system tool note + capability descriptor + KB.
4. "owner 权限" — deterministic gate + prompt facts + command metadata + KB audience summaries.
5. "视觉能力诚实说明" — `visualCapabilityNotice` injected into both system factualCtx and user facts.
6. "身份/不自称 AI/不自我否定" — persona + facts + rewrite system.
7. "记忆/群画像/关系块" — injected twice (system relBlocks and user facts).

Duplication matrix: `duplication_matrix.json`.

Important distinction recorded: code copies are `SECURITY_ENFORCEMENT`; prompt copies are `MODEL_GUIDANCE` or `USER_FACING_DESCRIPTION`. Duplication does not automatically mean the prompt copy is removable.

## D. Single-source violations

See `single_source_audit.json`.

- **Commands**: `server/bot/commands/*.meta.ts` is the single source (86 help entries). Shadow copies remain in the hand-written tool note and persona tool paragraphs; drift risk MEDIUM.
- **Capabilities**: `server/bots/capabilityCatalog.ts` is the single source. Shadow copies in `buildQueryOsuDescription` (derived, acceptable) plus the hand-written system tool note; drift risk MEDIUM.
- **Tool routing**: deterministic code is authoritative. The tool note restates routing facts that have previously been patched in code; drift risk HIGH.
- **Persona**: `persona.ts` is authoritative; analyzer compact persona and rewrite mini-persona are intentionally separate. LOW risk.
- **Safety/review**: deterministic gates + mechanical validator are authoritative; prose rules are duplicated across persona, tool note, rewrite guard, reviewer. LOW risk for hard facts, MEDIUM for prose.

## E. Review effectiveness (empirical)

Data: 63 `osuAnalyses` records in `%APPDATA%\Wuxin\db.json` (read-only).

| Metric | Value |
|---|---:|
| eligible analyses | 63 |
| review invoked | 63 / 63 (100%) |
| reviewer unavailable / invalid verdicts | 0 |
| all PASS | 53 / 63 (**84.13%**) |
| analyses with hard REJECT | 10 / 63 (**15.87%**) |
| analyses with quality-only REJECT | 0 |
| total verdicts | 504 (493 PASS, 11 hard REJECT) |
| **effective-change rate** | **15.87%** (10 analyses changed by deterministic fallback) |
| reviewer rewrite rate | 0 (architecture forbids LLM rewrite) |
| reject/error/fallback | see rule R049: deterministic fact-only downgrade |

Reject reason classification (11 rejects, rule-based, see `review_metrics.json`): 6 `CORRECT_INTERVENTION`, 2 `MEANINGFUL_SAFETY_CHANGE`, 2 `UNKNOWN` (short reason), 1 `STYLE_ONLY_CHANGE`.

Typical interventions observed:

- profile wrote "约 6.0 年" while verified facts say "约 2,174 天" — numerical mismatch corrected.
- BP5 wrote 4 NM + 1 DT but verified facts were #1-#3 NM, #4 NF, #5 DT — Mod composition corrected.
- conclusion treated PP+ dimension values as concrete abilities — blocked and downgraded.

Reviewer overhead per analysis:

- +1 reviewer call (up to 2 parse retries), temperature 0, max_tokens 2048.
- no LLM rewrite loop; hard REJECT triggers deterministic fallback only.
- exact reviewer token split UNKNOWN (analyze calls are not tagged in `usageEvents`).
- latency for reviewer/generator UNKNOWN (`LATENCY_DATA_UNAVAILABLE`); reply-gate latency p50 1,753 ms / p90 5,909 ms; tool execution p50 1,440 ms / p90 63.5 s; command execution p50 8,261 ms / p90 198.9 s (see `latency.json`).

Normal-chat rewrite guard (`rewriteNormalReply`) has **no persisted invocation counter**; its rate, PASS/rewrite/fallback split, and false-positive rate are **UNAVAILABLE**. Static risk: `isWeirdReply` treats any non-long-form reply over 180 chars as weird, so normal longer chat replies are candidates for unnecessary rewrites (P1 risk, no observed failure logged).

## F. Golden behavior corpus

Candidate manifest: `golden_manifest.json`, **15 cases**.

Coverage present: normal_chat, osu_lookup, natural_language_tool_call, slash_command, owner_command, group_admin, KB_hit, KB_miss, multi_turn, ambiguous_request, tool_failure, normal_content_that_review_may_false_positive, genuinely_sensitive_boundary, persona-heavy_chat, osu_analysis_with_review.

Missing categories recorded: explicit `owner_private_chat`, `quick_command_rendering`, `named-bot_degradation`, `search_request_with_no_provider`, and a real logged `rewriteNormalReply` trigger (no log exists). These are candidates for the next A/B phase; no expected prose was rewritten in this audit.

## G. Proposed slim plan (not implemented)

### P0_SAFE_DEDUP (no behavior change intended)

- Remove the duplicate injection of `visualCapabilityNotice`, group/owner/speaker facts, memory/group-profile/relationship blocks: keep one canonical layer (recommended: system for model guidance; drop the duplicate user-facts copies).
- Remove the unreachable command-scene prompt path or clearly mark it legacy in tests.
- Add a persisted counter for `rewriteNormalReply` and `isWeirdReply` triggers before changing its policy.
- Expected: normal static system reduction roughly **100–400 chars** for minimal DB, larger when memory/group profiles are enabled (up to the duplicated block size, capped by current `memoryMaxChars=1000`). Tool path similar unless memory/profile enabled. Review path **0 change**.
- Behavioral risk: LOW (duplicate text removal; fixture `kb-legacy-prompts.json` must be regenerated/compared under A/B).

### P1_SINGLE_SOURCE

- Generate the system tool guidance from `capabilityCatalog` + `CommandDescriptor` instead of the 1,401-char hand-written tool note; keep hard-routing rules in deterministic code.
- Generate persona tool paragraphs from capability metadata, or remove them and rely on schema + short task rules.
- Expected: tool-path system note could shrink toward a generated 500–1,000-char range (range depends on kept rules; **not measured by deletion**). Normal path may also shrink if persona tool paragraphs move from always-on persona core to task rules.
- Behavioral risk: MEDIUM; prerequisite: capability/command generation tests + `kb-verify`-style byte-compat fixture for the no-tool path.

### P2_CONDITIONAL_INJECTION

- Inject tool guidance only when tools are actually exposed; inject runtime facts only when they differ from defaults (model info only on identity/model questions; visual notice only when media present; owner/group facts only when needed).
- KB already conditional and quota-limited; keep its fence semantics.
- Expected: normal-chat static system could drop the unconditional runtime facts and much of the tool/persona overlap; estimated **300–1,500 chars** on normal path, with real tokens depending on history (range, not fabricated percentage).
- Behavioral risk: MEDIUM; prerequisite: golden corpus + A/B.

### P3_REVIEW_REDESIGN

- Keep the analyze fact reviewer mandatory; it demonstrably changes 15.87% of reports and rejects only 11/504 verdicts, which is a small, targeted safety gate.
- Remove the dead `quality` verdict branch or implement it explicitly; do not silently mix safety and style review.
- For normal chat, instrument `rewriteNormalReply` first; only then decide whether it should become deterministic formatter work or a sampled quality review.
- Expected: review path input unchanged or reduced only by removing dead prose; **not primarily a token-saving target**.
- Behavioral risk: LOW for analyze path if no policy change; MEDIUM for normal-chat rewrite changes.

No exact token-reduction percentages are claimed because no exact tokenizer was available and rewrite-path frequency is unlogged.

## H. Git

WuxinBot repository (audited):

- branch: `fix/onebot-connection-lifecycle`
- HEAD: `4bbcc6ba4c18b01ec11a4145289e955a56511221`
- remotes: origin `https://github.com/GH-Wuxin/WuxinBot.git` (cleanup temp clone remote also present)
- pre-audit status: 4 untracked entries (`.private/`, 3 docs); no tracked modifications
- post-audit status: unchanged tracked files + new untracked `tmp/prompt_review_audit_v01/` and `docs/WUXINBOT_PROMPT_REVIEW_AUDIT_V01.md`
- no commit, no push, no reset/clean/checkout

osu-skill-profiler working repository (session baseline, unchanged by this audit):

- branch `main`, HEAD `bc8655c2fa5d3f23807048c921cfd7f1e75bcdb9`, 86 dirty/untracked entries from prior approved work; no commit/push.

Test baseline recorded for WuxinBot prompt/review code: `npm run typecheck` → exit 0. Existing relevant verify suites identified (not all rerun): `kb-verify`, `osu-fixture-verify`, `agent-capability-audit`, `quick-context-qb08-*`, `vision-verify`.

## I. Verdict

**`PROMPT_REVIEW_AUDIT_READY_FOR_SLIM`**

Why READY and not INSUFFICIENT_EVIDENCE:

- Real runtime call graph was reconstructed from source and cross-checked against production DB artifacts.
- Normal-request fixed/static overhead is proven, not guessed: static system 6,072 chars / 15,222 bytes plus fixed user-side facts/identity ≈356 chars. Provider prompt tokens (p50 6,405) are the **whole request input**, not a bucket-level "Bot 自带 tokens"; bucket tokens remain ESTIMATED.
- Review layer is measured: 63/63 invoked, 53/63 all-pass, 10/63 changed via deterministic hard-fact fallback, effective-change 15.87%; no unlogged "reviewer rewrote everything" mystery.
- Rule duplication, shadow copies, contradictions, single-source violations, golden corpus and three-tier reduction options are all evidence-backed.

Residual gaps are explicit and non-blocking for planning:

- exact tokenizer unavailable (tokens are ESTIMATED from chars plus provider usage aggregates),
- LLM latency for main generation and analyze reviewer is `LATENCY_DATA_UNAVAILABLE`,
- `rewriteNormalReply` invocation rate is `UNAVAILABLE` (no counter),
- exact analyzer `knowledgeContext` size in reviewer prompt is `UNKNOWN` (placeholder reconstruction only).

Next step remains **`WUXINBOT_PROMPT_REVIEW_SLIM_V01`**, starting from P0_SAFE_DEDUP with the golden manifest and byte-compat fixtures as gates.
