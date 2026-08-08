# 异步 / Promise / 并发专项审计

> 审计日期：2026-08-08
> 项目：Wuxin / QQ-AI-ChatBot
> 性质：只读审计，未修改任何代码

---

## 1. 执行摘要

| 指标 | 数值 |
|------|------|
| 检查文件数 | 37 |
| async 函数声明 | 162 |
| await 调用 | 575 |
| fire-and-forget (`void`) | 19 |
| setTimeout | 26 |
| setInterval | 7 |
| AbortController | 8 |
| WebSocket/网络异步资源 | 6 (onebot WS, 4 localBridge WS, renderServer WS) |
| 共享可变状态 | 29 个 `let` + 13 个可变 `const Map/Set/object` |
| updateDb 写入点 | 108 |
| readDb 读取点 | 103 |
| 第一轮候选数 | 10 |
| 第二轮排除数 | 8 |
| **最终 C 类 Bug 数** | **1** |

---

## 2. C — 明确 Bug

### C1. match.ts `setInterval` + async `listen()` 导致并发重入竞态

严重程度：**High**

文件 + 精确行号：`server/osu/match.ts:153`

相关代码：

```typescript
// match.ts:145-157
start(): void {
  if (this.timer) return;
  if (this.match.match.end_time) {
    void this.onEventCb('matchEnd', { type: 'MATCH_END' });
    this.stop('MATCH_END');
    return;
  }
  void this.listen();                                          // line 152
  this.timer = setInterval(() => void this.listen(), 8000);    // line 153 ← 问题
  this.killTimer = setTimeout(() => {
    if (!this.stopped) this.stop('TIME_OUT');
  }, TIMEOUT_MS);
}
```

完整调用链：

```
start()
  → setInterval(() => void this.listen(), 8000)     // 每 8 秒触发
    → listen()                                        // async，修改共享状态
      → await getMatchAfter(...)                      // 网络请求，可能耗时 >8s
      → this.nowEventId = ...                         // 写入共享状态 (line 195-200)
      → this.nowGameId = ...                          // 写入共享状态 (line 189, 201)
      → this.parseUsers(...)                          // 写入 usersIdSet, userMap (line 204)
      → this.match = newMatch                         // 写入共享状态 (line 206)
      → this.onAllEvent(...)                          // fire-and-forget handleEvent
        → void this.handleEvent(event)                // 读取 userMap, usersIdSet, match (line 240-246)
          → await this.onEventCb('gameEnd/gameStart') // 异步回调
```

触发条件：
1. `getMatchAfter()` 网络请求耗时超过 8 秒（osu! API 慢、429 限流、网络抖动）
2. 或 `onEventCb` 回调中的渲染/发送操作耗时较长
3. 以上任一条件导致 `listen()` 在下一个 `setInterval` 触发时仍未完成

正常情况下应该发生：
- 每次 `listen()` 完成后才开始下一次轮询

当前代码实际发生：
1. 第 N 次 `listen()` 在 `await getMatchAfter()` 处挂起
2. 8 秒后 `setInterval` 触发第 N+1 次 `listen()`
3. 第 N+1 次 `listen()` 的 `getMatchAfter()` 返回后，修改 `this.nowEventId`、`this.nowGameId`、`this.match`、`this.usersIdSet`、`this.userMap`
4. 第 N 次 `listen()` 恢复执行，基于已被第 N+1 次修改的状态做判断（line 183: `if (this.nowEventId === newMatch.latest_event_id) return`）
5. 结果：同一事件可能被处理两次，或事件被跳过，或 `handleEvent` 读取到不一致的 `userMap`

为什么现有保护无法阻止：
- `listen()` 入口的 `if (this.stopped) return`（line 174）只检查停止标志，不检查是否已有 `listen()` 在运行
- 没有 `listening` 守卫标志
- `setInterval` 不关心回调是否已完成

最终后果：
- 同一比赛事件被重复处理并推送到 QQ 群
- 或事件被跳过（`nowEventId` 被提前推进）
- `handleEvent` 中读取的 `userMap` 可能处于不一致状态（部分用户被移除/添加）
- 比赛面板重复渲染或遗漏

复现思路：
- 启动比赛监听 `!ml <matchID>`
- 在 osu! API 响应慢时（可通过网络模拟工具延迟 API 响应至 >8s）观察是否出现重复推送

