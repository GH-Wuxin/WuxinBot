# RESPONSE_LATENCY_AUDIT_V01

- 日期：2026-08-15
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：只观察、追踪、基线；未优化、未改任何业务语义；未 commit/push
- Tracing：`server/perf/latencyTrace.ts`，仅 `PERF_TRACE=1` 启用；默认关闭且无文件写入

## 0. 结论摘要

- 可见 `!r`（yumu recent bridge）P50 ≈ **8990ms**、P95 ≈ **35038ms**，其中 bridge WS 响应占约 99%。
- 控制命令 `!ping` P50 ≈ **2.90ms**，说明 quick route 本身/绑定解析/store 不是当前瓶颈。
- **LLM_REQUEST_COUNT_PER_RE = 0**（代码与实测一致）。
- 实际 `!re` 路由与任务描述不完全一致：当前 `matchQuickCommand` 将 `!re` 匹配到 **kanon**（KANON_DEFS 在 EXCLAMATION_DEFS 中先于 YUMU_DEFS 的 tie 顺序），实测 kanon 本地桥 60s 超时，随后内部 fallback 因 harness 无 OSU OAuth 而失败。本报告不宣称 `!re` 的 bridge-success 基线；用 yumu `!r` 测量真实 bridge-success 路径，并记录一次真实 `!re` 失败样本。
- 未实现任何优化。

## 1. Actual chain（edge-by-edge）

以 `!re`/`!r` 实际代码路径为准：

| # | Step | File/function | await boundary | I/O class |
|---|---|---|---|---|
| 1 | WS message received | `server/onebot.ts` | async | WEBSOCKET |
| 2 | processIncoming quick route | `server/bot.ts:435-448` | sync decision before replyQueues | IN_PROCESS_SYNC |
| 3 | matchQuickCommand | `server/bot/quickRouter.ts:81-146` | sync | IN_PROCESS_SYNC |
| 4 | handleQuickCommand wrapper | `quickRouter.ts` | async | IN_PROCESS_ASYNC |
| 5 | gates / group / user policy | `quickRouter.ts` | sync | IN_PROCESS_SYNC |
| 6 | subject resolution | `resolveInjectionUser` / `parseOsuArgs` | async only if numeric binding needs osu API | IN_PROCESS_SYNC or HTTP |
| 7 | bridge command build | `buildBridgeCommand` | sync | IN_PROCESS_SYNC |
| 8 | bridge call | `callLocalBot` | async | WEBSOCKET (local bot WS) |
| 9 | bridge reply parse | `extractReplyFrame` | sync after WS frame | IN_PROCESS_SYNC |
| 10 | sendMessage | captured in harness | async | OTHER (captured; production OneBot HTTP) |
| 11 | command log | `writeCommandLog` | sync updateDb | STORE_IO |
| 12 | shadow observation | `recordShadow` → `buildQuickShadowSummary` | async fire-and-forget | HTTP after send |
| 13 | context persist | `recordQuickContext` | sync updateDb | STORE_IO |
| 14 | internal fallback | `executeInternalBotCommand case recent` | async | WEBSOCKET/HTTP/RENDER |

**Queue wait = 0**：quick route 在 `bot.ts` 的 replyQueues 之前执行；实测 `!ping` 路径无 queue wait。

## 2. Measured environment / harness

- Fresh `DATA_DIR` temp dir，先于所有 server import 设置。
- `PERF_TRACE=1`，`PERF_TRACE_DIR` 指向同 temp 目录。
- `sendMessage` 为 in-process capture，**不发送真实 QQ**。
- `osuBindings[testQQ] = { id: 0, username: 'mrekk' }`，避免 binding resolution 触发 osu API。
- Preflight：
  - TCP `127.0.0.1:8388` open。
  - `callLocalBot('yumu','!ping', ..., 8000)` 成功，约 **3108ms**，返回 1 张图片、0 文本、1 frame。
- `!r` samples：8 次，串行，每次 fresh messageId。
- `!ping` control：8 次。
- `!re` actual：1 次（因为每次 kanon bridge timeout 固定 60s，继续跑 30 次不现实；记录原因）。

## 3. E2E baseline tables (ms)

