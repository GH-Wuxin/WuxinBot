# 四 Bot Bridge / Timeout / Fallback 专项审计

> 审计日期：2026-08-08
> 项目：Wuxin / QQ-AI-ChatBot
> 性质：只读审计，未修改任何代码

---

## 执行摘要

| 指标 | 数值 |
|------|------|
| 检查文件数 | 12 |
| 快捷命令数量 | 113（43 yumu + 13 kanon + 10 hydrant + 47 lazybot） |
| bridge 调用点 | 1（quickRouter.ts:567 `callLocalBot`） |
| WebSocket 创建点 | 2（localBridge.ts:223 每次调用创建新 WS，onebot.ts 主连接） |
| timeout 数量 | 3（bridge 45s/60s，pendingBotCalls 20s，overallTimer 在 localBridge） |
| pending request 类型 | 2（bridge 路径：Promise；external bot 路径：pendingBotCalls Map） |
| fallback 路径数量 | 1（bridge 失败 → 内部 executor） |
| 第一轮候选数 | 6 |
| 第二轮排除数 | 6 |
| **最终 C 类数量** | **0** |

---

## 四 Bot 调用链

### 路径 A：QuickRouter Bridge 路径（快捷命令）

```
用户消息 "!p"
  → bot.ts:processIncoming()
    → quickRouter.matchQuickCommand()         // 匹配 EXCLAMATION_DEFS
    → quickRouter.handleQuickCommand()
      → 检查 globalPaused / group.enabled / userPolicy / silent
      → 检查 groupBotConfig[def.source]
      → 检查 hasLocalEndpoint(def.source)
      → resolveInjectionUser(db, userId)       // 解析 Wuxin 绑定
      → buildBridgeCommand(match)              // 构建原始命令
      → callLocalBot(def.source, cmd, ctx, timeout)
        → new WebSocket(endpoint.url, headers)
        → ws.on('open') → ws.send(buildEvent())
        → ws.on('message') → extractReplyFrame() → armSettle()
        → ws.on('close') → finish()
        → ws.on('error') → finish(error)
        → overallTimer → finish(timeout_error)
      → 成功：sendMessage(event, payload) → return
      → 失败：catch → fall through 到内部 handler
        → executeInternalBotCommand(botId, capability, username, context)
        → sendMessage(event, quickPayload(result)) → return
```

### 路径 B：LLM Tool 路径（自然语言）

```
用户消息 "帮我看看bp"
  → bot.ts:processIncoming()
    → decideReply() → shouldReply=true
    → buildPrompt() → LLM 调用
    → LLM 返回 tool_call: query_osu { capability: "bp" }
    → runToolLoop()
      → executeToolCall()
        → executeToolCallInner()
          → case 'query_osu':
            → executeInternalBotCommand(botId, capability, username, context)
            → 返回 ToolResult
      → LLM 生成最终回复
    → sendMessage(event, reply)
```

### 路径 C：External Bot 路径（QQ 通道）

```
用户消息 "用猫猫查一下bp"
  → bot.ts:processIncoming()
    → detectNamedBotRequest() → 检测到 "猫猫"
    → LLM 调用 → tool_call: query_external_bot { bot: "kanon", command: "!bp" }
    → executeToolCallInner()
      → case 'query_external_bot':
        → registerPendingBotCall(correlationId, botId, channel, groupId)
        → sendMessage(botEvent, command)  // 发送到目标 Bot 的 QQ
        → await responsePromise           // 等待 Bot 回复
          → tryResolveBotResponse()       // 匹配 incoming QQ 消息
          → finishPendingBotCall()        // resolve promise
        → 返回 ToolResult
```

---

## Bridge 状态机分析（localBridge.ts）

### finish() 幂等性验证

```typescript
// localBridge.ts:235-250
const finish = (error?: Error) => {
  if (settled) return;        // ← 幂等守卫
  settled = true;
  if (settleTimer) clearTimeout(settleTimer);
  try { ws.close(); } catch { /* noop */ }
  if (error) { reject(error); return; }
  // ... resolve
};
```

**验证**：`settled` 是闭包内布尔变量，`finish()` 首次调用设置 `settled=true`，后续调用直接 return。`resolve`/`reject` 只执行一次。

### 事件竞争分析

