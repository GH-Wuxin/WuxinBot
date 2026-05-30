# Changelog

## Unreleased

## v1.0.3 (2026-05-30)

### 2026-05-30 审查修复
- **关系画像 pending 计数按群隔离**：`pendingPairCounts` 从 `A:B` 改为 `groupId:A:B`，避免同一对 QQ 在不同群的互动被混算，导致错误触发关系画像更新。旧的 pair-only key 会在下一次计数时清理。
- **关系画像 DB 结构补齐**：`initialDb`、`normalizeDb`、`Db` 类型正式加入 `pendingPairCounts`，避免运行时隐式字段继续扩大维护风险。
- **全局重算进度修复**：`/api/recalc` 的群画像重算失败路径不再重复 `tickRecalc()`，避免进度条提前走完或统计不准。
- **新增验证**：`tools/relationship-verify.mjs` 覆盖跨群同 QQ pair 计数隔离和旧 key 清理。

### 新增
- **经验等级系统**：5 级系统（🌱新人→💬群友→🎯活跃群友→⭐老熟人→👑核心群友），XP 全局累计按 QQ 号，每日上限 30，连续活跃加成（×1.2/×1.5/×2.0），30 天不活跃自动降级。
- **经验指令**：`/w lv`（等级查询）、`/w top`（群排行榜）、`/w nick`（自定义称呼，Lv.2）、`/w style`（个人交互风格，Lv.3）、`/w me`（查看画像，Lv.3）、`/w exp`（owner 管理经验：add/set/reset）。
- **经验集成**：buildPrompt 注入用户等级+称呼+风格，LLM 自然适配。升级时 LLM 生成个性化恭喜语（可关闭）。GUI 总览页经验统计、群聊页成员等级、记忆页等级 badge、成员页等级 emoji。
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