### yumu `!r` bridge-success

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| PARSE | 8 | 0.41 | 0.67 | 0.67 |
| ROUTE | 8 | 8995.58 | 35046.57 | 35046.57 |
| E2E_VISIBLE | 8 | 8990.30 | 35037.82 | 35037.82 |
| E2E_CONTEXT_READY | 8 | 8997.29 | 35047.70 | 35047.70 |

### `!ping` control

| Metric | n | p50 | p95 | max |
|---|---|---|---|---|
| ROUTE | 8 | 7.14 | 25.49 | 25.49 |
| E2E_VISIBLE | 8 | 2.90 | 21.55 | 21.55 |
| E2E_CONTEXT_READY | 8 | 8.05 | 26.73 | 26.73 |

### actual `!re` single failure

| Metric | Value |
|---|---|
| ROUTE | 60028.21 |
| E2E_VISIBLE | 60022.88 |
| E2E_CONTEXT_READY | 60029.36 |
| reason | `recent_error` |
| failure | kanon local WS timeout 60s；随后 internal user resolution 因 harness 未配置 OSU OAuth 失败 |

## 4. Stage baselines for yumu `!r` (trace span durations)

| Stage | n | p50 | p95 | max |
|---|---|---|---|---|
| route_start | 8 | 0.57 | 1.09 | 1.09 |
| subject_resolution_start | 8 | 0.49 | 1.46 | 1.46 |
| subject_resolution_done | 8 | 0.44 | 0.84 | 0.84 |
| bridge_request_start | 8 | 0.41 | 0.63 | 0.63 |
| **bridge_response** | 8 | **8985.60** | **35032.83** | **35032.83** |
| send_start | 8 | 0.91 | 1.14 | 1.14 |
| send_resolved | 8 | 0.53 | 0.72 | 0.72 |
| observation_build_start | 7 | 3.63 | 4.28 | 4.28 |
| observation_persist_start | 2 | 3.51 | 3.51 | 3.51 |
| observation_persist_done | 2 | 3.58 | 3.58 | 3.58 |
| route_done | 8 | 1.26 | 2.08 | 2.08 |

Unavailable stages:

- `QUEUE_WAIT` = null，因为 quick route 在 replyQueues 之前。
- `SECONDARY_ENRICHMENT` = null，bridge-success 不执行 internal `enrichScoreStarRatings`。
- `RESULT_BUILD` = null，同上。
- `RENDER` = null，bridge-success 不执行 yumu-image render。
- `observation_build_done` = null，shadow IIFE 在 route finish 后才完成；`finishLatencyTrace` 会忽略迟到 span。

## 5. I/O counts

### bridge-success yumu `!r`

| Counter | Value |
|---|---|
| LLM_REQUEST_COUNT_PER_RE | **0** |
| HTTP_REQUEST_COUNT_VISIBLE | 0 |
| HTTP_REQUEST_COUNT_SHADOW_AFTER_SEND | 2 |
| WS_REQUEST_COUNT | 1 |
| STORE_READ_COUNT | 3 |
| STORE_WRITE_COUNT | 2 |
| FILESYSTEM_IO_COUNT | 1 (bridge image save) |
| RENDER_INVOCATION_COUNT | 0 |
| CACHE_LOOKUP_COUNT | 0 |
| SERIAL_EXTERNAL_AWAITS_VISIBLE | 1 |
| SERIAL_EXTERNAL_AWAITS_SHADOW | 2 |
| PARALLEL_EXTERNAL_AWAITS | 0 |

### bridge-fail actual `!re`

| Counter | Value |
|---|---|
| LLM_REQUEST_COUNT | 0 |
| HTTP_REQUEST_COUNT_VISIBLE | 0 |
| WS_REQUEST_COUNT_VISIBLE | 1 |
| WS_TIMEOUT_MS | 60000 |
| STORE_READ_COUNT | 3 |
| STORE_WRITE_COUNT | 2 |
| FILESYSTEM_IO_COUNT | 0 |
| RENDER_INVOCATION_COUNT | 0 |
| CACHE_LOOKUP_COUNT | 0 |
| SERIAL_EXTERNAL_AWAITS_VISIBLE | 1 |
| PARALLEL_EXTERNAL_AWAITS | 0 |

## 6. N+1 / duplicate work

