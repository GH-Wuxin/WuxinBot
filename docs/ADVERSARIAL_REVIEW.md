# External Bot Response Correlation / Bridge-Fallback Target Consistency 复审

> 审计日期：2026-08-08
> 项目：Wuxin / QQ-AI-ChatBot
> 性质：只读对抗性复审，未修改任何代码
> 目标：主动尝试推翻上一份报告的两个"已排除"结论

---

## External Bot Response Correlation 复审

### 实际 correlation 机制

`tryResolveBotResponse`（executor.ts:164-232）的匹配逻辑：

1. 从 event 中提取 senderQq、eventChannel、eventGroupId
2. 在 registry 中查找 QQ 号匹配的已启用 Bot
3. 在 pendingBotCalls 中查找匹配 botId/channel/groupId 的最旧 entry
4. **没有使用 correlationId 做 response 匹配**
5. **没有 generation 计数器**
6. **没有 tombstone / stale response 抑制窗口**
7. **没有 minimum response timestamp**

correlationId 只用于：
- Map 的 key（entry identity）
- finishPendingBotCall 的 identity check（line 86-87）

外部 Bot 通过 QQ 返回消息时，**不会携带 correlationId**。系统只能通过 sender QQ + channel + groupId 来猜测"这条消息属于哪个 pending request"。

### routeBusy 生命周期

```typescript
// executor.ts:128-134
const routeBusy = [...pendingBotCalls.values()].some((pending) =>
  pending.botId === botId &&
  pending.channel === channel &&
  (channel !== 'qq_group' || String(pending.groupId || '') === String(groupId || ''))
);
if (routeBusy) {
  throw new Error(`bot_route_busy: ...`);
}
```

routeBusy 检查的是 `pendingBotCalls` Map 中是否已有同 route 的 entry。

**routeBusy 解除时机**：`finishPendingBotCall` 执行 `pendingBotCalls.delete(entry.correlationId)` 时（line 90）。

`finishPendingBotCall` 在以下情况被调用：
1. timeout timer 触发（line 149）
2. image 收到时立即调用（line 222-223）
3. settle timer 触发（line 112）

**关键**：routeBusy 只保证"本地 pending 不重叠"，不能保证"远端 response 生命周期不重叠"。外部 Bot 可能在 entry 被删除后才发送响应。

### 超时后 late response 测试

#### Case A: A timeout → B registered → A late image

**输入**：
- 外部 Bot "ext_bot"（QQ: "999"）
- 群 "123"

**时序**：

```
T0: registerPendingBotCall({correlationId: "A", botId: "ext_bot", channel: "qq_group", groupId: "123"})
    → routeBusy = false（Map 空）
    → entryA 加入 Map
    → entryA.timeout = setTimeout(20s)

T1: 20s → entryA.timeout 触发
    → finishPendingBotCall(entryA, true)
    → pendingBotCalls.delete("A") → Map 空
    → promiseA.resolve({ok: false, error: "机器人响应超时"})

T2: registerPendingBotCall({correlationId: "B", botId: "ext_bot", channel: "qq_group", groupId: "123"})
    → routeBusy 检查 Map → 空 → false
    → entryB 加入 Map

T3: 外部 Bot 对 A 的迟到响应到达（图片）
    → tryResolveBotResponse(db, {userId: "999", groupId: "123", images: [...]})
    → candidateBots 找到 ext_bot（QQ 匹配）
    → pendingBotCalls 过滤 → entryB 匹配（同 botId/channel/groupId）
    → entryB.images.push(A 的图片)
    → entryB.images.length > 0 → finishPendingBotCall(entryB)
    → promiseB.resolve({ok: true, images: [A 的图片]})
```

**结果**：**FAIL** — promiseB 被 A 的迟到图片 resolve。

**用户可观察表现**：用户发了两个命令（A 和 B），B 的结果显示的是 A 的数据。

**为什么上一份报告的排除逻辑不成立**：

上一份报告说"routeBusy 保证同时只有一个 pending call"。这是正确的，但它回答的是错误的问题。routeBusy 防止的是 T2 时 Map 中有两个 entry。它不能防止 T3 时 A 的迟到响应被 B 认领。

**这是一个明确 Bug。**

---

#### Case B: A timeout → 无 B → A late response

**时序**：

