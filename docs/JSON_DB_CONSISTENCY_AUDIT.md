# JSON DB / 状态一致性专项审计

> 审计日期：2026-08-08
> 项目：Wuxin / QQ-AI-ChatBot
> 性质：只读审计，未修改任何代码

---

## 执行摘要

| 指标 | 数值 |
|------|------|
| DB 顶层字段数 | 24 (initialDb) + 8 (动态创建) |
| readDb 调用点 | 103 |
| updateDb 调用点 | 108 |
| writeDb 调用点 | 2 (backup restore + ensureStore) |
| 直接文件写入点 | 0（已验证不存在旁路） |
| migration/normalize 路径 | 1 (normalizeDb，每次 readDb 调用) |
| retention 路径 | 1 (applyRetention，每次 updateDb/writeDb 调用) |
| reset/delete 路径 | 48 |
| 第一轮候选数 | 12 |
| 二次排除数 | 7 |
| **最终 C 类 Bug 数** | **4** |

---

## C — 明确 Bug

### C1. `clearRelationshipProfile` 不清理 `pendingPairCounts`，导致已删除画像被自动重建

严重程度：**Medium**

文件 + 精确行号：`server/bot/relationshipProfile.ts:290-297`

涉及字段：`db.relationshipProfiles`, `db.pendingPairCounts`

相关代码：

```typescript
// relationshipProfile.ts:290-297
export function clearRelationshipProfile(groupId, userA, userB) {
  const pairKey = [String(userA), String(userB)].sort().join(':');
  updateDb((draft) => {
    if (!draft.relationshipProfiles) return;
    draft.relationshipProfiles = draft.relationshipProfiles.filter(
      (p) => !(String(p.groupId) === String(groupId) && p.pairKey === pairKey)
    );
  });
  return { ok: true };
}
```

初始 DB 状态：
```json
{
  "relationshipProfiles": [{ "groupId": "123", "pairKey": "A:B", ... }],
  "pendingPairCounts": { "123:A:B": 30 }
}
```

操作步骤：
1. 用户通过 `/w relation clear @A @B` 或 GUI 删除关系画像
2. `clearRelationshipProfile` 过滤掉 `relationshipProfiles` 中的条目
3. `pendingPairCounts["123:A:B"]` 未被删除，保留值 30

代码执行路径：
```
clearRelationshipProfile()
  → updateDb: 过滤 relationshipProfiles
  → pendingPairCounts 未触碰
```

预期结果：画像和对应的 pending 计数都被清理

实际结果：画像被删除，但 `pendingPairCounts` 中的计数（30）残留

为什么已有保护无效：`clearRelationshipProfile` 只过滤 `relationshipProfiles` 数组，没有检查 `pendingPairCounts`

最终影响：
- 用户 A 和 B 继续聊天 → `incrementPairPending` 将计数从 30 继续累加
- 计数达到 25 阈值 → `maybeAutoUpdateGroupProfile` 中的逻辑触发 → 画像被自动重新生成
- 用户明确删除的画像被"复活"

确定性复现方式：
1. 让用户 A 和 B 聊天积累 pendingPairCounts 到 30
2. 通过 GUI 或命令删除关系画像
3. 让 A 和 B 再聊几条消息
4. 画像会自动重新生成

最小修复方向：`clearRelationshipProfile` 中同时删除对应的 `pendingPairCounts` 条目

应该增加的测试：删除关系画像后验证 `pendingPairCounts` 中对应 key 不存在

---

### C2. `DELETE /api/users/:groupId/:userId` 不清理关联数据，留下孤儿引用

严重程度：**Medium**

文件 + 精确行号：`server/index.ts:822-829`

涉及字段：`db.users`, `db.messages`, `db.memories`, `db.experience`, `db.groupExperience`, `db.pendingPairCounts`, `db.relationshipProfiles`, `db.commandLogs`, `db.pendingLevelUps`

相关代码：

```typescript
// index.ts:822-829
app.delete('/api/users/:groupId/:userId', (req, res) => {
  updateDb((db) => {
    db.users = db.users.filter(
      (user) => !(String(user.groupId) === String(req.params.groupId) && String(user.userId) === String(req.params.userId))
    );
  });
  res.json(ok({ db: publicDb() }));
});
```