最小修复方向：
- 将 `setInterval` 改为 `setTimeout` 链式调用：`listen()` 完成后再调度下一次
- 或在 `listen()` 入口添加 `listening` 守卫标志，如果已在运行则跳过

需要增加的测试：
- 模拟 `getMatchAfter` 延迟 >8s，验证不会出现重复事件处理
- 验证 `stop()` 在 `listen()` 运行中时能正确终止

---

## 3. B — 有实际风险但需运行时确认

### B1. relationshipProfile.ts `.then()` 回调中 `updateDb` 失败导致锁永久持有

严重程度：**Medium**

文件 + 行号：`server/bot/relationshipProfile.ts:81-86`

相关代码：

```typescript
void updateRelationshipProfile(updated, parsed.groupId, parsed.userA, parsed.userB)
  .then((result) => {
    if (result.ok) {
      updateDb((draft) => {                                    // ← 可能抛出
        if (draft.pendingPairCounts) draft.pendingPairCounts[pKey] = 0;
      });
    }
    autoUpdateLock.delete(pKey);                               // ← 如果上面抛出则不执行
  })
  .catch(() => { autoUpdateLock.delete(pKey); });
```

完整调用链：
```
incrementPairPending() → readDb() → 阈值检查 →
  void updateRelationshipProfile().then(result => {
    updateDb(...)           // 如果文件锁超时或磁盘满，抛出异常
    autoUpdateLock.delete() // 不执行
  }).catch(() => {
    autoUpdateLock.delete() // 执行，锁被释放
  })
```

触发条件：
- `updateRelationshipProfile` 成功返回（不走 `.catch()`）
- 但 `.then()` 回调中的 `updateDb` 抛出异常（文件锁超时、磁盘满、JSON 序列化失败）

正常情况下应该发生：
- 画像更新成功后重置 pending 计数，释放锁

当前代码实际发生：
- `updateDb` 抛出 → `.then()` 返回的 Promise reject → `.catch()` 捕获 → `autoUpdateLock.delete(pKey)` 执行

经过二次验证：`.catch()` 确实能捕获 `.then()` 回调中的异常。**锁不会永久持有**。

**结论：已排除。** 二次验证确认 `.catch()` 覆盖了 `.then()` 回调的异常路径。降级为理论风险：仅在 `.catch()` 回调本身也抛出时才会锁泄漏，但 `.catch()` 回调只有一行 `autoUpdateLock.delete(pKey)`，Set.delete 不会抛出。

### B2. fire-and-forget `void maybeUpdateMemoryProfile()` 中 `updateDb` 在 catch 块内可能抛出

严重程度：**Low**

文件 + 行号：`server/bot/memory.ts:1148-1201`，调用点 `server/bot.ts:479`

相关代码：

```typescript
// memory.ts:1148-1201
export async function maybeUpdateMemoryProfile(event) {
  memoryUpdateInFlight.add(userId);
  try {
    const result = await updateMemoryProfile(db, memory);
    // ...
  } catch (error) {
    // ...
    updateDb((draft) => {     // ← 如果 updateDb 内部抛出
      target.lastProfileAttemptAt = nowIso();
      // ...
    });
  } finally {
    memoryUpdateInFlight.delete(userId);  // ← 如果 catch 中 updateDb 抛出，这里仍执行
  }
}
```

触发条件：
- `updateMemoryProfile` 失败（进入 catch）
- catch 块中的 `updateDb` 也失败（文件锁超时 200 次重试后抛出）

正常情况下应该发生：
- 画像更新失败时记录错误到 DB，释放 `memoryUpdateInFlight` 锁

当前代码实际发生：
- `updateDb` 抛出 → 异常从 catch 块逃逸 → `finally` 仍执行（锁释放）→ 异常传播到 `void` 调用方 → 全局 `unhandledRejection` handler 捕获 → `process.exit(1)`

为什么现有保护无法完全阻止：
- `finally` 确保锁释放（正确）
- 但异常逃逸到全局 handler 导致进程退出

最终后果：
- 进程崩溃后由 PM2/批处理脚本重启
- 非致命但代价过高（一个非关键的记忆更新失败导致整个机器人停机）

需要确认：
- 生产环境是否使用 PM2 或类似进程管理器
- `updateDb` 文件锁在实际运行中是否真的会超时

