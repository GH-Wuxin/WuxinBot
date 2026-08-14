# Beatmap Capabilities V01 — 实现报告（Phase A + Phase B）

- 日期：2026-08-14
- 仓库：WuxinBot（`G:\QQ-AI-ChatBot`）+ yumu-bot（`codex_work\napcat-local-bots\sources\yumu-bot`）
- 状态：**已实现并验证（Wuxin 侧未部署）**；yumu 侧已提交并部署
- 依据：`docs/CAPABILITY_AUDIT_V01.md`（能力审计 + 需求调查 + GPT 复审三处修订）

本文是交接文档。磁盘状态与代码为权威。

---

## 1. 目标回顾

把「player-centric 已全、beatmap-centric 缺失」的 Agent 能力失衡补齐：
Phase A 建立能力→Agent 工具的**派生映射层**（不手写第二张表），Phase B 落地三个谱面域工具（beatmap_lookup / pp_calc / leaderboard），并随 B 落地 unmet-capability 遥测（GPT 复审第 3 条）。

## 2. yumu 侧：结构化 pp 计算 JSON 端点

### 2.1 实现（已提交 `f6b513b`，已部署并实测）

| 文件 | 内容 |
|---|---|
| `model/calculate/CalculateInfo.kt`（新） | snake_case JSON 模型：engine/estimated 语义、stars/ar/od/hp/max_combo、estimated_pp + aim/speed/acc/flashlight/reading 分解、effective_miss_count、estimated_unstable_rate、FC acc 阶梯 |
| `OsuCalculateApiService.kt` | 新增 `calculatePPInfo(...)` |
| `CalculateApiImpl.kt` | rosu 实现（DifficultyRequest + PerformanceRequest，复用 RosuPerformance 的按模式字段映射） |
| `BotWebApi.kt` | 新增 `GET /pub/map/calculate`：accuracy 接受 0-1 或 1-100；返回谱面事实 + 请求回显 + calculation |

### 2.2 实测（部署后）

```
GET /pub/map/calculate?bid=5518740&mods=HDHR&accuracy=0.952&combo=1200&miss=1
→ HTTP 200 {"engine":"rosu","estimated":true,"unavailable":false,
   "calculation":{"estimated_pp":140.25,"stars":5.43,"ar":10,"od":10,"max_combo":197,
     "fc_ladder":{"1.00":201.31,...}}}
GET /pub/map/calculate?bid=5518740&accuracy=95.2  → request.accuracy=0.952（1-100 归一化正常）
回归：/pub/map、/pub/map/leaderboard 均 200；Wuxin /api/health 正常
```

### 2.3 部署记录与回滚

- 构建：`scripts/build-all.ps1 -Bot yumu`（Maven clean package → `target\nowbot-linux.jar` → 覆盖 `artifacts\yumu\nowbot-windows-v0.8.3-source-build.jar`）。
- 重启方式：停旧 java（命令行匹配 `nowbot-windows`）→ `start-all-recovery.ps1`（或直接 `java --enable-preview --enable-native-access=ALL-UNNAMED -Djava.io.tmpdir=<root>\data\yumu\tmp -jar ... --spring.config.additional-location=<root>\configs\private\yumu\application.yaml`）。
- 注意：`Start-Process -ArgumentList` 直接传参会导致进程秒退（无日志）；用 start-all-recovery 或前台运行即可。
- 回滚：上一版本 jar 未单独备份（构建时被覆盖）；旧包可从 `artifacts\yumu\nowbot-windows-v0.8.3-source-build.jar.bak-20260801-072201`（07-30 版）或从 git commit `01c0526` 重新构建恢复。

## 3. Wuxin 侧 Phase A：能力→工具映射层

| 文件 | 内容 |
|---|---|
| `server/bots/agentCapabilities.ts`（新） | `AGENT_CAPABILITY_META`（12 条：callable/description/sideEffects/rollout）；`callableCapabilities()`；`buildQueryOsuDescription()`；`auditAgentCapabilityRegistry()` 一致性门（META_WITHOUT_EXECUTOR / EXECUTOR_WITHOUT_META / DUPLICATE / NON_READONLY / INVALID_ROLLOUT） |
| `server/bots/registry.ts` | `buildBotToolSchemas` 的 query_osu 描述与 capability enum **从 meta 派生**（不再手写）；参数 schema 增 beatmap_id/mods/accuracy/combo/misses/limit |

