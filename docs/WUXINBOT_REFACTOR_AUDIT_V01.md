# WuxinBot Refactor Necessity Audit V01

- 审计日期：2026-08-15
- 仓库：`G:\QQ-AI-ChatBot`（WuxinBot）
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `63b992e`
- 性质：只读架构审计；本轮未修改任何生产代码、未重构、未 commit、未 push
- 方法：逐文件阅读当前实现 + 静态 import graph 实测 + git 近期改动统计 + 70 个 verifier 盘点；不依赖旧文档推断

## 0. 结论（先给答案）

**B. 只做少量 targeted refactor。**

当前架构没有进入“系统性重构”区间。命令元数据、agent capability 元数据、OneBot 连接状态机已经在最近几轮演化成可工作的分层；但存在几处**真实且正在产生漂移的中间态**：

1. `CommandDescriptor` 是归一化目标，实际定义层仍是 quick/osu/owner 三套 ad hoc 形状，权限与帮助存在双写，已出现可证实漂移。
2. agent tool 的能力枚举/描述已经派生，但参数 schema、guard 白名单、executor 注册表仍是手写并行。
3. external bot bridge 有两个近重复实现，其中一个当前是 guard 拒绝的“可见但不可调用”死路径。
4. 生命周期状态整体 owner 清晰，但 `replyQueues` 的锁由 `bot.ts` 与 `queue.ts` 分写；turn 级取消/超时仍缺失。
5. OneBot 连接已形成真正的单一状态机；不需要进一步状态机化。
6. `ownerCommands.ts` 已重新长成 1600 行级别的单函数 handler，但尚未变成跨域 god module。

建议按本报告第 11 节的 phase plan 做小步收敛；**不实施**，且不要在本轮顺手修 bug。

---

## 1. Command / Capability / Agent Tool

### 1.1 CommandDescriptor 当前承担什么职责

`CommandDescriptor`（`server/bot/commands/types.ts:51-79`）是完整的能力目录模型：

- id / namespace / path / aliases / syntax / description
- permission（all / group_admin / owner）
- visibility / discoverability / status
- execution：`local(handlerKey)` | `proxy(capability,targetBot)` | `documentation_only`
- arguments / cooldown（含 scope 和 resettableBy）/ deprecation / availability / permissionKey / family

它是一个**元数据描述符**，不持有 executor 函数，executor 通过 `handlerKey` 字符串指向实现（`types.ts:26-29`）。

归一化消费端已经建立：

- `getAllCommandHelpEntries()`（`server/bot/commands/index.ts:135-154`）把 quick/osu/owner 三套定义统一投影为 `CommandHelpEntry`。
- 运行时 `/w help`（`ownerCommands.ts:247-273`）、KB 构建（`tools/kb-build.mjs`）、capability summary（`commands/index.ts:232-272`）都消费该投影。

实测目录规模：`getAllCommandHelpEntries()` = 86 条（quick 38 / wuxin 39 / wuxin_osu 9）。

### 1.2 Agent tools 从哪里定义

Agent tools 由 `buildBotToolSchemas(registry)` 生成（`server/bots/registry.ts:157-261`）：

- `query_osu`：`registry.ts:162-225`
- `query_external_bot`：`registry.ts:228-244`（仅当 registry 有非 internal 且带 qq 的 bot 时生成）
- `get_player_skill`：`registry.ts:247-258`

`query_osu` 的**能力枚举和长描述已经派生**：

- `capability.enum = callableCapabilities()` ← `AGENT_CAPABILITY_META`（`agentCapabilities.ts:39-41`；使用处 `registry.ts:173`）
- `description = buildQueryOsuDescription()` ← 同一张 meta 表（`agentCapabilities.ts:43-49`；使用处 `registry.ts:167`）

但 `query_osu` 的参数 schema 是手写 JSON schema（`registry.ts:171-220`），guard 的参数白名单是第二份手写（`guard.ts:40-47`），executor 注册表 `INTERNAL_CAPABILITIES` 是第三份（`registry.ts:105-118`）。

### 1.3 命令与 agent capability 是否重复定义

**是，且已经产生可证实漂移。**

同一能力名至少存在于：

1. `AGENT_CAPABILITY_META`（`agentCapabilities.ts:20-33`）
2. `INTERNAL_CAPABILITIES`（`registry.ts:105-118`）
3. `quick.meta.ts` 的 `capability` 联合（`quick.meta.ts:25`）
4. `DEFAULT_BOTS` 命令表（`registry.ts:14-83`）
5. `executor.ts` / `guard.ts` / `intent.ts` 的硬编码分支

名称出现量（当前代码）：`bp_type` server 11 / tools 22；`beatmap_lookup` 9/11；`pp_calc` 20/35；`leaderboard` 24/48；`query_osu` 35/112；`query_bot` 10/31；`query_external_bot` 5/12。

已确认漂移：

