# RESPONSE_LATENCY_AUDIT_V01_1 — !re → Kanon 60s 超时根因

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：只观察、追踪、根因定位；未优化、未改业务语义；未 commit/push
- 新增诊断：`server/perf/bridgeTimeline.ts`，仅 `BRIDGE_TIMELINE=1` 启用；默认关闭
- 证据文件：`docs/RESPONSE_LATENCY_AUDIT_V01_1_EVIDENCE.json`

## 0. 结论摘要

- 复现出与 V01 记录一致的 60 秒超时签名（`elapsed 60036.42ms`、`recent_error`、Kanon 连接全程零帧）。
- **根因不是 osu API、不是渲染、不是 replyQueues、也不是 Kanon 执行卡死**。根因是 **Kanon 服务端把桥接注入的消息当“自己发的消息”静默丢弃**：

  `kanon-bot/src/Drivers/OneBot/Driver/Server.cs`：

  ```csharp
  var userId = root.GetProperty("user_id").GetRawText();
  if (clients.Iter().Any(s => s.Value.selfID == userId))
      return;   // 静默丢弃，不执行、不回包、不断开
  ```

  Wuxin `localBridge.ts` 给非 yumu bot 固定使用 `X-Self-ID: 1000000003`（`SPIKE_SELF_ID`）。当注入事件的 `user_id` 也是 `1000000003` 时（V01 harness 的 sender QQ 恰好等于该值），Kanon 静默 return，Wuxin 在 `callLocalBot` 里等满 60,000ms 超时。
- 换用不冲突的 sender QQ 后，同目标、同命令走完全相同路径 **8.57s 成功**（Kanon 首帧 5.54s，图片正常提取，settle 3s）。
- 直接（native）连 Kanon 同目标 `!re`：发送→首个 `send_msg` 回包 **5336.46ms**。
- 因此 Kanon 端点健康、协议正常、Kanon 后端约 5.3–5.5s 出图；60s 超时是桥接命令注入语义（身份冲突）触发的**确定性静默丢弃**，不是慢。
- 未实施任何优化。

## 1. 超时分类（Required）

**CONNECTED_NO_FRAMES**

- WS 连接成功建立（9.6–10.0ms）。
- 命令已发送（11.0ms）。
- 60,000ms 窗口内收到 **0 帧**（不是 connect timeout，不是 reply 提取失败，不是 settle 超时）。
- 60s 到点后由 `callLocalBot` 的 overall timer 拒绝，回退内部引擎。

## 2. 实测 Kanon 桥时间线（monotonic，ms，自 callLocalBot 开始）

### 2.1 失败复现（sender QQ = 1000000003 = 桥接 fake self id）

| 事件 | elapsed ms | sincePrev ms |
|---|---|---|
| endpoint_lookup_done | 0.64 | 0.64 |
| ws_construction_start | 1.24 | 0.60 |
| ws_constructed | 4.12 | 2.88 |
| ws_open | 10.01 | 5.89 |
| command_sent | 11.18 | 1.17 |
| **timeout（60s overall timer）** | **60014.08** | **60002.90** |
| finish（rejected, frames=0, endReason=timeout） | — | — |

Kanon 日志同期：`00:06:32.698 starting data receiver` → `00:07:32.706 close received`，**中间没有任何“收到OneBot用户”消息行**。

### 2.2 成功样本（sender QQ = 900000099，不冲突）

| 事件 | elapsed ms | sincePrev ms |
|---|---|---|
| endpoint_lookup_done | 0.50 | 0.50 |
| ws_construction_start | 1.05 | 0.56 |
| ws_constructed | 4.44 | 3.38 |
| ws_open | 9.60 | 5.17 |
| command_sent | 10.99 | 1.38 |
| **first_frame**（send_msg, 314,921B） | **5539.18** | **5528.19** |
| first_api_action_frame（action=send_msg） | 5540.08 | 0.90 |
| ack_sent | 5540.98 | 0.90 |
| first_reply_action_frame（array, segments=image） | 5541.65 | 0.67 |
| reply_extracted（0 文本 + 1 图片） | 5546.55 | 4.90 |
| settle_start（3000ms） | 5547.56 | 1.01 |
| settle_done | 8553.43 | 3005.87 |
| finish（resolved, frames=1, endReason=settle） | — | — |

E2E：`handleQuickCommand` 总耗时 **8570.72ms**，可见回复 send 于 **8562.06ms**（图片 90B CQ code），原因 `bridge:kanon`。
Kanon 日志：`00:05:34.363 ← 收到OneBot用户 900000099 的消息 !re [SHK]Wuxin`。回包后后台 `BeatmapTechDataProcess` 记录 duplicate key `2126752`（非阻塞，发生在 reply 之后，与可见延迟无关）。

## 3. A–L 答案

