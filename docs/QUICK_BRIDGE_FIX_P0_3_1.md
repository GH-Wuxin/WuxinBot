# QUICK_BRIDGE_FIX_P0_3_1 — ABSOLUTE_DEADLINE_HARDENING

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：P0_3 的边界语义加固；不是新功能、不是 QB-03；未改 3s/6s 策略、未改身份、未改 P0_2 语义

## 1. 为什么 timer-callback 状态 ≠ 逻辑 deadline

P0_3 的首次有效回复 transition 依据是“overallTimer 尚未执行”（在 `armSettle` 里 `clearTimeout(overallTimer)`）。在事件循环中，一个在逻辑 deadline 之后才可处理的有效帧，可能在 timeout callback 拿到 CPU 前先进入 message handler；旧实现会把该晚到帧当“准时”接受。判定必须来自显式单调时钟，而不是回调是否已跑。

## 2. 时钟

`process.hrtime.bigint()`（与 bridgeTimeline 同一单调源）。`Date.now()` 不参与逻辑 deadline。

## 3. 边界策略

```text
callLocalBot 进入 Promise executor 时：
  startedAtNs = process.hrtime.bigint()
  noReplyDeadlineNs = startedAtNs + round(timeoutMs) * 1_000_000ns

message handler 首行（任何解析/提取之前）：
  receivedAtNs = process.hrtime.bigint()

首次有效帧被提取后：
  if receivedAtNs <= noReplyDeadlineNs  -> 接受，退役 no-reply timer，进入 bounded settle
  if receivedAtNs >  noReplyDeadlineNs  -> 拒绝 transition：**在加入 frames/texts/images 之前丢弃**；
                                         不退役 deadline、不获得 settle grace；
                                         之后 close 只会因无内容而 reject `无回复`，
                                         绝不会基于这段晚到内容 resolve。
```

**精确边界：`arrival <= deadline` 接受（含恰好等于）。**

## 4. “arrival” 的定义

**frame handler 进入处理的时刻**（`ws.on('message')` 回调首行、任何 `String(data)`/JSON.parse/提取之前）。“解析慢不算迟到”——3MB 慢提取回归验证：收到时间 mock 为 deadline−1ms，解析跨越 deadline 后仍接受。

## 5. transition 前后状态机

- 前：`!replyAccepted`（回调未执行近似）→ clear overallTimer → bounded settle。
- 后：`!replyAccepted && receivedAtNs <= noReplyDeadlineNs` → clear overallTimer → bounded settle；否则 `late_reply_ignored_for_deadline` 标记并 return（settle 不武装）。

## 6. 6s 兼容性措辞更正

`MAX_POST_REPLY_MS = 6000ms` 是**为保留现有多帧 settle 行为而选择的保守兼容界**；**不是** Kanon/Yumu/OneBot 协议要求。`SETTLE_MS = 3000ms` 与每有效帧重置、硬上限不重置、硬上限以 resolve 已收集内容结束——全部保持 P0_3 不变。

## 7. error-after-valid 证据更正

- **SOURCE-CONFIRMED**：`ws.on('error')` 调 `finish(error)`，因此真实 client error 在有效内容后仍 reject（源码路径明确）。
- **RUNTIME**：本 Windows 主机上合成 `resetAndDestroy` 表现为 close-like resolve，未能可靠触发 client `error` handler；不声称运行时确认。未为此构建裸 malformed WebSocket。

## 8. 回归（`tools/quick-bridge-p03-deadline-verify.mjs`，16 断言 + 2000 例战役）

1. DEADLINE_MINUS_1（mock hrtime：deadline−1ms）→ resolve。
2. DEADLINE_EXACT（mock hrtime：恰好 deadline）→ resolve（`<=` 策略）。
3. DEADLINE_PLUS_1（deadline+1ms）→ reject，无复活。
4. EVENT_LOOP_DELAY_BEFORE_TIMEOUT_CALLBACK：timeout callback 人为延迟 80ms，逻辑 deadline 后、callback 前送达首有效帧 → 帧被处理并 ACK，但绝对 deadline 拒绝（reject 调用超时，ACK 证据证明 handler 先于 timer 运行）。
4b. LATE_FIRST_THEN_CLOSE_BEFORE_TIMEOUT_CALLBACK（edge case）：晚到首帧之后、延迟 timeout callback 之前 server 关闭 → **reject `无回复`，绝不 resolve**；ACK=1 证明帧被处理，而 close 无内容可 resolve 证明晚帧在收集前已被丢弃。
5. ON_TIME_FRAME_SLOW_EXTRACTION：接收 mock deadline−1ms + 3MB 慢解析 → resolve。
6/7. ACK/unrelated 在 deadline 后、延迟 callback 前 → reject 且不获 grace。
8. FIRST_VALID_THEN_LATE_VALID：准时首帧退役 deadline；原 deadline 后的第二帧仍参与 bounded settle（settle 200/grace 600 下 2 帧聚合）。
9/10. 2000 例边界战役（独立 verifier `quick-bridge-p03-deadline-race-verify.mjs`，timeout=120ms、timer 人为 +15ms、15 个到达类、8 并发）：**outcome 与 timeline 记录的 logical-arrival 分类 100% 一致**（accepted→resolved；lateIgnored→rejected；0 mismatch），exact-once 全通过，timer 句柄 before=after=0。

- P0_3 原 verifier 的 race campaign 移除已过时的“delay 启发式异常”判定（在绝对 deadline 语义下，handler 在 deadline 后才进入的早发帧被拒绝是正确行为）；其 settle 聚合与 f14 时间窗已加宽到抗调度抖动，仍 34/34。
- P0_1 166/166、P0_2 23/23 保持全绿。

## 9. Files changed

- `server/bots/localBridge.ts`：`startedAtNs`/`noReplyDeadlineNs`、`receivedAtNs` 捕获、`armSettle(receivedAtNs)` 边界判定、**晚到首帧 collection 前丢弃**、`late_reply_ignored_for_deadline` 标记、注释更新。
- `tools/quick-bridge-p03-deadline-verify.mjs`：边界 fixture（23 断言）。
- `tools/quick-bridge-p03-deadline-race-verify.mjs`：timeline 注释的 2000 例战役（6 断言）。
- `tools/quick-bridge-p03-settle-verify.mjs`：移除过时 delay 启发式、加宽 f14/multi 时间窗。
- `docs/QUICK_BRIDGE_FIX_P0_3_1.md`：本文件。

## 10. Remaining scope

QB-03 仍然未动：没有有效回复（或只有 ACK/无关帧）时，调用仍按原 30/60s no-reply deadline 拒绝；本阶段只定义“有效回复已到之后”的仲裁。

未 commit，未 push。
