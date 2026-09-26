# QUICK_BRIDGE_FIX_P0_3 — SETTLE_TIMEOUT_ARBITRATION

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：bug fix（QB-04）；未改 no-reply 超时策略（QB-03）、P0_1 身份逻辑、P0_2 抑制语义
- 旧审计图（`QUICK_BRIDGE_RELIABILITY_AUDIT_V01` / matrix JSON）为修复前快照，保持不动

## 1. 缺陷（QB-04）

`callLocalBot` 在 timeout 前收到并成功提取有效回复后，会等 3s settle 再 resolve。若有效回复落在 timeout 前 3s 窗口内：回复提取成功 → settle 武装 → overall timeout 先触发 → reject → 已提取的有效回复被丢弃。旧 fixture f14（timeout 300ms / reply 270ms）离线复现该丢弃。

## 2. 旧 timer 状态机

```text
created: overallTimer(timeoutMs)                     // no-reply deadline
on valid extracted frame: armSettle()
  armSettle: clear old settleTimer; settleTimer = setTimeout(finish, 3000)  // 每有效帧重置
on overallTimer: endReason=timeout; finish(new Error(超时))   // 无论是否已有有效帧
on settleTimer:  settleFired=true; finish()                  // resolve with content
on close:        clear overallTimer; finish()                // 有内容 resolve / 无内容 reject 无回复
on error:        clear overallTimer; finish(error)           // reject
finish: settled guard; clear settleTimer; ws.close(); reject/resolve once
```

失败竞态：reply@(T-2s) → settle 到期 T+1s，但 overall@T 先触发 → reject，内容丢弃。

## 3. 新 timer 状态机

```text
created: overallTimer(timeoutMs)                              // no-reply deadline（唯一截止）
transition (首次有效回复被接受，且 settled=false):
  clear overallTimer; overallTimer = null
  postReplyDeadlineTimer = setTimeout(finish, MAX_POST_REPLY_MS)  // 硬上限，不被任何帧重置
on valid extracted frame: armSettle()
  armSettle: 首次帧 -> 上述 transition
             clear old settleTimer; settleTimer = setTimeout(finish, SETTLE_MS)  // 每帧重置
on settleTimer:  settleFired=true; finish()                   // resolve with content
on postReplyDeadlineTimer: endReason=post_reply_deadline; finish() // 有内容 -> resolve
on overallTimer: endReason=timeout; finish(new Error(超时))    // 仅当从未有有效回复
on close:        clear overallTimer; finish()                  // 有内容 resolve
on error:        clear overallTimer; finish(error)             // 显式传输错误仍 reject
finish: settled guard; clear settleTimer + postReplyDeadlineTimer + overallTimer; ws.close();
        error 传入 -> reject；否则有内容 -> resolve，无内容 -> reject 无回复；仅一次
```

常量：`SETTLE_MS = 3000`，`MAX_POST_REPLY_MS = 2 * SETTLE_MS = 6000`。
默认关闭测试覆盖：`BRIDGE_SETTLE_MS` / `BRIDGE_MAX_POST_REPLY_MS`（未设置时行为逐字不变）。

## 4. 语义

- **NO_REPLY_TIMEOUT**：无有效回复时，overall timer 仍按配置 deadline reject；不因 ACK/无关/坏帧获得任何 grace（QB-03 未动）。
- **VALID_REPLY_BEFORE_DEADLINE**：首次有效回复在 deadline 前被接受 → no-reply timeout 退役；settle（或 close）后 resolve。即使 settle 完成超过原 deadline 也成功（f14）。
- **VALID_REPLY_AFTER_DEADLINE**：overall 已 reject 后到达的首个有效帧不能复活调用（armSettle 有 settled 保护；连接已关）。
- **MULTI_FRAME_SETTLE**：每个后续有效帧仍重置名义 3s settle；但总 post-reply 生命周期硬上限 6s（自首次有效帧起），不因帧流延长。
- **UNRELATED / ACK-ONLY**：不触发 transition、不获得 grace；no-reply deadline 不变。
- **CLOSE_AFTER_VALID_REPLY**：close 事件走 finish()（无 error），已收集内容 resolve（既有语义保留）。
- **ERROR_AFTER_VALID_REPLY**：显式传输错误仍 reject（既有语义保留；错误是明确失败信号，不属于 settle-vs-timeout 仲裁）。
- **EXACT_ONCE / CLEANUP**：settled 布尔守卫不变；finish 清 settleTimer、postReplyDeadlineTimer、overallTimer；close/error 事件晚到为 no-op；socket 在 finish 中关闭。

## 5. 回归覆盖

### `tools/quick-bridge-p03-settle-verify.mjs`（新增，34 断言）

1. f14 production-default：timeout 300 / reply 270 → **resolve**（修复前 reject），settle 窗口 3000–4500ms。
2. zero-frame no-reply：timeout 200 静默 → reject 调用超时，无 grace。
3. reply 190/200 deadline-epsilon → resolve。
4. reply 230/200 after-deadline → reject，不复活，exact-once。
5. 多有效帧聚合（a、b 两帧）。
6. settle 内迟到有效帧：名义 settle 延长但仍受硬上限约束。
7. 硬上限：每 25ms 连续帧，grace 到期仍 resolve 已收集内容，elapsed 90–250ms，exact-once。
8. 无关帧近 deadline：不给 grace，reject。
9. ACK-only 近 deadline：ACK 正确回执但 reject 超时，不给 grace。
10. close-after-reply：resolve 内容，fast。
11. error-after-reply：settled-once / no unhandled（平台可能呈现 close-like，已记录）。
12. 3000 例确定性 race campaign（settle=50/grace=100/timeout=120，24 并发）：784/787 resolve + 2213 reject 稳定，0 anomalies，exact-once 全通过，timer 生长 0。

### 既有 verifier 更新

- `tools/quick-bridge-reliability-verify.mjs` f14 期望改为 resolve + settle 窗口；其余 165 断言不变（含 P0_1 全量）。
- `tools/quick-bridge-p02-recent-verify.mjs` 23 断言不变。

## 6. Files changed

- `server/bots/localBridge.ts`：新增 SETTLE_MS / MAX_POST_REPLY_MS 常量与默认关闭 env 覆盖；finish 清理三 timer；armSettle 首帧 transition；overallTimer 改为 let；close/error 清理调整。
- `tools/quick-bridge-reliability-verify.mjs`：f14 期望更新。
- `tools/quick-bridge-p03-settle-verify.mjs`：新增。
- `docs/QUICK_BRIDGE_FIX_P0_3.md`：本文件。

## 7. Remaining risk

QB-03 不变：无帧/动作-only 的 open-but-silent 调用仍会烧满原 30/60s deadline——这是“没有有效回复时该等多久”的问题，不是“有效回复已到后的仲裁”，本阶段刻意不处理。

未 commit，未 push。
