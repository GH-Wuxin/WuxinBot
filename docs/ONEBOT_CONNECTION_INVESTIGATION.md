# OneBot 连接故障调查报告

> 调查日期：2026-08-08
> 范围：QQ / NapCat / OneBot 连接在长期运行中出现"掉线、被踢下线、重连异常、发送失败、状态与实际连接不一致"的所有潜在代码路径
> 性质：只读调查，未修改任何代码

---

## 调查范围

逐行检查了以下文件：

| 文件 | 行数 | 职责 |
|------|------|------|
| `server/onebot.ts` | 188 | WebSocket 连接核心 |
| `server/bot.ts` | 993 | 消息处理管线 |
| `server/bot/queue.ts` | 166 | 回复队列 + 入站去重 |
| `server/bot/reply.ts` | 258 | 回复发送 |
| `server/health.ts` | 119 | 健康状态 |
| `server/index.ts` | 1285 | 启动入口 |
| `server/types.ts` | 314 | 类型定义 |
| `server/bots/localBridge.ts` | 302 | 本地 Bot 桥接 |

---

## 完整生命周期追踪

### 1. 程序启动 → OneBot 建连

```
index.ts:1262  app.listen(port, '127.0.0.1', async () => {
                   ...
                   connectOneBot();       // ← 行 1281
                   startRenderServer(8389);
               });
```

`connectOneBot()`（onebot.ts:136-188）：
```
1. reconnectEnabled = true
2. 清除已有 reconnectTimer（如果存在）
3. 从 db.settings.oneBotWsUrl 读取 WS 地址
4. 如果地址为空 → 设置 status.connected=false，return
5. 如果旧 ws 存在 → ws.removeAllListeners() + ws.close()
6. 创建新 WebSocket(url, { headers: { Authorization: ... } })
7. 注册 open/message/close/error 四个事件
```

### 2. 正常运行

```
ws.on('open')    → status.connected = true, setOneBotConnected(true)
ws.on('message') → JSON.parse → handleOneBotEvent → processIncoming
                     ↓
                   sendOneBotMessage (HTTP, 独立于 WS)
```

### 3. 连接关闭/异常 → 重连 → 恢复

```
ws.on('close') → setOneBotConnected(false)
                  status.connected = false
                  scheduleReconnect()

ws.on('error') → status.connected = false
                  setOneBotError(error.message)
                  scheduleReconnect()

scheduleReconnect():
  if (!reconnectEnabled || reconnectTimer) return;  // 守卫
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectOneBot();  // 5 秒后重连
  }, 5000);
```

---

## A. 已确认不存在问题

### A1. 重连时旧 WebSocket 是否完全失效

**结论：旧连接被正确清理。**

`onebot.ts:151-154`：
```typescript
if (ws) {
  ws.removeAllListeners();  // 移除所有事件监听
  ws.close();               // 发送 close 帧
}
```
每次 `connectOneBot()` 执行时，先移除旧连接的所有监听器，再关闭旧连接，然后才创建新连接。不会出现旧连接的 listener 残留在新连接上的情况。

### A2. close/error 是否可能重复触发重连

**结论：不会重复触发。**

`onebot.ts:25-31`：
```typescript
function scheduleReconnect() {
  if (!reconnectEnabled || reconnectTimer) return;  // 守卫：已有 timer 则跳过
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectOneBot();
  }, 5000);
}
```

当 WebSocket 异常时，Node.js `ws` 库会先触发 `error` 事件再触发 `close` 事件。两个 handler 都调用 `scheduleReconnect()`：
- 第一次调用（error handler，行186）：`reconnectTimer` 为 null → 设置 5s timer
- 第二次调用（close handler，行178）：`reconnectTimer` 已存在 → 直接 return

不会同时存在多个 reconnect timer。

### A3. reconnect timer 是否可能堆积

**结论：不会堆积。**

`connectOneBot()` 入口处（行138-141）主动清除已有 timer：
```typescript
if (reconnectTimer) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}
```
即使 `scheduleReconnect` 被多次调用，也只有一个 timer 存在。`connectOneBot` 被调用时会清除它。

### A4. 发送消息不依赖 WebSocket 连接状态

**结论：HTTP 发送独立于 WS，设计正确。**