| 位置 | 漂移 | 证据 |
|---|---|---|
| 权限默认值 | `owner.meta.ts:34` 把 `me/nick/style` 归为 `all`；运行时真实默认 `store.ts:220-222` 是 `trusted` | help/KB 宣称 all，实际 `hasCommandPermission` 要求 trusted |
| 能力拼写 | quick meta 用 `pplus`（两 p，`quick.meta.ts:25`）；agent/executor 用 `ppplus`（三 p，`agentCapabilities.ts:26`，`registry.ts:111`）。executor 兼容两拼写（`executor.ts:2082-2083`），但 `internalCapabilitySupported('pplus')` 为 false，guard 会拒绝 LLM 直接发 `capability:'pplus'` | `guard.ts:130-131` |
| 描述漂移 | `bp` 的 meta 与 executor 文案多“支持”二字（`agentCapabilities.ts:21` vs `registry.ts:106`）；`pp_calc` 的 SS/FC 链路说明只存在于 meta（`agentCapabilities.ts:31`），executor 侧没有 | LLM 看到的与审计/报错看到的不完全一致 |
| 工具暴露 vs guard | `buildBotToolSchemas` 会在有外部 bot 时向 LLM 暴露 `query_external_bot`，但 `ALLOWED_OPERATIONS` 明确不含它（`guard.ts:10-18`），`validateOperation` 必定拒绝 | `guard.ts:118-121`；`query-osu-policy-verify.mjs:231-232` 断言其被拒 |
| 命令目录缺失 | `/w relation` 有运行时实现（`ownerCommands.ts:789-828`），但 `OWNER_COMMANDS` 没有 relation 描述符；`store.ts:245` 有 `profileRetry` 权限 key，但生产代码无人使用 | `owner.meta.ts` 全文无 relation/profileRetry |
| 帮助双写 | `ownerCommands.ts:181-243` 保留手写静态 help 字符串，`/w help` 已改用 meta 生成（`ownerCommands.ts:245-273`），但未知 prompt 分支仍发送旧静态字符串（`ownerCommands.ts:785`） | 两份帮助内容可漂移 |
| osu clear 权限双写 | `osu.meta.ts:109-165` 有权限元数据；`ownerCommands.ts:1673-1683` 又手写 bind/history/cooldown/recommend/cache → permissionKey 映射 | 第三份权限事实 |

### 1.4 是否值得抽象 Capability layer

**当前不是“是否引入新抽象”的问题，而是把已经存在的两个半套抽象合并。**

- 命令侧已经有完整 descriptor 模型（`commands/types.ts`）。
- agent 侧已经有 `AgentCapabilityMeta` + 一致性闸门 `auditAgentCapabilityRegistry()`（`agentCapabilities.ts:57-83`）。
- 但两侧由 `handlerKey` 字符串和 `capability` 字符串松散连接，`INTERNAL_CAPABILITIES` 是重复描述源。

结论：**TARGETED_REFACTOR**。合并为单一 capability 目录（见 11.2 Phase 2），但不要升级成更泛化的框架（不要引入插件系统、依赖注入容器、自动发现）。

---

## 2. Bot execution lifecycle

### 2.1 message → gate → routing → LLM → tool → reply 完整路径

| 阶段 | owner | 证据 |
|---|---|---|
| WS 接收 / meta / heartbeat | `onebot.ts` | 391-417 |
| 机器人回包关联（在进入 pipeline 前） | `executor.tryResolveBotResponse` | 278-359；`onebot.ts:282-293` |
| 事件归一化 | `bot.ts.oneBotToInternal` | 312-345 |
| 入站去重 | `queue.ts.claimInboundEvent` | 64-92；`bot.ts:364-366` |
| self/owner/外部 bot 过滤 | `bot.ts` | 368-433 |
| 快捷指令确定性路由 | `quickRouter.ts` | 392-797；`bot.ts:435-448` |
| reply decision | `bot.ts.decideReply` | 250-310 |
| LLM reply gate | `gate.ts.llmReplyGate` | 376-463 |
| per-member reply 队列锁 | `bot.ts` + `queue.ts` | 577-614、94-149 |
| 首轮 history/side effects | `bot.ts` | 460-553 |
| LLM 调用 | `llm.ts.completeChat` | 349-518 |
| tool loop / pending bot calls | `executor.ts.runToolLoop` | 2261-2831 |
| tool 安全校验 | `guard.ts.validateOperation` | 118-237 |
| 回复清洗/重写/分段发送 | `reply.ts` + `bot.ts` | reply.ts 84-92、206-244；bot.ts 915-1026 |
| usage 记账 / 错误决策 | `bot.ts` | 986-1040 |

流水线本身集中在 `bot.ts.processIncomingInner`，可读性尚可。真正的分散点是状态与取消所有权。

### 2.2 state / queue / abort / timeout / retry ownership