初始 DB 状态：用户 "456" 在群 "123" 中有用户记录、消息历史、记忆条目、经验值、关系画像等

操作步骤：
1. 通过 GUI 或 API 删除用户 `123/456`
2. `db.users` 中该用户的记录被过滤掉

代码执行路径：
```
DELETE /api/users/123/456
  → updateDb: 过滤 db.users
  → 以下字段未触碰：
    - db.messages（仍包含 userId=456 的消息）
    - db.memories（仍包含 userId=456 的记忆）
    - db.experience（仍包含 "456" 的经验值）
    - db.groupExperience（仍包含 "123:456" 的经验值）
    - db.pendingPairCounts（仍包含涉及 456 的计数）
    - db.relationshipProfiles（仍包含 userA=456 或 userB=456 的画像）
    - db.commandLogs（仍包含 userId=456 的命令日志）
    - db.pendingLevelUps（仍包含 "456" 的待发送升级短语）
```

预期结果：用户记录和所有关联数据都被清理

实际结果：只有 `db.users` 中的记录被删除，其他 8 个字段中的引用全部残留

为什么已有保护无效：代码只做了 `db.users.filter(...)`，没有级联清理

最终影响：
- 孤儿消息、记忆、经验值等不会导致功能错误（它们按 userId 查找，找不到用户记录就跳过）
- 但数据库持续膨胀，包含已删除用户的历史数据
- 如果同 userId 被重新添加，旧的经验值、记忆等会"复活"

确定性复现方式：
1. 删除一个有消息历史和经验值的用户
2. 重新添加同 userId 的用户
3. 该用户的经验值、记忆等仍然存在

最小修复方向：在 `updateDb` 回调中添加级联清理（参考 `DELETE /api/groups/:groupId` 的实现）

应该增加的测试：删除用户后验证所有关联字段中无该 userId 的引用

---

### C3. `/w osu clear bind` 不清理分析缓存，解绑后仍显示旧玩家数据

严重程度：**Low-Medium**

文件 + 精确行号：`server/osu/commands.ts:1424-1435`

涉及字段：`db.osuBindings`, `db.osuAnalyses`, `db.osuRecentAnalyses`, `db.osuTypeAnalyses`, `db.osuRecommendations`, `db.osuRecommendCooldowns`

相关代码：

```typescript
// osu/commands.ts:1424-1435
async function handleClearBind(ctx: OsuCommandContext) {
  const { event, sendMessage } = ctx;
  updateDb((draft) => {
    draft.osuBindings = draft.osuBindings || {};
    delete draft.osuBindings[String(event.userId)];
  });
  const syncResult = await removeLazybotBinding(event.userId);
  // ...
}
```

初始 DB 状态：
```json
{
  "osuBindings": { "456": { "id": 12345, "username": "PlayerA" } },
  "osuAnalyses": [{ "userId": "456", "osuUserId": 12345, "text": "..." }],
  "osuRecentAnalyses": [{ "userId": "456", ... }],
  "osuRecommendCooldowns": { "12345": 1700000000000 }
}
```

操作步骤：
1. 用户执行 `/w osu clear bind`
2. `osuBindings["456"]` 被删除
3. LazyBot MariaDB 中的绑定也被删除

代码执行路径：
```
handleClearBind()
  → updateDb: delete osuBindings["456"]
  → removeLazybotBinding: 清理 LazyBot DB
  → osuAnalyses 未触碰
  → osuRecentAnalyses 未触碰
  → osuTypeAnalyses 未触碰
  → osuRecommendations 未触碰
  → osuRecommendCooldowns 未触碰
```

预期结果：绑定和所有关联的分析缓存、推荐历史都被清理

实际结果：绑定被删除，但 5 个缓存字段中的旧数据残留

为什么已有保护无效：`handleClearBind` 只删除绑定条目，没有清理关联缓存

最终影响：
- 用户重新绑定不同 osu 账号后，`/w osu recent` 等命令可能仍显示旧账号的缓存数据
- `osuRecommendCooldowns` 中旧账号的冷却记录残留，影响新绑定的推荐功能
- `osuAnalyses` 中旧账号的分析结果残留