`sendOneBotMessage`（行74-109）使用 HTTP `fetch` 发送消息，不经过 WebSocket。WS 断开时 HTTP API 仍可能可用（取决于 NapCat 进程状态）。这是有意的设计——WS 只负责接收事件，HTTP 负责发送消息。

### A5. 入站消息去重机制

**结论：设计合理，不会漏处理。**

`queue.ts:66-93`：`claimInboundEvent` 基于 `message_id` 做 10 分钟窗口去重。重连后 NapCat 可能重发已处理的消息，去重机制会正确忽略它们。

### A6. 消息队列不会无限增长

**结论：有上限和 TTL 保护。**

- `REPLY_QUEUE_LIMIT = 20`（每 group+user 对最多 20 条排队）
- `REPLY_QUEUE_TTL_MS = 180_000`（3 分钟超时丢弃）
- 超限时新消息被直接丢弃并记录决策日志

### A7. listener 不会重复注册

**结论：不会。**

`connectOneBot()` 在创建新 WS 前先 `ws.removeAllListeners()`（行152），然后新 WS 使用 `ws.on()` 注册监听。每个 WS 实例只有自己的一套 listener。不存在累积。

### A8. 并发发送安全

**结论：安全。**

`sendOneBotMessage` 是无状态的 HTTP 调用，每次调用独立读取 db、独立发起 fetch。多个并发的 `processIncoming` 可以同时调用 `sendOneBotMessage`，互不干扰。Node.js 的 HTTP 连接池会自动管理。

---

## B. 有风险但需要运行时日志才能确认

### B1. WS 断开后 health 状态可能短暂不一致

**文件**：`onebot.ts:175-179` + `health.ts:32,45-47`

**路径**：
```
NapCat 进程被 kill
  → TCP 连接中断
  → 操作系统 TCP keepalive 超时（Windows: 120秒~30分钟）
  → ws 库触发 'close' 事件
  → setOneBotConnected(false)
```

**触发条件**：NapCat 进程被强杀、网络物理断开、NapCat 崩溃但 OS 未通知

**当前行为**：在 TCP keepalive 超时之前，`status.connected` 保持 `true`，health API 报告"正常运行"，但实际已无法收到消息。

**为什么可能有问题**：用户通过 GUI 看到"正常运行"但实际机器人已不响应。

**为什么不太可能导致掉线**：这是状态报告的准确性问题，不是导致掉线的原因。WS 库最终会触发 close 事件。且由于发送用的是 HTTP，如果 NapCat 整体死了，HTTP 发送也会失败，用户会注意到。

**需要确认**：NapCat 进程重启时是否会主动关闭 WS 连接（会立即触发 close），还是只是进程消失（需要等 TCP 超时）。

### B2. 消息处理中的异步并发——可能丢失回复但不会导致掉线

**文件**：`onebot.ts:163-173`

```typescript
ws.on('message', async (data) => {
  status.lastEventAt = new Date().toISOString();
  setOneBotEvent(status.lastEventAt);
  try {
    const event = JSON.parse(data.toString());
    await handleOneBotEvent(event, sendOneBotMessage);
  } catch (error) {
    status.lastError = error.message;
    setOneBotError(error.message);
  }
});
```

**路径**：
1. 收到消息 → 解析 JSON → 调用 `handleOneBotEvent`（async）
2. `handleOneBotEvent` 调用 `processIncoming`（async，可能耗时 10-60 秒）
3. 在 LLM 处理期间，新的 WS 消息继续到达
4. 每条新消息都触发一个新的 `handleOneBotEvent` 调用（无 await 队列）

**触发条件**：LLM 调用耗时长 + 短时间内多条消息

**当前行为**：多条消息的 `processIncoming` 并发执行。回复队列（`queue.ts`）按 group+user 对做 FIFO，同一用户的连续消息会被合并。不同用户的消息并行处理。

**为什么可能有问题**：如果 LLM 调用超时或抛异常，`catch` 块只记录错误到 health，不回复用户。用户看到的是"机器人没反应"。

**为什么不会导致掉线**：错误被 catch 了，不会传播到 WS 层。

### B3. 没有 WebSocket ping/pong keepalive

**文件**：`onebot.ts`（全文）