- **A 端点健康**：是。`ws://127.0.0.1:7700/` 接受连接，HTTP 探针返回 400（非 WS 请求拒绝），WS open 9.6–10ms，且能正常出图。
- **B 连接成功打开**：是（两次桥接均 open；Kanon 日志均有 data receiver 启动行）。
- **C 60s 窗口收到多少帧**：失败样本 **0 帧**；成功样本 1 帧。
- **D 帧类型**：失败样本无帧。成功样本：1 个 `send_msg` API action（带 echo、params.message 为数组、含 1 个 `image` segment、314,921B）。无 heartbeat/notice/meta_event。
- **E Kanon 是否收到注入的 !re**：成功配置**收到**（Kanon 日志明文记录 `!re [SHK]Wuxin`）；失败配置**未收到**（连接建立但无消息行，消息被 Server.cs 自消息过滤静默丢弃）。
- **F 精确注入命令**：`!re [SHK]Wuxin`（`match.alias='re'` + 绑定用户名注入，无额外 args）。
- **G 卡在哪里**：失败样本里 Kanon **执行根本没开始**——消息在 Kanon `Server.Parse` 的自消息检查处被丢弃，Wuxin 在 `callLocalBot` 中等待一个永远不会到来的回包直到 60s。成功样本没有卡点：Kanon 约 5.5s 完成 osu 查询+渲染+send_msg。
- **H 是否有回包但未被提取**：否。失败样本零帧，不存在回包；成功样本 `send_msg`+array+image 被 `extractReplyFrame` 正确提取（`reply_not_extracted` 从未触发）。
- **I native/direct Kanon !re 延迟**：同目标直接 OneBot WS 调用，发送→首个回包动作 **5336.46ms**（首帧 5335.23ms；观察窗口总时长 6541.60ms，含 1.2s 人为保持）。
- **J Wuxin 桥 !re 延迟**：正常路径 E2E 可见 **8562.06ms**（桥首帧 5539.18ms + 图片保存/提取 ~7ms + settle 3000ms）；身份冲突路径 **60036.42ms**（桥超时 60014.08ms 后内部 fallback 报 OAuth 缺失）。
- **K 主要问题是什么**：**命令注入语义（身份冲突）**。桥接用固定 fake self id `1000000003`，当注入的 `user_id` 与之相等（或等于任意已连接客户端的 self id）时，Kanon 的防自消息逻辑把真实命令静默丢掉。不是端点可用性、不是 Kanon 后端执行、也不是通用桥协议不匹配（不冲突时协议完全可用）。
- **L 第二桥接尝试可达性**：**CONDITIONAL**。`executeInternalBotCommand('kanon','recent',…)` 在 `case 'recent'` 内确实会再次 `callLocalBot('kanon', '!re <user.username>', {userId: 原 QQ, groupId: 原群}, 60_000)`，但该 switch 之前必须先通过 `resolveInternalPlayerTargetDetailed` + `loadInternalOsuUser`（需要 OAuth/osu API 成功）。V01/本次 harness 无 OAuth，第二次桥未到达（失败于 loadInternalOsuUser）；生产配置有 OAuth 时**可达**，且若 sender 仍冲突会再等第二个 60s。

## 4. 优化分类（仅分类，不实施）

**BRIDGE_PROTOCOL_FIX**

依据：

1. 60s 超时的唯一直接原因是桥接事件被 Kanon 自消息过滤静默丢弃（Server.cs 代码 + 双方日志 + 可控复现：换掉冲突 QQ 立即成功）。
2. 正常路径 Kanon 只需 ~5.3–5.5s 出图，**没有后端性能瓶颈**，因此 BACKEND_OPTIMIZATION / CACHE 都不符合证据。
3. 端点健康、路由匹配正确，ROUTING_CHANGE 无证据支撑。
4. FAIL_FAST 只能把 60s 变成更早的报错，不能阻止消息被丢弃；且固定“无帧即快速失败”会误伤合法慢命令（V01 已测 yumu p95 ≈ 35s）。修复方向应是桥接身份/协议层（例如非 yumu bot 也使用 per-call self id，或注入 user_id 与 self id 冲突时主动避免/检测），因此首选 **BRIDGE_PROTOCOL_FIX**。

## 5. 采样合规

共 3 次 Kanon `!re` 诊断调用：

1. Wuxin 桥正常配置（成功，8.57s）
2. Wuxin 桥身份冲突复现（60s 超时，证据已完备，遂停止）
3. native/direct 同目标（5.34s 出图）

未做压力测试。

## 6. Verification

- `npm run check` ✅ PASS（typecheck/build/sanity/security）
- `node --import tsx tools/quick-router-verify.mjs` ✅ 121/121
- `node --import tsx tools/bot-harness-verify.mjs` ✅ PASS
- `node --import tsx tools/queue-verify.mjs` ✅ PASS
- `node --import tsx tools/onebot-verify.mjs` ✅ PASS
- `npm run verify-all` ✅ **73/74 passed (105.8s)**；唯一失败 `reasoning-wire-verify.mjs`，exit `3221226505`，断言 `!(handle->flags & UV_HANDLE_CLOSING)`——与已登记基线完全相同（Windows + Node 24 teardown），非新增失败
- `git diff --check` ✅ 干净（仅 LF/CRLF 提示）

## 7. Files modified/created（本次 V01_1）

- 新增：`server/perf/bridgeTimeline.ts`（默认关闭的桥接时间线诊断）
- 修改：`server/bots/localBridge.ts`（仅插入默认关闭的 timeline 标记/帧摘要，业务分支未改）
- 新增：`docs/RESPONSE_LATENCY_AUDIT_V01_1.md`
- 新增：`docs/RESPONSE_LATENCY_AUDIT_V01_1_EVIDENCE.json`

诊断 harness 与 direct probe 为仓库外临时脚本（`G:\My pack\Agent Work\codex_work\tmp\`），未进入仓库。

未改动：quickRouter/quickMemory/executor 的 V01 instrumentation、onebot.ts、store、LLM、replyQueues、Kanon 任何源码、任何队列/缓存/并发/观察语义/生命周期/超时策略。

## 8. Explicit confirmation

No optimization was implemented. Bridge timeline tracing is default-off (`BRIDGE_TIMELINE=1` opt-in) and behavior-transparent when disabled. Nothing was committed and nothing was pushed.
