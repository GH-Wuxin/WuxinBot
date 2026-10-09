# Changelog

## Unreleased

### 清理（代码考古第一批）
- **测试隔离三态被塌缩成 boolean，导致门禁对自己说谎**。`tools/test-isolation.mjs` 的 `classifyProductionSnapshot` 本来就返回 PASS / FAIL / INCONCLUSIVE 三态，`recordIsolationResult` 也会为 INCONCLUSIVE 设好退出码 2，但 `verifyProductionDbUnchanged` 最后一行把它压成 `status === 'PASS'`。于是"无法证明生产库未被修改"在约 15 个调用点被当成**"生产库被改"硬失败**：只要机器上跑着 Wuxin（开发机的常态），门禁就永远红，而且会打印与事实相反的消息 —— 实测 `agent-tool-surface-hardening-verify` 在 before/after scope sha256 **逐字节相同**的情况下仍打印 `production db changed`。现在只有**被证实**的修改才算失败，INCONCLUSIVE 保留自己的状态与退出码 2；同时删掉 8 个 verifier 里把这枚 boolean 当结论打印的 `[isolation] production db unchanged: …` 行（`recordIsolationResult` 已经打印了权威的 `RESULT=` 行）。`tools/test-isolation-verify.mjs` 新增 4 条契约测试锁住这三态，防止塌缩回潮。
- **删除约 1,570 行死代码**。`server/osu/commands.ts` 的 `OSU_HANDLERS` 只登记 bind/analyze/clear/help，`handleOsuRecent`、`runLegacyAnalysis`、`runAnalysis` 三个函数**全仓零调用者**（编译器 `--noUnusedLocals` 独立证实）。删除它们后编译器逐层暴露出整条旧分析链：`generateConclusion`(131 行)、`generateAnalysisSectionComments`(206 行)、`reviewFullReport`(66 行)、`repairFailedText`、`findAnalysisStyleReuse`、`rejectedSectionKeys` 等 —— 该文件由 2,070 行降至 898 行（**−1,172 行**）。连带 `server/osu/oneLineReview.ts`（**332 行**，其 7 个导出全部只被已删的 `runAnalysis` 使用）与其验证器（69 行）一并删除。文档 `docs/WUXINBOT_PROMPT_REVIEW_AUDIT_V01.md` 曾把 `runAnalysis` 描述成"现行 analyze 管线"，实际现行路径是 `runMvpAnalysisCommand`。
- **清掉 81 处编译器证实的死声明，并把这个检查加进门禁**。`npm run typecheck` 只跑 `tsc --noEmit`，"声明了但从未读取"完全不可见。清理 `gate.ts`(26 处，含 :5-19 一整片无人使用的 import)、`queue.ts`(5 个 import 块整块未用)、`owner/profile.ts`(10 处 `const x = ctx.x`)、`index.ts`(导入了 `decideReply`/`buildPrompt`/`callLLM` 却从不使用) 等之后，`typecheck` 脚本改为 `tsc --noEmit --noUnusedLocals`，现在全仓 **0 处**，且不会再退化。
- **把"grep 源文本"的断言换成真调用**。`tools/prompt-review-slim-phase0-verify.mjs` 有两条断言直接读取 `server/osu/commands.ts` 的**源文本**，检查里面是否还包含 `ENABLE_RUNTIME_LLM_FACT_REVIEW = true` 与 `v.kind !== 'quality'`。源文本断言只会在有人编辑该文件时失败，**从不会因行为变化而失败**，而它们钉住的正是编译器已证实不可达的旧 reviewer 分支 —— 等于在保护死代码。现在改为真调用 `applyReviewerHardFallbacks` 断言行为："quality 裁决不降级任何段落"与"hard 裁决确定性地降级结论"。
- **删除恒真的死开关** `ENABLE_RUNTIME_LLM_FACT_REVIEW = true`（`:1070` 的 `&&` 右侧恒真）与随旧链一起消失的 `ENABLE_OSU_ANALYZE` 守卫分支；删除已成孤儿的 `RECENT_COOLDOWN` 导出。

