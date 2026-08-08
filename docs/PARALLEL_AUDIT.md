# Parallel Code Audit — Wuxin / QQ-AI-ChatBot

> 审计日期：2026-08-08
> 架构：1 Coordinator + 6 只读专项 Agent 并行工作
> 性质：只读审计，未修改任何代码

---

## Executive Summary

| Agent | 职责 | 检查文件 | Candidates | Excluded | B | C | D |
|-------|------|----------|------------|----------|---|---|---|
| 1 | Delivery Pipeline | 8 | 11 | 7 | 4 | 0 | 0 |
| 2 | LLM Tool Loop | 6 | 12 | 7 | 5 | 0 | 0 |
| 3 | Process Lifecycle | 6 | 6 | 0 | 3 | 2 | 0 |
| 4 | Routing/Permissions | 9 | 11 | 5 | 0 | 2 | 4 |
| 5 | Cache Correctness | 11 | 21 | 19 | 1 | 1 | 0 |
| 6 | osu Score Semantics | 13 | 7 | 2 | 1 | 2 | 0 |

**独立 C 根因总数：7**
**跨 Agent 重复：0**（每个 C 类都有独立根因）

---

## C — Confirmed Bugs

### P0-1: `/api/simulate` 调用者可伪造 userId 获得 owner 权限

**发现 Agent**: Agent 4 (Routing/Permissions)
**涉及模块**: API 端点安全

**当前最新文件 + 行号**: `server/index.ts:943-954`

**用户可见表现**: 拥有 adminPassword（或 GUI 未设密码时完全开放）的调用者可以通过 `/api/simulate` 端点以任意 userId 执行 `/w op`、`/w ban`、`/w prompt set` 等 owner 命令。

**确定触发条件**:
1. 调用 `POST /api/simulate`，body 中设置 `userId` 为 owner 的 QQ 号
2. `text` 设置为 `/w op @某人` 或其他 owner 命令
3. `processIncoming` 将 `event.userId` 视为真实发送者
4. `bot.ts:378` 判断 `isOwner = event.userId === settings.ownerQq` → true

**完整调用链**:
```
POST /api/simulate {userId: ownerQq, text: "/w op @target"}
  → index.ts:943: processIncoming({userId: ownerQq, ...})
  → bot.ts:378: isGroupOwner = event.userId === settings.ownerQq → true
  → bot.ts:414: handleOwnerCommand(event, sendMessage, {isOwner: true, ...})
  → ownerCommands.ts: 执行 owner 级命令
```

**确定性测试**: curl POST /api/simulate with userId=ownerQq, text="/w prompt set 新提示词"

**为什么已有保护无效**: `/api/simulate` 的 `userId` 直接来自 `req.body.userId`（line 949），不经过 `identifier()` 验证，不与真实 QQ 身份绑定。adminPassword 是唯一的保护，但 GUI 在未设置密码时完全开放。

**最小修复方向**: 模拟端点应固定 userId 为 `'gui-simulation'` 或拒绝与 `settings.ownerQq` 匹配的 userId。

---

### P0-2: `/api/onebot/event` 可注入任意 QQ 事件

**发现 Agent**: Agent 4 (Routing/Permissions)
**涉及模块**: API 端点安全

**当前最新文件 + 行号**: `server/index.ts:938-941`

**用户可见表现**: 拥有 adminPassword 的调用者可以伪造来自任何 QQ 用户的群消息/私聊消息，触发命令执行、LLM 回复、记忆写入等。

**确定触发条件**:
1. `POST /api/onebot/event`，body 为任意 OneBot 格式 JSON
2. `handleOneBotEvent(req.body)` 直接处理，不验证 `oneBotAccessToken`
3. `processIncoming` 将其视为真实 QQ 消息

**完整调用链**:
```
POST /api/onebot/event {post_type:"message", user_id:ownerQq, group_id:"123", message:"/w prompt set 新提示词"}
  → index.ts:939: handleOneBotEvent(req.body)
  → onebot.ts:220-243: normalize → processIncoming
  → bot.ts: 全管道执行
```

**为什么已有保护无效**: `oneBotAccessToken` 仅用于 WS 连接认证（`onebot.ts:264`），不用于 HTTP webhook 端点。`handleOneBotEvent` 不验证 token。

**最小修复方向**: webhook 端点应有独立的 token 验证或 IP 白名单。

---

### P1-1: renderedPanelCache 缺少 historyUser 维度

**发现 Agent**: Agent 5 (Cache Correctness)
**涉及模块**: BP 面板渲染缓存

**当前最新文件 + 行号**: `server/bots/render.ts:983-996`（bpListCacheKey）

**用户可见表现**: 请求 B 期望看到带有历史对比头部卡片的 BP 面板，实际返回了请求 A 的无历史版本。