| 状态 | 定义 | 读写方 | owner |
|---|---|---|---|
| `recentInboundEvents` | queue.ts 64 | 仅 queue.ts | 单一 |
| `replyQueues` | queue.ts 94 | **queue.ts 与 bot.ts 分写**（bot.ts 611 直接 push、614 直接置 locked=true） | **分裂** |
| `pendingBotCalls` / route drain | executor.ts 36-75 | 仅 executor.ts | 单一 |
| `inFlightRecommends` | executor.ts 57 | 仅 executor.ts | 单一 |
| `health.state` | health.ts 4-34 | 仅通过 setter | 单一 |
| onebot 生命周期全局变量 | onebot.ts 19-25 | 仅 onebot.ts | 单一 |
| osu analyze 队列 | osu/commands.ts 52-79 | 仅 osu/commands.ts | 单一 |
| match listener timers | osu/match.ts 129-192 | 仅 match.ts | 单一 |

取消/超时：

- LLM 超时与 SDK 重试/abort 在 `llm.ts` 内部闭环（396-433），**不暴露 caller AbortSignal**。
- `processIncoming` 无任何外层取消、无 wall-clock 上限；唯一 timer 是 cosmetic thinking notice（`bot.ts:755`）。
- `runToolLoop` 只有 `maxIterations` 上限（`bot.ts:849` 传入 4），没有 wall-clock；渲染调用（executor 多处）无单次超时。
- 外部 bot pending call 有 20s 超时（`executor.ts:59,263`）；但 `query_external_bot` 在 `sendMessage` 抛错时**不 cancel pending**（893-894），会泄漏 20s pending 并占用 route，而 `query_bot` 有 cancel（1116-1121）。
- local bridge 有 45s/60s/30s 超时与 3s settle（`localBridge.ts:256-263`），caller 普遍 fallback。

重试 / 幂等：

- 入站 dedupe key = `source:type:groupId:messageId`，10 分钟，5000 key（`queue.ts:66-91`）。
- `oneBotToInternal` 在 OneBot `message_id` 缺失时生成 UUID（`bot.ts:334`），此时重复投递不可去重。
- 队列 drain 合并同成员 burst 为一次 LLM（`queue.ts:140-170`），drain replay 跳过首次副作用（`bot.ts:455-460`）。
- 出站 HTTP 发送**无重试、无幂等键**（`onebot.ts:177-193`）；这是刻意的重复消息保护，但也意味着 timeout 后“不确定是否送达”。
- `drainReplyQueue` 吞掉 `processIncoming` 错误（`queue.ts:145-148`），失败不可观测。

### 2.3 判断

流程 orchestration 集中在 `bot.ts`，但生命周期状态分散在 6 个模块；`executor.ts` 是第二生命周期中心。**不需要重写 pipeline，但需要两个 targeted 修复**：

1. 把 `replyQueues` 的 acquire/release 收进 `queue.ts`。
2. 给 turn 级加 outer AbortSignal / wall-clock，并给渲染路径加超时。

---

## 3. OneBot / NapCat lifecycle

### 3.1 当前是不是单一状态机

**是。** 当前代码已经形成真正单一状态机，而不是多个模块各自维护 connection truth：

- canonical truth：`connectionStatus`（`onebotStatus.ts:104-358`），`getOneBotStatus()` 直接返回其 snapshot（`onebot.ts:45-47`），GUI `/api/state` 直接消费（`index.ts:151`）。
- 唯一编排者：`onebot.ts` 是所有连接生命周期事件的唯一 mutator。
- `health.ts.state.onebot` 是派生镜像：grep 确认只有 `syncHealth()` 写 OneBot 字段（`onebot.ts:195-211`），外加 `setOneBotEvent`（`onebot.ts:409`）；不是独立 truth。
- 生命周期句柄 `ws/reconnectTimer/reconnectStableTimer/statusProbeTimer/statusSampleTimer` 全部私有于 `onebot.ts:19-25`。

### 3.2 connect / replace / shutdown / error / close / stale socket

已由当前分支的修复和回归测试覆盖：

- CONNECTING socket 替换不再因无 listener 的 error 崩溃：`closeSocketQuietly`（`onebot.ts:67-79`）。
- error + close 只 schedule 一个 reconnect：guard（`onebot.ts:50`），由 `tools/onebot-lifecycle-verify.mjs:111-143` 实测。
- accept-then-close 不会把 backoff 重置回 1s：stable timer（`onebot.ts:96-103`），由 `lifecycle-verify.mjs:145-168` 实测。
- shutdown 清 timer、禁 reconnect、重置 attempt（`onebot.ts:434-458`）。
- WS close/error 重置旧会话证据（account/heartbeat），同时保留独立 HTTP observer 的 fail streak（`onebotStatus.ts:168-185`）。

### 3.3 残余小缝隙（不是重构理由）