```
T0: entryA 注册
T1: A timeout → entryA 删除 → promiseA reject
T2: 外部 Bot 对 A 的迟到响应到达
    → tryResolveBotResponse()
    → pendingBotCalls 为空 → 返回 false
    → handleOneBotEvent 中 resolved = false
    → 消息进入 processIncoming（正常聊天管线）
    → looksLikeExternalBotSender() 检查发送者 QQ
    → 如果 QQ 在 externalBotQqs 中 → 消息被标记为外部 Bot，记录但不回复
```

**结果**：**PASS** — 迟到响应被正常管线过滤，不产生副作用。

---

#### Case C: A timeout → B registered → A progress message late arrival

**时序**：

```
T0: entryA 注册，发送 "!bp PlayerA" 到外部 Bot
T1: 外部 Bot 回复 "正在查询…"（progress）
    → entryA.textParts.push({text: "正在查询…", progress: true})
    → schedulePendingSettlement(entryA, 10000)  // progress settle 10s
T2: 20s timeout → finishPendingBotCall(entryA) → entryA 删除
    （此时 settle timer 已被 finishPendingBotCall 清除）
T3: entryB 注册
T4: 外部 Bot 对 A 的第二段响应到达（"查询完成"）
    → tryResolveBotResponse() 找到 entryB
    → entryB.textParts.push({text: "查询完成", progress: false})
    → schedulePendingSettlement(entryB, 1200)  // text settle 1.2s
T5: 1.2s 后 settle timer → finishPendingBotCall(entryB)
    → promiseB.resolve({ok: true, text: "查询完成"})
```

**结果**：**FAIL** — B 被 A 的迟到文本 resolve。

**注意**：如果 A 的进度消息在 T1 时到达，它会被加入 entryA 的 textParts。但 entryA 在 T2 被删除时，这些数据也被丢弃了。T4 时到达的是 A 的新消息，它被加入 entryB。

---

#### Case D: A timeout → B registered → A image late arrival（最重要）

**时序**：

```
T0: entryA 注册，发送 "!bp PlayerA"
T1: A timeout → entryA 删除
T2: entryB 注册，发送 "!bp PlayerB"
T3: 外部 Bot 返回 A 的 BP 面板图片
    → tryResolveBotResponse() 找到 entryB
    → entryB.images.push(A 的图片)
    → entryB.images.length > 0 → finishPendingBotCall(entryB)
    → promiseB.resolve({ok: true, images: [A 的 BP 面板]})
```

**结果**：**FAIL** — B 的 promise 被 A 的图片立即 resolve。

**用户可观察表现**：用户查 PlayerB 的 BP，看到的是 PlayerA 的 BP 面板。

**这是最严重的场景**，因为 image 会立即 finish（line 222-223），不经过 settle timer。

---

#### Case E: A timeout → B registered → A late → B correct response

**时序**：

```
T0-T2: 同 Case D
T3: A 的图片到达 → B 被 resolve → promiseB 返回 A 的数据
T4: B 的真实响应到达
    → tryResolveBotResponse()
    → pendingBotCalls 中无 entry（B 已被 resolve 并删除）
    → 返回 false
    → 消息进入 processIncoming → 被 looksLikeExternalBotSender 过滤
```

**结果**：**FAIL** — B 收到了 A 的数据，B 自己的真实响应被丢弃。

---

#### Case F: A 正常 resolve → A 第二段/图片迟到 → B 已建立

**时序**：

```
T0: entryA 注册
T1: 外部 Bot 返回 A 的文本 "正在渲染面板…"
    → entryA.textParts.push({text: "正在渲染面板…", progress: false})
    → schedulePendingSettlement(entryA, 1200)  // text settle 1.2s
T2: 1.2s 后 settle timer → finishPendingBotCall(entryA)
    → promiseA.resolve({ok: true, text: "正在渲染面板…"})
    → entryA 从 Map 删除
T3: entryB 注册
T4: 外部 Bot 返回 A 的面板图片（延迟 3 秒）
    → tryResolveBotResponse() 找到 entryB
    → entryB.images.push(A 的图片)
    → finishPendingBotCall(entryB)
    → promiseB.resolve(A 的图片)
```

**结果**：**FAIL** — settle timer 的 1.2 秒窗口不足以保证所有响应都结束。

**关键发现**：`textSettleMs`（默认 1.2 秒）假设"1.2 秒内没有新消息 = 响应结束"。但外部 Bot 可能先发文字再发图片，中间间隔超过 1.2 秒。