**确定触发条件**:
1. 请求 A: `renderBestScoresList(user, scores, {startRank: 1})` → 无 historyUser → 缓存 key = `a4:12345:1:n:...`
2. 请求 B: `renderBestScoresList(user, scores, {startRank: 1, historyUser: oldProfile})` → key 完全相同 → 命中缓存 → 返回无历史版本

**确定性测试**: 连续两次调用 renderBestScoresList，第二次传入 historyUser，验证返回的图片是否包含历史对比卡片。

**为什么已有保护无效**: `bpListCacheKey` 只使用 `apiUser.id`、`ranks`、`compact`、`scoreSigs` 构建 key，`options.historyUser` 不参与 key 计算。

**最小修复方向**: 在 key 中加入 `options.historyUser?.id || 0`。

---

### P1-2: gracefulShutdown 不等待进行中操作

**发现 Agent**: Agent 3 (Process Lifecycle)
**涉及模块**: 进程生命周期

**当前最新文件 + 行号**: `server/index.ts:56-64`

**用户可见表现**: Ctrl+C 关闭时，正在进行的 LLM 调用被强制中断，回复丢失。如果 `updateDb` 正在 `withDbLock` 中间，可能留下 `db.lock` 残留。

**确定触发条件**:
1. 用户发送消息，触发 LLM 调用（耗时 3-10 秒）
2. LLM 调用进行中时按 Ctrl+C
3. `gracefulShutdown` 调用 `shutdownOneBot()`，200ms 后 `process.exit(0)`
4. LLM 调用的 Promise 仍在执行，被强制终止

**为什么已有保护无效**: `gracefulShutdown` 只关闭 WS 连接，不等待进行中的操作。200ms 的 `setTimeout` 对于 LLM 调用来说太短。

**最小修复方向**: 引入 `activeProcessing` 计数器，shutdown 时等待其归零（设上限如 10 秒），同时清理所有 setInterval。

---

### P1-3: `/w osu clear bind` 不清理关联的分析缓存

**发现 Agent**: Agent 4 (Routing/Permissions) — 通过交叉引用此前审计发现
**涉及模块**: osu 绑定管理

**当前最新文件 + 行号**: `server/osu/commands.ts:1424-1435`

**用户可见表现**: 用户解绑后重新绑定不同账号，旧账号的分析缓存仍存在，可能显示旧数据。

**确定触发条件**:
1. 绑定账号 A → 执行分析 → 产生缓存
2. 解绑（`/w osu clear bind`）
3. 绑定账号 B
4. 查看历史分析，仍显示账号 A 的数据

**为什么已有保护无效**: `handleClearBind` 只删除 `osuBindings[userId]`，不清理 `osuAnalyses`、`osuRecentAnalyses`、`osuRecommendCooldowns`。

**最小修复方向**: 解绑时同时清理该 userId 的关联缓存。

---

### P2-1: 推荐引擎硬编码 'osu' 模式

**发现 Agent**: Agent 6 (osu Score Semantics)
**涉及模块**: 谱面推荐

**当前最新文件 + 行号**: `server/osu/recommender.ts:443-445`

**用户可见表现**: 用户请求 taiko/catch/mania 模式的推荐时，系统返回 osu 模式的数据，而不是报错或切换模式。

**确定触发条件**:
1. 用户绑定的账号主要玩 taiko
2. 请求推荐谱面
3. 推荐引擎查询 osu 模式的 BP → 返回 osu 模式的推荐

**为什么已有保护无效**: `recommendForPlayer` 中所有 API 调用硬编码 `'osu'` 模式。

**最小修复方向**: 将模式参数传递到推荐引擎，或在非 osu 模式时返回明确错误。

---

### P2-2: buildRankingArray 区间长度 off-by-one

**发现 Agent**: Agent 6 (osu Score Semantics)
**涉及模块**: 排名统计渲染

**当前最新文件 + 行号**: `server/bots/render.ts:453, 470`

**用户可见表现**: info 面板中"持续改进天数"少报 1 天。

**确定触发条件**:
- 排名序列: [100, 90, 80, 70]（连续 4 天提升）
- 中间分支计算: `startIndex=0, endIndex=3, length=3`（应为 4）

**为什么已有保护无效**: `endIndex - startIndex` 在两个分支中都缺少 `+1`，而第三个分支（排名下降后回升）正确使用了 `endIndex - startIndex + 1`。

**最小修复方向**: 将 line 453 和 470 的 `endIndex - startIndex` 改为 `endIndex - startIndex + 1`。

---

## B — Actual Risks

