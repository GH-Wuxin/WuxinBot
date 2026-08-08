# !ml / Match Listener 端到端专项审计

> 审计日期：2026-08-08
> 项目：Wuxin / QQ-AI-ChatBot
> 性质：只读审计，未修改任何代码
> 已知历史：此前已修复 setInterval 重入、nowEventId 回退、重复事件等并发 Bug

---

## Command Contract

| 命令 | 参数 | 实际语义 | 状态变化 | 用户输出 |
|------|------|----------|----------|----------|
| `!ml <matchId>` | 数字 ≥4 位 | 开始观战指定比赛 | 创建 DB entry + 内存 listener | 确认消息 |
| `!ml list` / `!ml l` | 无 | 列出本群观战 | 无 | 本群观战列表 |
| `!ml end` / `!ml stop` / `!ml off` | 无 matchId | 停止本群所有观战 | 删除 DB entry + 停止 listener | 已停止列表 |
| `!ml stopall` / `!ml o` | 无 | 停止全部观战（owner） | 清空 DB + 停止所有 listener | 已停止数量 |
| `!ml <matchId> #N` | matchId + skip | 开始观战，跳过最后 N 局 | 同 `!ml <matchId>` | 确认消息 |
| `!ml end <matchId>` | end + matchId | **误解析为 startListener** | 创建新 listener | 确认消息（错误） |

---

## 完整调用链

```
用户 "!ml 12345"
  → quickRouter: matchAlias → {id:'match', source:'yumu', capability:'match'}
  → quickRouter: executeInternalBotCommand('yumu', 'match', '', context)
  → executor.ts:1530: commandName === 'match'
    → matchManager.handleCommand(db, event, rawText, isOwner)
    → handleCommand: parse tokens → matchId=12345, operate='', skip=0
    → startListener(db, event, 12345, 0, isOwner)
      → 检查: 已在观战？群上限？用户上限？
      → getMatch(12345) — 获取比赛数据
      → 检查: 比赛已结束？
      → 计算 lastEventId（考虑 skip）
      → 保存 DB state
      → 创建 MatchListener(match, matchId, callback)
        → constructor: nowEventId, parseUsers, 处理当前 game
      → listener.start()
        → 检查 match.end_time → 如果已结束则 stop
        → void this.tick() — 开始轮询
        → killTimer = setTimeout(6h)
  → 返回确认消息
```

---

## Listener Identity

| 维度 | 值 | 说明 |
|------|-----|------|
| 内存 key | `matchId` (number) | `this.listeners` Map 的 key |
| DB key | `String(matchId)` | `db.osuMatchListeners` 的 key |
| 唯一性 | 同一 matchId 只有一个 listener | 新群加入时复用已有 listener |
| 多群支持 | 一个 listener 可服务多个群 | `entry.groups` 数组 |
| 群上限 | 3 个/群 | `GROUP_MAX = 3` |
| 用户上限 | 3 个/用户 | `USER_MAX = 3` |

---

## Match Event State Machine

```
构造时:
  nowEventId = match.latest_event_id
  如果 current_game_id != null:
    nowGameId = current_game_id
    nowEventId = lastGameEvent.id - 1  ← 问题点
    emit(gameStart 或 gameEnd) for lastGameEvent

轮询:
  getMatchAfter(matchId, nowEventId) → newMatch
  
  if latest_event_id < nowEventId → skip (stale)
  if latest_event_id === nowEventId → skip (no new)
  
  if current_game_id != null:
    找到 newMatch.events 中最后一个 game event
    if gameId 变了 → isAbort = true, 更新 nowGameId
    if gameEvent && nowEventId === gameEvent.id - 1 && !isAbort → skip (已处理)
    else if gameEvent → nowEventId = gameEvent.id - 1  ← 问题点
    else → nowEventId = latest_event_id
  else:
    nowEventId = latest_event_id
    nowGameId = null
  
  parseUsers, addUsers, onAllEvent
  if match.end_time → stop('MATCH_END')
```

