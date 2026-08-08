# WuxinBot 交接文档（Analyze v83 接手 → 2026-08-08）

最后整理：2026-08-08（Asia/Shanghai）

主项目：`REDACTED_REPO_ROOT`

本地 Bot 部署与运维：`REDACTED_BOTS_ROOT`

本机运行数据：`REDACTED_USERPROFILE\AppData\Roaming\Wuxin\db.json`

> 本文记录的是**从接手 GPT 的 Analyze v83 冻结点以来**，到 2026-08-08 为止的全部开发、运维与遗留事项。若与更早的交接文档冲突，以本文、最新 git 历史与当前代码为准。本文不包含任何密钥、密码或 token。

---

## 0. 一句话现状

WuxinBot 现在是"一个入口（pippi）+ 四台本地 osu! Bot 桥接 + 三层知识体系"的组合：Analyze 已稳定在 v89（生成器/reviewer 均为 deepseek-v4-flash 正式版）；知识库 v4.1（BM25 三集合）代码已上线但生产默认关闭；指令元数据已完成单源化（CommandDescriptor）；NapCat 使用独立 profile + patched shell，但 QQ 账号 REDACTED_QQ_002 近期被腾讯高频踢下线，需要扫码重登。

**当前有一批未提交改动（工具调用审计 / bp_type 确定性路由 / 玩家目标解析与 `@` 路由 / Reviewer hard-error 降级 / Analyze 队列恢复 / osuClearCache owner 锁死），已通过 46/46 完整隔离验证，但尚未提交、尚未重启部署。**

---

## 1. 接手时的基线：Analyze v83

### 1.1 时间点

- v83 迭代产物：`artifacts/osu-analyze-evals/2026-08-01T18-46-21-802Z-iteration-16b-flash-v83`（2026-08-01 18:46）。
- v83 冻结对照：`artifacts/osu-analyze-evals/checkpoint-v83-freeze-20260802`（2026-08-02 02:47 生成，含 mrekk / [SHK]Wuxin / ahahhaha 三份最终输出、逐份 metadata 与 `baseline-v83.diff`）。
- 接手后首个提交：`a7af2bf feat(osu-analyze): v89 pipeline - persona refresh, hard-fact gating, LLM surgical repair`（2026-08-02 08:05）。

### 1.2 接手时的已知问题（历史背景）

- validator 持续膨胀：正则/词表越加越多，误杀与漏洞交替出现；
- fallback 率偏高、结论复读前七栏、模板化严重；
- 生成链路长（七栏 + 结论 + 多轮 reviewer/重写），单人分析成本高；
- v79 九人真实回归未通过，尚未进入盲测；
- 用户已拍板：停止"单词/短语/否定前缀/修辞补丁"路线，validator 改为小型高精度事实保险层。

---

## 2. 当前系统全景（2026-08-08 实测）

### 2.1 三层架构

```text
QQ 群消息
  → NapCat（pippi 账号 REDACTED_QQ_002，OneBot HTTP 3000 / WS 3001）
  → server/onebot.ts
  → server/bot.ts
       ├─ /w 指令        → server/osu/commands.ts、server/bot/ownerCommands.ts
       ├─ 快捷指令        → server/bot/quickRouter.ts（确定性，不走 LLM）
       │                    └─ localBridge 桥接 雨沐/猫猫/消防栓/LazyBot 原渲染
       ├─ osu 数据工具     → executor.ts（query_osu / bp_type / oracle…）
       └─ 普通聊天        → pippi persona v2 + 知识库（可旁路）+ DeepSeek
```

### 2.2 服务与端口（均为本机回环）

| 端口 | 服务 | 说明 |
| --- | --- | --- |
| 8787 | Wuxin 后端 | portable-node v22（禁止系统 Node 20） |
| 5173 | Wuxin GUI | Vite |
| 3000/3001 | NapCat OneBot | HTTP / WebSocket |
| 6099 | NapCat WebUI | |
| 8388 | 雨沐 YumuBot | PostgreSQL |
| 8800 | 消防栓 Hydrant | PostgreSQL |
| 7700 | 猫猫 KanonBot | |
| 1145 | LazyBot | MariaDB |
| 9001 | PP+ aggregate | 猫猫/LazyBot 共用，Aloic 本地聚合 |
| 5432 / 3306 | PostgreSQL / MariaDB | |