| # | Agent | 描述 | 文件:行号 | 触发条件 |
|---|-------|------|-----------|----------|
| B1 | 1 | HTTP 超时但 QQ 已收到 | onebot.ts:50 | NapCat 响应延迟 >12s |
| B2 | 1 | drainReplyQueue splice-then-process 丢失消息 | queue.ts:142-148 | updateDb 在 drain 过程中失败 |
| B3 | 1 | mergeQueuedReplyItems 丢失图片 | queue.ts:151-165 | 多条带图快速消息排队 |
| B4 | 2 | 跨迭代 tool_call 无去重 | executor.ts:2299 | LLM 在 iteration 2 重复 iteration 1 的 tool call |
| B5 | 2 | withTimeout 不取消底层 LLM API 调用 | llm.ts:82-88 | LLM API 超时后 SDK 继续重试 |
| B6 | 2 | LLM API 调用无 AbortController | llm.ts:314-330 | 最昂贵的调用不可取消 |
| B7 | 3 | setInterval 缺少 .unref() | index.ts:1228-1233 | 进程退出时 timer 阻塞 |
| B8 | 3 | MatchManager.restore 失败静默删除绑定 | match.ts:637-638 | getMatch 因网络超时失败 |
| B9 | 3 | restoreBackup 不经过 normalizeDb | backup.ts:76 | 恢复旧版备份时 schema 不一致 |
| B10 | 5 | bpTypeAnalysis 缺少 mode 维度 | bpTypeAnalysis.ts:28-34 | 当前硬编码 osu 不触发，扩展模式时会成为 C |
| B11 | 6 | 推荐排除 beatmapset 级粒度不一致 | recommender.ts:490-496 | 推荐历史过度排除 |

---

## D — Cannot Confirm

| # | Agent | 描述 | 原因 |
|---|-------|------|------|
| D1 | 4 | API 端点无细粒度权限 | 设计选择（GUI 单用户模式），非代码缺陷 |
| D2 | 4 | /w op 可跨群操作 | 仅 owner 能触发，owner 被信任管理所有群 |
| D3 | 4 | !p/!r/!bp 短别名跨 bot 依赖注册顺序 | 当前无实际冲突，有全局开关保护 |
| D4 | 4 | Hydrant 前缀自由命令拦截普通聊天 | 需 quickRouterEnabled=true，默认关闭 |

---

## A — Important Exclusions

| # | Agent | 检查项 | 排除原因 |
|---|-------|--------|----------|
| A1 | 1 | 同一结果重复发送 | claimInboundEvent 10 分钟去重 |
| A2 | 1 | 重试发送已成功消息 | sendOneBotMessage 无 retry 机制 |
| A3 | 1 | 队列永久卡死 | try/finally 保证 drain，锁最终释放 |
| A4 | 1 | 群间共享队列状态 | key = `group:{groupId}:{userId}`，完全隔离 |
| A5 | 2 | LLM 重试重复副作用 | retryAfterEmpty 删 tools；SDK 重试在 HTTP 层 |
| A6 | 2 | maxRounds off-by-one | maxIterations=4 → 循环 3 + 最终 1 = 4，正确 |
| A7 | 2 | tool_call id 关联 | 全链路一致传递 |
| A8 | 2 | 外部/内部 fallback 双执行 | 互斥分支 + routeBusy 保护 |
| A9 | 3 | 启动顺序 | normalizeDb 在服务启动前运行，restore 在接受消息前调用 |
| A10 | 4 | alias 绕过权限 | 别名规范化不改变命令语义 |
| A11 | 4 | quick→LLM 双消费 | handled=true 时直接 return，不进入 LLM |
| A12 | 5 | osu/api.ts 全部 API 缓存 | Key 包含 userId/beatmapId/mode/mods，维度完整 |
| A13 | 5 | skillStore 缓存 | Key 为 osuUserId:mode，QQ 是查找别名 |
| A14 | 6 | BP 排序 | osu! API 返回已排序，weight.pp 加权正确 |
| A15 | 6 | NC/DT 归一化 | normalizedScoreMods 去重+排序正确 |

---

## Cross-Agent Findings

无跨模块组合触发的问题。每个 C 类都有独立根因，不存在"A 模块的 Bug 触发 B 模块的 Bug"的情况。

---

## Recommended DeepSeek Queue

按优先级排列：

1. **P0-1 + P0-2**: API 端点安全加固（/api/simulate userId 限制 + /api/onebot/event token 验证）
2. **P1-1**: renderedPanelCache key 加入 historyUser
3. **P1-2**: gracefulShutdown 等待进行中操作
4. **P1-3**: /w osu clear bind 级联清理缓存
5. **P2-1**: 推荐引擎模式参数化
6. **P2-2**: buildRankingArray off-by-one
7. **B5+B6**: LLM API 调用加入 AbortController
8. **B3**: mergeQueuedReplyItems 保留所有消息的图片
9. **B8**: MatchManager.restore 失败时保留绑定