---

## 确认的 Bug

### C1. Cursor off-by-one 导致跳过非游戏事件

严重程度：**Medium**

文件 + 行号：`server/osu/match.ts:146, 218`

相关代码：

```typescript
// 构造函数 line 146
this.nowEventId = gameEvent ? gameEvent.id - 1 : match.latest_event_id;

// listen() line 218
this.nowEventId = gameEvent.id - 1;
```

确定初始状态：
- 比赛有事件 [1..100]
- 最后一个 game event 在 id=95（gameStart）
- 之后有非游戏事件 id=96（player-joined）、id=97（player-left）等
- `current_game_id != null`（游戏进行中）

确定事件序列：
1. 构造函数：`nowEventId = 95 - 1 = 94`，emit gameStart for id=95
2. 第一次轮询：`getMatchAfter(matchId, 94)` 返回事件 [95, 96, 97, 98, 99, 100]
3. `listen()` 中：`gameEvent = id=95`（最后一个 game event）
4. 检查：`nowEventId (94) === gameEvent.id - 1 (94) && !isAbort (true)` → **return early**
5. 事件 96-100 全部被跳过

当前代码结果：非游戏事件（player-joined、player-left、host-changed）被永久跳过。

用户观察：比赛监听期间，玩家加入/退出/换房主等事件不会被处理，`userMap` 不会更新。

为什么已有保护无效：`nowEventId === gameEvent.id - 1 && !isAbort` 检查的目的是防止重复处理同一个 game event，但它也阻止了后续非游戏事件的处理。

确定性测试：
1. 创建比赛，事件 [1..100]，game event 在 id=95
2. 启动 `!ml`
3. 构造函数 emit gameStart for id=95
4. 第一次轮询返回 [95, 96, 97, 98, 99, 100]，其中 96-100 是非游戏事件
5. 验证：96-100 是否被处理

最小修复方向：将 `gameEvent.id - 1` 改为 `gameEvent.id`，使 cursor 指向已处理的 game event 本身而非它的前一个位置。这样 `getMatchAfter(matchId, gameEvent.id)` 返回的事件从 `gameEvent.id + 1` 开始，不包含已处理的 game event。

---

### C2. `!ml end <matchId>` 误解析为 startListener

严重程度：**Low-Medium**

文件 + 行号：`server/osu/match.ts:374-382`

相关代码：

```typescript
// line 374
if ((operate === 'stop' || operate === 'end' || operate === 'off') && matchId == null) {
  return this.stopByGroup(groupId);
}

// line 378-382
if (matchId == null) {
  return { text: '用法：...' };
}
return this.startListener(db, event, matchId, skip, isOwner);
```

确定初始状态：
- 群中有 match 12345 的观战

确定事件序列：
1. 用户发送 `!ml end 12345`
2. `handleCommand` 解析：`tokens = ['end', '12345']` → `matchId = 12345`, `operate = 'end'`
3. 检查 `(operate === 'end') && matchId == null` → `true && false` → **false**（跳过）
4. `matchId != null` → 进入 `startListener`
5. `startListener` 检查：match 12345 已在观战 → 返回 "已经在观战了"

当前代码结果：用户无法通过 `!ml end 12345` 停止特定比赛的观战。只能用 `!ml end` 停止本群所有观战。

用户观察：输入 `!ml end 12345` 得到 "已经在观战了" 而不是停止观战。

为什么已有保护无效：命令解析逻辑中，`operate` 和 `matchId` 的组合没有被正确处理。`operate === 'end'` 只在 `matchId == null` 时生效。

确定性测试：
1. 启动 `!ml 12345`
2. 发送 `!ml end 12345`
3. 验证：是否停止了 match 12345 的观战

