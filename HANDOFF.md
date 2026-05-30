# Wuxin AI ChatBot · HANDOFF

## 2026-05-30 Release v1.0.3

- **版本准备**：`package.json` / `package-lock.json` 已更新到 `1.0.3`，`CHANGELOG.md` 已将本轮修复固化为 `v1.0.3 (2026-05-30)`。
- **发布内容**：本版重点是稳定性修复：`/w exp` 参数解析、群聊画像空壳防护、关系画像 pending 计数按群隔离、全局重算进度修正，并补充对应 verify 脚本。
- **验证清单**：发布前已通过 `npm run build`、`npm run structure`、`npm run sanity`、`experience/group-profile/relationship/vision/v2/queue/content-filter` 全部 verify。
- **打包规则**：release 包继续排除 `data/`、`.env`、`.git`、`HANDOFF*`、`TODO.md`、`CLAUDE.md`；lite 包需要用户自备 Node.js 20+，full 包内置 `portable-node`。

## 2026-05-30 Bug 审查记录

- **备份**：本轮修改前已备份到 `G:\QQ-AI-ChatBot-backup-audit-20260530-171319`。
- **已修复 P1：关系画像 pending 计数跨群污染**。旧逻辑用 `A:B` 作为计数 key，同一对 QQ 在不同群会共用计数；已改为 `groupId:A:B`，并在遇到旧 key 时自动清理。新增 `tools/relationship-verify.mjs` 验证。
- **已修复 P2：重算进度重复 tick**。`/api/recalc` 中群画像更新失败时原来可能一轮计两次进度；已改为每个群固定只 tick 一次。
- **已补齐结构**：`pendingPairCounts` 已写入 `initialDb`、`normalizeDb` 和 `Db` 类型，避免后续继续依赖隐式字段。
- **验证结果**：`npm run build`、`npm run structure`、`npm run sanity`、`tools/experience-verify.mjs`、`tools/group-profile-verify.mjs`、`tools/relationship-verify.mjs`、`tools/vision-verify.mjs`、`tools/v2-verify.mjs`、`tools/queue-verify.mjs`、`tools/content-filter-verify.mjs` 全部通过。
- **仍需留意**：`npm run structure` 仍提示 `server/bot/commandHandlers.ts` 没接入主运行路径，这是旧架构风险，不是本轮新增 bug。后续如果继续拆命令，应该一次性把 `runOwnerCommand()` 迁移到该模块，避免“双份命令表”长期并存。

## 趣味功能后续方案

优先原则：默认低打扰、可关、可限频、所有新指令进权限页，尽量不用 LLM 或只在明确触发时用 LLM。

1. **轻量随机系**：`/w roll 1d100`、`/w coin`、`/w pick A B C`、每日运势。纯本地逻辑，成本为零，适合第一批做。
2. **群语录本**：`/w quote add`、`/w quote random`、`/w quote del`。只允许 owner/admin 或高信任成员添加，避免乱收隐私和刷屏。
3. **临时称号/周报称号**：按经验、近期互动和群画像生成“本周称号”，只做娱乐展示，不写进长期人格画像。
4. **群氛围播报**：`/w vibe` 基于最近聊天和群画像生成一句短评；必须加冷却，避免变成高频总结机。
5. **小游戏对决**：`/w duel @某人`、猜数字、抽卡式小游戏。结果只随机，不根据画像给负面标签。
6. **每日话题/破冰**：`/w topic` 生成一句适合当前群氛围的话题；默认手动触发，后续再考虑定时。
7. **Bingo/梗词收集**：群内自定义 bingo 词条，出现时计数；需要 opt-in，避免把普通发言过度游戏化。
8. **节日/纪念日彩蛋**：按群配置生日、纪念日、开服日等，触发短句祝福；数据要能导出/删除。

## 最新提醒：经验等级与开发协作模型（2026-05-29）