确定性复现方式：
1. 绑定账号 A → 执行分析 → 产生缓存
2. 解绑 → 绑定账号 B
3. 查看历史分析，可能仍显示账号 A 的数据

最小修复方向：`handleClearBind` 中同时清理该 userId 的 `osuAnalyses`、`osuRecentAnalyses`、`osuRecommendCooldowns`（通过绑定的 osuUserId 查找）

应该增加的测试：解绑后验证所有缓存字段中无该 userId 的引用

---

### C4. `profileLogs` 无 retention 上限，无限增长

严重程度：**Low**

文件 + 精确行号：`server/store.ts:86-93`（`applyRetention`）+ `server/bot/profileLog.ts:39-47`

涉及字段：`db.profileLogs`

相关代码：

```typescript
// store.ts:86-93 — applyRetention
export function applyRetention(db) {
  if ((db.messages || []).length > MAX_MESSAGES) db.messages = db.messages.slice(-MAX_MESSAGES);
  if ((db.decisions || []).length > MAX_DECISIONS) db.decisions = db.decisions.slice(-MAX_DECISIONS);
  if ((db.commandLogs || []).length > MAX_COMMAND_LOGS) db.commandLogs = db.commandLogs.slice(-MAX_COMMAND_LOGS);
  if ((db.toolCallLogs || []).length > MAX_TOOL_LOGS) db.toolCallLogs = db.toolCallLogs.slice(-MAX_TOOL_LOGS);
  if ((db.adminActions || []).length > MAX_ADMIN_ACTIONS) db.adminActions = db.adminActions.slice(-MAX_ADMIN_ACTIONS);
  return db;
  // profileLogs 不在此处
}
```

```typescript
// profileLog.ts:39-47
export function writeProfileLog(entry) {
  updateDb((draft) => {
    if (!draft.profileLogs) draft.profileLogs = [];
    draft.profileLogs.push({ id: crypto.randomUUID(), ...entry, createdAt: nowIso() });
    // 只有这个位置写入，无 slice 上限
  });
}
```

初始 DB 状态：`db.profileLogs` 有 50000 条记录

操作步骤：
1. 机器人长期运行，频繁触发画像更新
2. 每次画像更新写入多条 profileLog（run_started, llm_result, patch_applied 等）
3. `profileLogs` 数组持续增长

代码执行路径：
```
writeProfileLog() → updateDb → push 到 profileLogs
applyRetention() → 不检查 profileLogs
```

预期结果：`profileLogs` 有类似其他数组的 retention 上限

实际结果：`profileLogs` 无上限，持续增长

为什么已有保护无效：`applyRetention` 只覆盖 `messages`、`decisions`、`commandLogs`、`toolCallLogs`、`adminActions`，遗漏了 `profileLogs`

最终影响：
- `db.json` 文件大小持续增长
- `publicDb()` 不暴露 `profileLogs`（GUI 不受影响），但磁盘占用增加
- 每次 `readDb()` 都要解析越来越大的 JSON

确定性复现方式：
1. 让机器人运行数周
2. 检查 `db.json` 中 `profileLogs` 数组长度

最小修复方向：在 `applyRetention` 中添加 `profileLogs` 的 retention 上限（如 5000 条）

应该增加的测试：验证 `applyRetention` 对 `profileLogs` 的裁剪

---

## B — 实际风险

### B1. `usageEvents` retention 不在 `applyRetention` 中，依赖写入点自行 slice

严重程度：**Low**

涉及字段：`db.usageEvents`

说明：`usageEvents` 在 6 个不同文件中被写入（bot.ts, bot/memory.ts, bot/groupProfile.ts, bot/relationshipProfile.ts, bot/gate.ts, ownerCommands.ts），每个写入点自行执行 `slice(-5000)`。如果任何一个写入点遗漏了 slice，该处的 usageEvents 就会无限增长。

当前状态：经验证，所有 6 个写入点都有 `slice(-5000)`。**目前安全**，但维护风险高——新增写入点时容易遗漏。

### B2. `osuAnalyses` / `osuRecentAnalyses` / `osuTypeAnalyses` retention 不在 `applyRetention` 中

严重程度：**Low**

涉及字段：`db.osuAnalyses`, `db.osuRecentAnalyses`, `db.osuTypeAnalyses`