1. 旧 socket 的 in-flight message handler 在 `await handleOneBotEvent` 之后仍可写当前 `connectionStatus` flight recorder / `syncHealth`（`onebot.ts:391-417`）——没有 generation/epoch guard。
2. in-flight `probeGetStatus` 无 shutdown 标记；standalone shutdown 后，一个迟到 probe 仍可重写 `apiReachable`（`onebot.ts:213-259`）。
3. `health.ts.setOneBotConnected` 先写 `transportConnected=connected` 再由 `setOneBotDetail` 纠正，正确性依赖调用顺序（`health.ts:82-83`；`onebot.ts:197-198`）。
4. crash 路径的 close 是 best-effort，注释已如实说明（`index.ts:27-33,70-80`）。

**分类：NO_REFACTOR（状态机本体）；残余项为 LOCAL_CLEANUP 级 generation guard。** 不建议再做状态机框架化。

---

## 4. External capability / bot bridge

### 4.1 实际存在的 provider / capability

以代码为准：

| Provider | 形态 | 证据 |
|---|---|---|
| Wuxin internal engine | `query_osu` 12 能力 | `registry.ts:105-118`；`executor.ts:699-858` |
| 雨沐 Yumu | `channel:'internal'` + local WS bridge `ws://127.0.0.1:8388/pub/onebotSocket` + 渲染器 | `registry.ts:19-31`；`localBridge.ts:57`；`render.ts/renderServer.ts` |
| 猫猫 Kanon | `channel:'internal'` + WS `ws://127.0.0.1:7700/`（messageArray + echo ack） | `registry.ts:36-48`；`localBridge.ts:58` |
| 消防栓 Hydrant | `channel:'internal'` + WS `ws://127.0.0.1:8800/`（raw token + echo ack） | `registry.ts:53-65`；`localBridge.ts:59,220-222` |
| LazyBot | `channel:'internal'` + WS `ws://127.0.0.1:1145/lazybot`；MariaDB binding sync | `registry.ts:70-82`；`localBridge.ts:60`；`bindingSync.ts:88-128` |
| osu! API v2 | HTTP client | `osu/api.ts` |
| PP+ 聚合 | HTTP `http://127.0.0.1:9001` | `osu/pplus.ts` |
| rosu pp 计算 | 经 Yumu HTTP `/pub/map/calculate` | `bots/beatmapCapabilities.ts:6,65-101` |
| osu!oracle / bp_type | 本地 deterministic classifier + 24h cache | `bots/bpTypeAnalysis.ts:17-103` |
| yumu-image renderer | 本机 WSS 8389，协议独立 | `bots/renderServer.ts` |
| osu! 多人观战 | 自研 MatchManager + poll | `osu/match.ts` |
| LazyBot MariaDB | `execFileSync` 镜像绑定 | `bots/bindingSync.ts` |

### 4.2 adapter contract / duplication / special cases

**没有统一 adapter contract。** 四套调用合同并存：

| 路径 | 返回 | 超时 | 取消 | 解析 |
|---|---|---|---|---|
| `callLocalBot` | `LocalBotReply{text,images,frames}` | 30/45/60s + 3s settle | 关 WS；无 AbortController | 自有 JSON frame/CQ 解析 |
| `query_external_bot` | `ToolResult` | pending 20s | send 失败时**不 cancel** | `tryResolveBotResponse` settle |
| `query_osu` internal | string 或 `{content,images,final}` | 由内层服务各自限制 | 无 executor 级 abort | renderer/null/text fallback |
| quickRouter bridge | 直接发送 + fallback | 30/60s | 无 | 复用 `callLocalBot` |

确认的重复 glue：

- `query_bot` QQ 分支（`executor.ts:1080-1159`）与 `query_external_bot`（`executor.ts:879-907`）几乎复制同一段 correlation → pending → send → settle。
- CQ 图片解析两套：`localBridge.extractReplyFrame`（116-156）vs `tryResolveBotResponse`（326-343）。
- BP 参数解析三处以上：`executor.ts:390-485`、`quickRouter.ts:157-245`、`intent.ts:32-40`。
- bot event 构造两处：`localBridge.buildEvent`（158-197）vs executor 内 `botEvent`（893、1106-1114）。
- 路由特例集中在 `quickRouter.ts` 和 `executor.ts` 的 bot-specific case：hydrant `~`/`查@`、kanon `!re`、lazybot `/`、虚拟群 `770099`、echo ack、每 bot 端口/鉴权。

### 4.3 当前 `query_external_bot` 是死路径

- `guard.ts:10-18` 明确把 `query_external_bot` 排除在 whitelist 外。
- 默认四个 bot 都是 internal 且无 qq（`registry.ts:19-83`），所以 schema 通常不生成。
- 一旦外部 bot 被配置，schema 会生成但 `validateOperation` 会拒绝：**可见但不可调用**（`registry.ts:228-244` vs `guard.ts:118-121`）。

### 4.4 判断