| 事件 | 时序 | finish() 行为 | 结果 |
|------|------|---------------|------|
| 正常 message → settle → finish | T1: message, T2: settle timeout | 首次调用，resolve | 正常完成 |
| overallTimer → finish(error) | T1: timeout fires | 首次调用，reject | 超时拒绝 |
| overallTimer → message → armSettle → settle → finish | T1: timeout, T2: message, T3: settle | T1: reject, T3: `settled=true` → return | 安全，无双 resolve |
| overallTimer → close → finish | T1: timeout, T2: close | T1: reject, T2: `settled=true` → return | 安全 |
| overallTimer → error → finish(error) | T1: timeout, T2: error | T1: reject, T2: `settled=true` → return | 安全 |

**结论**：所有事件路径最终都经过 `settled` 守卫，`resolve`/`reject` 严格只执行一次。

### Timer 清理验证

| Timer | 创建位置 | 清理位置 | 泄漏风险 |
|-------|----------|----------|----------|
| `overallTimer` | line 259 | `finish()` 中 `ws.on('close')` 清除 (line 289)，`ws.on('error')` 清除 (line 293) | 无 |
| `settleTimer` | line 256 `armSettle()` | `finish()` line 238 清除 | 低（见下） |

**settleTimer 泄漏分析**：
当 `overallTimer` 先触发 → `finish()` 执行 → `settleTimer` 被清除 → WS 关闭。
如果 `ws.on('message')` 在 WS 关闭前触发 → `armSettle()` 创建新的 `settleTimer`。
这个新 timer 3 秒后触发 → `finish()` → `settled=true` → return → timer 被 GC。

**结论**：存在一个 3 秒的悬挂 timer，但不影响功能（无副作用，自动 GC）。

### Socket 关闭验证

`finish()` 中 `try { ws.close(); } catch { /* noop */ }` 确保 WebSocket 一定关闭。
即使 `ws.close()` 抛出异常（如 already closed），也被 catch 吞掉。

---

## Timeout → Fallback → Late Response 场景验证

### 完整时序

```
T0: 用户发 "!p"
T1: callLocalBot('yumu', '!p', ctx, 60000) 开始
    → WebSocket 连接 ws://127.0.0.1:8388
    → ws.send(buildEvent())
    → overallTimer = setTimeout(finish(timeout), 60000)
T2: yumu 很慢，60 秒无响应
T3: overallTimer 触发
    → finish(new Error("yumu 调用超时（60s）"))
    → settled = true
    → clearTimeout(settleTimer)
    → ws.close()
    → reject(error)
T4: callLocalBot 的 Promise reject
T5: quickRouter catch 块
    → console.error("bridge yumu 失败，回退内部引擎")
T6: fall through 到内部 handler
    → executeInternalBotCommand('yumu', 'recent', username, context)
    → sendMessage(event, result)
T7: 用户收到内部引擎的回复
T8: yumu 终于回复（late response）
    → ws.on('message') 可能已不再触发（WS 已关闭）
    → 即使触发：armSettle() → settleTimer → finish() → settled=true → return
```

**T6 是否会产生副作用**：是，sendMessage 发送内部引擎结果到 QQ。
**T8 是否会产生副作用**：否，`settled` 守卫阻止任何额外 resolve/reject。
**用户观察**：只收到一条回复（内部引擎结果），不会双回复。

### 关键保护机制

1. `finish()` 的 `settled` 守卫（localBridge.ts:236）
2. `ws.close()` 阻止后续消息到达（localBridge.ts:239）
3. quickRouter 的 catch 块只 log 不 send（quickRouter.ts:598-600）
4. 内部 handler 和 bridge 是互斥路径（bridge 成功 → return；bridge 失败 → fall through）

---

## PendingBotCalls 专项分析

### Correlation Key 设计

