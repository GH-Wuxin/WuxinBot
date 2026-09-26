# WuxinBot Capability Audit V01

- 日期：2026-08-14
- 仓库：`G:\QQ-AI-ChatBot`（WuxinBot）
- 性质：只读盘点（能力面 + 真实需求 + 后端证据），不修改任何生产代码
- 目标：为「Capability → Agent Tool」映射层（Phase A）提供事实基础

本文是交接文档。磁盘状态与代码为权威；数字来自 2026-08-14 的实测。

---

## 1. 核心结论

> 此前以为的问题是「pippi 工具太少」；更准确的问题是 **Agent capability 分布严重失衡**：
> **player-centric 已相当完整，beatmap-centric 基本缺失。**

群聊里 osu! 的两个核心实体是「玩家」和「谱面」。pippi 现在：

```text
查我 / 查某玩家：profile / recent / bp / pplus / recommend  ✅ 齐全
查这张图：星数 ❌ 属性 ❌ pp 估算 ❌ 榜单 ❌ 谱面信息 ❌
```

用户在群里发一张图或丢一个 BID 问「这图多少星 / HR 后多少 / 榜一多少 pp / 我打 99acc 能多少 pp」时，pippi 会「突然变聋」。这正是 08-12 DSML 事故（模型编造 pp_calc 工具）的土壤。

## 2. 能力面盘点（实测）

### 2.1 Agent 工具面（LLM 实际可自主调用）

| 工具 | 动作数 |
|---|---|
| `query_osu`（capability: bp / bp_type / recent / info / profile / pplus / skill / recommend / match） | 9 |
| `get_player_skill`（历史快照） | 1 |

`query_external_bot` 代码存在但生产未暴露（四个 bot 均 `channel: internal` 且无 qq）。

### 2.2 命令面（用户可手动使用）

| 入口 | 数量 | 说明 |
|---|---|---|
| `/w osu` 子命令 | 5（bind/analyze/recent/clear/help）+ 5 个 clear 动作 | 完整 |
| `/w` 其他指令 | 40 | 等级/画像/群管/模型/系统 |
| 快捷指令注册表 | 121 | **76 条空壳**（lazybot 36 / yumu 34 / kanon 7 / hydrant 3 / common 3），34 条已接通（bridge 13 / capability 13 / handler 8） |
| 自然语言确定性路由 | ~8 | bp/recent/bp_type/recommend/观战/点名/视觉/绑定解析 |

### 2.3 Agent Coverage

```
命令面可用的领域数据动作 ≈ 30（不含纯管理动作）
Agent 可自主调用的动作 ≈ 10（9 个挤在 query_osu 一个工具里）
beatmap-centric 动作 = 0
```

## 3. 真实需求调查（数据驱动）

数据源：db 12,000 条用户消息 + NapCat 两天全量日志（~1800 条收发）+ 890 条指令日志 + 115 条工具调用审计。

### 3.1 已高频使用的路径（不缺）

| 用户指令 | 次数 | LLM 工具调用 | 次数 |
|---|---|---|---|
| `/w osu`（analyze/recent/bind） | 347 | profile | 36 |
| `!pr`（recent） | 235 | recent | 21 |
| `!ppp`（PP+） | 52 | recommend | 19 |
| `!etx` | 30 | pplus / info | 12 / 12 |
| `!bp`/`!bs`/`!score` | 52 | bp_type | 10 |

### 3.2 明确的未满足需求（unmet intent）

| 需求 | 证据量（下界） | 后端现状 |
|---|---|---|
| 谱面信息/星数/属性 | ~8 次直接发问 + 大量带图讨论（"这图底力星数只有5.3星""chino 练习上限推荐多少星"） | ❌ 未暴露（osu API 客户端已有 getBeatmap/getBeatmapAttributes） |
| pp 估算（99acc fc 多少 pp） | 2 直接 + 6 acc/combo 语境（含 08-12 事故原句） | ❌ 未暴露（后端已实测可用，见 §4） |
| 榜单（榜一/前十） | 6（"个人stat前十一个都没有"） | ❌ 未暴露（后端已实测可用，见 §4） |
| 推荐 | 28 | ✅ 已有（含筛选） |
| "谁最近打了什么图" | 13 | ✅ 已有 recent |
| 分析/瓶颈 | ~40 | ⚠️ 走 `/w osu analyze`（命令入口好，自然语言入口弱） |
| 观战 | 36（含赛事管理噪音） | ⚠️ `!ml` 已接，自然语言弱 |
| web 搜索 | 7（多为链接分享） | 不做 |

### 3.3 解读纪律（重要）

- 「~8 次谱面发问」是 **confirmed lower bound**：上下文依赖型表达（"这个呢""hr后呢""这个fc多少"）和带图讨论无法被关键词统计，真实需求更高。
- 115 次工具调用只能说明「当前工具集下模型选了什么」，不能说「模型想调什么」——不存在的工具永远是 0 次。
- 「玩家维度」的结论措辞：**当前核心玩家查询覆盖充分**（不是"饱和"——低频≠没需求，玩家对比/趋势等未验证的需求只是缺证据，不预判）。

## 4. Beatmap 域后端能力（实测证据）

### 4.1 已核实：yumu 内嵌 rosu pp 计算器

- 实现：`sources\yumu-bot` 中 `CalculateApiImpl` 使用 `me.aloic.rosupp`（rosu-pp-java），原生库 `downloads\yumu-rosu\native\rosu_pp_ffi.dll`。
- HTTP 端点（`BotWebApi`，前缀 `/pub`，端口 8388）：

