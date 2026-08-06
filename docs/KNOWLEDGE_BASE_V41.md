# WuxinBot 综合知识库 v4.1（BM25 三集合）

## 定位

知识库是 **可旁路的增量层**：总开关关闭时，`buildPrompt` 输出与接入前逐字节一致；`osu_analysis` 场景在任何加载/检索之前短路（零索引、零日志、零注入）；`osu_domain` 加载/检索失败时回退原有 `buildOsuTopicKnowledge` 关键词路径。Analyze V89 未修改。

## 三集合

- `wuxin_self`：14 条功能/指令说明（canonical 命令语法置顶，`commandExamples` 经真实注册表验证）。
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

`none / wuxin_self / osu_domain / community_style / self_and_domain / osu_casual_with_domain`。

- 命令、确定性结果、`osu_analysis`、serious：`none`。
- 功能提问：`wuxin_self`；osu 概念定义/机制提问：`osu_domain`；策略型 osu 提问：`osu_casual_with_domain`；功能+概念组合提问：`self_and_domain`；普通闲聊/吐槽/短反应：`community_style`（由 minScore/minDistinctQueryTokens 控制零注入）。
- `/w` 前缀但属于功能提问的消息按提问处理，不当作可执行命令。

## 检索与注入

- BM25 与 Python 黄金实现一致：k1=1.2、b=0.75、`idf=log(1+(N-df+0.5)/(df+0.5))`、token 为英文 3+ 小写词 + 中文相邻双字 bigram（文档按唯一 token 集合计）。
- 阈值唯一来源：manifest `content.retrievalConfig`（运行时不静默覆盖，v1 不支持在线改阈值）。
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
npx tsx tools/kb-verify.mjs   # 独立验收（10 项门槛 + 黄金对拍 + 62 路由场景 + 命令新鲜度）
npm run verify-all            # 全量回归（自动包含 kb-verify）
npm run typecheck
```

`tools/fixtures/kb-legacy-prompts.json` 是接入前固化的 8 个场景 system prompt；`kb-verify` 以严格字符串相等验证 KB 关闭时无任何行为变化。

## 上线前必做

1. 用校准集调 `retrievalConfig`（当前为初值），重新构建并人工审阅 A/B 报告；
2. 保持 `settings.kb.enabled=false` 部署；
3. 你审完报告后按部署顺序放量，不要反复重置。
