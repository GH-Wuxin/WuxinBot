# QUICK_BRIDGE_FIX_P0_2 — RECENT_DOUBLE_BRIDGE

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：bug fix（仅 recent 同目标重复桥接）；未改超时/身份/路由/观察/渲染/osu API
- 前置：QUICK_BRIDGE_FIX_P0_1（Kanon 身份碰撞）保持生效
- 历史审计图（`docs/QUICK_BRIDGE_FALLBACK_GRAPH_V01.json`）为修复前快照，保持不动

## 0. 缺陷

quickRouter 桥 #1 失败后，`executeInternalBotCommand('…','recent')` 在玩家解析成功后会再次对**同一 bot、同一目标**发起本地桥 #2（DUP_BRIDGE_FALLBACK）。对 Kanon，桥 #2 可能撞上目标侧 same-sender/same-command dedup，再烧一个完整 60s 静默超时；即使不撞 dedup，也是同一请求内的重复外部工作。

## 1. 旧 recent 回退图

```text
quickRouter:
  bridge #1 (kanon|yumu|lazybot, 30/60s) --fail/empty-->
  internal engine recent
executor recent:
  resolve player -> loadInternalOsuUser(getUser) ->
  bridge #2: botId==='kanon' ? kanon : yumu   (60s)  <-- 同目标重复
  -> getUserRecentScores -> enrich -> render/text
```

## 2. 新 recent 回退图

```text
quickRouter:
  bridge #1 (kanon|yumu|lazybot, 30/60s) --fail/empty-->
  internal engine recent, options = { bridgeAlreadyAttemptedFor: <source> }
executor recent:
  resolve player -> loadInternalOsuUser(getUser) ->
  if bridgeAlreadyAttemptedFor === bridgeBot:
      SKIP bridge #2 (mark recent_bridge_skipped)
  else if bridgeAlreadyAttemptedFor !== bridgeBot (e.g. lazybot -> yumu):
      keep bridge #2 (deliberate cross-target compatibility fallback)
  else (no flag):
      bridge #2 as before
  -> getUserRecentScores -> enrich -> render/text
```

## 3. 请求级抑制机制

- `executeInternalBotCommand` 的 `options` 新增 `bridgeAlreadyAttemptedFor?: string`（请求级事实，无全局状态、无时间缓存、无单例、无命令字符串启发式）。
- recent case 计算 `bridgeBot` 后只比较 `options.bridgeAlreadyAttemptedFor === bridgeBot`：
  - 相等 → 跳过本地桥，打 `recent_bridge_skipped` 延迟标记（默认关闭），直接内部 recent。
  - 不等 → 保留（显式跨 bot 兼容回退不被抑制）。
  - 未设置 → 行为不变。

### 设置该状态的调用方（唯一）

`server/bot/quickRouter.ts`：桥接段在真正发出 `callLocalBot(def.source, …)` 之前设 `bridgeAlreadyAttemptedFor = def.source`；随后内部引擎调用传入 `{ bridgeAlreadyAttemptedFor }`（仅当确实发起了桥接）。

### 不设置该状态的调用方

- `executeToolCall` 的 `query_osu`（agent/LLM 路径）：options 仅 `translateRecommendFilters`/`enrichBpEstimates`，无该字段 → 本地桥保留。
- 其他任何直接调用 `executeInternalBotCommand(… recent …)` 且未传该选项的调用方 → 本地桥保留。
- 新请求的 quickRouter 再次从 `bridgeAlreadyAttemptedFor = ''` 开始 → 每请求独立。

## 4. 各 recent 来源行为

| 来源 | 桥 #1 目标 | 桥 #2 目标（executor） | 修复后 |
|---|---|---|---|
| kanon | kanon | kanon（同目标） | **抑制**（Kanon dedup 60s 风险消除；同请求只 1 次 kanon 桥） |
| yumu | yumu | yumu（同目标） | **抑制**（同请求只 1 次 yumu 桥） |
| lazybot | lazybot | **yumu**（跨目标兼容回退，executor `botId==='kanon'?'kanon':'yumu'`） | **保留**（`bridgeAlreadyAttemptedFor='lazybot'` ≠ `bridgeBot='yumu'`；回归断言 yumu 桥 #2 发生） |