### B3. match.ts `onAllEvent` 中多个 `handleEvent` 并发执行无排序保证

严重程度：**Low-Medium**

文件 + 行号：`server/osu/match.ts:215-229`

相关代码：

```typescript
private onAllEvent(events: OsuMatchEvent[]): void {
  const gameEvents = events.filter((e) => e.game != null);
  if (gameEvents.length === 0) return;
  if (gameEvents.length > 1) {
    const abortGames = gameEvents.slice(0, -1);
    for (const event of abortGames) {
      const game = event.game!;
      if (game.end_time != null) {
        void this.handleEvent(event);           // ← fire-and-forget，async
      } else {
        void this.onEventCb('gameAbort', ...);  // ← fire-and-forget
      }
    }
  }
  void this.handleEvent(gameEvents[gameEvents.length - 1]);  // ← fire-and-forget
}
```

触发条件：
- 一次 API 返回包含多个 game 事件（快速连续开局/结束）
- `handleEvent` 内部的 `onEventCb` 回调（渲染面板）耗时不同

当前代码实际发生：
- 多个 `handleEvent` 并发执行，谁先完成 `await this.onEventCb(...)` 不确定
- 如果第一个是 `gameEnd`、最后一个是 `gameStart`，但 `gameEnd` 的渲染更慢，则 QQ 群可能先收到 `gameStart` 面板再收到 `gameEnd` 面板

需要确认：
- `handleListenerEvent` 中是否有基于 `eventId` 的排序或去重

### B4. osu/commands.ts `drainQueue()` 未 await 调用

严重程度：**Low**

文件 + 行号：`server/osu/commands.ts:1316`

相关代码：

```typescript
return new Promise((resolve) => {
  queue.push({ event, sendMessage, target, mode, userId, groupId, resolve });
  if (!running) drainQueue();    // ← 未 await
});
```

触发条件：
- `drainQueue` 在第一个 `await` 之前同步抛出（理论上不会，因为 while 循环和 shift 不会抛出）

需要确认：
- `drainQueue` 内部是否有任何在第一个 await 之前可能抛出的同步代码

经过验证：`drainQueue` 的第一个操作是 `while (queue.length > 0)` 和 `queue.shift()`，均为安全的同步操作。第一个 `await` 在 `runAnalysis()` 处。**已排除同步抛出风险。**

但 `drainQueue` 是 async 函数，如果 `runAnalysis` 或 `sendAsReply` 抛出异常未被内部 catch 捕获，会成为 unhandled rejection。经过验证：`drainQueue` 有完整的 try/catch/finally 结构，所有路径都被覆盖。**已排除。**

---

## 4. D — 当前无法判断

### D1. osu! API 429 时 match.ts 轮询行为

无法判断：当 osu! API 返回 429 时，`getMatchAfter` 抛出异常，`listen()` 的 catch 块调用 `void this.onEventCb('error', ...)`。无法从当前代码判断：连续 429 时是否会触发 osu! API 的封禁机制，以及 match listener 是否应该退避。

### D2. concurrent `updateDb` 在高消息频率下的文件锁等待时间

无法判断：`withDbLock` 最多重试 200 次（每次 sleepSync 25ms = 最长 5 秒）。在高消息频率下（多群多用户同时触发），文件锁等待可能接近上限。需要运行时日志确认实际锁等待时间。

### D3. renderServer 的 WebSocket 渲染客户端在高并发下的行为

无法判断：`renderServer.ts` 使用 round-robin 分配渲染任务。如果渲染客户端处理速度慢于任务到达速度，任务可能积压。需要运行时监控确认。

---

## 5. A — 重要的已排除嫌疑

### A1. osu/auth.ts token refresh 并发安全

**初始怀疑**：多个并发 401 可能导致重复 token 刷新。

**排除原因**：`refreshPromise` 模式正确实现了并发合并。当 `refreshPromise` 非空时，所有并发调用都 await 同一个 Promise。`.then()` 回调设置 `currentToken` 和清除 `refreshPromise`，`.catch()` 清除 `refreshPromise` 并重新抛出。在 Node.js 单线程模型中，`.then()` 回调的执行是原子的（在同一个微任务中），不存在两个回调同时修改 `currentToken` 的情况。