### 新增
- **运行控制：端口占用可查看并接管**。此前端口被别的进程占用时只显示「端口占用（PID …）」，既看不到是谁占的，也没有任何办法让 Desktop 接手。现在：
  - **显示占用者**：状态里给出进程名、PID、可执行文件路径与完整命令行；同一组件的另一个实例会标注「同组件的其他实例」，其余标注「其他进程」。
  - **由用户决定接管**：卡片上出现「停止占用进程并启动」按钮，点击后弹确认框，列出将被强制终止的进程（含子进程），确认才执行。
  - **安全约束**：每个 PID 在**终止前**会重新校验它此刻仍是该端口的监听者，过期快照里的 PID 永远不会被误杀；拒绝终止 Desktop 自身；接管前校验组件已启用且配置了端口。
  - 实现：`desktop/process-inspection.mjs` 新增 `describeProcesses`；`process-manager.mjs` 的 `portStatus` 增加占用者分类（owned/matching/foreign）、`portError` 带进程名、新增 `takeOver(id)` 与 `killPortListener(pid, port)`；新增 IPC `runtime:takeover` 与 `window.desktop.runtime.takeOver`；`src/pages/Runtime/index.jsx` 增加占用者列表与确认对话框。
  - `tools/apply-desktop-runtime-fix.mjs` 的补丁范围由 3 个文件改为整层 6 个（补上此前漏掉的 `preload.cjs`、`ipc-guard.mjs`、`api-bridge.mjs`）—— 否则新增的 preload API 永远不会出现在已安装应用中。
  - 测试：`tools/desktop-runtime-verify.mjs` 新增 6 个用例（占用者描述、同组件实例归属、无占用时拒绝接管、无端口/未启用/未知 id 的拒绝、终止前监听者校验、真实外部进程的完整接管），并修正 3 个因本次行为变更而过期的断言。**46/46 通过**。

### 修复
- **引用消息不再阻塞入站管线**：`hydrateQuotedMessage` 过去对每条引用回复同步等待 NapCat `/get_msg`，用的是 12 秒默认超时。NapCat 对已淘汰缓存的消息从不响应，于是一次引用就占住 6 个入站准入槽之一长达 12 秒（生产日志累计 446 次超时 + 54 次 `fetch failed`，并触发过 48 槽等待队列耗尽）。现在：本地库已解析出引用内容时不再发网络请求；超时收紧到 2.5 秒；同一 `message_id` 的失败在 5 分钟内不再重试（上限 500 条）。最坏耗时由 12 秒降至 2.5 秒，重复引用降至 0。
- **单实例锁失败不再伪装成崩溃**：`acquireInstanceLock` 抛错原本无人接住，会走 `uncaughtException` 写一份 crash 日志并打印带 source-map 误导帧的堆栈（曾连续 3 次）。现在输出一行 `[instance] 启动失败：…` 后 `process.exit(1)`，行为与紧随其后的 `openStore` fail-closed 分支一致。
- **`UserEntry.policy` 类型补齐 `owner`**：`server/types.ts` 的联合类型漏了 `'owner'`，而 `USER_POLICIES`（`server/index.ts`）与 `bot.ts` 的限频绕过分支都按 owner 处理。补上并加注释说明必须与 `USER_POLICIES` 同步。
- **文档不再指向已移除的维护脚本**：`tools/restart-wuxin.ps1`、`tools/start-napcat.ps1`、`tools/wuxin-guard.ps1` 已在桌面端「运行控制」页上线时删除（`c0c7311`），但 README 与 `docs/EXTERNAL_INTEGRATION.md` 仍在指引调用。两份现行文档改为指向 Desktop 运行控制页，并保留删除说明。