说明：这些数组的 retention 由各自的写入点管理（osu/commands.ts 和 bots/bpTypeAnalysis.ts）。与 B1 类似，当前安全但维护风险高。

### B3. `normalizeDb` 每次 `readDb` 都执行，性能开销

严重程度：**Low**

说明：`readDb()` → `readDbUnlocked()` → `normalizeDb(JSON.parse(...))`。每次读取数据库都执行 normalizeDb，包括构建 roleMap、合并 permissions、调用 `activateModelProfile` 和 `recoverProviderProfiles`。虽然单次开销很小，但在高频读取场景下（如每条消息处理中多次 readDb），会产生不必要的重复计算。

经验证 `normalizeDb` 是幂等的：所有操作使用 `||=` 或 spread merge，多次执行结果相同。

---

## D — 无法确认

### D1. `restoreBackup` 后异步任务是否可能写回旧状态

无法判断：`restoreBackup` 调用 `writeDb(json)` 覆盖整个数据库。如果有异步任务（如 `maybeUpdateMemoryProfile`）正在执行且持有旧 db 的引用，该任务完成后会通过 `updateDb` 写入。但 `updateDb` 在锁内重新读取最新状态（即恢复后的状态），所以写入的是恢复后的数据加上该任务的修改。理论上安全，但需要运行时日志确认任务的执行时序。

### D2. `db.settings` 整体替换时是否丢失并发修改

无法判断：`index.ts:691` 的 `db.settings = {...db.settings, ...updateProviderSettings(...)}` 使用 spread merge。如果两个并发请求同时修改 settings，后写入的会覆盖先写入的。但由于 `updateDb` 的文件锁保证串行，实际上不存在并发写入。

---

## A — 重要已排除项

### A1. `updateDb` 读-改-写安全性

**结论：安全。** `updateDb` 在 `withDbLock` 内执行 `readDbUnlocked()` → `mutator(db)` → `writeJsonAtomic()`。文件锁保证同一时刻只有一个 `updateDb` 在执行。不存在 lost update。

### A2. `normalizeDb` 幂等性

**结论：幂等。** 所有操作：
- `||=` 赋值：已存在则跳过
- `activateModelProfile`：纯函数，相同输入相同输出
- `recoverProviderProfiles`：从快照恢复，相同快照相同结果
- `applyRetention`：`slice(-N)` 幂等
- `commandRoles` 合并：已排序的角色再次排序结果相同

`normalizeDb(normalizeDb(db))` 与 `normalizeDb(db)` 等价。

### A3. `recordSendSuccess` 重置 `recentFailures`

**结论：正确。** `health.ts:116`：`state.sendMessage.recentFailures = 0;`。发送成功后正确重置失败计数。

### A4. `readDb()` → `await` → `updateDb()` 模式

**结论：安全。** 项目中所有 `readDb()` → `await` → `updateDb()` 模式（如 bot.ts:610-942, groupProfile.ts:48-138, memory.ts:736-1081）中，`updateDb` 在锁内重新读取最新 DB。旧 `readDb()` 的结果只用于上下文（如构建 prompt），不直接用于覆盖写入。

### A5. Backup/Restore 一致性

**结论：安全。** 
- `createBackup` 使用 `fs.copyFileSync` 复制 db.json（原子操作）
- `restoreBackup` 先创建 pre-restore 备份，再 `writeDb(json)`（带锁）
- `writeDb` 内部使用 `writeJsonAtomic`（tmp + rename）
- `pruneAutoBackups` 只删除 `auto-*` 和 `pre-restore-*` 文件，不误删手动备份
- 路径校验 `safeBackupName` 防止越界删除

### A6. 群删除的级联清理

**结论：完整。** `DELETE /api/groups/:groupId`（index.ts:761-779）清理了：groups, users, messages, decisions, commandLogs, groupProfiles, relationshipProfiles, groupBotConfig, pendingPairCounts, groupExperience。未清理的 memories 和 experience 是全局 per-user 的，不属于任何特定群。

### A7. 数据库旁路写入

**结论：不存在。** 全仓搜索确认所有数据库写入都通过 `updateDb` 或 `writeDb`，没有模块直接读写 `db.json`。

---

## 数据生命周期地图