- **当前开发协作主力模型**：暂时使用 `Mimo V2.5 Pro` 帮忙写代码/审查/总结。DeepSeek 因余额/成本问题先暂停。注意：这不是 bot 运行时使用的模型配置。
- **bot 运行模型**：以控制台“模型”页面和 `%APPDATA%\Wuxin\db.json` / `DATA_DIR` 里的实际配置为准，不要从 HANDOFF 的开发协作模型推断。
- **经验等级必须绑定个人 QQ 号**：经验值不是按群独立清零。QQ 群 bot 的经验体系应以用户 QQ 为主键，全局累计；在不同群里仍然是同一个人的等级。可以额外记录“此人在某群的活跃度/群内表现”，但等级与总 XP 不应换群消失。
- **群内维度只做辅助**：`/w top` 可以按当前群统计贡献排行，但用户总等级仍来自全局 XP。实现时建议拆成 `userExperience[qq]` 与 `groupExperience[groupId][qq]` 两层，前者决定等级，后者用于群内排行和群聊氛围分析。
- **昵称/风格审核不要做死**：允许 LLM 做语义判断，避免硬编码过多规则。仍建议保留最基本的安全边界，例如空内容、明显超长内容、控制字符、prompt 注入式内容不要入库。目标是“别死板”，不是“完全无防护”。
- **升级祝贺不需要冷却**：升级本身低频，不必为此额外做复杂冷却逻辑。只需避免同一次升级事件重复触发即可。
- **群管理员自动识别仍按当前群作用域处理**：OneBot `sender.role=owner/admin` 可以自动获得当前群的管理指令权限，但不能变成全局 bot 管理员，也不能操作 bot owner。

## 速览
- **项目路径**: `G:\QQ-AI-ChatBot` | **数据**: `%APPDATA%\Wuxin\db.json` (或 `DATA_DIR`)
- **Bot QQ**: 3312171148 | **Owner**: 570341031 | **bot 运行模型**: 以控制台/DB 实际配置为准
- **GUI**: http://127.0.0.1:5173 | **API**: http://127.0.0.1:8787 | **OneBot**: :3000/:3001
- **NapCat**: `G:\My pack\NapCat.Shell.Windows.OneKey\NapCat.Shell`
- **启动脚本**:
  - `启动Wuxin.bat` — 主入口 (portable-node + 自动构建 + 端口清理 + 打开浏览器)
  - `停止Wuxin.bat` — 按端口杀进程
  - `打开控制台.bat` — 查看运行日志
  - `开启NapCat本地OneBot.bat` — 单独启动 NapCat OneBot
- **验证**: `npm run build` + `npm run sanity` + `npm run structure` (duplicateImports: 0)

## 模块清单

| 文件 | 职责 | 状态 |
|------|------|------|
| `server/bot.ts` | 主流程: processIncoming, decideReply, 全部指令 | live |
| `server/store.ts` | JSON DB, normalizeDb, publicDb, DATA_DIR | live |
| `server/index.ts` | Express API + backup/health/group-profile routes | live |
| `server/onebot.ts` | WS接收 + HTTP发送 + 合并转发 | live |
| `server/health.ts` | 内存健康状态 (连接/LLM/暂停/错误/重算进度) | live |
| `server/backup.ts` | DB备份/恢复/轮转 (每8h自动, 最多10份) | live |
| `bot/cleaning.ts` | CQ解析, 消息清洗, 卡片占位 | live |
| `bot/llm.ts` | 统一LLM层 (DeepSeek/OpenAI兼容) | live |
| `bot/prompt.ts` | buildPrompt, 复杂度评分, 自动模型, 定价 | live |
| `bot/reply.ts` | 输出清洗, 分段发送, 改写, 合并转发 | live |
| `bot/memory.ts` | 个人画像 (语境感知, 风险分级, 旧画像降权, 长期/近期分层) | live |
| `bot/groupProfile.ts` | 群聊画像 (V2自动更新, LLM+手动编辑) | live |
| `bot/signals.ts` | 互动信号抽取 (纯规则, 不调LLM) | live |
| `bot/trust.ts` | 自动信任分 (规则评分, 三档升降级) | live |
| `bot/relationshipProfile.ts` | 关系画像 (pair维度, 敏感关系硬约束) | live |
| `bot/search.ts` | 真实搜索适配器 (SearXNG, extractSearchQuery, 超时控制) | live |
| `bot/commands.ts` | 权限角色, 指令解析, 日志 | live |
| `bot/deepseek.ts` | 兼容重导出 (废弃) | legacy |
| `bot/commandHandlers.ts` | 独立指令函数 (未接入主流程) | 备用 |

## 指令速查

```
【成员管理】op · deop · ban · unban · trust · focus · quiet · normal
【备注画像】note show/clear · profile show/samples/retry/rule/clear (@某人)
【人设】prompt show/add/set/reset/savebase
【群聊】group add · group profile show/update/clear/on/off
【群参】rate · cooldown · mode(silent|mention|light|natural) · status
【模型】model list/模型名 · search on/off/status/fast/balanced/deep
【系统】sysfacts on/off · preset(class|away|sleep|active|silent|debug)
        usage · pause · resume · why · my · ping · help · summarize
        refresh · recalc
【关系】relation show/update/clear @A @B
```