- **记忆画像批量更新不再整体失败（D1）**：`llmPolicy` 的回合预算存在 `AsyncLocalStorage` 中，而入站回合用 `withLlmTurnPolicy` 包住整条消息处理，于是 `runBackgroundTask('memory.profile', …)` 在分离之后仍继承该回合的 12 次调用 / 180 秒预算。任何批量触发（`/w refresh` 的全局重算）都会瞬间耗尽预算：生产日志出现 283 次 `profile.error`（其中 279 次 `LLM_TURN_BUDGET_EXHAUSTED`，涉及 280 个用户），而重算计数照常推进 —— 静默的批量失败。现在 `backgroundTasks` 通过新增的 `runDetachedFromTurnPolicy` 脱离调用方预算，改由模型准入闸门（并发 4 / 排队 32）与单次调用超时约束。修复后同一路径 45 分钟内 0 错误、5 次 LLM 成功返回、4 份画像实际落盘。
- **画像更新超时不再被 120 秒硬编码压制（D2）**：`memory.ts` 的 `PROFILE_UPDATE_TIMEOUT_MS = 120_000` 覆盖了 `settings.codexTimeoutMs`，在 `gpt-6-luna` + `reasoningEffort: max` 下必然超时（owner 的 `lastProfileStatus` 长期为 error，控制台「重算画像」返回 400）。改为 `profileUpdateTimeoutMs(settings)`：以 240 秒为下限，并按配置的 provider 超时上浮。实测 `POST /api/memories/:id/recalculate` 由 400 / 120 秒超时变为 200 / 57 秒成功。
- **`/w exp add|set` 首次写入不再丢失（D3）**：在 `updateDb` 的写代理内"先挂载新建对象、再修改它"，该修改不会落盘；于是给尚无经验记录的新成员发经验时，条目以 `xp:0` 落盘，却仍回"已给 X 增加 N XP"的成功提示（假成功）。现在新建分支直接构造带最终值的完整条目再挂载。实测 `set 250 → xp=250`、`add 50 → xp=300`。
- **`/w refresh` 不再阻塞 4 分钟（D4）**：全局重算改为 `runBackgroundTask('recalc.qq')` 派发，命令立即回复"已开始全局重算：个人画像 N 人、群画像 M 群、关系画像 K 对。用 /w recalc 查看进度。"。实测由 >240 秒客户端超时变为 210 毫秒返回。
- **hydrant 桥接超时收紧（D6）**：`quickRouter` 原先只区分 lazybot(30s) 与其它(60s)，hydrant 因此要等满 60 秒才回退内部引擎（生产日志 `hydrant 调用超时（60s）` 之后内部引擎正常作答）。hydrant 的 profile/where/PP+ 都有完整的内部替代实现，改为 25 秒。
- **`/w osu clear bind` 需要显式确认（D7）**：绑定是长期资产且会同步到 LazyBot，原先裸命令即静默解绑发送者自己。现在先返回"解绑会删除你与 osu! 玩家「X」的绑定（并同步到 LazyBot），操作不可撤销。确认请发送：/w osu clear bind confirm"，只有带 `confirm` 才执行；`handleOsuClear` 的严格解析只对 `bind` 放行 `bind confirm` 这一种双词形式，其余动作仍拒绝模糊写法。
- **`/w info p:…` 写法错误给出用法提示（D8）**：`p:[SHK]Wuxin` 这类缺外层方括号的写法被原样透传给 osu! API，回的是裸 `osu! 资源不存在 /users/@p%3A…`。现在识别为写法错误并回"玩家名写法有误。名字含空格或方括号时要整个包在 p:[...] 里…"。
- **`/w skill recent` 不再把正常状态说成失败（D9）**：证据不足原本以抛错表达，被共用包装器渲染成"指令执行失败：近期证据暂不足…"。改为正常回复"近期证据暂不足，请稍后积累更多近期成绩后再试。"。
- **`maxTokens` 默认值对齐（D11）**：`initialDb.settings.maxTokens` 原为 300，而调用路径 `options.maxTokens || settings.maxTokens || 420` 把 `''` 视为"用内置默认"。任何让该键回落到 initialDb 的路径都会把回复上限从 420 悄悄降到 300（测试中确实观测到 `''` → `300` 的漂移，触发点未能定位）。默认值改为 `''` 并加注释，消除这一不一致。