### DUP_SHADOW_RECENT

- producer：quickRouter bridge 成功。
- first_consumer：visible `sendMessage`。
- repeated_consumer：`buildQuickShadowSummary` 在 send 后重新 `getUser` + `getUserRecentScores`。
- reason：bridge image-only 结果没有文本，context memory 需要事实摘要。
- measured cost：harness 无 OSU OAuth，shadow 在第二次 HTTP 前失败；代码路径是 2 次串行 HTTP after send。
- verdict：不修复。

### DUP_BRIDGE_FALLBACK

- producer：quickRouter bridge attempt。
- first_consumer：quickRouter visible path。
- repeated_consumer：bridge 失败后 `executeInternalBotCommand case 'recent'` 会再次 `callLocalBot`。
- reason：内部 engine fallback 保持原渲染优先级。
- measured cost：本次 `!re` 未触发第二次 bridge，因为 OAuth 缺失让 user resolution 先失败；code-derived 潜在 second WS request。
- verdict：不修复。

## 7. Observation path / race

- `recordShadow` 用 void IIFE 启动 shadow summary；route 立即返回。
- `finishLatencyTrace` 会从 active map 删除 trace，因此 shadow 完成后的 `observation_build_done`/`observation_persist_done` 迟到 span 被丢弃。
- 生产影响为零（tracing 默认 off）。Harness 通过独立 polling `db.messages` 捕获 E2E_CONTEXT_READY。
- 这不是生产竞态，而是 instrumentation visibility limit。

## 8. Top-5 stages

1. **PRIMARY_RECENT_FETCH (bridge_response)** — p50 8985.60ms，p95 35032.83ms。
2. **E2E_VISIBLE** — p50 8990.30ms，p95 35037.82ms。
3. **E2E_CONTEXT_READY** — p50 8997.29ms，p95 35047.70ms。
4. **OBSERVATION_BUILD (shadow, after send)** — start marker p50 3.63ms；真实耗时取决于 shadow HTTP。
5. **SEND** — captured sendMessage p50 0.53ms（真实 OneBot HTTP 未测量）。

## 9. Top optimization candidates（仅评估，不实施）

| Rank | Candidate | Contribution | Removable cost | Risk | Complexity |
|---|---|---|---|---|---|
| 1 | yumu/kannon bridge panel cache | ~99% visible latency | 8.9-35s p50/p95 | stale panel / invalidation | medium |
| 2 | Shadow summary 合并/复用 bridge payload | post-send，不影响 visible | 重复 HTTP work | context freshness | low |
| 3 | `!re` alias routing review | actual `!re` 60s timeout | 最多 60s failure path | visible bot semantics change；本轮禁止 | low but behavior change |

**First recommended optimization**（不实施）：

> Cache yumu/kannon bridge panel results keyed by `(botId, command, resolvedUsername, mode)` with a short TTL and explicit stale-on-error fallback. Do not implement in this audit; validate against production bridge variance first.

## 10. Verification

- `npm run check` ✅ PASS
- `node --import tsx tools/quick-router-verify.mjs` ✅ 121/121
- `node --import tsx tools/queue-verify.mjs` ✅ PASS
- `node --import tsx tools/bot-harness-verify.mjs` ✅ PASS
- `node --import tsx tools/onebot-verify.mjs` ✅ PASS
- `npm run verify-all`：见执行记录，预期只有 pre-existing `reasoning-wire-verify` teardown failure；任何新增失败都会阻断并回滚 instrumentation。
- `git diff --check`：见执行记录。

## 11. Files modified/created

- 新增：`server/perf/latencyTrace.ts`
- 修改：`server/bot/quickRouter.ts`
- 修改：`server/bot/quickMemory.ts`
- 修改：`server/bots/executor.ts`
- 新增：`docs/RESPONSE_LATENCY_AUDIT_V01.md`
- 新增：`docs/RESPONSE_LATENCY_BASELINE_V01.json`

未修改：onebot.ts、store、LLM、replyQueues、analyzer/match 等。未提交/push；临时 harness 在 `%TEMP%` 且已删除脚本。

## 12. Explicit confirmation

No optimization was implemented. Tracing is default-off and behavior-transparent. Only observation/tracing/baseline docs and instrumentation were added.