全部可简写 `/w`。权限以 GUI 权限页为准。长输出用合并转发不刷屏。

## 关键约束

- **信任成员≠管理员**：只给互动待遇 (回复权重+25/窗口5min/记忆0.6×)，不给管理权限
- **关系画像禁写敏感关系**：情侣/夫妻/父子等词在输出端直接 strip，除非群成员长期明确自述
- **纯人设模式**：`/w sysfacts on` 跳过全部底层注入，LLM 只看到 personalityPrompt
- **画像写入前必判**：subject (self/other/bot/topic) + addressee + observationType，不满足不写
- **长期画像防近因污染**：短期高频话题先进入"近期动态"，不能一晚/单场景覆盖长期画像
- **旧画像自动降权**：无 context 快照的旧样本标注降权，新数据优先，但不能无条件重写整份画像
- **备份恢复安全**：JSON 校验 + pre-restore 自动备份 + safeBackupName 防路径穿越
- **数据不进 Git**：`.gitignore` 屏蔽 `data/` `.env`，DB 在 `%APPDATA%\Wuxin`
- **视觉能力分层**：DeepSeek 官方接口强制纯文字；`openai-compatible` + Mimo/vision/VL/multimodal 或 `visionMode=on` 才会走多模态。OneBot 图片 `url/file` 会按 OpenAI-compatible `image_url` 传给 LLM，本地/内网图片默认转 data URL。
- **图片记忆护栏**：图片只以 `image-summary` 低权重样本进入长期记忆；无配文图片策略 `visionMemoryPureImagePolicy=important/all/off` 默认只处理重点/信任/管理员，避免成本和画像污染。画像更新 prompt 明确禁止仅凭图片推断人格/身份/心理状态。

## 当前状态

### Git 状态

工作区干净。最近提交：
- `1dd88d0` CQ码大小写修复
- `f382b2c` /w exp 指令
- `bfdff75` GUI记忆页等级显示
- `74ba4f8` GUI总览页+群聊页等级显示
- `41efae6` LLM内容过滤
- `18e280a` buildPrompt注入+升级恭喜+GUI
- `2c1ab98` 经验等级系统核心+群管自动识别
- `d65cfae` 回复排队系统
- `4ee6fe4` 图片查看增强
- `ec3a57b` V2聚类hasSpecial修复
- `a21c0cf` 画像空跑修复+多模态图片链路

备份：`G:\QQ-AI-ChatBot-backup-multimodal-20260529-144532`、`G:\QQ-AI-ChatBot-backup-pre-queue-20260529-163915`、`G:\QQ-AI-ChatBot-backup-pre-experience-*`
验证：`npm run build` + `npm run sanity` + `npm run structure` + 所有 verify 测试 3 次全过

### 已完成（详见 CHANGELOG.md / HANDOFF-DIARY.md）

| 项目 | 说明 | 参考 |
|------|------|------|
| 经验等级系统 | 5 级系统，XP 全局累计，每日上限 30，连续活跃加成，30 天不活跃降级。新指令 /w lv /w top /w nick /w style /w me /w exp | commit 2c1ab98+ |
| 群管自动识别 | sender.role=owner/admin 自动获得该群 admin 权限，仅限本群 | commit 2c1ab98 |
| LLM 内容过滤 | nick/style 设置时 LLM 审核 + 基本安全边界（注入/控制字符） | commit 41efae6 |
| buildPrompt 注入 | 用户等级 + customName（称呼联动）+ customStyle（个人风格） | commit 18e280a |
| 升级恭喜 | LLM 生成个性化祝贺语，群内开关 levelUpNotifyEnabled | commit 18e280a |
| GUI 经验展示 | 总览页经验统计、群聊页成员等级、记忆页等级 badge、设置页开关 | commit 74ba4f8+ |
| /w exp 参数修复 | 完整解析 @目标 后面的 add/set/reset；支持 QQ号 add/set/reset；nick/style 同类尾部参数解析同步修复 | 0530 |
| 群画像空壳防护 | LLM 六字段全空时不算成功，不覆盖旧画像；自动更新失败记录原因并保留部分 pending；GUI/指令显示为待生成 | 0530 |
| 回复排队系统 | @bot 消息不再丢弃，FIFO 队列（10 条/群），drain 自动处理下一条 | commit d65cfae |
| 图片查看增强 | 引用消息图片 + 上下文图片搜索 + 自然语言看图请求 | commit 4ee6fe4 |
| V2 聚类修复 | hasSpecial 正则与 SPECIAL_TERMS 不一致 | commit ec3a57b |
| 画像空跑修复 | 画像更新结果统一 commit，空画像/占位容错 | commit a21c0cf |
| 多模态图片链路 | cleaning.ts 提取图片，llm.ts 转 image_url，图片摘要记忆 | commit a21c0cf |
| P0 身份锚点 | @self 锚点注入 + 自否定禁令 + isWeirdReply 拦截 + 兜底 | commit 0878238 |
| P0 真实搜索 | search.ts + SearXNG 适配器 + 搜索注入 prompt | tag v1.0.1 |
| P1 画像分层 | 长期画像/近期动态两层 + Jaccard 聚类 + phrase 降级 + groups 提取 | commit 2c83e40 |
| 思考提示 | thinkingNoticeMode (off/simple/detail/slow) + `/w thinking` + GUI | commit 681bfe9 |
| 社交记忆层 | signals + trust + relationshipProfile | 0523 |
| 决策沙盒 + 重算 | POST /api/sandbox + `/w refresh`/`recalc` + 进度条 | 0523 |