### 安全与可靠性
- 修复配置快照中 API Key/后台密码会通过 `/api/state` 返回浏览器的问题。
- 控制台状态响应由约 23.49 MB 降至约 1.08 MB，日志和画像样本改为限量返回，轮询间隔改为 10 秒。
- JSON 数据库改为临时文件写完后原子替换；备份恢复也统一使用安全写入。
- OneBot 发送现在同时校验 HTTP 状态和 JSON `status/retcode`，避免将业务失败记为成功。
- 外部 bot 过滤不再因 QQ 群管理身份绕过，并支持在 QQ 连接页显式填写其他 Bot QQ。
- 队列、经验、内容过滤、关系 GUI 验证脚本改为临时数据库，不再读写真实用户数据。
- 升级 Vite 6.4.3、concurrently 9.2.3、ws 8.21.0 及间接依赖，`npm audit` 归零。
- 内部 `HANDOFF*`/`TODO.md`/`CLAUDE.md` 从发布分支取消跟踪，仅保留在本机。

## v1.0.3 (2026-05-30)

### 2026-05-30 审查修复
- **关系画像 pending 计数按群隔离**：`pendingPairCounts` 从 `A:B` 改为 `groupId:A:B`，避免同一对 QQ 在不同群的互动被混算，导致错误触发关系画像更新。旧的 pair-only key 会在下一次计数时清理。
- **关系画像 DB 结构补齐**：`initialDb`、`normalizeDb`、`Db` 类型正式加入 `pendingPairCounts`，避免运行时隐式字段继续扩大维护风险。
- **全局重算进度修复**：`/api/recalc` 的群画像重算失败路径不再重复 `tickRecalc()`，避免进度条提前走完或统计不准。
- **新增验证**：`tools/relationship-verify.mjs` 覆盖跨群同 QQ pair 计数隔离和旧 key 清理。

### 新增
- **按需看图**：扩展看图意图识别（查看/分析/现在看/能看出来吗），无图但明确要求看图时从最近 10 分钟同群消息取最相关 1 张图传给多模态模型。
- **图片记忆预算**：纯图片摘要自动限频（important 策略冷却 30 分钟/每日 3 次，all 策略冷却 10 分钟/每日 8 次），有配文或 @ 机器人不受限。
- **关系画像质量门槛**：采样收紧（只采集真实互动），shouldSave 质量门槛（模型判断不出稳定互动时跳过），GUI/API 过滤无效空壳画像。
- **LLM 配置错配防呆**：DeepSeek 配置遇到 Mimo 风格 key 直接报错，Mimo endpoint 归一为 OpenAI-compatible，GUI 自动切接口。
- **单人画像重算**：记忆页新增"重算画像"按钮，`POST /api/memories/:userId/recalculate`。
- **经验等级系统**：5 级系统（🌱新人→💬群友→🎯活跃群友→⭐老熟人→👑核心群友），XP 全局累计按 QQ 号，每日上限 30，连续活跃加成（×1.2/×1.5/×2.0），30 天不活跃自动降级。
- **经验指令**：`/w lv`（等级查询）、`/w top`（群排行榜）、`/w nick`（自定义称呼，Lv.2）、`/w style`（个人交互风格，Lv.3）、`/w me`（查看画像，Lv.3）、`/w exp`（owner 管理经验：add/set/reset）。
- **经验集成**：buildPrompt 注入用户等级+称呼+风格，LLM 自然适配。升级时 LLM 生成个性化恭喜语（可关闭）。GUI 总览页经验统计、群聊页成员等级、记忆页等级 badge、成员页等级 emoji。
- **群关系画像 GUI 管理**：新增"关系"页面，可查看/编辑/启停/删除已生成关系画像，显示候选关系对并一键生成。后端 GET/POST/PATCH/DELETE 四个 API。
- **画像独立日志系统**：新增"画像日志"页面，记录样本采纳/拒绝、画像启动、LLM 返回、patch 应用、错误等事件。支持按用户/RunID/事件类型过滤。`profileLog.ts` 模块独立于聊天日志。
- **个人画像 V3 数据结构**：证据账本制（`profileV3.ts`），规则提取自述偏好/观察行为/说话风格，证据跨天自动升级 strength，跨群标记。与 V2 并行运行。
- **内容过滤**：nick/style 设置时 LLM 审核不当内容 + 基本安全边界（空/控制字符/提示词注入）。
- **群管自动识别**：OneBot `sender.role` = `owner`/`admin` 自动获得该群 bot 管理权限，无需手动 `/w op`。群管权限仅限本群，不能 `/w op`。
- **回复排队系统**：bot 正在生成回复时，新的 @bot 消息不再丢弃，而是加入 FIFO 队列（上限 10 条/群）。当前回复完成后自动处理队列中下一条。指令（/w）不受队列阻塞。队列状态通过 `/api/health` 暴露。
- **图片查看增强**：引用含图消息并 @bot 时自动提取被引用消息的图片；"看上文图片/看看上面的图" 等自然语言请求不再被误判为视觉限制，vision-capable 模型会从近期上下文搜索图片并发送给 LLM。

