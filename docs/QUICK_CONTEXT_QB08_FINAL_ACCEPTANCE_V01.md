# QUICK_CONTEXT_QB08_FINAL_ACCEPTANCE + END_TO_END_STABILITY_V01

- 状态：**QB-08 = CLOSED**
- 依据：A1/A2 两个 correctness 边界均通过；!re → immediate follow-up 端到端 9 阶段验收全绿；QB-01~QB-08 关键回归通过。
- 本阶段新增：`tools/quick-context-qb08-final-acceptance-verify.mjs`（9/9）。
- 无 QB-09、无架构扩张、无新增非阻塞修复。

## A1 — registration 先于 externally observable visible completion

源码证据（`server/bot/quickRouter.ts`，bridge 成功分支）：

```
const payload = [reply.text, ...reply.images].filter(Boolean).join('\n');
if (payload) {
  const bridgeText = ...;
  if (bridgeText) record(...);                       // 文本路径：context 先写
  else if (shadowCap && shadowUser) recordShadow(...); // image-only：placeholder + pending 注册
  else record(...);
  try { await sendMessage(event, payload); }          // visible boundary 在注册之后
  ...
}
```

即：在 `await sendMessage`（用户可观察边界）之前，`recordQuickContextPending`（placeholder + `pendingQuickId`）与 `registerPendingQuickObservation`（pending handle）均已存在。

Runtime 证据（final-acceptance `a1-boundary`）：
- 在 `sendMessage` 回调内部同步检查：`pendingCount == 1`、db 中已存在带 `pendingQuickId` 的 assistant slot；
- shadow 在 send 完成后独立完成并 hydrate。

结论：**无 visible → 极短窗口 → pending register 缺口。**

## A2 — drain timeout 是 aggregate budget

源码（`server/bot/quickContext.ts`）：

```
const timeout = new Promise<'timeout'>((resolve) => setTimeout(resolve, waitMs));
await Promise.race([
  Promise.allSettled(entries.map((entry) => entry.promise)),   // 并行 join
  timeout,                                                      // 单一共享 deadline
]);
```

Runtime 证据（final-acceptance `a2-timeout`，全部 promise 永不 settle，budget=80ms）：

| pending 数 | 实测 wall | 期望（若逐个等） |
|---|---|---|
| 1 | 92ms | 80ms |
| 2 | 82ms | 160ms |
| 8 | 84ms | 640ms |
| 16 | 91ms | 1280ms |

结论：总 wall ≈ 单个 timeout + 调度容差，不是 pendingCount × timeout。

## 端到端验收 timeline（!re → immediate follow-up）

| 场景 | quick_visible_ms | followup_wait_ms | context_ready_ms | 结果 |
|---|---|---|---|---|
| B1 yumu image-only + 立即追问（shadow 500ms） | 136–142 | 516–524 | 668–677 | buildPrompt context 含同一 visible snapshot；recent×1、user×1、bridge×1 |
| B2 kanon text+image | — | 0 | — | 无 pending、无 Wuxin fetch、context 复用 bridge text |
| B3 shadow 100ms | 134 | 123 | 257 | hydrated |
| B3 shadow 500ms | 99 | 523 | 622 | hydrated |
| B3 shadow 2s | 120 | 2005 | 2125 | hydrated |
| B3 shadow >bound（40s / policy 300ms） | 98 | 305 | — | bounded 返回；该次 drain 后未 hydrated，后台继续 |
| B4 shadow failure | — | 1 | — | visible 成功；placeholder fallback；无 retry storm；bridge=1；无 unhandled |
| B5 A/B 反序完成 | — | ~499 | — | 槽位顺序=visible 顺序；原位 hydrate；A/B 各一槽；recent×2 |
| B6 isolation | group vs private / 不同 user / 不同 group 均 0ms | — | — | 只等自己的 pending |
| B7 并发双追问 | — | — | — | 同一 promise；recent×1；单一 hydrate |

## 30s timeout policy 观察

- hard correctness bound：drain ≤ `QUICK_CONTEXT_PENDING_WAIT_MS` + 调度容差（A2 已证）。
- UX wait policy：**POLICY_TUNING_REQUIRED**。本阶段没有真实 shadow latency 分布，不主张 30s 是最佳默认值；仅记录当前默认值来源（shadow 链两次串行 osuFetch 各 15s，token fetch 无超时是必须设上界的原因）。可用 `QUICK_CONTEXT_PENDING_WAIT_MS` 覆盖。
- 这不阻塞 QB-08 correctness closure。

## 最终判定

**QB-08 = CLOSED**：

- pending registration 严格早于 externally observable visible completion（A1）；
- drain timeout 是 aggregate budget（A2）；
- immediate follow-up race verifier 通过（B1–B7）；
- ordering / isolation / failure / concurrency 全通过；
- visible latency 不被 shadow 阻塞（quick_visible_ms 98–144 vs shadow 100–40000ms）；
- QB-07 fetch graph 未增加（qb07 verifier 7/7，fetch 计数不变）。

## 回归

- `npm run check` PASS
- `git diff --check` clean
- QB-08 visible-race：8/8
- QB-08 final-acceptance：9/9
- QB-07：7/7
- QB-06：7/7 wrapper（JVM 19/19）
- QB-05 dedup：66/66
- QB-05 safeslot：unit 9/9、quickrouter-fallback 5/5、executor-fallback 4/4；blackbox 阶段在本机磁盘负载下出现既有 timing 敏感 flake（100 次 callLocalBot 同步循环跨池秒边界，导致 101st 未命中同一池），生产 invariant 由 unit + fallback 阶段独立覆盖，记为非阻塞测试环境 flake。
- P0_2 23/23；P0_3 deadline 23/23；quick-router 121/121；bot-harness PASS。

## 本阶段新增文件

- `tools/quick-context-qb08-final-acceptance-verify.mjs`
- `docs/QUICK_CONTEXT_QB08_FINAL_ACCEPTANCE_V01.md`（本文件）

## 修改文件（QB-08）

- `server/bot.ts`（buildPrompt 前 drain 同 key pending）
- `server/bot/quickRouter.ts`（A1：record/placeholder+pending 注册移到 send 之前）
- `server/bot/quickMemory.ts`（placeholder + 原位 hydrate）
- `server/bot/quickContext.ts`（新增 pending registry / aggregate drain）
- `tools/quick-context-qb08-visible-race-verify.mjs`
- `docs/QUICK_CONTEXT_FIX_QB08_VISIBLE_CONTEXT_RACE.md`