### 待复查

- **recentDynamicsUpdates.groups**：回归测试 6/6 PASS 中含 groups 提取。已从样本 cluster 提取来源群并写入。
- **回复队列实际验证**：queue-verify 测试 4 次全过，建议实际 QQ 群中测试并发 @bot 场景。

## 变更时间线

```
0530 群画像空壳防护：updateGroupProfile 校验六字段有效内容；全空 LLM 结果不算成功且不覆盖旧画像；
     自动更新失败记录 lastUpdateStatus/lastUpdateError，并保留部分 pending 进度；GUI 和 /w group profile show 显示待生成。
0530 /w exp 参数修复：runOwnerCommand 增加完整 commandArgs 解析和 parseTargetAndRest；/w exp @某人 add/set/reset
     不再丢失 @ 后面的动作参数；/w nick、/w style 的 @目标+尾部文本解析同步修复。
0529 回复排队系统：@bot消息不再丢弃，FIFO队列(10条/群)，drain自动处理下一条，
     指令(/w)不受阻塞，isFromDrain参数跳过锁检查避免死循环，健康API暴露队列状态。
     V2聚类hasSpecial正则修复：hasSpecial缺少react/vite/onebot等技术术语，改用SPECIAL_TERMS_NG。
     CLAUDE.md项目文档。备份清理(只保留最新1个)。
0525 个人画像空跑修复：updateMemoryProfile 结果统一写回；/api recalc 与 /w refresh 不再丢结果；
     空画像/占位画像不算成功且不清 pending；空画像用户下次真实文本会触发补画像(30min冷却)；
     画像取样从历史消息补长期证据；记忆页新增样本保留数和尝试状态。
0529 个人画像容错追加：扩展占位识别/清理、prompt 注入过滤和 JSON-only 低温修复重试。
0529 多模态真实接入：visionMode(auto/on/off)、图片传输方式(auto/url/data)、visionMaxImages；
     DeepSeek 强制纯文字；OneBot 图片提取 url/file；OpenAI-compatible image_url 传图；
     image-summary 低权重样本进画像；Mimo 模型下拉修复。
0524 搜索修复v1.0.2 · 本地搜索检测 · 高级设置折叠 · 思考提示可配 · 画像分层 · 身份锚点修复
     真实搜索(SearXNG) · Release v1.0.0/v1.0.1/v1.0.2 · portable-node · 启动脚本统一
0523 社交记忆层(信号+信任+关系) · 决策沙盒 · 全局重算 · 群聊画像V2 · 语境感知画像 · Codex硬化
0522 备份恢复+健康状态+记忆置信度+高风险降级 · 底层prompt重构+sysfacts · 画像护栏
0521 Wuxin重命名 · 数据目录分离 · Git安全加固 · 底层拆分 · BOM防护
```

> 详细日记见 `HANDOFF-DIARY.md` · 更新日志见 `CHANGELOG.md`

## 0524 — Release 整理

- **GitHub Release v1.0.0**: 两包发布 — full(232MB,内置Node.js)/lite(33MB,需自备Node)。`gh` CLI 便携版。
- **portable-node**: Node.js v22.14.0 便携版，用于生成 full 包。已在 `.gitignore`。
- **启动脚本统一**: 删除旧 `启动控制台.bat`/`停止控制台.bat`/`启动Wuxin.ps1`，当前 4 个入口脚本见速览。
- **仓库清理**: Git 历史清除 134MB 大 zip，`G:\` 旧备份/脚本遗骸清理。