### 修复
- **/w exp 参数解析**：修复 `/w exp @某人 add 1200` 只显示当前经验的问题。经验指令现在读取完整参数尾部，支持 `@某人 add/set/reset` 和 `QQ号 add/set/reset`。同类的 `/w nick @某人 ...`、`/w style @某人 ...` 也改为读取完整尾部参数。
- **群聊画像空壳防护**：群画像 LLM 返回六字段全空时不再算成功，也不会覆盖旧画像；自动更新失败会记录失败状态并保留部分 pending 进度，避免下次每条消息都重试。GUI 和 `/w group profile show` 会把空壳记录显示为“待生成”，不再当作有效画像。
- **V2 聚类 hasSpecial 正则不一致**：`clusterSamplesByTopic` 中 `hasSpecial` 正则缺少 react/vite/onebot/napcat/qq/npm/node/jsx/css 等技术术语，与 `SPECIAL_TERMS` 不一致。改用 `SPECIAL_TERMS_NG`（非 global 版）避免 `.lastIndex` 副作用。
- **个人画像空跑**：自动画像、手动画像、GUI/QQ 全局重算现在都会把画像结果写回数据库；空画像/仅近期动态不再清空 `pendingCount`
- **长期证据取样**：画像更新不再只看最近几十条样本，会从历史消息补充长期文本，并按天/群做多样化取样
- **空画像识别**：`暂无跨时间跨群稳定特征` 这类占位文案不再算作有效画像
- **空画像补触发**：已有足够长期文本但画像为空的人，下次真实文本会触发补画像（30 分钟冷却）
- **占位画像清理**：`暂无长期稳定特征，仅...` 等扩展占位文案会被视为空画像并在下次更新时清除
- **提示词注入过滤**：旧数据中残留的占位画像不会再注入聊天 prompt
- **画像 JSON 容错**：画像更新遇到 LLM 输出非法 JSON 时，会低温重试一次“只修 JSON”，减少格式错误导致的记忆更新失败
- **视觉限制提示改为能力感知**：不再每轮固定注入“不能看图”；DeepSeek 强制纯文字，Mimo/OpenAI 兼容多模态按视觉能力处理
- **/w refresh 关系计数**：修复关系画像重算成功后计数变量错误
- **记忆样本保留数**：默认每人保留 120 条样本，GUI 记忆页可调
- **画像尝试状态**：记录最近画像尝试时间、状态和失败/空结果原因，GUI 可见
- **真实图片输入链路**：OneBot 图片 segment/CQ 码会提取 `url/file`；多模态请求按 OpenAI-compatible `image_url` 格式附带图片，内网/本地图片可转 data URL
- **图片摘要记忆**：记忆页新增“图片摘要进入长期记忆”和无配文图片策略。多模态模型可把用户图片总结成 `image-summary` 低权重样本；DeepSeek 不执行
- **Mimo 模型选择修复**：模型下拉加入 `mimo-v2.5-pro`、`mimo-v2.5`、`mimo-v2-omni`、`mimo-v2-pro`，并显示当前自定义模型，避免界面误显示 DeepSeek Chat
- **LLM 连接错误更清晰**：OpenAI-compatible 接口连接失败时，日志会带上当前 API 地址，便于区分 DNS/代理/接口地址问题
- **图片摘要失败不污染回复诊断**：后台图片记忆摘要失败不再写进“为什么回/为什么没回”，只计入健康/错误状态

## v1.0.2 (2026-05-24)

### 修复
- **搜索失败直接返回**：搜索无结果/超时/错误时不再继续等待 LLM，改为确定性提示
- **空搜索词提示**：extractSearchQuery 返回空时直接要求补关键词
- **thinkingTimer 提前返回修复**：`thinkingTimer` 提升到 `try` 前声明，避免提前 return 触发 ReferenceError