### A2. store.ts `updateDb` 并发安全

**初始怀疑**：两个并发 `updateDb` 可能导致 lost update。

**排除原因**：`updateDb` 使用 `withDbLock` 文件锁，锁内执行 read-modify-write 原子操作。文件锁基于 `fs.openSync('wx')`（排他创建），加上 PID 检测和 stale 锁清理。同一进程内的并发 `updateDb` 调用会串行化（第二个等待第一个释放锁）。`readDb` 不需要锁（读取的是已原子写入的完整 JSON 文件）。

### A3. bot/queue.ts 回复队列锁安全

**初始怀疑**：`queueState.locked` 可能被提前释放或并发修改。

**排除原因**：`locked` 在 `processIncoming` 的 `finally` 块中通过 `drainReplyQueue` 释放。`drainReplyQueue` 在队列为空时设置 `locked = false` 并删除队列 key。由于 Node.js 单线程，`locked` 的检查和设置在同一微任务中完成，不存在竞态。`drainReplyQueue` 本身有 try/catch 保护。

### A4. bots/executor.ts `pendingBotCalls` 并发安全

**初始怀疑**：`registerPendingBotCall` 和 `tryResolveBotResponse` 可能并发修改 Map。

**排除原因**：`registerPendingBotCall` 同步创建 entry 并加入 Map，`tryResolveBotResponse` 同步查找并调用 `finishPendingBotCall`。`finishPendingBotCall` 有 identity 检查（`if (current !== entry) return`）防止过期 entry 的误操作。所有操作在同一微任务中完成。timeout 和 settleTimer 的 `clearTimeout` 在 `finishPendingBotCall` 中统一处理。

### A5. bots/executor.ts `inFlightRecommends` 并发安全

**初始怀疑**：并发的 recommend 请求可能重复执行。

**排除原因**：使用 Promise 本身作为去重 key（line 631: `inFlightRecommends.get(recommendKey) === run` identity check）。第二个相同请求 await 同一个 Promise，不重复执行。`finally` 块只删除自己创建的 entry（identity 匹配）。

### A6. onebot.ts 重连与消息处理竞争

**初始怀疑**：`connectOneBot` 时旧连接的 message handler 可能仍在执行。

**排除原因**：`connectOneBot` 先 `ws.removeAllListeners()` 再 `ws.close()`。`removeAllListeners` 确保旧连接不再触发新的 handler。已在执行的 handler 会继续完成（它们的 `handleOneBotEvent` 调用是独立的 async 函数）。旧 handler 完成后不会写入错误状态（因为 `connectionStatus` 和 `syncHealth` 基于最新的连接状态）。

### A7. bot.ts `thinkingTimer` 生命周期

**初始怀疑**：`thinkingTimer` 可能在 `finally` 块之后仍然触发。

**排除原因**：`thinkingTimer` 在 `finally` 块中被 `clearTimeout`（line 998-999）。`sendThinking` 函数有 `thinkingSent` 守卫（line 723: `if (thinkingSent || !sendMessage) return`），即使 timer 在 `clearTimeout` 之前触发，`sendThinking` 也不会重复发送。

### A8. osu/recommender.ts timeout timer 泄漏

**初始怀疑**：`timeout()` 函数中的 `setTimeout` 在 Promise race 结果确定后不会被清除。

**排除原因**：这确实是 timer 泄漏（timer 在 race 胜出后仍然排队），但不是 bug：
1. timer 触发后创建的 rejection 被 `withTimeout` 的 `catch` 吞掉（返回 null）
2. 不影响功能正确性
3. Node.js 会在 timer 触发后 GC 相关闭包
4. 在高并发下（20 个 worker × 每个 2 次 timeout 调用 = 40 个 dangling timer），资源浪费有限

标记为"已知但可接受的浪费"，不列为 bug。

---

## 6. 共享状态竞争地图