### 2.3 账号与身份

- bot 发言账号（pippi）：`REDACTED_QQ_002`
- owner：`REDACTED_QQ_001`
- 群管权限来自 OneBot `sender.role`（owner/admin），仅限本群
- 桌面 QQ（`D:\AppFile\QQ`）是 owner 本人账号，与 bot 无关，操作时必须区分

---

## 3. 开发时间线（v83 接手后）

### 3.1 Analyze v83 → v89（2026-08-01 晚 ~ 08-02 早）

**v84：validator 大减法（A/B 验证）**

- 删除 `causePattern` 动机/状态大词表、PP+ 能力化系列、偏好/NM 价值化、Mod 动机、稳定断言、萌新词表、档位/群体比较、追星动作、社区用语黑名单、全部单句补丁；
- 保留 A 类硬门（数字白名单、PP+ 维度-数值绑定、Mod 数量、分类数量、星数阈值、BP1 满准、统计夸写、结构/JSON、身份代词、术语、简报未提供内容）+ 4 条 B 类通用规则；
- reviewer 改为只记录 `reviewLog`，不再触发重写/降级；
- 生成轨迹记录每次 attempt 的 raw draft。

**v85：三锚点 ×3 → 九人黄金回归 → 八人盲测 → 随机十人**

- 三锚点 9/9 LLM、0 fallback、首稿直通 8/9（88.9%）；
- 九人黄金 9/9 LLM、0 fallback；
- 八人盲测 8/8 LLM、0 fallback（Akari Date / windpipeey / [SHK]Mriyu / MALISZEWSKI / Junmoyan / Miko_Parsley / qqfrr / lolol233）；
- 随机十人 10/10 LLM（种子 20260802，名单见 `random-ten-pool-2026-08-02.json`）；
- 修复：数字"万"归一化损坏、星数 claims 串线、98% 对称漏判、NM 全覆盖、HD 写成"隐身"漏网。

**v86 → v89：收口**

- v86 profile-order、v86/v87 regression、v88/v89 repair 产物均在 `artifacts/osu-analyze-evals/`；
- 最终 v89 pipeline 主题：persona refresh（persona v2 落地）、hard-fact gating（硬事实门）、LLM surgical repair（局部修复而非整篇重写）；
- `ANALYSIS_FORMAT_VERSION = 89`（`server/osu/commands.ts`）；
- 8/2 08:05 一次性提交 `a7af2bf`（含全部代码与 84 版迭代评估产物，438 文件；产物后来在 8/7 移出 git）。

### 3.2 四 bot 桥接与命令体系（8/1 ~ 8/7）

- M1 quick-command 注册表与前缀路由（`!` 猫猫∪雨沐、`/` LazyBot、无前缀/查@ 消防栓）；
- localBridge 直连原 Bot 保留原渲染：雨沐 `!r` 完整面板、猫猫 `!re`、LazyBot、消防栓；
- 点名路由：先确定性映射（"用猫猫查…"→kanon），LLM 自主填 bot 只作兜底（实测 LLM 会选错工具）；
- 绑定体系：`/w osu bind` 单入口 + 23 条一次性绑定导入 + 桥接用户名注入；
- `!ml` 观战迁移（Wuxin 轮询监听 + yumu-image E7/F3 渲染 + MatchRating 移植）、`!ra` 桥接；
- 按群开关单个 bot（quickRouter 群级过滤 + GUI osu 界面开关）；
- 8/7 `!update` 桥接到猫猫 Kanon（带绑定注入）。

### 3.3 聊天质量与稳定性（8/2 ~ 8/5）

