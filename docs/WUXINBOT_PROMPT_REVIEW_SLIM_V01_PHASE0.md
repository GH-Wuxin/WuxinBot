# WUXINBOT_PROMPT_REVIEW_SLIM_V01_PHASE0

Status: **PHASE0 COMPLETE — telemetry + compatibility fixtures + exact-dup-only dedup**

Repository: `G:\QQ-AI-ChatBot`
Follows: `docs/WUXINBOT_PROMPT_REVIEW_AUDIT_V01.md`

Artifacts:

- `tmp/prompt_review_slim_v01_phase0/rewrite_telemetry_schema.json`
- `tmp/prompt_review_slim_v01_phase0/dedup_inventory.json`
- `tmp/prompt_review_slim_v01_phase0/prompt_fixture_manifest.json`
- `tmp/prompt_review_slim_v01_phase0/before_after_budget.json`
- `tmp/prompt_review_slim_v01_phase0/prompt_reconstruction_after_same_fixture.json`
- `tmp/prompt_review_slim_v01_phase0/profile_path_before_after.json`
- verify tool: `tools/prompt-review-slim-phase0-verify.mjs`

---

## 1. rewriteNormalReply behavior (unchanged semantics)

```text
main reply
  -> sanitizeReply
  -> isWeirdReply(replyText)          eligible predicate (deterministic regex + >180 chars)
  -> hasDirectToolDelivery?           skip: direct_tool_delivery
  -> longForm?                        skip: long_form
  -> isIdentityQuestion?              skip: identity_question_deterministic
  -> rewriteNormalReply               invoked
       -> one LLM call (DeepSeek / db.settings.model)
       -> system: 370-char style guard, no persona/history/KB/tools
       -> user: current speaker + original reply
       -> temperature 0.25, max_tokens 180
       -> provider error -> original (ERROR_FALLBACK)
       -> empty output -> original (EMPTY_FALLBACK)
       -> timeout/abort -> original (TIMEOUT_FALLBACK)
       -> no recursive rewrite / no reviewer after rewrite
  -> final send
```

Facts boundary: the rewrite prompt explicitly says "保留大意即可" and is a style/identity guard; it is not allowed to introduce new facts. No change was made to this behavior.

## 2. Instrumentation

New module: `server/bot/rewriteTelemetry.ts`.

- Destination: existing `db.usageEvents`, `kind='rewrite-reply'`, capped at 5000 (same as existing usageEvents).
- Recorded when: rewrite is eligible-but-skipped or invoked.
- Recorded fields: correlation ids, provider/model, `inputTokens/outputTokens/cachedInputTokens` (null + `usageAvailable=false` when provider does not return them), latency, result code, original/rewritten char counts, deterministic `contentChanged`, sha256 hashes.
- Privacy: no plaintext content is stored.
- Failure contract: `recordRewriteTelemetry` catches every write error; user reply is never affected (verified).
- No extra LLM call; no expensive synchronous diff.

Result enum: `SKIPPED / UNCHANGED / CHANGED / ERROR_FALLBACK / EMPTY_FALLBACK / TIMEOUT_FALLBACK / OTHER_FALLBACK`.

`CHANGED` is deterministic: trim + newline unification + whitespace normalization only, no LLM.

## 3. Compatibility fixtures

`tools/prompt-review-slim-phase0-verify.mjs` implements 7 fixture groups (45 PASS checks):

- F_A normal chat
- F_B tool path
- F_C KB hit
- F_D KB miss
- F_E owner/group_admin deterministic permission
- F_F rewrite path
- F_G analyze reviewer unchanged

Full prose is not locked; fixtures lock structure + required semantics + exact-once/no-duplicate invariants.

## 4. Safe dedup

Only exact duplicates were removed from the user-side `facts` block. Canonical copies remain in system `factualCtx` / `relBlocks`:

| Group | Content | Before chars | After | Canonical |
|---|---|---:|---:|---|
| D1 | `当前群：...` | 15 | 0 | system factualCtx |
| D2 | visual capability notice | 49 (conditional) | 0 | system factualCtx |
| D3 | strict search notice | 25 (conditional) | 0 | system factualCtx |
| D4 | long-form notice | 25 (conditional) | 0 | system factualCtx |
| D5 | owner private context notice | runtime-dependent | 0 | system factualCtx |
| D6 | group profile block | 116 (measured) | 0 | system relBlocks |
| D7 | relationship profile block | 75 (measured) | 0 | system relBlocks |
| D8 | memory block user copy | NOT removed | unchanged | system relBlocks (user copy carries precedence clause) |

Not touched: 1401-char tool note, tool schemas, persona, KB semantics, routing, analyze reviewer, quality dead branch (recorded only).

### Before/after (same synthetic fixture, exact chars)

| Path | Before user chars | After user chars | Delta |
|---|---:|---:|---:|
| A normal chat | 396 | 380 | -16 |
| B osu question no tool | 396 | 380 | -16 |
| C tool trigger | 398 | 382 | -16 |
| D slash static | 409 | 393 | -16 |
| E KB hit | 400 | 384 | -16 |
| F serious | 400 | 384 | -16 |
| G owner | 429 | 413 | -16 |
| profile-heavy (group+relationship) | 566 (reconstructed) | 375 | -191 |
| analyze reviewer path | unchanged | unchanged | 0 |

System chars are unchanged in every path. Tool note and tool schema are unchanged. **No char delta is converted into exact token savings.**

## 5. Audit documentation correction

`docs/WUXINBOT_PROMPT_REVIEW_AUDIT_V01.md` now separates:

- static/fixed bot-added content: system 6,072 chars + user-side fixed facts/identity ≈356 chars = ≈6,428 chars;
- provider-observed whole prompt input: n=749, mean 6,747, p50 6,405, p90 13,803, p95 14,945, max 24,355 tokens (includes history + user input).

The old wording that implied "Bot 自带 6,405 tokens" has been removed.

## 6. Validation

- `npm run typecheck` -> PASS
- `node --import tsx tools/prompt-review-slim-phase0-verify.mjs` -> **45 PASS, 0 FAIL**
- `git diff --check` -> PASS (see final report)
- Existing relevant verify scripts are unchanged; no production fixture/bot behavior verify was skipped for changed paths.

## 7. Verdict

**`PROMPT_REVIEW_SLIM_PHASE0_PASS`**

**`READY_FOR_P1_SINGLE_SOURCE`** (tool note / capability / command generated guidance, conditional injection).

Phase0 deliberately delivers measurement and regression protection, not large token reduction.
