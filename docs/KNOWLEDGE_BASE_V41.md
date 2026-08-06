# WuxinBot 综合知识库 v4.1（BM25 三集合）

## 指令知识单源化（v4 实施基线）

所有指令收敛为纯元数据目录 `server/bot/commands/`：

- `types.ts`：`CommandNamespace / CommandPermission / CommandVisibility / CommandDiscoverability / CommandStatus / CommandExecution / CooldownPolicy / CommandAddress / CommandHelpEntry / KnowledgeDocumentKind / CommandPermissions`。生命周期（active/deprecated/disabled）、执行方式（local/proxy/documentation_only）、可见性（public/group_admin/owner/hidden）、可发现性（listed/direct_only/hidden）四者正交，不再使用 `implemented` 布尔值。
- `commandConstants.ts`：冷却完整策略单源化（`ANALYSIS_COOLDOWN / RECENT_COOLDOWN / RECOMMEND_COOLDOWN`，含 ms/scope/resettableBy）；运行时冷却器与元数据读同一对象。
- `alias.ts`：`normalizeAlias` 与解析域冲突键（`!`/`/`/`none`）唯一事实。
- `quick.meta.ts`：quick 注册表纯数据迁移，`resolveQuickCommand` 纯解析器与 `quickRouter.matchQuickCommand` 语义一致。
- `osu.meta.ts`：`OSU_SUBCOMMANDS` / `OSU_CLEAR_ACTIONS_META` 及其派生 ID；`parseOsuCommandText` 纯解析器。
- `owner.meta.ts`：`OWNER_COMMANDS`（从 helpDefs + defaultCommandPermissions 转录）+ `parseOwnerCommandText`（共享 commandPath 精确分发、成员策略别名）。
- `index.ts`：`getAllCommandHelpEntries` 归一化导出、`commandDocumentId` 稳定 ID（`cmd:quick:!:bs` / `cmd:wuxin:help` / `cmd:wuxin_osu:bind` / `cmd:wuxin_osu:clear.cache` / `summary:osu:public`）、`commandKnowledgeText` 固定渲染模板、`buildCapabilitySummaryDocs` 分层摘要。

约束：

- `*.meta.ts` / `commandConstants.ts` / `alias.ts` 只允许导入 `./` 且解析后仍在 `server/bot/commands/` 内；禁止 db/fs/net/logger/运行时 handler。kb-verify g14 做静态白名单 + 隔离导入（不写 db.json）双重校验。
- `/w help`、`/w osu help`、KB 文档、能力摘要、测试 fixture 全部复用 `canViewCommand` / `canListCommand`（`direct_only` 仅对拥有执行权限的调用者列出，但普通用户可直接询问）。
- 能力总览问题（你能做什么/有什么功能/会哪些指令）走 `capability_summary` 路由，只检索当前权限层级对应的 `summary:all:<audience>` 单文档（public ⊂ group_admin ⊂ owner 累积视图），多份摘要不参与同一 BM25。
- KB 版本语义：进程启动时若 `KB_ENABLED=false` 完全跳过；否则**无条件读取一次 `CURRENT`** 固定 buildId（不读文档、不建索引）。运行中数据库开关放开时只能加载启动时固定的 buildId，`CURRENT` 后续变化忽略；启动时无有效 buildId 则 fail closed，必须重启。不做热更新、不实现 `/w kb reload`。
- `clear cache`：`permission: owner`、`visibility: public`、`discoverability: direct_only`；严格解析（裸 `clear` / `caches` / `cache xxx` 均不执行）；权限检查在任何清理动作之前。
- 新增/修改指令的标准流程：补元数据 → `npx tsc --noEmit` → kb-verify（含 commandExamples 纯解析器校验、解析域冲突、status×execution 组合表、冷却单源、meta 纯度、分层摘要）→ 重建 KB → 回归。

## 定位

知识库是 **可旁路的增量层**：总开关关闭时，`buildPrompt` 输出与接入前逐字节一致；`osu_analysis` 场景在任何加载/检索之前短路（零索引、零日志、零注入）；`osu_domain` 加载/检索失败时回退原有 `buildOsuTopicKnowledge` 关键词路径。Analyze V89 未修改。

## 三集合