- pippi persona v2（身份/场景/语言风格完整重写）；
- 回复合并规则：只有拆成 2+ 条消息时才 merge-forward，单段回复保持普通消息；raw tool payload 不进自然聊天；
- DeepSeek 禁用隐藏思考（延迟 10.8s→3.4s，消除空回复）；
- recent 查询实时化，堵住快照缺 `recentSummary` 导致的 LLM 误判；
- 等级系统重做：等级 = pp 数（无上限），升级提示由 pippi 结合真实 pp 生成（排队机制，不单独弹）；随后多轮修复 prompt 泄漏、调性、示范格式、旧数据迁移；
- 推图推荐 MVP：实时协同过滤 + LLM 包装 + BID 强制交付 + 工具失败不再走 LLM（堵死编造链）+ 冷启动 98s→26s；
- 快捷指令结果写入对话上下文，pippi 能记忆查询者与结果。

### 3.4 社区语料与知识库 v4.1（8/5 ~ 8/6）

- `community-corpus` 管道：脱敏（token/群号/画像/转发/邀请全量清洗）、窗口切分、去重、分层（usage tiers）、安全标注导出、XLSX 审查表；V2 选出 24 条用户批准风格候选；
- 社区 banter bank 进入 casual 场景；
- KB v4.1（`docs/KNOWLEDGE_BASE_V41.md`）：BM25 三集合（`wuxin_self` 14 条手工 + 自动命令文档 + 15 条分层摘要 / `osu_domain` 31 条 / `community_style` 17 条）；
- 开关体系：`KB_ENABLED=false` 启动级硬禁、`db.settings.kb.enabled` 运行时熔断、`DISABLED` sentinel 兜底、rollout（off/allowlist/all）；
- `osu_analysis` 场景在任何加载/检索之前短路（零索引/零日志/零注入）；
- 生产写入/删除守卫（fsSafe）、推荐过滤（recommendFilters）；
- tokenizer v3：CJK bigram + 停用词 + 权威标签锚点（修复 PP/AR/HD/HT 等短词检索）；
- 8/6 移除纯文本视觉模式指令（视觉模式指令用户要求删掉，保留图片占位符防编造提示）。

### 3.5 指令单源化（8/6）

`server/bot/commands/`：

- `types.ts`（权限/可见性/可发现性/生命周期/执行方式/冷却/地址/文档类型正交化，删除 `implemented` 布尔）；
- `commandConstants.ts`（冷却完整策略单源：`ANALYSIS_COOLDOWN` / `RECENT_COOLDOWN` / `RECOMMEND_COOLDOWN`）；
- `quick.meta.ts` / `osu.meta.ts` / `owner.meta.ts`（纯数据，命令 ID 从 descriptor 键派生）；
- `alias.ts`（解析域冲突键：`!` / `/` / `none`）；
- `index.ts`（`getAllCommandHelpEntries`、`commandDocumentId`、`commandKnowledgeText`、`buildCapabilitySummaryDocs`）；
- 约束：meta 文件静态依赖白名单 + 隔离导入测试；`/w help`、`/w osu help`、KB、能力摘要、fixture 共用 `canViewCommand` / `canListCommand`。

### 3.6 数据安全与运维（7/31 ~ 8/8）

- 7/31：db 污染事故（fakegroup 清理相关，`incidents/db-contaminated-20260731-063345.json`、MariaDB errorlog 存档）；
- 8/4：db 自动备份（5 分钟间隔、保留 24 份），防零填充损坏；
- 8/6：db.json 损坏自动恢复（从自动备份）；NapCat 改用 patched shell + 独立 profile（`REDACTED_NAPCAT_DIR`）+ 快速登录；
- 8/7：artifacts 移出 git 跟踪（`c79ee52`，本地保留）；store retention caps（messages 12000 / decisions 30000 / commandLogs 2000 / adminActions 1000）；验证套件离线化（共享 osu API mock）；
- 8/8：腾讯多次踢号 → 恢复脚本、每 5 分钟在线监测、二维码扫码流程（详见第 6 节）。

### 3.7 2026-08-08 代码审查与 P1 修复