### 新增
- **检测本地搜索服务**：模型页一键检测 `http://127.0.0.1:8080` 的 SearXNG，通过后自动保存配置
- **高级设置折叠**：SearXNG 地址移入高级设置面板，普通用户无需手填

---

## v1.0.1 (2026-05-24)

### 修复
- 搜索补丁：isSearchAvailable 尊重 enableWebSearch 开关
- extractSearchQuery 清洗查询词（去 CQ at/图片占位/触发词）
- 移除旧 supportsProviderSearch 拦截（之前把真的 SearXNG 也挡了）
- SearXNG 请求 finally clearTimeout 防泄漏
- 无搜索结果正确返回 ok=false + 写搜索日志

---

## v1.0.0 (2026-05-23/24)

### 新增（0524）
- **真实联网搜索**：search.ts + SearXNG 适配器。搜索→注入 prompt→LLM 基于结果回答。未配置时显式搜索请求拒绝（不瞎编）。GUI 搜索源配置。
- **思考状态提示可配置**：/w thinking off|simple|detail|slow [ms]|status，GUI下拉+延迟调整。默认 slow 3s。4种模式：关/简短/详细/仅慢请求。
- **画像分层**：长期画像 + 近期动态两层。单日/单场景高频话题只进入近期动态，不覆盖长期画像
- topic cluster 降权：同一话题短窗口内合并计数，不按消息条数线性放大
- LLM patch 模式：longTermUpdates/recentDynamicsUpdates/preserveExisting/removeOrDowngrade
- 近期动态自然衰减：7天降权/14天移除
- GUI + /w profile show 分层显示
- CHANGELOG.md（给人看的更新日志）

### 新增（0523）
- 决策沙盒：POST /api/sandbox，不写DB，可选群/成员/策略覆盖/画像预览/LLM
- 全局重算 + 进度条：/w refresh、/w recalc，GUI 进度条 + 停止按钮
- 社交记忆层：信号抽取 + 自动信任分 + 群友关系画像
- 群聊画像 V2：自动更新 + 手动编辑 + GUI 面板
- 语境感知画像：样本带上下文快照，profile samples 分层展示
- 场景预设：/w preset（class/away/sleep/active/silent/debug）
- 画像定向重算：/w profile retry @某人 方向
- /w why 诊断命令
- 备份系统：每 8h 自动 + GUI 手动 + 恢复安全校验
- 健康状态页：总览页红黄绿灯 + 每 5s 轮询
- 记忆置信度 + 高风险降级 + profileMeta
- 权限页补全：27 条指令 + 搜索
- /w help 分组 + /w my 权限感知
- 成员页优化：搜索/筛选/排序/彩色标签
- 群聊页优化：识别强化 + 搜索
- 决策沙盒发言人列表：合并配置用户+消息历史
- 长期记忆：语境感知的个人画像 + 群聊氛围画像 + 群友关系画像
- 信任成员自动化（信任分 + 三档升降级 + 定时器）
- 24 个指令权限键

### 修复
- P0：decideReply event 崩溃
- P1：关系画像采样限定 A/B + /w why 权限
- P2：注入收窄 + 接线 + 权限粒度
- 画像 JSON 类型安全修复
- BOM 防护
- 多处 UX 优化（错误信息透传、搜索、危险确认）

### 变更
- 启动脚本统一：启动Wuxin.bat（支持 portable-node）
- 仓库清理：Git 历史清除大文件，.gitignore 完善
- GitHub Release v1.0.0：full 包(232MB) + lite 包(33MB)

---

## v0.1.0 (2026-05-21~22)

### 核心
- 底层拆分：cleaning/llm/prompt/reply/memory/commands
- Diaz→Wuxin 重命名，/d→/w，数据目录分离
- 底层 prompt 重构 + sysfacts 纯人设模式
- 备份恢复 + 健康状态 + 记忆置信度 + 高风险降级
- 成员页/群聊页优化
- 画像护栏（过滤 + 侮辱性标签清洗）
- Git 安全加固 + BOM 防护