- `wuxin_self`：14 条手工功能/边界说明 + 由 `CommandDescriptor` 自动生成的叶子命令文档（含 canonical 语法/用途/权限/冷却/使用限制）+ 15 条分层能力摘要（all/osu/quick/profile/administration × public/group_admin/owner）。构建时跳过 wuxin 帮助目录里的 osu 重复条目，摘要按语法去重；`commandExamples` 经纯解析器（quick/osu/owner）+ 运行时 matcher 双重验证，跨 bot 同 alias 的示例必须精确命中本条目。
- `osu_domain`：31 条领域知识（由 `server/osu/knowledge` 的 core/topics/mods 条目派生）。
- `community_style`：17 条已批准 V2 窗口（24 条中剔除含占位符/URL/QQ 号/转发块的 7 条；`[表情N]` 占位符被剥离）。

## 构建

```powershell
npx tsx tools/kb-build.mjs                 # 生产数据目录（DATA_DIR 或 %APPDATA%\Wuxin）
npx tsx tools/kb-build.mjs --data-dir <dir> # 显式目录（测试/部署隔离）
```

产物模型（Windows 安全）：

```text
<data-dir>/knowledge/
├─ CURRENT                     # 指针文件：当前 content SHA
└─ builds/<content-sha>/
   ├─ wuxin_self.json
   ├─ osu_domain.json
   ├─ community_style.jsonl
   └─ manifest.json             # content（可复现）+ build（generatedAt/git commit）
```

构建先生成 `builds/<sha>.tmp` → 校验 → 改名 `builds/<sha>` → 原子写 `CURRENT`。运行时读取 `CURRENT`，校验 manifest content SHA 与各文件 SHA-256 后才可用；未过哈希校验即隔离失败。

`lastVerifiedAt` 只在人工核验时修改，构建脚本不自动写当前时间。`implementationRefs` 只使用仓库相对路径 + 符号名。

## 开关（免重启）

- `KB_ENABLED=false`：启动级硬禁用。
- `db.settings.kb.enabled`：运行时总开关（每请求读取，数据库读取失败即 fail closed）。
- `<data-dir>/knowledge/DISABLED`：本机 sentinel 兜底（≤1s TTL 缓存，文件存在或检测出错一律关闭）。
- `db.settings.kb.rollout`：`off | allowlist | all`，`groupIds` 只存数据库，日志/健康页只显示群号 hash。
- `db.settings.kb.collections`：按集合开关。

部署顺序：代码上线且总开关关闭 → allowlist 测试群 → `wuxin_self` → `osu_domain` → `community_style` → `mode='all'`。全程数据库开关，无需重启、无需重置。

## 路由（封闭枚举）

`none / wuxin_self / osu_domain / community_style / self_and_domain / osu_casual_with_domain / capability_summary`。

- 命令、确定性结果、`osu_analysis`、serious：`none`。
- 能力总览提问（你能做什么/有什么功能/会哪些指令）：`capability_summary`（仅检索当前权限层级的 `summary:all:<audience>`）。
- 功能提问：`wuxin_self`；osu 概念定义/机制提问：`osu_domain`；策略型 osu 提问：`osu_casual_with_domain`；功能+概念组合提问：`self_and_domain`；普通闲聊/吐槽/短反应：`community_style`（由 minScore/minDistinctQueryTokens 控制零注入）。
- `/w` 前缀但属于功能提问的消息按提问处理，不当作可执行命令。

## 检索与注入