---

### 多段 response 生命周期测试

**text → image**：

```
T0: entryA 注册
T1: Bot 返回文本 "查询完成" → settle timer 1.2s
T2: 1.2s → finishPendingBotCall(entryA) → resolve with text only
T3: Bot 返回图片（延迟 2 秒）
    → entryA 已删除 → tryResolveBotResponse 返回 false
    → 进入 processIncoming → 被过滤
```

**结果**：A 收到文本但丢失图片。不是 stale response 污染问题，但仍是数据丢失。

**progress → text → image**：

```
T0: entryA 注册
T1: Bot 返回 "正在查询…"（progress）→ settle timer 10s
T2: Bot 返回 "查询完成" → 替换 settle timer → 1.2s
T3: 1.2s → finishPendingBotCall(entryA) → resolve with text
T4: Bot 返回图片 → entryA 已删除 → 进入 processIncoming → 被过滤
```

**结果**：同上，图片丢失。

**image → delayed caption**：

```
T0: entryA 注册
T1: Bot 返回图片 → finishPendingBotCall(entryA) → 立即 resolve
T2: Bot 返回文字说明 → entryA 已删除 → 进入 processIncoming → 被过滤
```

**结果**：图片正确获取，文字说明丢失（通常可接受）。

---

### correlationId 的真实作用

`correlationId` 的唯一实际用途：

1. `pendingBotCalls` Map 的 key（line 150）
2. `finishPendingBotCall` 的 identity check（line 86-87）
3. `cancelPendingBotCall` 的查找（line 155）

**它不用于 response correlation。** 外部 Bot 通过 QQ 返回消息时，不会携带 `correlationId`。系统通过 sender QQ + channel + groupId 匹配响应。

`correlationId` 的格式 `${botId}_${Date.now()}_${random}` 看起来像 correlation token，但实际上只是 Map key。

---

## Bridge / Fallback Target Consistency 复审

### 命令语义矩阵

| 命令 | 用户输入 | 请求者 binding | @ binding | 显式 username | Bridge command | Bridge 目标 | Fallback username | Internal 目标 |
|------|----------|---------------|-----------|---------------|----------------|-------------|-------------------|---------------|
| `!p` | `!p` | PlayerA | — | — | `where PlayerA` | PlayerA | "" → resolver 用 binding | PlayerA ✓ |
| `!bp` | `!bp` | PlayerA | — | — | `!bp PlayerA` | PlayerA | "" → resolver 用 binding | PlayerA ✓ |
| `!bp B` | `!bp PlayerB` | PlayerA | — | PlayerB | `!bp PlayerB` | PlayerB | "PlayerB" | PlayerB ✓ |
| `!bp B 1-10` | `!bp PlayerB 1-10` | PlayerA | — | PlayerB | `!bp PlayerB 1-10` | PlayerB | "PlayerB" + bpSelection | PlayerB ✓ |
| `~` | `~` | PlayerA | — | — | `where PlayerA` | PlayerA | "" → resolver 用 binding | PlayerA ✓ |
| `查@B` | `查@B` | PlayerA | PlayerB | — | `where PlayerB` | PlayerB | resolveAtBinding(@B) | PlayerB ✓ |
| `!bp @B` | `!bp @B` | PlayerA | PlayerB | — | `!bp PlayerB` | PlayerB | @B binding → "PlayerB" | PlayerB ✓ |
| `!p` | `!p` | 无绑定 | — | — | 早期 return unbound | — | 早期 return unbound | — ✓ |
| `!bp B` | `!bp PlayerB` | 无绑定 | — | PlayerB | `!bp PlayerB` | PlayerB | "PlayerB" | PlayerB ✓ |
| `!bp` | `!bp` | 无绑定 | — | — | 早期 return unbound | — | 早期 return unbound | — ✓ |

### 场景 A: 请求者绑定 PlayerA，显式目标 PlayerB

**Bridge 路径**（quickRouter.ts:541-563）：
1. `parsedArgs = parseOsuArgs(def, "PlayerB")` → `{ username: "PlayerB" }`
2. `parsed.username = "PlayerB"` → 不为空，跳过 binding 解析
3. `bridgeUser = "PlayerB"`
4. `bridgeCommand = "!bp PlayerB"`
5. Bridge 查询 PlayerB