| 端点 | 实测 | 用途 |
|---|---|---|
| `GET /pub/map?bid=&mode=&mods=&accuracy=&combo=&miss=` | **HTTP 200 / image/jpeg** | 谱面信息 + rosu pp 计算面板 |
| `GET /pub/map/leaderboard?bid=&mode=&mods=&stable=` | **HTTP 200 / image/jpeg（970KB）** | 榜单面板 |

- 实测样例：`/pub/map?bid=5518740&accuracy=0.952&mods=HDHR` → 200 面板图。
- 参数注意：`accuracy` 用 **0-1 浮点**（`95.2` 会 500，`0.952` 正常）；`mods` 为成对双字母（HDHR）。
- QQ 命令通道的 `!cal` 桥接探测**全部超时**（yumu 已无 cal 命令或触发词变更）——所以「雨沐 !cal 空壳」不可作为实现证据；**HTTP 端点才是实现路径**。

### 4.2 osu! 官方 API（Wuxin 客户端已封装）

- `getBeatmap` / `getBeatmapAttributes`（带 mod 星数/AR/OD/CS/max_combo）/ `getBeatmapScores`（榜单）——已在 `server/osu/api.ts`，尚未暴露给 LLM。
- 官方 API 无「指定 acc/combo 的假设 pp」端点；pp 估算必须走 rosu（yumu）。

## 5. 修订后的实施计划（Phases）

> 架构阶段（Phase）与产品优先级（P0/P1）分离，避免混淆。

### Phase A — Capability exposure foundation（最小映射层）

**只做最小可用，不重构 CommandDescriptor。**

1. 能力元数据：给能力目录加 `agent: { callable, toolName, description, inputSchema, sideEffects, permission, rollout }`；
2. `buildAgentToolSchemas` 派生器：由能力目录**生成** LLM 工具 schema（不手写第二张表）；
3. 一致性门（build/verify 时强制）：
   - callable 但无 executor → build failure；
   - executor 有暴露但无元数据 → build failure；
   - tool 名重复 → build failure；
   - permission 与命令权限同源（**权限与 rollout 分离**：`agent.callable` 只描述能力；灰度用 `agent.rollout: owner_canary`，不混入业务权限）。
4. 复用现有 query_osu 的参数白名单 + validateOperation 门。

### Phase B — Beatmap P0 capabilities

| 工具 | 后端 | schema 要点 |
|---|---|---|
| `osu_beatmap_lookup` | osu API getBeatmap + getBeatmapAttributes（结构化返回）＋可选 yumu `/pub/map` 面板图 | `{ beatmap_ref, mods? }` → 星数/AR/OD/CS/HP/BPM/长度/maxCombo/mapper/状态 + `mods_applied` |
| `osu_pp_calc` | yumu `/pub/map`（rosu） | `{ beatmap_ref, mods?, accuracy?, combo?, misses?, fc? }`；FC 语义：`misses=0, combo=maxCombo`；返回 `estimated_pp`（**明确"估算，雨沐 rosu"，不得伪称官方值**） |
| `osu_leaderboard` | yumu `/pub/map/leaderboard` | `{ beatmap_ref, mods?, limit? }` |

**验收**：用 12k 消息里的真实句子做 replay（"这图多少星""hr之后多少星""99acc fc多少pp""榜一多少""前十是谁"），比纯 synthetic unit test 优先；每个工具附 validateOperation 白名单 + policy verify 用例 + 面板图 smoke。

### Phase C — Existing capability NL coverage

- "我最近怎么样 / 我是不是瓶颈了" → 引导 `/w osu analyze`（或经 `agent.rollout` 灰度后由 Agent 结构化触发；**权限与手动一致，不额外 owner-only**）；
- "帮我观战 xxx" → `!ml` 自然语言意图；
- 目标是把**已有能力的自然语言覆盖率**补到与命令面一致。

### Phase D — Observed expansion（遥测驱动）

**Unmet Capability Telemetry**（Phase B 同时落地，不是事后补）：

```
当 Agent 判断用户想执行某操作但无匹配工具时记录：
{ intent, reason: NO_TOOL_MATCH | TOOL_NOT_CAPABLE | TOOL_PERMISSION_DENIED | TOOL_ARGUMENT_UNRESOLVED,
  userTextHash, groupId, timestamp }
```

以后 P1/P2 决策依据变成「过去 30 天 NO_TOOL_MATCH: N 次，beatmap/query 43、pp/calc 19 …」，不再人工挖日志。

### 明确不做

- `execute_command` 万能工具（GPT 反对点成立：失去结构化参数、权限审计难）；
- 76 个空壳全量桥接（多数低频，按遥测滚动）；
- 玩家维度新工具（当前证据不支撑）；
- web 搜索接入（无真实需求信号）。

## 6. 决策记录（GPT 复审三处修订，已采纳）

1. 「玩家维度饱和」→「当前核心玩家查询覆盖充分；无新增玩家域能力的事实依据」；
2. analyze 的「owner-only 自动触发」→ 权限与 rollout 分离（同一权限源；灰度用 `rollout: owner_canary`）；
3. P0 同步加入 unmet-capability telemetry。

## 7. 风险与红线

- pp 估算必须标注来源与"估算"语义；accuracy 参数解析（0-1 / 1-100 / 101-10000）以实测为准（当前 0-1 最稳）；
- yumu HTTP 端点是外部依赖：调用需超时 + 失败如实说（沿用 localBridge 的 fallback 纪律）；
- 不动 yumu 本体；Wuxin 只消费其 HTTP API；
- 每个工具的验收走完整红线：verify 用例 → typecheck → verify-all → 报告 → 提交 → 部署（先提交后部署）。