| 状态 | 定义位置 | 写入方 | 读取方 | 并发保护 | 结论 |
|------|----------|--------|--------|----------|------|
| `ws` | onebot.ts:19 | connectOneBot | connectOneBot, shutdownOneBot | 单写者（connectOneBot 入口清理旧值） | **安全** |
| `reconnectTimer` | onebot.ts:20 | scheduleReconnect, connectOneBot | scheduleReconnect, connectOneBot | 守卫 `if (reconnectTimer) return` | **安全** |
| `reconnectEnabled` | onebot.ts:21 | connectOneBot | scheduleReconnect | 单写者 | **安全** |
| `statusProbeTimer` | onebot.ts:22 | ensureStatusProbe, shutdownOneBot | ensureStatusProbe | 守卫 `if (statusProbeTimer) return` | **安全** |
| `statusSampleTimer` | onebot.ts:23 | ensureStatusProbe, shutdownOneBot | ensureStatusProbe | 同上 | **安全** |
| `connectionStatus` | onebot.ts:25+ | open/message/close/error handlers, probeGetStatus | syncHealth | Node 单线程，同步操作 | **安全** |
| `state` (health) | health.ts:4 | 18+ setter 函数 | getHealth, statusSummary | Node 单线程，同步操作 | **安全** |
| `recalcState` | health.ts:189 | startRecalc, tickRecalc, stopRecalc, finishRecalc | getRecalcProgress | Node 单线程 | **安全** |
| `replyQueues` | queue.ts:94 | getQueueState, drainReplyQueue | getQueueState, getReplyQueueStats | locked 标志 + 单线程 | **安全** |
| `recentInboundEvents` | queue.ts:64 | claimInboundEvent | claimInboundEvent | 单线程，同步操作 | **安全** |
| `memoryUpdateInFlight` | memory.ts:15 | maybeUpdateMemoryProfile | maybeUpdateMemoryProfile, maybeSweepDueMemoryProfiles | 守卫 `if (has) return` + finally delete | **安全** |
| `profileLlmCircuit` | memory.ts:17 | maybeUpdateMemoryProfile | maybeUpdateMemoryProfile | 单线程，同步检查 | **安全** |
| `autoUpdateLock` | relationshipProfile.ts:11 | incrementPairPending | incrementPairPending | Set.has 守卫 + .then/.catch delete | **安全**（经二次验证） |
| `pendingBotCalls` | executor.ts:16 | registerPendingBotCall, tryResolveBotResponse, finishPendingBotCall | tryResolveBotResponse | identity check + 单线程 | **安全** |
| `inFlightRecommends` | executor.ts:36 | executeToolCall | executeToolCall | Promise identity check | **安全** |
| `renderedPanelCache` | render.ts:24 | renderBestScoresList | renderBestScoresList | 单线程，同步操作 | **安全** |
| `queue` (osu analyze) | osu/commands.ts:76 | handleOsuAnalyze, drainQueue | handleOsuAnalyze, drainQueue | running 标志 + 单线程 | **安全** |
| `running` (osu analyze) | osu/commands.ts:77 | drainQueue | handleOsuAnalyze, drainQueue | 单线程 | **安全** |
| `currentToken` | osu/auth.ts:9 | getToken | getToken | refreshPromise 合并 | **安全** |
| `refreshPromise` | osu/auth.ts:10 | getToken | getToken | 单写者 + .then/.catch 清除 | **安全** |
| `cache` (osu TTL) | osu/cache.ts:4 | cacheSet, cacheClear | cacheGet | Node 单线程 | **安全** |
| `cache` (oracle) | osu/oracleCache.ts:18 | saveClassifications | getCachedClassifications | Node 单线程 | **安全** |
| `ppTokenCache` | osu/pplus.ts:22 | getPPlusToken, getPlayerPPlus | getPPlusToken | 并发 401 可能重复刷新（幂等） | **安全**（低风险） |
| `nowEventId` | match.ts:125 | listen() | listen(), handleEvent() | **无保护** | **BUG (C1)** |
| `nowGameId` | match.ts:124 | listen() | listen(), handleEvent() | **无保护** | **BUG (C1)** |
| `match` | match.ts:131 | listen() | listen(), handleEvent() | **无保护** | **BUG (C1)** |
| `usersIdSet` | match.ts:126 | listen() → parseUsers() | handleEvent() | **无保护** | **BUG (C1)** |
| `userMap` | match.ts:127 | listen() → parseUsers() | handleEvent() | **无保护** | **BUG (C1)** |
| `consoleAnalysesRunning` | index.ts:187 | POST handler, async IIFE | POST handler | Set.has + Set.add + finally delete | **安全** |
| `loaded` (KB) | knowledgeBase.ts:202 | 首次加载 | 所有调用 | 单次写入 + 单线程 | **安全** |
| `lastAutoBackupAt` | store.ts:78 | autoBackupIfDue | autoBackupIfDue | 单线程 | **安全** |

