# Wuxin AI ChatBot · HANDOFF

## 速览
- **项目路径**: `G:\QQ-AI-ChatBot` | **数据**: `%APPDATA%\Wuxin\db.json` (或 `DATA_DIR`)
- **Bot QQ**: 3312171148 | **Owner**: 570341031 | **默认模型**: deepseek-v4-flash
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
- `d65cfae` 回复排队系统
- `aa02cad` CLAUDE.md
- `ec3a57b` V2聚类hasSpecial正则补全
- `a21c0cf` 画像空跑修复 + 多模态图片链路 + 画像容错

备份：`G:\QQ-AI-ChatBot-backup-multimodal-20260529-144532`、`G:\QQ-AI-ChatBot-backup-pre-queue-20260529-163915`
验证：`npm run build` + `npm run sanity` + `npm run structure` + `tools/queue-verify.mjs`（5 项全过）

### 已完成（详见 CHANGELOG.md / HANDOFF-DIARY.md）

| 项目 | 说明 | 参考 |
|------|------|------|
| 回复排队系统 | @bot 消息不再丢弃，FIFO 队列（10 条/群），drain 自动处理下一条，指令不受阻塞，健康 API 暴露队列状态 | commit d65cfae |
| V2 聚类 hasSpecial 修复 | `hasSpecial` 正则与 `SPECIAL_TERMS` 不一致，缺少 react/vite/onebot 等技术术语。改用 `SPECIAL_TERMS_NG`（非 global 版）。新增 `tools/v2-verify.mjs` 5 项验证 | commit ec3a57b |
| CLAUDE.md | 项目文档：架构、模块、关键约束、常用任务、验证清单 | commit aa02cad |
| 画像空跑修复 | 画像更新结果统一 commit，空画像/仅近期动态不清 pending；历史消息补样本；默认每人保留 120 条样本；GUI 显示画像尝试状态 | commit a21c0cf |
| 画像 JSON/占位容错 | `暂无长期稳定特征，仅...` 不算有效画像；LLM 输出非法 JSON 时低温重试一次 JSON 修复 | commit a21c0cf |
| 多模态图片链路 | `cleaning.ts` 提取图片 `url/file`；`llm.ts` 将图片转为 OpenAI-compatible `image_url`；DeepSeek 路线强制不传图 | commit a21c0cf |
| 图片摘要记忆 | `maybeRecordImageMemorySummary()` 用多模态模型生成图片短摘要，作为 `image-summary` 低权重样本进入长期记忆 | commit a21c0cf |
| Mimo 模型下拉 | 模型页加入 Mimo 常用模型 ID，避免 select value 不在 options 时视觉回退到 DeepSeek Chat | commit a21c0cf |
| LLM 连接诊断 | OpenAI SDK 的 `Connection error` 会包装成带 baseURL 的错误 | commit a21c0cf |
| v1.0.2 搜索修复 | 搜索失败直接返回 + 空搜索词提示 + thinkingTimer 修复 + 本地搜索检测 | commit dbfede6 |
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