**统一 adapter contract 值得做，但现在不紧急。** 当前生产形态其实是“一个 internal engine + 一个 local WS transport + 一个休眠的 QQ relay”。在重新启用 external QQ 通道之前，先把重复的 `query_bot`/`query_external_bot` 合并，再定义 `BotBridge`；在那之前不要为 4 个 provider 做插件化。

分类：**TARGETED_REFACTOR（conditional，前置条件 = 重新启用外部 QQ bot）**；当前死路径本身是 LOCAL_CLEANUP。

---

## 5. Command / admin / configuration

### 5.1 owner commands

- 运行时入口：`handleOwnerCommand` → `runOwnerCommand`（`ownerCommands.ts:101-1741`）。
- `runOwnerCommand` 是**约 1600 行的单函数**，34 个 `if (command === '...')` 分支，16 个模块 fan-out。
- 元数据已外置到 `server/bot/commands/owner.meta.ts`，help 已改为 meta 驱动（`ownerCommands.ts:245-273`）。
- 但仍有手写静态 help 字符串（`ownerCommands.ts:181-243`）用于未知 prompt 分支（`ownerCommands.ts:785`）。

### 5.2 group admin / runtime config / feature flags / rollout

- 权限事实：`store.ts.defaultCommandPermissions:213-259` + `db.settings.commandPermissions` 覆盖，运行时 `commands.ts:27-37`。
- GUI `/api/settings`（`index.ts:698-729`）通过 `hasOwnProperty(db.settings, key)` 接受所有已知 settings 字段；秘密字段有 keep-placeholder 保护，命令角色有合法性收敛。
- ownerCommands 是第二配置写入口：13 处 `draft.settings.* =`。
- feature flags 散布在 `store.ts.initialDb.settings`（261-334），被约 20 个模块直接读取（`bot.ts`、`prompt.ts`、`memory.ts`、`gate.ts`、`search.ts`、`llm.ts`、`knowledgeBase.ts`、`reasoningRouter.ts`、`onebot.ts` 等）。没有集中的 settings schema/owner 层；`DbSettings` 有 index signature（`types.ts:83`），类型只覆盖部分字段。
- rollout 控制：`AGENT_CAPABILITY_META.rollout` 目前全部 `all`（`agentCapabilities.ts:20-33`）；KB 有自己的 `settings.kb.rollout`（`knowledgeBase.ts` 与 `knowledgeTypes.ts`）。两者互不感知。

### 5.3 是否重新成为 god module / miscellaneous bucket

- **`ownerCommands.ts` 是一个 god function，不是跨域 god module。** 它只处理 `/w` 命令族，职责边界清楚，但单函数体积已到提取阈值。
- **`index.ts` 是一个 GUI/API route bucket + 进程启动器**：54 个 Express route + 启动/bootstrap。不是调度 god，但继续堆 route 会变 miscellaneous bucket。
- **`store.ts.settings` 是配置 god bag**：所有模块直接读，两个模块写，类型靠 index signature 放宽。这是当前最像“miscellaneous bucket”的部分。

分类：ownerCommands = TARGETED_REFACTOR（按命令组拆 handler，低优先级）；settings = TARGETED_REFACTOR（可选 Phase 3）；index.ts = LOCAL_CLEANUP / 暂缓。

---

## 6. Verification architecture

### 6.1 当前 verifier / consistency gate 盘点

- `tools/*-verify.mjs` 共 **70 个**，由 `run-all-verifies.mjs` 顺序执行。
- 主题分布：osu/bridge 19、agent/tool 10、pipeline 6、features 10、data/security 8、other 17。
- 生产侧已有 consistency gate：`auditAgentCapabilityRegistry()`（`agentCapabilities.ts:57-83`）、`db-consistency-verify`、`safety-guard-verify`、`agent-tool-count-contract-verify`、`kb-verify`（消费 command meta）、`query-osu-policy-verify`。

### 6.2 双写 / 重复维护（确认存在）

| 重复点 | 证据 |
|---|---|
| 命令/tool/capability 名称在生产与 verifier 双写 | `query_osu` 在 tools 出现 112 次；`leaderboard` 48；`query_bot` 31；`query_external_bot` 12 |
| guard 规则在 verifier 中逐条重写 | `query-osu-policy-verify.mjs:51-92` 手写约 25 条允许/拒绝；`agent-capability-verify.mjs` 又检查 schema |
| quick registry 的第二事实源 | `quick-router-verify.mjs:87-135` 手写匹配表 + 反例 |
| intent 规则双写 | `intent-verify.mjs:57-124` 与 `intent.ts` 手写对拍 |
| BP 解析规则双写 | `bp-rank-verify` / `bp-range-route-verify` / `quick-router-verify` / `osu-fixture-verify` 各保留一套期望 |
| verifier 复制业务规则 | `reasoning-wire-verify.mjs` 全量复制 reasoning wire 契约；`match-f3-contract-verify` 复制 F3/E7 payload 契约 |