- BP 类型自然语言目标支持带空格用户名，例如 `Akari Date`、`[SHK] Pain boy`；
- 纯 `@` 查询优先解析被提及玩家，过滤仅用于唤醒机器人的 self QQ；`查 @某人 的 BP 类型` 不再被消防栓资料快捷路由截走；
- 玩家名比较保留合法方括号字符，`[A]same` 与 `[B]same` 不再合并；仅允许请求者省略绑定用户名的前置社区标签；
- 独立 Reviewer 从“只记录”改为最终 hard-error 门：被拒栏目局部替换成确定性事实短评，结论被拒只替换结论，其他 LLM 内容保持不变；未知栏目标签才整份降级；
- Analyze 队列使用 `finally` 清理运行状态，即使报告和失败通知都发送失败也不会永久卡住队列；
- 新增/扩充目标解析、带空格用户名、`@` BP 类型路由和 Reviewer 局部降级 fixture；
- `npm run typecheck`、全部定向测试和 `npm run verify-all` 均通过；完整结果为 **46/46**，测试使用临时 `DATA_DIR`，未写生产数据库。

---

## 4. 当前未提交改动（重要，勿动）

`git status` 当前代码/测试改动如下（2026-08-08，P1 修复后）：

```text
M server/bot.ts
M server/bots/bpTypeAnalysis.ts
M server/bots/executor.ts
M server/bots/intent.ts
M server/osu/commands.ts
M server/store.ts
M server/types.ts
M tools/bp-type-analysis-guard-verify.mjs
M tools/intent-verify.mjs
M tools/osu-fixture-verify.mjs
M tools/store-retention-verify.mjs
?? tools/player-target-verify.mjs
```

内容：

1. **工具调用审计**：每次 `query_osu`（含确定性 required-tool 路由）写入 `db.toolCallLogs`（capability/args/ok/error/contentLength/latencyMs/群/人/消息），上限 `MAX_TOOL_LOGS=5000`，审计失败不影响聊天路径。目的：回答"到底走没走 osu_oracle"不再靠猜。
2. **bp_type 确定性路由**：`detectBpTypeAnalysisIntent` + `extractBpTypeUsername` 覆盖显式 `osu_oracle` 调用话术（"调用osu_oracle检查[SHK]Boring的bp组成"），强制走 `query_osu capability=bp_type`，禁止 LLM 用上下文旧数据编造比例。
3. **玩家目标解析重写**：`resolveInternalPlayerTarget` 支持 `TargetResolutionExtra`（nickname/atTargets/groupId）；带空格用户名和纯 `@` 目标可正确解析；合法方括号不再被无条件删除；新增 `player-target-verify.mjs` fixture（防“把别人的数据按到自己头上”类事故）。
4. **Reviewer hard-error 处置**：Reviewer 明确判错的栏目不再原样发送，改为局部确定性降级；通过栏目不重写。
5. **Analyze 队列恢复**：发送失败路径通过 `finally` 释放 `running/currentEntry`，失败通知自身失败也被捕获。
6. **osuClearCache 权限锁死**：`normalizeDb` 强制 `osuClearCache: 'owner'`，数据库配置无法把全局缓存清理降到 owner 以下。
7. store retention 扩展到 `toolCallLogs`。

**红线：禁止 `git reset` / `checkout` / `clean`；禁止部署或重启后端之前先提交（用户要求先提交后部署）。**

---

## 5. 验证与测试体系

```powershell
npm run typecheck     # tsc --noEmit
npm run verify-all    # node tools/run-all-verifies.mjs（全部 verify 套件）
npm run sanity        # 基础集成
npm run security      # 安全回归
```

常用验证脚本（`tools/`）：

- osu：`osu-fixture-verify`（18+ 组 fixture + 硬门回归）、`osu-star-api-verify`、`osu-api-mock`（离线共享 mock）、`bp-rank-verify`、`bp-range-route-verify`、`bp-type-analysis-guard-verify`、`player-target-verify`、`recommend-verify`、`match-verify`、`natural-chat-delivery-verify`
- 路由/聊天：`quick-router-verify`、`intent-verify`、`processIncoming-deterministic-route-verify`、`search-routing-verify`、`repeated-history-verify`、`bot-harness-verify`、`named-bot-sandbox-verify`
- 知识库：`kb-verify`（18 项门槛 + 黄金对拍 + 67 路由场景 + 纯解析器新鲜度 + A6/A8/A9）、`kb-build`、`kb-calibrate`、`kb-ab-test`
- 可靠性：`store-retention-verify`、`store-concurrency-verify`、`backup-restore-verify`、`safety-guard-verify`、`security-verify`、`isolation-verify`、`test-isolation`、`queue-verify`、`experience-verify`、`vision-verify`、`onebot-verify` 等