最小修复方向：在 `handleCommand` 中增加 `operate && matchId != null` 的分支，当 `operate` 是 stop/end/off 且有 matchId 时，停止指定 match 的观战。

---

## B — 实际风险

### B1. 比赛结束时 eventChain 中待发送的面板可能丢失

文件 + 行号：`server/osu/match.ts:240-248`

当 `stop()` 被调用时（比赛自然结束或手动停止），`emit('matchEnd', ...)` 被追加到 `eventChain`。但 `eventChain` 中可能还有未完成的 gameEnd 渲染。

`emit` 中的检查：
```typescript
if (this.stopped && type !== 'matchEnd') return;
```

这意味着 `stop()` 之后，所有非 matchEnd 的事件都被跳过。如果最后一个 gameEnd 的渲染还在 eventChain 中等待，它会被跳过。

用户观察：比赛最后一局的成绩面板可能不会被推送。

触发条件：比赛结束时，上一局的渲染尚未完成。

### B2. 渲染/发送失败后事件永久丢失

文件 + 行号：`server/osu/match.ts:204-225`

`nowEventId` 在 `onAllEvent` 之前更新。如果 `onAllEvent` 中的渲染/发送失败（被 `emit` 的 `.catch()` 吞掉），cursor 已经前进，下一轮不会再处理该事件。

用户观察：某局成绩面板渲染失败后，该局永远不会被推送。

触发条件：renderServer 不可用、图片保存失败、QQ 发送失败。

### B3. 重启后跳过断线期间的事件

文件 + 行号：`server/osu/match.ts:618-639`

`restore()` 创建新的 `MatchListener`，使用 `getMatch(matchId)` 获取当前状态。构造函数设置 `nowEventId = match.latest_event_id`，不使用 DB 中存储的 `lastEventId`。

用户观察：Bot 重启期间发生的比赛事件不会被补发。

触发条件：Bot 重启时比赛正在进行。

---

## D — 无法确认

### D1. osu API `?after=` 参数的精确语义

无法从当前代码确认 osu API 的 `after` 参数是 exclusive（`id > after`）还是 inclusive（`id >= after`）。当前代码假设是 exclusive，但需要 API 文档或实际测试确认。

### D2. 比赛结束后 osu API 是否继续返回事件

无法确认：比赛结束后，`getMatchAfter` 是否还会返回新的事件（如 match-disbanded）。当前代码通过 `match.end_time` 检测比赛结束。

---

## A — 重要排除项

### A1. setInterval 重入（已修复）

当前代码使用 `tick()` → `listen()` 完成后再 `setTimeout` 调度下一轮。不会出现并发 `listen()`。

### A2. nowEventId 回退（已修复）

`listen()` 中有 `if (newMatch.latest_event_id < this.nowEventId) return;` 检查，防止 cursor 回退。

### A3. 重复事件（部分修复）

`nowEventId === gameEvent.id - 1 && !isAbort` 检查防止了同一个 game event 的重复处理，但引入了 C1（跳过非游戏事件）。

### A4. stop 后晚到的 API 响应（已修复）

`listen()` 中有 `if (this.stopped) return;` 检查，在 API 响应到达后再次验证 stopped 状态。

### A5. eventChain 串行副作用（已修复）

所有副作用通过 `emit()` 追加到 `eventChain` Promise chain，保证顺序执行。`.catch()` 吞掉单个失败，不影响后续事件。

### A6. stop 幂等性

`stop()` 首行 `if (this.stopped) return;` 保证幂等。多次调用不会产生多个 matchEnd 推送。

### A7. 跨群串数据

每个 matchId 只有一个 `MatchListener` 实例，所有群共享同一个 listener。事件通过 `handleListenerEvent` 分发到 `entry.groups` 中的所有群。不会出现 A 群收到 B 群比赛的数据。

---

## 内存 / DB 一致性矩阵

