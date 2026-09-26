# WUXINBOT_REWRITE_TELEMETRY_ANALYZER_V01

Status: **IMPLEMENTED**

Repository: `G:\QQ-AI-ChatBot`
Branch: `refactor/prompt-review-slim-v01`
Based on: commit `8f56965e2be7a0fe393eaaeeb7553bc9772a6a95` (Phase0 instrumentation)

---

## Purpose

Phase0 为 `rewriteNormalReply` 添加了 telemetry（`kind='rewrite-reply'` 写入 `db.usageEvents`）。
本 analyzer 把已有 telemetry 变成可持续查看的指标，用于回答：

> rewriteNormalReply 到底值不值得保留、条件化或删除？

**ANALYZER ONLY. 不修改生产行为。不调用 LLM。**

---

## Telemetry Contract (from `server/bot/rewriteTelemetry.ts`)

| Field | Type | Nullable | Meaning |
|---|---|---|---|
| `kind` | `'rewrite-reply'` | no | event discriminator |
| `eligible` | `boolean` | no | isWeirdReply triggered |
| `invoked` | `boolean` | no | rewrite LLM call was made |
| `skipReason` | `string` | yes | why skipped (e.g. `long_form`, `identity_question_deterministic`) |
| `provider` | `string` | yes | LLM provider |
| `model` | `string` | yes | LLM model |
| `inputTokens` | `number \| null` | yes | prompt tokens |
| `outputTokens` | `number \| null` | yes | completion tokens |
| `cachedInputTokens` | `number \| null` | yes | cached prompt tokens (subset of input) |
| `usageAvailable` | `boolean` | no | whether provider returned usage |
| `latencyMs` | `number \| null` | yes | wall-clock ms |
| `result` | `enum` | no | SKIPPED / UNCHANGED / CHANGED / ERROR_FALLBACK / EMPTY_FALLBACK / TIMEOUT_FALLBACK / OTHER_FALLBACK |
| `originalChars` | `number` | no | char count of original reply |
| `rewrittenChars` | `number` | no | char count of rewritten reply |
| `contentChanged` | `boolean` | no | deterministic (normalize + compare) |
| `originalHash` | `string` | yes | sha256 of original |
| `rewrittenHash` | `string` | yes | sha256 of rewritten |
| `createdAt` | `ISO string` | no | event timestamp |

---

## Usage

```bash
# All available data
node --import tsx tools/rewrite-telemetry-analyze.mjs

# Last 24 hours
node --import tsx tools/rewrite-telemetry-analyze.mjs --since 24h

# Last 7 days
node --import tsx tools/rewrite-telemetry-analyze.mjs --since 7d

# Custom time range
node --import tsx tools/rewrite-telemetry-analyze.mjs --from 2026-07-01 --to 2026-07-29

# Custom output directory
node --import tsx tools/rewrite-telemetry-analyze.mjs --output tmp/my_report
```

Default output: `tmp/rewrite_telemetry_report_v01/`

---

## Metrics

### Counts
- `total_events`, `eligible`, `not_eligible`, `invoked`, `not_invoked`

### Result Distribution
- `SKIPPED`, `UNCHANGED`, `CHANGED`, `ERROR_FALLBACK`, `EMPTY_FALLBACK`, `TIMEOUT_FALLBACK`, `OTHER_FALLBACK`, `UNKNOWN_RESULT`

### Core Rates (each with explicit denominator)
- `eligibility_rate = eligible / total_events`
- `invocation_rate_overall = invoked / total_events`
- `invocation_rate_given_eligible = invoked / eligible`
- `change_rate_overall = CHANGED / total_events`
- `change_rate_given_invoked = CHANGED / invoked`
- `unchanged_rate_given_invoked = UNCHANGED / invoked`
- `fallback_rate_given_invoked = all_fallbacks / invoked`

Zero denominator -> `null` in JSON, `N/A` in Markdown.

### Skip Reasons
Grouped by `skipReason`, with `count`, `% of skipped`, `% of all events`.

### Token Usage (invoked + usageAvailable only)
- `input_tokens`: total, mean, p50, p90, p95, max
- `output_tokens`: same
- `cached_input_tokens`: same
- `total_known_tokens` = input + output (cached is a subset, not added)