---

## 7. Timer / Listener / Promise 生命周期清单

### Timers

| Timer | 创建位置 | 持有引用 | 正常清理 | 错误路径清理 | 重复调用保护 | shutdown 清理 | 结论 |
|-------|----------|----------|----------|-------------|-------------|--------------|------|
| reconnectTimer | onebot.ts:42 | 模块变量 | connectOneBot 入口 clearTimeout | scheduleReconnect 守卫 | `if (reconnectTimer) return` | shutdownOneBot 关闭 WS | **安全** |
| statusProbeTimer | onebot.ts:209 | 模块变量 | shutdownOneBot clearInterval | ensureStatusProbe 守卫 | `if (statusProbeTimer) return` | shutdownOneBot clearInterval | **安全** |
| statusSampleTimer | onebot.ts:212 | 模块变量 | shutdownOneBot clearInterval | ensureStatusProbe 守卫 | 同上 | shutdownOneBot clearInterval | **安全** |
| thinkingTimer | bot.ts:745 | 局部变量 | finally clearTimeout | finally clearTimeout | 单次创建 | N/A（函数级） | **安全** |
| MatchListener.timer | match.ts:153 | 实例属性 | stop() clearInterval | stop() clearInterval | `if (this.timer) return` | stop() clearInterval | **安全**（但 setInterval 回调有 C1 问题） |
| MatchListener.killTimer | match.ts:154 | 实例属性 | stop() clearTimeout | stop() clearTimeout | — | stop() clearTimeout | **安全** |
| entry.timeout | executor.ts:149 | pendingBotCalls entry | finishPendingBotCall clearTimeout | finishPendingBotCall clearTimeout | — | 自动超时 | **安全** |
| entry.settleTimer | executor.ts:112 | pendingBotCalls entry | finishPendingBotCall clearTimeout | finishPendingBotCall clearTimeout | 先 clear 再 set | 自动超时 | **安全** |
| authTimer | renderServer.ts:107 | 闭包 | 认证成功 clearTimeout | 超时关闭 WS | — | stop() 关闭 WSS | **安全** |
| heartbeatSweep | renderServer.ts:153 | 实例属性 | stop() clearInterval | stop() clearInterval | — | stop() clearInterval | **安全** |
| overallTimer | localBridge.ts:259 | 闭包 | finish() clearTimeout | finish() clearTimeout | — | finish() 在 close/error 中调用 | **安全** |
| settleTimer | localBridge.ts:256 | 闭包 | finish() clearTimeout | finish() clearTimeout | armSettle 先 clear 再 set | finish() 调用 | **安全** |
| timeout timer (recommender) | recommender.ts:131 | 闭包 | **未清理** | 无 | — | N/A | **泄漏但无害** |
| fetchWithTimeout timer | onebot.ts:52 | 闭包 | .finally clearTimeout | .finally clearTimeout | — | N/A | **安全** |
| fetchWithTimeout timer | osu/api.ts:25 | 闭包 | .finally clearTimeout | .finally clearTimeout | — | N/A | **安全** |
| fetchWithTimeout timer | osu/pplus.ts:10 | 闭包 | .finally clearTimeout | .finally clearTimeout | — | N/A | **安全** |
| classifier kill timer | classifier.ts:117 | 闭包 | close/error handler clearTimeout | close/error handler clearTimeout | settled 守卫 | N/A | **安全** |
| search abort timer | search.ts:47 | 闭包 | finally clearTimeout | finally clearTimeout | — | N/A | **安全** |
| render abort timer | render.ts:971 | 闭包 | clearTimeout (line 973) | try/catch 包围 | — | N/A | **安全** |
| backup interval | index.ts:1228 | 无引用 | 无（进程级） | — | — | 进程退出时 | **可接受** |
| trust interval | index.ts:1231 | 无引用 | 无（进程级） | — | — | 进程退出时 | **可接受** |
| decay interval | index.ts:1233 | 无引用 | 无（进程级） | — | — | 进程退出时 | **可接受** |
| gracefulShutdown timer | index.ts:63 | 无引用 | 进程退出 | — | — | N/A | **可接受** |
| TCP probe timeout | index.ts:193 | socket | done() 中 destroy | done() 中 destroy | — | N/A | **安全** |
| autodetect timeout | index.ts:911 | 闭包 | clearTimeout | clearTimeout | — | N/A | **安全** |