KB 兼容性基线：`tools/fixtures/kb-legacy-prompts.json`（接入前固化的 8 个场景 system prompt），`kb-verify` 用严格字符串相等验证 KB 关闭时行为无变化（A1 双轨制）。

Analyze 评估体系：`tools/osu-analyze-eval.mjs`、`tools/osu-analyze-random-ten.mjs`；产物在 `artifacts/osu-analyze-evals/`（本地保留，已移出 git）。

---

## 6. 运维手册（本机）

### 6.1 启动

统一入口：`codex_work\napcat-local-bots\scripts\start-all-recovery.ps1`（登录自启：启动文件夹 `NapCat-Bots.lnk` → `start-all.cmd`）。

脚本按 数据库 → PP+ → 雨沐 → 渲染 → 猫猫/消防栓/LazyBot → NapCat → Wuxin → GUI → watchdog 顺序拉起，端口已在监听则跳过；每次生成 `logs/startup-*.log` 与 `recover-*.log`。

### 6.2 NapCat 登录与被踢

- 密码回退登录会因"需要验证码"失败（日志 `Login Error ErrCode: 3`），随后 NapCat 自动出二维码；
- 二维码保存于 `REDACTED_WORKSPACE\NapCat.Shell.Windows.OneKey\NapCat.44498.Shell\versions\9.9.26-44498\resources\app\napcat\cache\qrcode.png`，约 1-2 分钟自动刷新；
- **用户确认：每次都要人工扫码，不要宣称"自动登录成功"**；密码文件在 `REDACTED_WORKSPACE\其他杂物\password.txt`（不要明文展示）；
- 被踢特征：日志 `[KickedOffLine]`，监测 5 分钟内从 ONLINE → WS_ALIVE（HTTP 失效但 WS 可能还挂着）或 OFFLINE；
- 处理流程：确认 3000/3001 状态 → 若 NapCat 进程还活着且 3001 监听，脚本会跳过 NapCat，必须先停掉 `NapCat.44498.Shell` 目录下的 QQ.exe/NapCatWinBootMain 进程（PID 过滤 ExecutablePath，绝不碰 `D:\AppFile\QQ`）→ 再跑 `start-all-recovery.ps1` → 展示新二维码；
- 在线监测：`scripts\monitor-pippi-online.ps1` + 计划任务，每 5 分钟写 `logs\monitor-pippi-online.log`（只写日志不弹窗，用户明确要求）。

### 6.3 Wuxin 重启

- `tools/restart-wuxin.ps1` 或 `REDACTED_REPO_ROOT\启动Wuxin.bat`；必须用项目 `portable-node`（Node 22），系统 Node 20 有 happy-eyeballs 并发连接崩溃问题。
- Wuxin 守护：计划任务 `WuxinBackendWatchdog`（每 5 分钟）。

### 6.4 数据与备份