分类：
- kanon/yumu：**same-target duplicate** → 抑制。
- lazybot → yumu：**cross-target compatibility fallback** → 刻意保留（无证据表明是缺陷；不改）。

## 5. 理论最坏延迟（从代码推导，非实测）

单次 Wuxin 侧 HTTP 上限：getUser ≤ 15s×2（401 重试）= 30s；recent 15s；attributes ≤ 15s×3 + 回退 2.4s ≈ 47.4s；render 无上限。

| 链 | 修复前 | 修复后 |
|---|---|---|
| kanon/yumu recent 可见 | 60 + 30 + 60 + 15 + 47.4 + render = **212.4s + render** | 60 + 30 + 15 + 47.4 + render = **152.4s + render** |
| kanon/yumu recent context-ready | + shadow getUser 30 + recent 15 = **257.4s + render** | **197.4s + render** |
| lazybot recent（跨目标保留） | 30 + 30 + 60(yumu) + 15 + 47.4 + render = **182.4s + render** | 不变（刻意保留） |

## 6. 回归覆盖（`tools/quick-bridge-p02-recent-verify.mjs`，23 断言）

1. `KANON_QUICK_BRIDGE_FAILS`：`!re` 桥 #1 失败 → kanon 连接数 = 1（桥 #2 被抑制），内部 recent 文本成功，71ms，无跨 bot 连接。
2. `YUMU_QUICK_BRIDGE_FAILS`：`!r` 同理，yumu 连接数 = 1。
3. `DIRECT_EXECUTOR_RECENT`：无选项直接调用 → kanon 桥被发起并返回 `bridge:kanon:ok`。
4. `FLAG_ONLY_SAME_TARGET`：`bridgeAlreadyAttemptedFor:'yumu'` + botId kanon → kanon 桥仍发起（只抑制同目标）。
5. `AGENT_INTERNAL`：`executeToolCall(query_osu, capability=recent)` → kanon 桥发起，内容含 bridge 回复（无全局抑制）。
6. `LAZYBOT_RECENT`：`/pr` 桥 #1 lazybot 失败 → yumu 桥 #2 发起并返回 `bridge:yumu:ok`（跨目标保留）。
7. `FAILURE_CHAIN_LATENCY_MODEL`：kanon 端点设为 hang，`options{bridgeAlreadyAttemptedFor:'kanon'}` 直调 executor → kanon 连接 0，5s race 内内部 recent 完成（旧行为会挂在 60s 桥 #2）。
8. `PER_REQUEST_SCOPE`：随后新的 `!re` 再次发起桥 #1（kanon 连接 +1），证明非全局/冷却抑制。
9. P0_1 身份/并发/env 回归由 `tools/quick-bridge-reliability-verify.mjs` 继续覆盖（166 断言）。

## 7. Live 验证

未执行。离线合成服务器 + osu API mock 已覆盖目标路径；任务允许不等待真实 60s 超时。Kanon/Yumu 未被压测。

## 8. 未触碰

QB-03（open-but-silent 全超时）、QB-04（settle vs timeout）未修改。超时、Kanon 身份分配、路由优先级、别名、观察语义、渲染、osu API 均未变。

## 9. Files changed

- `server/bot/quickRouter.ts`：请求级 `bridgeAlreadyAttemptedFor` 标记 + executor options 传递。
- `server/bots/executor.ts`：options 类型 + recent 同目标桥跳过逻辑 + `recent_bridge_skipped` 标记。
- `tools/quick-bridge-p02-recent-verify.mjs`：新增永久回归。
- `docs/QUICK_BRIDGE_FIX_P0_2.md`：本文件。

未 commit，未 push。