| 字段 | 初始化 | 读取 | 修改 | 重置/删除 | retention | 结论 |
|------|--------|------|------|-----------|-----------|------|
| `settings` | initialDb + normalizeDb | 全仓 50+ 点 | ownerCommands, index API | 无（永不删除） | N/A | **安全** |
| `groups` | `[]` | index, bot, ownerCommands | index API upsert/filter | DELETE /api/groups | N/A | **安全**（有级联） |
| `users` | `[]` | index, bot, ownerCommands | index API upsert/filter | DELETE /api/users | N/A | **C2（无级联）** |
| `memories` | `[]` | bot/memory, ownerCommands | bot/memory updateDb | DELETE /api/memories | N/A | 孤儿风险低 |
| `groupProfiles` | `[]` | bot/groupProfile | bot/groupProfile updateDb | DELETE /api/group-profiles | N/A | **安全** |
| `relationshipProfiles` | `[]` | bot/relationshipProfile | bot/relationshipProfile updateDb | DELETE /api/relationship-profiles | N/A | **C1（pendingPairCounts 残留）** |
| `pendingPairCounts` | `{}` | relationshipProfile | relationshipProfile updateDb | 群删除时清理 | N/A | **C1** |
| `experience` | `{}` | experience.ts | experience.ts updateDb | /w exp reset | N/A | **安全** |
| `groupExperience` | `{}` | experience.ts | experience.ts updateDb | 群删除+exp reset | N/A | **安全** |
| `messages` | `[]` | bot, ownerCommands | bot updateDb | 群删除+clear-context | 12,000 | **安全** |
| `decisions` | `[]` | bot, ownerCommands | bot updateDb | 群删除+clear-context | 30,000 | **安全** |
| `commandLogs` | `[]` | index | ownerCommands updateDb | 群删除+clear-context | 2,000 | **安全** |
| `toolCallLogs` | `[]` | (API only) | executor updateDb | 无 | 5,000 | **安全** |
| `adminActions` | `[]` | (API only) | ownerCommands updateDb | 无 | 1,000 | **安全** |
| `usageEvents` | `[]` | publicDb | 6 文件 updateDb | 无 | 5,000（各写入点） | **B1（维护风险）** |
| `usage` | all 0 | publicDb, ownerCommands | bot, memory, gate, ownerCommands | 无 | N/A | **安全** |
| `profileLogs` | `[]` | profileLog.ts | profileLog.ts updateDb | 无 | **无上限** | **C4** |
| `profileV3` | `{}` | profileV3.ts | profileV3.ts updateDb | 无 | N/A | **安全** |
| `osuBindings` | 动态创建 | osu/commands, index | osu/commands, index | clear bind + API remove | N/A | **C3（缓存未清理）** |
| `osuAnalyses` | 动态创建 | osu/commands | osu/commands updateDb | clear history/cache | 写入点 slice | **B2** |
| `osuRecentAnalyses` | 动态创建 | osu/commands | osu/commands updateDb | clear cache | 写入点 slice | **B2** |
| `osuTypeAnalyses` | 动态创建 | bpTypeAnalysis | bpTypeAnalysis updateDb | clear cache | 写入点 slice | **B2** |
| `osuRecommendCooldowns` | 动态创建 | recommender | recommender updateDb | clear cooldown/recommend | N/A | **安全** |
| `osuRecommendations` | 动态创建 | recommender | recommender updateDb | clear recommend | 写入点 slice | **安全** |
| `osuMatchListeners` | 动态创建 | match.ts | match.ts updateDb | 无 | N/A | **安全** |
| `pendingLevelUps` | 动态创建 | bot.ts | bot.ts updateDb | 消费后删除 | 200 上限 | **安全** |
| `skillStore` | `{records:[], updatedAt:''}` | skills.ts | skills.ts updateDb | 无 | N/A | **安全** |
| `groupBotConfig` | `{}` | index | index updateDb | 群删除时清理 | N/A | **安全** |
| `configSnapshots` | 动态创建 | store.ts | store.ts | 无 | 10 条 | **安全** |

---

## Backup/Restore 一致性结论

**结论：安全。**