约束：不改 CommandDescriptor；权限与 rollout 分离（meta 只有 rollout 字段，业务权限仍走 validateOperation / 命令权限）。

## 4. Wuxin 侧 Phase B：三个谱面域 capability

| capability | 后端 | 返回 |
|---|---|---|
| `beatmap_lookup` | osu API v2（getBeatmap + getBeatmapAttributes） | 谱面事实（标题/mapper/状态/星数/BPM/时长/物件/AR/OD/CS/HP/max combo）+ 带 mod 官方星数 |
| `pp_calc` | yumu `/pub/map/calculate`（rosu） | estimated_pp + 分解 + acc 阶梯 + 带 mod 属性，**明确"估算，不是官方精确 pp"** |
| `leaderboard` | osu API v2（getBeatmapScores） | 全球榜前 N（用户/pp/acc/combo/mods） |

- 实现：`server/bots/beatmapCapabilities.ts`（新）+ executor 路由（query_osu 内三个分支）。
- 白名单：`server/bots/guard.ts` —— beatmap_id 必填；player 参数（username/bp_*）与 beatmap 参数互斥；accuracy 0-100、combo ≥0 整数、misses 0-999、limit 1-50；mods 成对字母 ≤16 字符；accuracy/combo/misses 仅 pp_calc、limit 仅 leaderboard。
- 遥测：`executor.ts` 新增 `recordUnmetCapability`（NO_TOOL_MATCH / TOOL_NOT_CAPABLE / TOOL_ARGUMENT_UNRESOLVED / TOOL_PERMISSION_DENIED），写入 `db.unmetCapabilities`（cap 2000，store 初始化 + retention 同步）。
- persona：pp_calc 指引 + 谱面域指引（引用数值逐字一致、禁止编造）。

## 5. 验证证据

| 检查 | 结果 |
|---|---|
| `tools/query-osu-policy-verify.mjs` | 63/63（新增 beatmap 合法/非法参数 20 项） |
| `tools/agent-capability-verify.mjs`（新） | **32/32**（一致性门 + 派生 schema + meta 纪律 + 遥测三态写入断言） |
| `tools/beatmap-capability-verify.mjs`（新） | 6/6（真实句子 replay：这图多少星 / hr之后多少星 / 99acc fc多少pp / 95.2acc 1miss / 榜一多少 / 前十是谁） |
| `tools/natural-chat-delivery-verify.mjs` | 10/10 |
| `tools/quick-router-verify.mjs` | 121/121 |
| `tools/kb-verify.mjs` | 56/56（persona 变更后基线已重固化） |
| `tsc --noEmit` | PASS |
| `npm run verify-all` | **69/69 PASS**（含 2 个新 verify；遥测修复后最终一轮见下文） |

## 6. 部署边界与红线

- **yumu**：已提交（`f6b513b`）+ 已部署（19:54 起新 jar 运行中）。
- **Wuxin**：已提交（`f25999f` + `ebcaca7` + 遥测修复提交）；**运行中进程仍是 Phase B 前代码**——pp_calc 等三个 capability 在重启前不可用。
- 流程：重启 Wuxin（`tools/restart-wuxin.ps1` 或 `启动Wuxin.bat`，需用户确认）→ 健康核查。
- 部署后建议在群里实测一次："这图多少星 / 99acc fc 多少 pp / 榜一多少"。

## 7. 已知边界

- `beatmap_lookup` 的带 mod AR/OD/CS 不在 osu attributes 响应内（只有星数/max_combo）；需要时用 pp_calc（rosu 给 ar/od/hp）。
- pp_calc 只支持 osu!std（yumu 端点 mode=osu 固定）；其他模式后续按需求扩展。
- leaderboard 是文本版；面板图走 `!l` 快捷指令（雨沐）。
- 遥测只记录"LLM 尝试调用但失败/不支持"；自然语言 unmet intent 的自动分类（用户没触发工具就问了）不在本期范围，仍依赖日志审计。
- yumu 端点依赖本地 8388；Wuxin 侧 30s 超时 + 失败如实说（不重试不编造）。