- BM25 与 Python 黄金实现一致：k1=1.2、b=0.75、`idf=log(1+(N-df+0.5)/(df+0.5))`、token 为英文 2+ 小写词（含 PP/AR/HD/HR/DT 等两字母 osu 术语，纯数字不索引）+ 中文相邻双字 bigram（文档按唯一 token 集合计）。tokenizerVersion=`v3-cjk-bigram`：剔除无领域含义的泛化疑问/连接 bigram（`怎么/什么/是什/为什/和有`），避免小语料中高频疑问词以高 IDF 反超真正含 `bonus+pp`、`hd+hr` 的文档。
- 阈值唯一来源：manifest `content.retrievalConfig`（运行时不静默覆盖，v1 不支持在线改阈值）。
- 权威标签锚点：若查询 token 命中文档手工维护的 `tags`（标签比较前去除 `!/+` 等命令标点；结构型通用 tag `command/osu/wuxin/quick/快捷指令` 不参与锚点），优先按标签选取 topK，不受 minScore/minDistinctQueryTokens 限制（score>0 仍要求正文词面重叠）；无标签命中才回退 BM25 minScore/gap 路径。这解决“AR 是什么”只剩单 token、`bonus pp` 被“是什/什么”反超、HT 文档靠“和有/BPM”误入 HD/HR/BPM 查询、以及所有快捷指令因“已绑定 osu! 账号”样板句抢占绑定查询等问题。
- 查询构造 `queryBuilderVersion=1`：从当前消息倒序取最多 5 条真人文本、累计 500 字符截止、排除 Bot/系统/纯命令/纯媒体、保留时间顺序、当前消息最后、分隔符 `\n---\n`、剥离 CQ/QQ 号/URL。
- 配额（A6）：`wuxin_self` 800 / `osu_domain` 900 / `community_style` 400–600 / `self_and_domain` 750+600 / `osu_casual_with_domain` 400+500，总量 ≤1500；截断顺序：减文档 → 文档边界 → 单篇正文；canonical 命令行不中截；围栏字符单独计量。
- Prompt 层 `PromptKnowledgeBlock` 只含 `sourceClass/title/text`，不暴露 documentId/window_id/SHA/cluster/内部路径；社区文本带围栏（不得逐句引用、近似复述，不得声称是真实成员说的）。
- 日志只记录元数据（route/reason/collection/documentIds/scores/dropReasons/injectedChars/elapsedMs/groupHash），不记录原始查询与正文。

## 健康/状态

`GET /api/kb/status`（全局 admin 密码保护）与 `/api/diagnostics` 返回：

- 各集合 `disabled | not_loaded | loading | ready | failed` + 文档数 + errorCode；
- 当前 content SHA、加载时间、构建时间、retrievalConfigVersion；
- 最近一次 `KbEnableDecision` 的来源（env/sentinel/db/db_unavailable/collection/rollout/scene）。

不显示堆栈、绝对路径、坏行、社区文本或 git 敏感信息。

## 测试

```powershell
npx tsx tools/kb-verify.mjs   # 独立验收（18 项门槛 + 黄金对拍 + 67 路由场景 + 纯解析器命令新鲜度 + A6/A8/A9）
npm run verify-all            # 全量回归（自动包含 kb-verify）
npm run typecheck
```

`tools/fixtures/kb-legacy-prompts.json` 是接入前固化的 8 个场景 system prompt；`kb-verify` 以严格字符串相等验证 KB 关闭时无任何行为变化（A1 双轨制：代表场景硬门槛 `expect(newPrompt).toBe(legacyPrompt)`，只有含动态字段的场景才允许受控规范化）。

kb-verify 额外门槛：

1. `osu_analysis` 零加载零注入零日志；
2. community_style 每查询 ≤1 条；
3. 组合路由必须显式 route kind；能力总览返回且只返回 1 条对应 audience 摘要；
4. manifest content 可复现，build 元数据易变；
5. 未过哈希校验不可用；任一集合失败不影响旧功能；
6. commandExamples 纯解析器验证 + 运行时 matcher 一致性；
7. 解析域内 document id 唯一；status×execution 组合表合法；
8. 冷却 ms/scope/resettableBy 与 `commandConstants` 对象同一；
9. meta 静态依赖白名单 + 隔离导入无副作用；
10. `canViewCommand`/`canListCommand` 在 help 与 KB 两入口一致，普通用户 fixture 中 owner/group_admin 文档为 0；
11. 分层摘要按 audience 单选且内容为累积视图；
12. `clear` 四类输入解析 fixture；
13. 构建产物按 ID 排序且确定性一致。

注意：`verifyProductionDbUnchanged` 在检测到本机有正在运行的 `server/index.ts` 进程时会放宽为警告（生产写入归因于运行中的 bot，测试代码始终 DATA_DIR 隔离；无 live server 时仍严格校验）。

## 上线前必做

1. 用校准集调 `retrievalConfig`（当前为初值），重新构建并人工审阅 A/B 报告；
2. 保持 `settings.kb.enabled=false` 部署；
3. 你审完报告后按部署顺序放量，不要反复重置。