### 6.3 判断

verifier 不是“只测行为”，而是大量复制生产规则作为第二事实源。当前是有用的防回归网，但代价是：**改 guard/registry/quick meta 必须同时改多个 verify，否则测试会抓住不一致**。这反过来说明第 1 节的 metadata drift 严重性：测试已变成另一份实现。

**不建议**本轮动 verifier 架构；先收敛生产 metadata，再让 verifier 从 descriptor 派生断言（`agent-capability-verify.mjs` 已经是好范本）。

---

## 7. Dependency / coupling audit（实测）

静态 import graph：server 82 个模块，只统计 `import`/`export from`/`import()`/`require`。

### 7.1 fan-in top

| 模块 | fan-in |
|---|---|
| `server/store` | 29 |
| `server/bot/llm` | 14 |
| `server/osu/api` | 13 |
| `server/osu/types` | 13 |
| `server/bot/cleaning` | 11 |
| `server/health` | 8 |
| `server/bot/commands`（catalog） | 6 |
| `server/bot/prompt` / `modelConfig` / `knowledgeTypes` | 6 |
| `server/bot/experience` / `reply` / `executor` / `registry` / `pplus` | 5 |

### 7.2 fan-out top

| 模块 | fan-out |
|---|---|
| `server/index` | 26 |
| `server/bot` | 25 |
| `server/bots/executor` | 20 |
| `server/bot/ownerCommands` | 16 |
| `server/osu/commands` | 14 |
| `server/bot/prompt` | 13 |
| `server/bot/quickRouter` | 9 |
| `server/bot/gate` | 7 |

### 7.3 circular dependency

检测到 2 个：

1. `server/bots/registry` ↔ `server/bots/agentCapabilities`
   - `registry.ts:3` import agentCapabilities；`agentCapabilities.ts:8` import `INTERNAL_CAPABILITIES` from registry。
   - 当前是**良性 ESM cycle**：agentCapabilities 只在函数体内使用 `INTERNAL_CAPABILITIES`，模块初始化不触发 TDZ。但它把“executor 注册表”和“agent 元数据”锁在一个环里，正是能力目录合并应解开的点。
2. `server/bots/executor` → `server/bots/bpTypeAnalysis` → executor
   - 静态图中是 cycle，实际 `executor.ts` 用 dynamic `await import('./bpTypeAnalysis.js')`（`executor.ts:1878`），初始化安全。属于刻意打破静态环。

### 7.4 shared mutable state / singletons / dynamic imports / side-effect imports

- 模块级可变状态：`queue.ts` 2 个 Map；`executor.ts` 3 个 Map + timers；`onebot.ts` 6 个 handle；`health.ts` 1 个大 state；`match.ts` listener；`store.ts` 2 个模块变量。**大多数单一文件 owner，唯一分裂是 `replyQueues.locked/queue`（bot.ts 直写）。**
- dynamic import 共 64 处，主要集中在 `index.ts`（route 级懒加载）、`executor.ts`（capability/渲染懒加载）、`osu/commands.ts`。作用是打破启动环和降低启动成本，但 `executor.ts` 大量动态 import 使静态依赖图不可靠。
- singleton/global：`matchManager`、`getRenderServer()`、`connectionStatus`、`replyQueues` 都是进程内 singleton。符合当前单进程 bot 形态。
- side-effect import：`server/index.ts` 是唯一入口副作用所有者（store init、process handlers、timers、server start）；测试通过 `DATA_DIR` 隔离。

### 7.5 判断

依赖结构不是系统性债务。`store` fan-in 29 是正常持久化根；`bot.ts`/`executor.ts` fan-out 高与业务集中有关。两个 cycle 都是良性，但 registry↔agentCapabilities 是能力目录中间态的直接症状。

---

## 8. Change-risk evidence（git）

- 2026-05-01 以来共 **204 commits**；其中 `fix/回退/revert/regress` 主题 **63 个**。
- 高 churn 文件（touch 次数）：`server/bot.ts` 47、`server/bots/executor.ts` 31、`src/App.jsx` 26、`server/index.ts` 26、`store.ts` 23、`quickRouter.ts` 21。
- fix 提交集中文件：`executor.ts` 14、`bot.ts` 13、`quickRouter.ts` 9、`store.ts` 4、`osu/match.ts` 4、`osu/recommender.ts` 4。
- 近 20 次 `executor.ts` 提交里，大多数是 agent tool / DSML / recommend / 渲染 / 外部 bot 路由修复；`bot.ts` 高 churn 多来自“每加一个 feature 都要在 pipeline 加一条确定性路由或提示词规则”。
- `quickRouter.ts` 是 bridge 回归集中地：alias 优先级、echo ack、虚拟群、双发、bare-slash 等多次修复。