- 主数据：`%APPDATA%\Wuxin\db.json`（当前约 27MB）；自动备份 5 分钟间隔保留 24 份；损坏时从备份自动恢复；
- 历史事故备份：`incidents\`（db 污染、fakegroup 清理前后，保留勿删）；
- KB 构建产物：`<data-dir>\knowledge\builds\<content-sha>\` + `CURRENT` 指针（Windows 原子切换模型）。

---

## 7. 已知问题与风险

1. **腾讯高频踢号（当前最大运维风险）**：8/7-8/8 多次 `KickedOffLine`，账号疑似被重点关照；每次都要扫码，无法可靠免密。候选换号：Diaz / Butterfly（用户未最终决定）。
2. **未提交改动未部署**：第 4 节内容已通过本地验证，但尚未提交/重启，生产行为仍是旧逻辑（bp_type 显式 oracle 话术可能漏到 LLM）。
3. **PP+ 上游偶发 500**（`lol server goes boooom`），采集器有重试；pp+ 数值曾出现"缩水"疑云，最终确认为不同计算源/缓存问题，需继续观察。
4. **知识库仍默认关闭**：`kb.enabled=false`，部署开放需按 rollout 顺序（allowlist → wuxin_self → osu_domain → community_style → all），每次放开前跑 A/B。
5. **db.json 体积增长**：messages/usageEvents/画像样本占大头；已有 retention caps，但历史归档尚未做。
6. **仓库瘦身未完成**：artifacts 已移出跟踪；tools 一次性脚本、`tmp-*.mts`、`_old-test-backups` 仍留待处理（用户曾要求先不动）。
7. **Analyze 模型切换约束**：生成器/reviewer 固定 deepseek-v4-flash 正式版；切换模型必须重跑完整回归（黄金/盲测/随机），不能只比单次文风。
8. **P2 性能与次要正确性问题尚未处理**：`query_osu` 审计同步重写约 28MB `db.json`；PP+ 最长五分钟等待位于全局 Analyze 单队列前段；均衡 osu!oracle 分布仍固定写“倾向明显”；`bp_type` 仍重复加载一次玩家资料。

---

## 8. 下一步建议（按优先级）

1. 用户审阅第 4 节未提交改动 → 提交 → 部署重启；当前运行进程仍是 P1 修复前代码。
2. 决定换号候选或继续接受扫码；考虑把监测升级为自动提醒（当前只写日志）。
3. 继续 KB 灰度：allowlist 测试群先开 `wuxin_self`，收集数据再开其余集合。
4. 仓库瘦身后续：一次性脚本归档、临时文件清理、db 历史数据归档（需用户确认）。
5. Analyze 长期维护：以 v89 为基线，任何 persona/模型/数据源变更都必须走 `osu-analyze-eval` + 盲测回归。

---

## 9. 关键文件索引

### 交接与设计文档（`REDACTED_REPO_ROOT\docs\`）

- `WUXIN_HANDOVER_2026-08-08.md`（唯一当前总交接；冲突时以当前代码和测试为准）
- `KNOWLEDGE_BASE_V41.md`（知识库 + 指令单源化实施约束）
- `微调后黄金实例.txt`（Analyze 人工文风参考，不作为事实验收基线）

### 核心代码（`REDACTED_REPO_ROOT\server\`）

- `osu\analyzer.ts` / `osu\commands.ts`（Analyze v89）
- `bot\knowledgeBase.ts` / `kbRoute.ts` / `kbPrompt.ts` / `kbQuoteGuard.ts`（KB v4.1）
- `bot\commands\*.ts`（CommandDescriptor 单源化）
- `bot\quickRouter.ts` / `bots\executor.ts` / `bots\localBridge.ts` / `bots\registry.ts`（快捷指令与桥接）
- `bot.ts` / `store.ts`（入口与数据层）

### 部署与运维（`REDACTED_BOTS_ROOT\`）

- `scripts\start-all-recovery.ps1`、`scripts\monitor-pippi-online.ps1`
- `DEPLOYMENT_STATUS.md`、`STARTUP.md`、`LAZYBOT_HANDOFF.md`、`PPPLUS_INFO_V1.md`
- `四bot并入WuxinBot迁移方案.md`（M1 方案与词表）

### 评估产物（`REDACTED_REPO_ROOT\artifacts\`，已移出 git，本地保留）

- `osu-analyze-evals\`：v79→v89 全部批次（baseline/iteration/anchors/ab/golden/blind/random-ten/regression/repair + v83 checkpoint）
- `kb-ab\`：知识库 A/B 产物

---

## 10. 交接红线

1. 不提交/不部署未提交改动之前，禁止重启生产后端（用户明确要求）；
2. 禁止 `git reset` / `checkout` / `clean`（工作区有未提交改动与历史产物）；
3. 不把密钥、密码、OneBot token 写进任何文档或聊天；
4. 不碰桌面 QQ（`D:\AppFile\QQ`）与 owner 本人账号；
5. Analyze 任何改动必须跑 osu-fixture + 真实回归；模型切换必须重跑全套；
6. KB 生产开放必须按 rollout 顺序，不允许直接 `mode='all'`；
7. NapCat 登录只确认实际端口/连接状态，不把"已出二维码"当成"已登录"。