**证据**：整个文件没有 `ws.ping()` 调用，没有设置 `ws.pingInterval`。

**触发条件**：NapCat 或中间代理有空闲超时。如果 NapCat 不发 ping 且群聊长时间无人说话，中间设备可能静默断开连接。

**为什么可能有问题**：在低活跃群中，WS 可能被中间代理静默断开，但代码不知道。

**为什么不太可能**：这是一个本地机器人（NapCat 和 Wuxin 通常运行在同一台机器上），中间通常没有反代。但如果用户通过公网连接远程 NapCat，这个问题就可能出现。

**需要确认**：实际部署场景中是否有中间网络设备。NapCat 的 WS 服务器是否主动发送 ping。

### B4. LLM 持续失败时回复队列的无意义重试

**文件**：`bot.ts:974-991`

```typescript
} catch (error) {
  updateDb((draft) => { draft.usage.errors += 1; ... });
  return { replied: false, error: error.message };
} finally {
  if (thinkingTimer) clearTimeout(thinkingTimer);
  void drainReplyQueue(replyLockKey, processIncoming);
}
```

**路径**：
1. 用户A 消息进入处理 → LLM 调用失败
2. `catch` 记录错误 → `finally` 调用 `drainReplyQueue`
3. 队列中的消息被取出，再次调用 `processIncoming`
4. 如果根本原因（如 API key 无效）未修复，再次失败

**当前行为**：队列始终被排空（不会堆积），但每条消息都会触发一次可能失败的 LLM 调用。

**为什么不会导致掉线**：错误被 catch，不会传播到 WS 层。但会产生无意义的 API 调用。

**需要确认**：是否有短路机制（连续失败 N 次后暂停处理）。

### B5. sendReplySegments 中的 sendMessage 失败不会传播

**文件**：`reply.ts:78-86`

```typescript
export async function sendReplySegments(sendMessage, event, replyText) {
  const segments = splitReplySegments(replyText).slice(0, 3);
  if (!sendMessage) return segments;
  for (let index = 0; index < segments.length; index += 1) {
    await sendMessage(event, segments[index]);
    if (index < segments.length - 1) await wait(700 + Math.floor(Math.random() * 600));
  }
  return segments;
}
```

**路径**：`sendMessage`（即 `sendOneBotMessage`）可能因为 HTTP 超时或 NapCat 返回错误而抛异常。异常会传播到 `processIncoming` 的 `catch` 块（bot.ts:974），被记录但不回复用户。

**为什么可能有问题**：如果第一段发送成功但第二段失败，用户看到不完整的回复。

**为什么不会导致掉线**：异常被 `processIncoming` 的 catch 块捕获，不影响 WS 连接。

---

## C. 存在明确代码缺陷

### C1. 没有 process.on('SIGINT'/'SIGTERM') 优雅关闭处理

**文件**：整个 `server/` 目录

**证据**：grep `process.on|SIGINT|SIGTERM|beforeExit|uncaughtException|unhandledRejection` 在所有 `.ts` 文件中返回 **0 结果**。

**触发条件**：
- 用户按 Ctrl+C
- 任务管理器结束进程
- Windows 关机
- `npm stop` 或 PM2 重启

**当前行为**：进程直接退出，WS 连接被 OS 强制关闭（不发送 close 帧），NapCat 侧需要等到 TCP 超时才知道连接断开。

**影响**：
1. NapCat 可能认为连接仍然存在，在此期间尝试通过 WS 推送事件会失败
2. 正在处理中的 LLM 请求被中断，已排队的消息丢失（但有 TTL 兜底）
3. 进程重启后，NapCat 可能需要一段时间才释放旧连接，新连接可能暂时被拒绝

**严重程度**：中等。对于本地工具来说可以接受（重启后自动重连），但不是最佳实践。

### C2. WS open 事件中没有验证连接是否真正可用

**文件**：`onebot.ts:157-161`

```typescript
ws.on('open', () => {
  status = { connected: true, lastError: '', lastEventAt: status.lastEventAt };
  setOneBotConnected(true);
  setOneBotError('');
});
```

**触发条件**：TCP 连接建立但 NapCat 的 WS 服务端尚未就绪，或认证失败但连接仍然 open