### Latency (ms)
- All invoked, CHANGED only, UNCHANGED only, Fallback only
- count, mean, p50, p90, p95, max
- n < 5 -> `SMALL_N` marker

### Character-Length Impact
- delta_chars = rewritten - original (mean/p50/p90/p95/max)
- changed-only delta, unchanged-only delta
- expansion/shrink/same-length rates
- **Note:** chars != semantic change != token savings

### Provider/Model Breakdown
Per provider+model: events, invoked, changed, fallback, usage_available, latency p50/p95, input/output/cached tokens.

### Day Trend
Per-day buckets: events, eligible, invoked, changed, fallback, latency_p50, known_tokens.

---

## Data Quality

Separate section reports:
- `total_records_seen`, `valid_records`, `malformed_records`
- `unknown_result_records`, `missing_created_at`, `missing_usage`
- `invalid_negative_tokens`, `invalid_negative_latency`, `invalid_char_counts`

Bad records: skipped from metrics, counted in data quality. Report never crashes.

---

## No-Data Behavior

When 0 rewrite-reply events exist:
- JSON: `{ "status": "NO_DATA", "event_count": 0 }`
- Markdown: "No rewrite-reply telemetry is available in the selected window."

No synthetic data. No production behavior conclusions.

---

## Interpretation Guardrails

Analyzer computes facts only. It does NOT conclude:
- "rewrite should be removed"
- "rewrite should always run"
- "rewrite is worth the cost"
- "rewrite is useless"

May include: "Decision requires product review."

---

## Token Semantics

Traced through `server/bot/rewriteTelemetry.ts` → `server/bot/llm.ts` → provider API response:

- `inputTokens` = `usage.prompt_tokens` (or `usage.input_tokens`) — **total** prompt tokens
- `cachedInputTokens` = `usage.prompt_tokens_details.cached_tokens` (or `input_tokens_details.cached_tokens`) — **subset** of inputTokens

**Cached is a subset of input, not additional.** The formula `known_tokens = inputTokens + outputTokens` is correct. `cachedInputTokens` is reported as a decomposition only.

Evidence: `rewriteTelemetry.ts:115-121` reads `prompt_tokens` and `prompt_tokens_details.cached_tokens` from the same `usage` object. OpenAI/DeepSeek API convention: `cached_tokens ⊆ prompt_tokens`.

---

## Time-Window Semantics

Records with missing or invalid `createdAt`:

| Scenario | In metrics? | In data quality? |
|---|---|---|
| No explicit `--since`/`--from`/`--to` | Yes | Yes |
| Explicit time window | **No** (membership unknowable) | Yes |

Implementation: `filterRewriteEvents` checks `hasWindow` before passing records with missing/invalid `createdAt`. `analyzeDataQuality` runs on ALL rewrite events (before time filtering).

---

## Verification

```bash
node --import tsx tools/rewrite-telemetry-analyze-verify.mjs
```

27 test cases covering:
1. Zero records -> NO_DATA
2. SKIPPED event
3. Eligible but not invoked
4. Invoked UNCHANGED
5. Invoked CHANGED
6. ERROR_FALLBACK
7. EMPTY_FALLBACK
8. TIMEOUT_FALLBACK
9. OTHER_FALLBACK
10. Unknown result
11. Usage available
12. Usage unavailable
13. Zero denominator -> null
14. Latency percentiles
15. Token percentiles
16. Chars delta
17. Multiple providers/models
18. Malformed records
19. Negative tokens
20. Negative latency
21. Missing createdAt (no window: included in metrics)
22. Time filter
23. Strict JSON
24. No plaintext content
25. Deterministic output
26. Missing createdAt + no window: included in aggregate metrics
27. Missing createdAt + explicit window: excluded from window metrics, included in data quality

---

## Files

| File | Role |
|---|---|
| `tools/rewrite-telemetry-analyze.mjs` | Analyzer (read-only, CLI) |
| `tools/rewrite-telemetry-analyze-verify.mjs` | Verifier (synthetic, no LLM) |
| `docs/WUXINBOT_REWRITE_TELEMETRY_ANALYZER_V01.md` | This document |

---

## Read-Only Guarantee

- Reads `db.json` via direct `fs.readFileSync` (no `updateDb`/`writeDb` import)
- No network calls
- No LLM calls
- No DB mutation
- No plaintext reconstruction (hashes only)
- Output goes to `tmp/` (gitignored)