结论：**change reason 最高的热点是 `bot.ts + executor.ts + quickRouter.ts + 对应 verifier` 这条 agent/osu 路由链。** 这支持 targeted refactor 先做 metadata 收敛和 bridge 去重，而不是先拆 bot.ts。

---

## 9. File size（仅作辅助指标）

| 文件 | 行数 | 观察 |
|---|---|---|
| `server/bots/executor.ts` | 2622 | tool dispatch + pending correlation + internal capability executor 混在一个文件；高 churn |
| `server/osu/analyzer.ts` | 2005 | 分析 pipeline，自洽；不因行数拆分 |
| `server/bot/ownerCommands.ts` | 1623 | 单函数 1600 行，34 分支；handler 型 god function |
| `server/osu/commands.ts` | 1530 | `/w osu` + 分析队列 |
| `server/index.ts` | 1249 | 54 routes + bootstrap |
| `server/bot/memory.ts` | 1131 | 记忆 pipeline，自洽 |
| `server/bots/render.ts` | 1018 | 渲染 payload |
| `server/bot.ts` | 985 | pipeline 编排 + 确定性路由 |
| `server/bot/quickRouter.ts` | 754 | bridge 路由特例集中地 |
| `server/onebot.ts` | 421 | 生命周期编排（已经清理） |

**不把“超过 N 行”当作拆分理由。** 上面只有 `executor.ts` 和 `ownerCommands.ts` 因 cohesion/ownership/churn 有独立拆分理由，其余大文件保持现状风险更低。

---

## 10. 候选区域分类总表

| # | 区域 | 分类 |
|---|---|---|
| C01 | owner.meta 权限镜像 / 帮助双写 / relation 缺失 | LOCAL_CLEANUP |
| C02 | CapabilityDescriptor 目录合并 + 单拼写 | TARGETED_REFACTOR |
| C03 | `query_external_bot` 死路径 / pending leak | LOCAL_CLEANUP |
| C04 | replyQueues 锁所有权收归 queue.ts | TARGETED_REFACTOR |
| C05 | turn 级 abort / wall-clock / render timeout | TARGETED_REFACTOR |
| C06 | external bot bridge adapter 去重 | TARGETED_REFACTOR（conditional） |
| C07 | ownerCommands 单函数拆分 | TARGETED_REFACTOR（低优先级） |
| C08 | OneBot generation guard / late probe | LOCAL_CLEANUP |
| C09 | settings god bag 类型化 / owner 层 | TARGETED_REFACTOR（可选） |
| C10 | verifier 双写收敛 | NO_REFACTOR（先不动） |
| C11 | OneBot 状态机进一步框架化 | NO_REFACTOR |
| C12 | executor.ts 大规模拆分 | DO_NOT_TOUCH_NOW |
| C13 | osu analyzer / match listener / store 持久化 | DO_NOT_TOUCH_NOW |
| C14 | registry↔agentCapabilities cycle | 随 C02 解决；当前 NO_REFACTOR |
| C15 | bindingSync 同步 execFileSync | LOCAL_CLEANUP（风险低） |

---

## 11. 最终结论与 Phase Plan

**最终结论：B — 只做少量 targeted refactor，继续功能开发。**
当前架构没有到 C/D。已有分层（command catalog、capability meta、OneBot state machine、health mirror）方向正确；问题是中间态漂移，而不是结构崩塌。

若选择 B，按风险排序的 phase plan（**仅计划，不实施**）：

### Phase 0 — 零代码决策（立即）
- 冻结“加功能必须同时改 bot.ts + executor.ts + quickRouter + verifier”的模式；新 capability 只允许落在 `AGENT_CAPABILITY_META` 单一目录。
- 暂不重新启用 external QQ bot，直到 C03/C06 完成。

### Phase 1 — LOCAL_CLEANUP（低风险，1 个改动窗口）
1. 权限单源：`owner.meta.permFromKey` 直接 import `store.defaultCommandPermissions` 或统一映射；修正 `me/nick/style` 为 trusted；补 `/w relation` descriptor；删除死 key `profileRetry`。
2. 删除/生成 `ownerCommands.ts` 静态 help 字符串，未知 prompt 分支改用 `buildHelpText`。
3. `query_external_bot`：与 guard 对齐（要么不进 schema，要么进 whitelist 并补 send 失败 cancel pending）；补 `query_external_bot` 与 `query_bot` 的 pending-cancel 一致性。
4. OneBot generation/epoch guard：旧 socket in-flight message tail、in-flight probe 在 shutdown 后不再写状态。
5. `bindingSync.ts` 的 `execFileSync` 移出 request path（异步 worker 或 fire-and-forget 队列）。