### Listeners

| Listener | 创建位置 | 清理位置 | 结论 |
|----------|----------|----------|------|
| ws.on('open/message/close/error') | onebot.ts:266-310 | connectOneBot 入口 removeAllListeners + close | **安全** |
| localBridge ws.on('open/message/close/error') | localBridge.ts:261-294 | finish() 中 ws.close() | **安全**（每次调用独立 WS） |
| process.on('uncaughtException') | index.ts:43 | 无（进程级） | **安全** |
| process.on('unhandledRejection') | index.ts:49 | 无（进程级） | **安全** |
| process.on('SIGINT/SIGTERM') | index.ts:66-67 | 无（进程级） | **安全** |
| wss.on('connection') | renderServer.ts:100 | stop() 中 wss.close() | **安全** |
| python.on('close/error') | classifier.ts:87,106 | 自动（进程结束） | **安全** |
| python.stdout/stderr.on('data') | classifier.ts:84-85 | 自动（进程结束） | **安全** |

### Fire-and-forget Promises

| 调用位置 | 被调用函数 | 内部 try/catch | 全局 handler 兜底 | 结论 |
|----------|-----------|---------------|-------------------|------|
| bot.ts:479 | maybeUpdateMemoryProfile | 是（完整 catch + finally） | 是 | **安全**（除非 catch 内 updateDb 失败 → B2） |
| bot.ts:484 | maybeRecordImageMemorySummary | 是（line 577 catch） | 是 | **安全** |
| bot.ts:999 | drainReplyQueue | 是（try/catch 包围 processIncoming） | 是 | **安全** |
| groupProfile.ts:182 | maybeAutoUpdateGroupProfile | 是（try/catch + updateDb 恢复） | 是 | **安全**（除非 catch 内 updateDb 失败） |
| memory.ts:661 | maybeUpdateMemoryProfile | 同 bot.ts:479 | 是 | **安全** |
| memory.ts:1236 | maybeUpdateMemoryProfile | 同 bot.ts:479 | 是 | **安全** |
| relationshipProfile.ts:81 | updateRelationshipProfile.then.catch | .catch 覆盖 | 是 | **安全**（经二次验证） |
| match.ts:141 | this.handleEvent | 是（handleEvent 内 try/catch） | 是 | **安全** |
| match.ts:148 | this.onEventCb | 无（void 调用） | 是 | **低风险** |
| match.ts:152 | this.listen | 是（try/catch 包围） | 是 | **安全** |
| match.ts:153 | setInterval → this.listen | 同上 | 是 | **安全**（但有 C1 重入问题） |
| match.ts:166 | this.onEventCb | 无 | 是 | **低风险** |
| match.ts:179,211 | this.onEventCb | 无 | 是 | **低风险** |
| match.ts:223,225,229 | this.handleEvent / this.onEventCb | handleEvent 有 try/catch | 是 | **安全** |
| onebot.ts:210 | probeGetStatus | 是（try/catch） | 是 | **安全** |
| quickRouter.ts:447 | async IIFE | 是（try/catch） | 是 | **安全** |
| index.ts:610 | async IIFE (console analyze) | 是（try/catch + finally） | 是 | **安全** |
| index.ts:1319 | matchManager.restore | .catch 处理 | 是 | **安全** |

---

## 8. 推荐修复顺序

仅针对已确认的问题：

1. **C1 (High)**: `osu/match.ts:153` — 将 `setInterval` 改为 `setTimeout` 链式调用，或添加 `listening` 守卫标志

---

## 9. 推荐补充测试

1. **match.ts 重入测试**：模拟 `getMatchAfter` 延迟 15 秒，验证比赛事件不会被重复处理
2. **match.ts stop 并发测试**：在 `listen()` 执行过程中调用 `stop()`，验证不会产生悬挂状态
3. **updateDb 锁压力测试**：并发发送 50+ 条群消息，监控文件锁等待时间和成功率
4. **memory profile update 失败测试**：模拟 `updateDb` 在画像更新的 catch 块中失败，验证进程行为