**Fallback 路径**（quickRouter.ts:708-762）：
1. `parsed = parseOsuArgs(def, "PlayerB")` → `{ username: "PlayerB" }`
2. `username = "PlayerB"`
3. `executeInternalBotCommand(botId, 'bp', 'PlayerB', context, bpSelection)`
4. `resolveInternalPlayerTarget(db, userId, "PlayerB", extra)` → 检查 "PlayerB" 是否匹配请求者 binding（PlayerA）→ 不匹配 → 使用 "PlayerB" 作为显式用户名
5. Internal 查询 PlayerB

**结果**：**PASS** — 两边都是 PlayerB。

### 场景 B: 请求者绑定 PlayerA，@PlayerB

**Bridge 路径**：
1. `parsedArgs.username = ""` → 空
2. `resolveInjectionUser(db, atTargets[0])` → PlayerB 的 binding → "PlayerB"
3. `bridgeUser = "PlayerB"`
4. `bridgeCommand = "!bp PlayerB"`

**Fallback 路径**：
1. `parsed.username = ""` → 空
2. `atTargets.length > 0` → true
3. `bindingUser(db, atTargets[0])` → PlayerB 的 binding → "PlayerB"
4. `username = "PlayerB"`
5. 查询 PlayerB

**结果**：**PASS** — 两边都是 PlayerB。

### 场景 C: 请求者绑定 PlayerA，显式 PlayerB + @PlayerC

**Bridge 路径**：
1. `parsedArgs.username = "PlayerB"` → 不为空
2. `bridgeUser = "PlayerB"`（显式用户名优先，@ 被忽略）

**Fallback 路径**：
1. `parsed.username = "PlayerB"` → 不为空
2. `username = "PlayerB"`（@ 被忽略）

**结果**：**PASS** — 两边都是 PlayerB，@ 被忽略。

### 场景 D: 请求者无绑定，显式 PlayerB

**Bridge 路径**：
1. `parsedArgs.username = "PlayerB"` → 不为空
2. `bridgeUser = "PlayerB"`
3. `bridgeCommand = "!bp PlayerB"`

**Fallback 路径**：
1. `parsed.username = "PlayerB"` → 不为空
2. `username = "PlayerB"`
3. 查询 PlayerB

**结果**：**PASS** — 两边都是 PlayerB。

### 场景 E: 请求者绑定 PlayerA，`!bp`（无参数）

**Bridge 路径**：
1. `parsedArgs = { username: "", bpSelection: { startRank: 1, endRank: 10 } }`
2. `parsed.username = ""` → 空
3. `resolveInjectionUser(db, event.userId)` → PlayerA
4. `bridgeUser = "PlayerA"`
5. `bridgeCommand = "!bp PlayerA"`

**Fallback 路径**：
1. `parsed = { username: "", bpSelection: { startRank: 1, endRank: 10 } }`
2. `username = ""` → 空
3. `atTargets.length === 0` → 跳过
4. `bindingUser(db, event.userId)` → "PlayerA" → truthy → 不进入 unbound 块
5. `username` 仍为 ""
6. `executeInternalBotCommand(botId, 'bp', '', context, { startRank: 1, endRank: 10 })`
7. 内部 resolver: `resolveInternalPlayerTarget(db, userId, '', extra)` → 请求者 binding → PlayerA

**结果**：**PASS** — 两边都是 PlayerA。

**注意**：Bridge 路径显式注入 "PlayerA" 到命令中，Fallback 路径传空字符串让内部 resolver 解析。两者最终查询同一玩家。

### Bridge resolved identity vs Fallback resolved identity

两条路径的解析机制：

| 路径 | 解析函数 | 数据源 | 解析顺序 |
|------|----------|--------|----------|
| Bridge | `resolveInjectionUser(db, qq)` | `db.osuBindings[qq]` | username → id（API 解析） |
| Fallback | `resolveInternalPlayerTarget(db, userId, username, extra)` | `db.osuBindings[userId]` | 5 级信任链 |

两者都使用 `db.osuBindings`。最终查询的 osu player identity 取决于：
- Bridge: `resolveInjectionUser` 返回的 username（或 id 解析后的 username）
- Fallback: `resolveInternalPlayerTarget` 返回的 `{kind: 'id', value}` 或 `{kind: 'username', value}`

在所有测试场景中，两者解析到同一玩家。