### Phase 2 — TARGETED_REFACTOR（中低风险，1-2 个改动窗口）
6. 合并能力目录：`AGENT_CAPABILITY_META` 成为唯一能力事实，`INTERNAL_CAPABILITIES` 从它派生；统一 `ppplus` 拼写；`auditAgentCapabilityRegistry` 增加 quick alias / guard / schema 三向审计。
7. `query_osu` 参数 schema 与 `guard.PARAM_KEYS` 由 descriptor 的 arguments 派生；删除 `BEATMAP_CAPABILITIES` 硬编码重复。
8. `replyQueues` 增加 `acquireReplySlot/releaseReplySlot`；`bot.ts` 不再直写 `locked/queue`。
9. turn 级取消：给 `processIncoming` 增加可选 `AbortSignal`，`llm.ts` 接受 caller signal；`runToolLoop` 加 wall-clock；渲染调用加超时。配套 lifecycle verifier。

### Phase 3 — TARGETED_REFACTOR（中等风险，有明确触发条件才做）
10. External bridge adapter：只有当决定重新启用外部 QQ bot 时，定义 `BotBridge`（send/cancel/timeout/error 归一），删除 `query_external_bot` 与 `query_bot` 的复制。
11. `ownerCommands` 按命令组拆 handler（与 meta `execution.handlerKey` 对齐）。
12. Settings schema/owner 收敛：去掉 `DbSettings` 宽泛 index signature，feature flags 分组与 GUI 字段一一对应。

### 明确不做
- 不重写 OneBot 状态机。
- 不按行数拆 `executor.ts` / `analyzer.ts`。
- 不做插件式 provider framework。
- 不把 70 个 verifier 合并成测试框架。

---

## 12. 七个专门问题

### Q1. CommandDescriptor 是否应该升级为 CapabilityDescriptor
**不升级，但合并。** `CommandDescriptor` 应继续服务命令帮助/KB/权限面；agent 能力是另一轴，已经有 `AgentCapabilityMeta`。需要的是让两者的 `execution.handlerKey` / `capability` 与单一能力目录类型化关联，而不是把 CommandDescriptor 泛化成 CapabilityDescriptor。

### Q2. Agent Tool Registry 是否应由 capability metadata 派生
**应该，且一半已经派生。** 枚举和描述已派生；下一步应派生参数 schema 与 guard 白名单。当前手写 JSON schema 是 `pplus/ppplus`、`query_external_bot` 这类漂移的温床。

### Q3. external bot bridge 是否需要统一 adapter contract
**需要，但有前置条件。** 当前生产只有 1 个 internal engine + 1 个 local WS + 1 个休眠 QQ relay；统一接口的真实收益要等 external QQ bot 重新启用才兑现。先做 C03 死路径清理，再在启用前做 C06。

### Q4. OneBot lifecycle 是否还需要进一步状态机化
**不需要。** 当前 `onebotStatus.ts` 是唯一 truth，`onebot.ts` 是唯一编排者，`health.ts` 是派生镜像，且有 lifecycle regression 覆盖 error+close、accept-close、shutdown、CONNECTING replacement。剩余只需 generation guard 类局部补丁。

### Q5. owner/admin 模块是否已经重新成为 god module
**是 god function，不是 god module。** `ownerCommands.runOwnerCommand` 约 1600 行 / 34 分支，但边界仍限定在 `/w` 命令族，元数据已经外置；`index.ts` 是 route bucket。建议按命令组拆分 handler，但优先级低于能力目录收敛。

### Q6. 当前最大的三个 architecture debt
1. **能力目录中间态漂移**：command meta / agent meta / executor registry / guard schema / quick registry 五处双写，已出现权限与拼写漂移。
2. **turn 级生命周期缺少取消与超时，且 replyQueues 锁分写**：hung render/LLM 可长期占锁；`query_external_bot` 还有 pending leak。
3. **external bridge 复制与死路径**：`query_bot`/`query_external_bot` 近重复，CQ/BP 解析三份，外部路径当前 guard 不可达。

### Q7. 当前最不应该碰的三个区域
1. **`server/osu/analyzer.ts` 及 osu analyze 队列**：2005 行自洽，最近稳定，无生命周期缺陷；重排只会引入回归。
2. **`server/osu/match.ts` + matchRating/render F3-E7 链路**：刚经过 cursor/race/contract 修复，测试密集；动它收益最低。
3. **`server/store.ts` 原子持久化/恢复/retention + `llm.ts` timeout/retry 内部实现**：正确性关键且已有完整测试；任何“顺手优化”都是成本/数据风险。

---

## 附：审计限制

- 只做静态代码与 git 证据；未做生产运行 profile / runtime heap / 真实网络压测。
- 未读取 `.private/` 或生产 db 中的私有配置；external bot 实际启用状态以代码默认值 `DEFAULT_BOTS` 和注释为准。
- 本轮零生产代码修改；文档 `docs/WUXINBOT_REFACTOR_AUDIT_V01.md` 与 `docs/WUXINBOT_REFACTOR_CANDIDATES_V01.json` 为仅有的新文件，不提交、不推送。