| 操作 | 内存 listener | DB entry | timer | 一致性 |
|------|---------------|----------|-------|--------|
| start 成功 | 创建 | 创建 | tick + killTimer | ✓ |
| start 重复 match | 复用 | 更新 groups | 不变 | ✓ |
| start API 失败 | 不创建 | 不创建 | 无 | ✓ |
| start 比赛已结束 | 不创建 | 不创建 | 无 | ✓ |
| manual stop (stopByGroup) | 删除 | 删除 | 清除 | ✓ |
| manual stop (stopAll) | 清空 | 清空 | 清除 | ✓ |
| natural match end | 删除 | 删除 | 清除 | ✓ |
| timeout (6h) | 删除 | **保留** | 清除 | ⚠️ |
| API 错误 | 保留 | 保留 | 继续 | ✓ |
| process restart | 丢失 | 保留 | 丢失 | ⚠️ |
| restore 成功 | 重建 | 保留 | 重建 | ✓ |
| restore 比赛已结束 | 不创建 | 删除 | 无 | ✓ |
| restore API 失败 | 不创建 | 删除 | 无 | ✓ |

**timeout 后 DB 保留**：`cleanup('stopped')` 不删除 DB。重启后 `restore()` 会重新创建 listener。这是设计选择（比赛可能只是暂时无新事件）。

**restart 后 lastEventId 丢失**：`restore()` 不使用 DB 中的 `lastEventId`，而是从 `latest_event_id` 开始。断线期间的事件被跳过。

---

## Cursor Commit Point

| 阶段 | 时机 | 是否可重试 |
|------|------|-----------|
| nowEventId 更新 | `listen()` 中 `onAllEvent` 之前 | 否 — cursor 已前进 |
| parseUsers | `listen()` 中 cursor 更新之后 | N/A（内存状态） |
| onAllEvent → emit | 追加到 eventChain | 否 — 失败被 `.catch()` 吞掉 |
| render/send | eventChain 中执行 | 否 — 失败后 cursor 已前进 |

当前设计是 at-most-once 语义：事件最多被推送一次，失败后不会重试。

---

## API Failure Recovery Matrix

| 错误类型 | 当前行为 | 下一轮是否恢复 | 问题 |
|----------|----------|---------------|------|
| timeout | emit('error')，继续 | 是 | 无 |
| 401 | emit('error')，继续 | 是（依赖 auth 刷新） | 无 |
| 404 | emit('error')，继续 | 是 | 无 |
| 429 | emit('error')，继续 | 是 | 无 |
| 500 | emit('error')，继续 | 是 | 无 |
| malformed JSON | emit('error')，继续 | 是 | 无 |
| network reset | emit('error')，继续 | 是 | 无 |
| 连续失败 | 每 8 秒 emit('error') | 持续重试 | 可能刷屏 |

---

## Stop / Natural End Matrix

| 场景 | matchEnd 次数 | timer 清理 | DB 清理 | eventChain 行为 |
|------|--------------|-----------|---------|-----------------|
| 自然结束 | 1 | 是 | 是 | 待发送事件被跳过 |
| 手动 stop | 1 | 是 | 是（stopByGroup） | 待发送事件被跳过 |
| stopAll | 1 per listener | 是 | 是 | 待发送事件被跳过 |
| timeout | 1 | 是 | **否** | 待发送事件被跳过 |
| 自然结束 + 手动 stop 同时 | 1（stop 幂等） | 是 | 是 | 无竞争 |
| 比赛结束后再次 stop | 1（第一次 stop 生效） | 是 | 是 | 无 |

---

## 推荐修复优先级

1. **C1 (Medium)**: `nowEventId = gameEvent.id - 1` → `gameEvent.id`，修复非游戏事件跳过
2. **C2 (Low-Medium)**: `handleCommand` 增加 `!ml end <matchId>` 的正确解析
3. **B2 (Medium)**: 考虑在渲染/发送失败时记录失败事件，允许下一轮重试