**唯一的理论漂移点**：如果 binding 只有 id 没有 username，Bridge 通过 `getUserById(id)` 获取 username 并缓存，而 Fallback 直接用 id 查询。如果 osu API 的 id→username 解析和 username→id 解析不一致（理论上不应该），可能导致不同结果。但这取决于 osu API 行为，不是代码 Bug。

---

## 对上一份报告的修正

### 1. "routeBusy 足以排除 stale response" 是否成立

**不成立。**

routeBusy 只保证"同一 route 同时只有一个 pending entry"。它不能防止前一个请求的 late response 被下一个请求认领。

上一份报告的错误在于混淆了两个不同的问题：
- "同一 route 同时有两个 pending"（routeBusy 确实防止）
- "前一个已 timeout 的请求的 late response 污染下一个请求"（routeBusy 不能防止）

实际保护机制缺失：
- 没有 generation 计数器
- 没有 tombstone
- 没有 stale response 抑制窗口
- correlationId 不用于 response correlation

### 2. "两边最终都使用 binding，所以 target 一致" 是否成立

**成立，但论证不充分。**

上一份报告说"最终都使用 db.osuBindings"是正确的，但论证太粗糙。正确的论证应该是：

- 对于有显式用户名的命令：两条路径都直接使用显式用户名，不经过 binding 解析
- 对于无显式用户名的命令：Bridge 通过 `resolveInjectionUser` 解析 binding，Fallback 通过 `resolveInternalPlayerTarget` 解析 binding，两者使用同一数据源
- 对于 @ 目标：Bridge 通过 `resolveInjectionUser(db, atTarget)` 解析，Fallback 通过 `bindingUser(db, atTarget)` 解析，两者使用同一数据源

### 3. 是否存在上一份报告漏掉的 response-boundary 问题

**是。**

`textSettleMs`（默认 1.2 秒）是一个基于时间窗口的 response boundary 猜测。外部 Bot 协议没有 end-of-response marker。如果 Bot 先发文字再发图片（间隔 >1.2 秒），系统会：
1. 收到文字 → settle timer 1.2s
2. 1.2s 后 finish → resolve with text only
3. 图片到达时 entry 已删除 → 图片丢失

这不是 stale response 污染问题，但仍是数据丢失。

---

## 最终 Bug 数量

### Part 1: External Bot Stale Response

**C — 明确 Bug：1**

**C1. External Bot stale response 认领下一个 pending request**

严重程度：**High**

涉及路径：`query_external_bot` 和 `query_bot`（executor.ts:677-966）

文件 + 行号：`server/bots/executor.ts:164-232`（tryResolveBotResponse），`server/bots/executor.ts:85-108`（finishPendingBotCall），`server/bots/executor.ts:117-152`（registerPendingBotCall）

确定触发条件：
1. 向外部 Bot 发送请求 A
2. A 超时（20 秒无响应）
3. 向同一 Bot 发送请求 B
4. 外部 Bot 对 A 的迟到响应（文字或图片）到达

用户可观察表现：
- 请求 B 的结果显示的是请求 A 的数据
- 如果 A 的迟到响应是图片，B 立即被 resolve（不等 B 的真实响应）
- 如果 A 的迟到响应是文字，B 被 settle timer resolve（1.2 秒或 10 秒）
- B 的真实响应被丢弃（进入正常管线被过滤）

最小修复方向：
引入 generation 计数器或 request sequence number。每个 pending entry 增加 `generation` 字段。响应到达时，只匹配当前 generation 的 entry。或者增加 `createdAt` timestamp 检查，拒绝 `response.timestamp < entry.createdAt` 的响应。

需要增加的测试：
- 注册请求 A → 超时 → 注册请求 B → 注入 A 的迟到图片 → 验证 B 不被 resolve
- 注册请求 A → 超时 → 注册请求 B → 注入 A 的迟到文字 → 验证 B 不被 resolve

---

### Part 2: Bridge / Fallback Target Consistency

**A — 已严格排除**

所有测试场景（A-E）中，Bridge 和 Fallback 最终查询同一 osu 玩家。两条路径使用同一 binding 数据源（`db.osuBindings`），解析逻辑一致。

唯一的理论漂移点（binding 只有 id 没有 username 时的解析路径差异）不影响最终结果，因为 osu API 的 id↔username 解析是一致的。