- `createBackup`：`fs.copyFileSync` 原子复制，附带 `.meta.json` 元数据
- `restoreBackup`：JSON 校验 → pre-restore 备份 → `writeDb`（带锁 + 原子写入）
- `pruneAutoBackups`：只删除 `auto-*`（保留 10 个）和 `pre-restore-*`（保留 5 个），不误删手动备份
- `safeBackupName`：路径遍历检查，防止越界
- 异步任务安全性：所有异步任务通过 `updateDb` 写入，`updateDb` 在锁内重新读取最新状态

---

## Normalize/Migration 幂等性结论

**结论：幂等。**

`normalizeDb` 的所有操作均为幂等：
- `||=` 赋值（已存在则跳过）
- spread merge（相同输入相同输出）
- `activateModelProfile`（纯函数）
- `recoverProviderProfiles`（相同快照相同结果）
- `applyRetention`（`slice(-N)` 幂等）
- `commandRoles` 排序（已排序再次排序结果相同）

每次 `readDb()` 都执行 `normalizeDb`，保证数据格式始终最新。

---

## 孤儿数据检查结果

| 删除操作 | 孤儿字段 | 严重程度 |
|----------|----------|----------|
| DELETE /api/users | messages, memories, experience, groupExperience, pendingPairCounts, relationshipProfiles, commandLogs, pendingLevelUps | **C2** |
| DELETE /api/memories | messages, decisions（引用 userId 但不引用 memory） | 低（功能不受影响） |
| /w osu clear bind | osuAnalyses, osuRecentAnalyses, osuTypeAnalyses, osuRecommendations, osuRecommendCooldowns | **C3** |
| /w osu clear history | osuRecentAnalyses, osuTypeAnalyses, osuRecommendations | 低（命令设计如此） |
| clearRelationshipProfile | pendingPairCounts | **C1** |
| /w exp reset | pendingLevelUps | 低（自动过期） |

---

## 状态机异常清单

| 字段 | 只增不减？ | 成功后恢复？ | 失败后恢复？ | 跨天重置？ | 重启保留？ |
|------|-----------|-------------|-------------|-----------|-----------|
| `sendMessage.recentFailures` | 否（成功时归零） | 是 | N/A | N/A | N/A（内存态） |
| `llm.recentFailures` | 否（成功时归零） | 是 | N/A | N/A | N/A（内存态） |
| `osu.api429Count` | **是（只增不减）** | 否 | N/A | 否 | 否（重启归零） |
| `osu.renderFailures` | **是（只增不减）** | 否 | N/A | 否 | 否（重启归零） |
| `usage.errors` | **是（只增不减）** | 否 | N/A | 否 | 是（持久化） |
| `usage.replies` | **是（只增不减）** | 否 | N/A | 否 | 是（持久化） |
| `profileLogs` | **是（只增不减）** | 否 | N/A | 否 | 是（持久化） |

注：`osu.api429Count` 和 `osu.renderFailures` 是内存态健康指标，重启归零，设计如此。`usage.errors` 和 `usage.replies` 是累计统计，设计如此。`profileLogs` 是审计日志，但缺少 retention 上限（**C4**）。

---

## 推荐修复优先级

1. **C1 (Medium)**: `clearRelationshipProfile` 中添加 `delete draft.pendingPairCounts[pairKey]`
2. **C2 (Medium)**: `DELETE /api/users` 中添加级联清理（参考群删除实现）
3. **C3 (Low-Medium)**: `handleClearBind` 中清理关联的分析缓存
4. **C4 (Low)**: `applyRetention` 中添加 `profileLogs` 的 retention 上限

---

## 推荐增加的确定性测试

1. **C1 测试**：创建关系画像 → 累积 pendingPairCounts → 删除画像 → 验证 pendingPairCounts 中无残留
2. **C2 测试**：创建用户及关联数据 → 删除用户 → 验证 messages/memories/experience 中无该 userId
3. **C3 测试**：绑定 osu 账号 → 执行分析 → 解绑 → 重新绑定不同账号 → 验证旧缓存已清理
4. **C4 测试**：写入 10000 条 profileLogs → 执行 applyRetention → 验证 profileLogs 被裁剪到上限
5. **normalizeDb 幂等性测试**：构造旧版 DB → normalizeDb(normalizeDb(db)) 与 normalizeDb(db) 对比
6. **retention 边界测试**：各数组恰好在上限时的行为（slice 不触发 vs 触发）