**当前行为**：只要 TCP 连接建立就标记为 `connected: true`。如果 NapCat 随后发送认证失败或协议错误，状态会通过 error handler 更新，但中间有一个时间窗口 health 显示"已连接"但实际不可用。

**为什么是缺陷**：`ws` 库的 `open` 事件只表示 TCP 握手完成和 WebSocket 升级成功，不代表应用层就绪。如果 NapCat 要求认证（某些 OneBot 实现可能在应用层验证），`open` 后立即可能收到 close。

**实际影响**：较小。当前代码在 close/error 事件中会正确更新状态。但存在一个短暂的"假连接"窗口。

### C3. 未捕获的 Promise rejection 可能导致进程崩溃

**文件**：整个 `server/` 目录

**证据**：grep `uncaughtException|unhandledRejection` 返回 **0 结果**。

**具体路径**：
- `bot.ts:489`：`void (async () => { ... })()` — 等级提升短语生成的异步 IIFE
- `bot.ts:470`：`void maybeUpdateMemoryProfile(event)` — 记忆画像更新
- `bot.ts:476`：`void maybeRecordImageMemorySummary(event, userPolicy)` — 图片记忆

这些 `void` 调用故意忽略返回值，但如果内部抛出未被 catch 的异常，在 Node.js 20+ 默认的 `--unhandled-rejections=throw` 模式下会导致进程崩溃。

**需要确认**：这些函数内部是否有完整的 try/catch。从代码看，`bot.ts:532` 有 `catch { /* non-fatal */ }`，但 `maybeUpdateMemoryProfile` 和 `maybeRecordImageMemorySummary` 的内部错误处理需要检查各自的实现。

---

## D. 无法从当前代码判断

### D1. NapCat 进程重启后的恢复逻辑

**无法判断**：NapCat 重启时是否会主动关闭已有的 WS 连接。

- 如果 NapCat 重启时发送 close 帧 → Wuxin 立即触发重连（5秒后）→ 正常恢复
- 如果 NapCat 重启时不发送 close 帧 → 需要等 TCP 超时 → 恢复延迟

`onebot.ts` 的重连逻辑本身是正确的，但恢复速度取决于 NapCat 的行为。

### D2. NapCat 是否会在 WS 重连后重发未确认的消息

**无法判断**：取决于 NapCat 的实现。

`claimInboundEvent` 的去重机制（10 分钟窗口）可以处理重发，但如果 NapCat 不重发，则断连期间的消息会永久丢失。这是 OneBot 协议层面的行为，不在 Wuxin 代码中控制。

### D3. 高频发送是否可能触发腾讯风控

**相关代码**：
- `reply.ts:83`：分段发送间隔 700-1300ms
- `bot.ts:686`：搜索进行中的提示消息
- `bot.ts:641-647`：named bot 无适配器的即时回复
- `bot.ts:654-660`：搜索不可用的即时回复

**无法判断**：腾讯的风控策略不公开。当前代码在正常聊天场景下发送频率不高（依赖 LLM 响应时间自然节流），但在以下场景可能产生突发：
1. 一个用户快速发送多条消息 → 排队后合并为一次 LLM 调用 → 一次回复
2. 多个用户同时 @ 机器人 → 并行 LLM 调用 → 并行回复

由于不同用户的回复是并行的，如果群内多人同时触发，可能短时间内发送多条消息。但 LLM 调用的延迟（10-60 秒）天然形成了时间分散。

### D4. 本地 Bot 桥接（localBridge）的并发连接是否可能导致端口耗尽

**相关代码**：`localBridge.ts:200-297` — 每次调用创建新的 WS 连接

**无法判断**：取决于系统 TCP 端口回收速度和并发调用频率。每次调用结束后 WS 正常关闭（行239），但 TIME_WAIT 状态可能积累。

---

## 关键代码路径速查表