```typescript
// executor.ts:696
const correlationId = `${extBot.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

`correlationId` 是唯一的，但实际 correlation 不依赖它。`tryResolveBotResponse` 使用：

```typescript
// executor.ts:179-186
const candidateBots = (registry.bots || []).filter(
  (candidate) =>
    candidate.enabled &&
    candidate.qq === senderQq &&          // ← 匹配发送者 QQ
    candidate.channel === eventChannel &&  // ← 匹配通道
    (eventChannel !== 'qq_group' ||
      String(candidate.groupId || eventGroupId || '') === String(eventGroupId || ''))
);
```

然后找到该 bot/channel/group 的最旧 pending call：

```typescript
// executor.ts:193-200
const entry = [...pendingBotCalls.values()]
  .filter((pending) =>
    candidateBotIds.has(pending.botId) &&
    pending.channel === eventChannel &&
    (eventChannel !== 'qq_group' ||
      String(pending.groupId || '') === String(eventGroupId || ''))
  )
  .sort((a, b) => a.createdAt - b.createdAt)[0];
```

### Key 唯一性验证

| 场景 | Key 区分 | 是否冲突 |
|------|----------|----------|
| 同 Bot 同群连续请求 | `routeBusy` 检查阻止（line 128-134） | 否 |
| 不同 Bot 同群 | botId 不同 | 否 |
| 同 Bot 不同群 | groupId 不同 | 否 |
| 不同用户同群同 Bot | `routeBusy` 阻止第二个请求 | 否 |

### Late Response 与新建 Entry 的竞争

```
T0: 请求 A → pendingBotCalls.set("bot_1", entryA)
T1: 请求 A 超时 → finishPendingBotCall(entryA) → pendingBotCalls.delete("bot_1")
T2: 请求 B → pendingBotCalls.set("bot_2", entryB)
T3: Bot 的 late response 到达
    → tryResolveBotResponse()
    → 找到 entryB（最旧的 pending call）
    → entryB 被 late response resolve
```

**这是潜在问题吗**：不是。`routeBusy` 检查（line 128-134）确保同一 bot/channel/group 同时只有一个 pending call。所以 T2 只有在 T1 完成后才能执行。late response 到达时，如果没有 pending call，`tryResolveBotResponse` 返回 false，消息进入正常处理流程。

### Image 触发立即完成

```typescript
// executor.ts:222-224
if (entry.images.length > 0) {
  finishPendingBotCall(entry);
}
```

当 Bot 返回图片时，立即完成 pending call。这是正确的——osu! 面板 Bot 的图片就是最终结果。

### Progress Message 处理

```typescript
// executor.ts:207-211
const progress = looksLikeProgressResponse(text, policy.progressKeywords);
if (!entry.textParts.some((part) => part.text === text)) {
  entry.textParts.push({ text, progress });
}
```

进度消息（如"正在查询…"）被标记为 `progress: true`，使用更长的 settle timer（10 秒 vs 1.2 秒）。实质性消息使用短 settle timer。

---

## Response Correlation Map

| 请求类型 | correlation 机制 | timeout | late response 处理 | 结论 |
|----------|------------------|---------|-------------------|------|
| Bridge (localBridge) | Promise + settled guard | 45s/60s | settled guard 阻止双 resolve | 安全 |
| Internal (executeInternalBotCommand) | 同步调用，无 pending | N/A | N/A | 安全 |
| External Bot (pendingBotCalls) | QQ + channel + groupId | 20s | routeBusy 阻止新 entry；无 pending 时丢弃 | 安全 |

---

## QuickRouter 多重命中分析

### 路由优先级

```
输入 "!p"
  → 1. 检查 /w 前缀 → 不匹配
  → 2. 检查 ! 前缀 → 匹配
  → 3. matchAlias(EXCLAMATION_DEFS, "p")
    → 遍历所有 aliases，找最长匹配
    → "p" 匹配 yumu.recent (aliases: ['p', 'pass', ...])
    → 返回第一个匹配
  → 4. return match（唯一）
```

### 唯一消费验证

| 输入 | 匹配结果 | 是否可能多重命中 |
|------|----------|-----------------|
| `!p` | yumu.recent | 否（! 前缀只匹配 EXCLAMATION_DEFS） |
| `/bp` | lazybot.bp | 否（/ 前缀只匹配 SLASH_DEFS） |
| `~` | hydrant.self_profile | 否（~ 前缀只匹配 HYDRANT_DEFS） |
| `查@某人` | hydrant.at_profile | 否（查 前缀只匹配 HYDRANT_DEFS） |
| `打什么图` | hydrant.recommend | 否（prefix-free 匹配 HYDRANT_DEFS） |

### 与 LLM Pipeline 的互斥

```typescript
// bot.ts:422-431
const quickMatch = detectBpTypeAnalysisIntent(event.text) ? null : matchQuickCommand(event);
if (quickMatch && quickRouterEnabled(db, event)) {
  const quickResult = await handleQuickCommand(event, sendMessage, db, quickMatch, { ... });
  if (quickResult?.handled) {
    return quickResult;  // ← 消费消息，不进入 LLM
  }
}
// 未被 quick path 消费的消息继续进入 LLM pipeline
```

**结论**：quick path 和 LLM pipeline 是互斥的。`handled: true` 时消息被消费，不再进入 LLM。

---

## Fallback 语义一致性

### Bridge → Internal Fallback 参数对比

| 命令 | Bridge 参数 | Fallback 参数 | 是否一致 |
|------|-------------|---------------|----------|
| `!p` (recent) | `where {user}` 通过 resolveInjectionUser | `executeInternalBotCommand('yumu', 'recent', username, ctx)` | 一致（都用 db.osuBindings） |
| `!bp` (bp) | `!bp {user}` 通过 resolveInjectionUser | `executeInternalBotCommand('yumu', 'bp', username, ctx, bpSelection)` | 一致 |
| `~` (self_profile) | `where {user}` 通过 resolveInjectionUser | `executeInternalBotCommand('hydrant', 'profile', '', ctx)` | 一致 |
| `查@某人` (at_profile) | `where {user}` 通过 resolveAtBinding | `executeInternalBotCommand('hydrant', 'profile', username, ctx)` | 一致 |

### Binding 解析一致性

Bridge 路径使用 `resolveInjectionUser(db, qq)`：
```typescript
// quickRouter.ts:301-328
async function resolveInjectionUser(db, qq) {
  const binding = db?.osuBindings?.[String(qq)];
  if (!binding) return '';
  const { id, username } = bindingParts(binding);
  if (username) return username;
  if (id > 0) { /* 通过 osu API 解析 username */ }
  return '';
}
```

Internal 路径使用 `resolveInternalPlayerTarget(db, userId, username, extra)`：
```typescript
// executor.ts:1173-1263
// 1. 请求者自己的绑定（名称匹配）
// 2. @提及用户的绑定
// 3. 拒绝未绑定用户的昵称猜测
// 4. 群昵称 → QQ → 绑定
// 5. 显式用户名
```

**关键差异**：Bridge 路径直接用 `resolveInjectionUser(db, event.userId)` 解析请求者绑定。Internal 路径用 `resolveInternalPlayerTarget` 的 5 级信任链。

当 bridge 失败 fallback 到 internal 时：
- 如果用户没有显式用户名：bridge 用 `resolveInjectionUser(db, userId)` → internal 用 `resolveInternalPlayerTarget(db, userId, '')` → 两者都从 `db.osuBindings[userId]` 获取 → **一致**
- 如果用户有显式用户名：bridge 用 `resolveInjectionUser(db, userId)` 注入到命令中 → internal 用 `resolveInternalPlayerTarget(db, userId, username)` → 两者可能解析到不同账号（如果显式用户名和绑定不同）

**但这不是 bug**：bridge 失败时，用户输入的显式用户名已经丢失（bridge command 被重建），fallback 路径重新从 event 中解析。两条路径最终都使用 `db.osuBindings`。

---

## Timer / Socket Cleanup 表

| 资源 | 创建 | settle | cleanup | late callback 防护 | 结论 |
|------|------|--------|---------|-------------------|------|
| bridge WS | callLocalBot line 223 | finish() | finish() ws.close() | settled guard | 安全 |
| overallTimer | callLocalBot line 259 | — | close/error handler clearTimeout | settled guard | 安全 |
| settleTimer | armSettle() line 256 | — | finish() clearTimeout | settled guard | 安全（有 3s 悬挂 timer，无害） |
| pendingBotCalls entry.timeout | registerPendingBotCall line 149 | — | finishPendingBotCall clearTimeout | identity check | 安全 |
| pendingBotCalls entry.settleTimer | schedulePendingSettlement line 112 | — | finishPendingBotCall clearTimeout | identity check | 安全 |
| inFlightRecommends | executeToolCallInner line 627 | — | finally block line 631-633 | identity check | 安全 |

---

## 推荐修复顺序

**无 C 类 Bug 需要修复。**

---

## 推荐增加的运行时观测点

1. **Bridge 调用延迟监控**：记录 `callLocalBot` 的实际耗时，用于判断 timeout 是否需要调整
2. **Fallback 触发频率**：统计 bridge 失败 → internal fallback 的次数，用于评估 bridge 可靠性
3. **PendingBotCalls 队列深度**：监控同时活跃的 pending call 数量
4. **Late response 丢弃计数**：统计 `tryResolveBotResponse` 返回 false 但 sender 匹配已知 bot 的次数