| 路径 | 文件:行号 | 函数 | 触发条件 | 后果 |
|------|-----------|------|----------|------|
| WS 创建 | onebot.ts:155 | connectOneBot | 程序启动 / 手动连接 / 重连 | 创建新 WS 连接 |
| WS open | onebot.ts:157-161 | (anonymous) | TCP+WS 握手完成 | 标记 connected=true |
| WS message | onebot.ts:163-173 | (anonymous) | 收到 QQ 事件 | 解析→处理→可能回复 |
| WS close | onebot.ts:175-179 | (anonymous) | 连接关闭 | 标记 connected=false, 5s 后重连 |
| WS error | onebot.ts:181-187 | (anonymous) | 连接错误 | 记录错误, 5s 后重连 |
| 重连调度 | onebot.ts:25-31 | scheduleReconnect | close/error 事件 | 5s 后调用 connectOneBot |
| 旧连接清理 | onebot.ts:151-154 | connectOneBot | 重连时 | removeAllListeners + close |
| HTTP 发送 | onebot.ts:74-109 | sendOneBotMessage | 回复消息 | 独立 HTTP POST |
| HTTP 超时 | onebot.ts:33-44 | fetchWithTimeout | HTTP 请求 | 12s 超时后 abort |
| 消息去重 | queue.ts:66-93 | claimInboundEvent | 每条入站消息 | 10 分钟窗口 message_id 去重 |
| 回复排队 | bot.ts:566-596 | processIncoming | 同用户已有回复在生成 | 加入 FIFO 队列 |
| 队列排空 | queue.ts:111-149 | drainReplyQueue | 回复完成/失败 | 取出队列消息, 合并, 处理 |
| 队列超时 | queue.ts:114-133 | drainReplyQueue | 队列中消息超过 3 分钟 | 丢弃旧消息 |
| 健康状态 | health.ts:31-41 | statusSummary | /api/health 查询 | 根据 connected/paused/failures 判断 |
| 启动连接 | index.ts:1281 | connectOneBot | Express 监听成功后 | 建立首次 WS 连接 |
| 手动重连 | index.ts:855-858 | POST /api/onebot/connect | 用户点击"连接" | 调用 connectOneBot |

---

## 共享状态清单

| 变量 | 位置 | 类型 | 写入点 | 读取点 |
|------|------|------|--------|--------|
| `ws` | onebot.ts:8 | WebSocket|null | connectOneBot | connectOneBot, scheduleReconnect |
| `reconnectTimer` | onebot.ts:9 | Timeout|null | scheduleReconnect, connectOneBot | scheduleReconnect, connectOneBot |
| `reconnectEnabled` | onebot.ts:10 | boolean | connectOneBot | scheduleReconnect |
| `status` | onebot.ts:11-15 | object | open/close/error/message handlers | getOneBotStatus |
| `state.onebot` | health.ts:5 | object | setOneBotConnected/Event/Error | getHealth, statusSummary |
| `state.sendMessage` | health.ts:6 | object | recordSendSuccess/Error | getHealth |
| `replyQueues` | queue.ts:94 | Map | getQueueState, drainReplyQueue | getQueueState, getReplyQueueStats |
| `recentInboundEvents` | queue.ts:64 | Map | claimInboundEvent | claimInboundEvent |

---

## 最值得增加的运行时观测点

以下列出不修改代码的前提下，最有价值的运行时观测点，按优先级排序：

1. **WS 连接生命周期事件日志**：在 `open`/`close`/`error` 事件中添加 `console.log`，记录连接建立时间、关闭原因（code + reason）、错误消息。目前这些事件只更新内存状态，没有持久化日志。

2. **重连计数器**：记录累计重连次数和最近一次重连时间。当前 `reconnectTimer` 是纯控制变量，没有统计信息。

3. **WS close code 和 reason**：`ws.on('close', (code, reason) => ...)` 当前没有捕获 close code。不同的 code 含义不同（1000=正常关闭，1001=服务端关闭，1006=异常关闭）。

4. **sendOneBotMessage 的 HTTP 响应时间**：当前只记录成功/失败，没有记录延迟。长时间的 HTTP 响应可能表明 NapCat 过载。

5. **processIncoming 的端到端延迟**：从消息到达到回复发送完成的总耗时。当前 `commandLogs` 记录了命令延迟，但普通聊天消息没有。

6. **replyQueues 的活跃队列数量和深度**：`getReplyQueueStats()` 已经存在但只在 API 中暴露，没有定时采样或日志。

7. **LLM 调用失败的连续计数**：`health.ts` 有 `recentFailures` 但没有连续失败阈值告警。

8. **WS 消息到达速率**：统计每分钟收到的 WS 消息数量，用于检测异常流量或连接问题。
