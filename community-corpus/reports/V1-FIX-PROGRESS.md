# V1 修复进度（无人值守）

## 当前目标

修复 community-corpus V1 切窗/脱敏系统性问题并重新生成 300 条审核样本。
旧版验收：understandable 76.7%、effective 71.0%、trigger 74.3%、bot/spam 16.3%、隐私泄露 6 条。

## 已完成

- 定位 6 个隐私泄露窗口与根因（凭据 URL 长 token、群号、Discord/profile、转发昵称、invite_code、审核表未脱敏）。
- `adapters.py`：RawRecord 增加 reply_sender_names，`clean_text` 可完整剥离 reply 预览里的原始昵称。
- `sanitize.py`：新增凭据 URL 整段替换、token 值字符集扩展（%/+）、群+数字、Discord/Website/Occupation 等 profile 字段、invite_code 参数、转发块内昵称脱敏；pii 增加 profile。
- `full_import.py`：传递 reply_sender_names；扩充 bot 输出内容识别（bp类型/pp+等待/Markdown/Lazybot/帮助/PP+最佳/猜谱面/最飞升/汇率/WuxinBot 推荐）。
- `windows.py`：
  - 新增 dataset 分类：community / bot_operation / media_reaction / rejected_candidate。
  - temporal_burst 改为“先切段再取最大合法窗口”，段边界基于 reply/同人/词汇重叠/短反应/数字反应，命令与 Bot 输出强制断段。
  - media_or_bot_reaction 收集反应时在命令/Bot 输出处停止；Bot 触发附带前置命令；媒体无文字且前置命令视为 Bot 渲染图。
  - 去重：message_ids Jaccard>=0.8，或同 trigger + 时间重叠>=0.8 + 内容重叠（0.6 消息 / 0.8 文本）；记录删除原因与重叠率；0 反应 Bot/媒体窗口保留到对应分区。
  - windows.parquet 新增 dataset 字段。
- `report_v1.py`：报告增加 dataset 分布、duplicateApproxRemoved/Remaining；抽样池改为 community；manual review 记录 dataset。
- `review_annotate.py`：逐行 sanitize_text 后写入审核表。
- `review_sheet.py`：主文本列靠前，新增易读 XLSX（冻结表头/自动换行/中文列名/筛选）。
- `review_precheck.py`：新增自动预检（300 条门槛 + 可选全量 PII 扫描），已接入 CLI。
- `cli.py`：新增 --review-seed（默认 20260806），新 seed 重抽样本。
- `tests/test_v1.py`：更新重叠/去重/Bot 输出断言，新增脱敏、reply 昵称、dataset、XLSX 用例（39 个全绿）。
- mypy 0 错误。

## 已完成的验收重跑

- 全量重跑完成：1,279,462 条消息解析 0 失败，窗口去重 533,347 → 498,385。
- 新 300 条审核样本（seed 20260806）已生成，旧 6 个泄露窗口均不在内。
- 自动预检通过：privacyLeakCount 0、overlapPairs 0、mediaWithoutAnchor 0、
  botSystemSpamRatio 0.0（全量双引擎 PII 扫描 0 命中）。
- 审核产物：manual-review-v1.jsonl / annotated.jsonl / review-sheet.csv / .xlsx /
  precheck.json / quickstart.md 全部生成。
- 复验：39 个单元测试全绿 + mypy 0 错误。

## 2026-08-05 第二轮：验收目标调整

用户新方向：隐私与安全是唯一一票否决；普通窗口质量不再作为通过/失败条件；
不再为人工审核百分比反复优化切窗；重叠窗口保留并只做检索侧去重。

### 改动

- `windows.py`：`dataset` 四分类替换为 `usage_tier` 五层
  （style_ready / contextual_style / bot_interaction / ambient_chat /
  private_or_rejected）；`_dedupe_near_duplicates` 替换为
  `_cluster_overlapping_windows`：不删除高度重叠窗口，生成
  `overlap_cluster_id` + 代表标记；新增 `retrieval_dedupe_windows`
  保证检索时每簇最多一条。`_is_spam` 放宽为只有 ≥2 条非空文本才判重复刷屏，
  避免单条媒体反应被误杀。
- `sanitize.py`：新增实名自述（我叫/真名/本名…）与通用私有 URL 参数
  （sid/session/token/code/key…）脱敏。
- `security_fixtures.py`：新增 24 组对抗性 PII fixture（QQ/手机/邮箱/IP/
  群号/凭据/邀请码/私有参数/Discord/profile/转发作者名/@提及/身份证/
  银行卡/学校公司地址/实名/QQ+osu 映射/reply 预览昵称）。
- `review_annotate.py`：导出记录移除原始 sender_name（此前为泄露点）。
- `review_precheck.py`：改为隐私一票否决 + 结构门（usage_tier 存在、
  overlap_cluster_id 存在、样本内非高风险同簇为 0、source_refs 存在、
  审核表 0 泄露、全量 PII 0）；质量指标降为 informational。
- `report_v1.py`：报告输出 usageTierDistribution 与重叠簇统计；
  抽样改为全高风险 + 四层按群/类型/风险分层，且样本内不重复选同簇窗口。
- `review_sheet.py`：新增“使用分层”“重叠簇ID”列；质量列保留为参考。
- `cli.py`：默认 --review-seed 20260807；预检默认跑全量 PII 扫描。

### 第二轮全量结果（seed 20260805 / review-seed 20260807）

- 窗口 547,946（精确重复剔除 4,210；重叠簇 37,196，覆盖 82,941 窗口，
  最大簇 24，重叠均值 0.8441）。
- 分层：style_ready 24,059 / contextual_style 238,690 /
  bot_interaction 194,872 / ambient_chat 1,257 / private_or_rejected 89,068。
- 预检全过：privacyLeakCount 0、annotatedLeakCount 0、usageTierMissing 0、
  overlapClusterMissing 0、sampleClusterDupes 0、missingSourceRefs 0、
  fullCorpusPiiHitTypes 0。
- 样本分层：style_ready 34 / contextual_style 121 / bot_interaction 80 /
  ambient_chat 23 / private_or_rejected 42（含全部 42 条高风险）。
- 42 个单元测试全绿 + mypy 0 错误。

## 提交记录（refactor/wuxin-cleanup-20260731-224209）

- 461ac00 chore(corpus): scaffold community-corpus base pipeline and ignore generated outputs
- 17153dc feat(corpus): full redaction for tokens, group ids, profiles, forwards, invites
- 8e84877 feat(corpus): topic-aware window segmentation, dataset split, near-dup dedup
- 7a5bbbb feat(corpus): secure annotated review export, XLSX sheet, precheck
- 4544ab7 test(corpus): 39 unit tests green, mypy clean; freeze legacy corpus-build.mjs
- 05f0f43 feat(corpus): usage tiers, overlap clustering, retrieval dedupe
- ccce5c0 feat(corpus): security fixtures, real-name/private-param redaction, safe annotated export
- e882df6 feat(corpus): privacy-first precheck and tier-aware review export
- 61df26d test(corpus): 42 green including security fixtures and tier gates; docs update

## 2026-08-05 第三轮：Codex 人工代审 + 隐私补漏

用户要求由 Codex 亲自审 300 条样本（不再交给外部 GPT 打分）。两轮通读后
发现并修复了以下问题：

### 修复

- `sanitize.py`
  - 新增邀请短链脱敏：`discord.gg/`、`oopz.cn/i/`、`kook.app/invite/`、
    `kookapp.cn/invite/`（此前 `https://oopz.cn/i/jUg00i` 原样泄露）。
  - 新增裸 QQ 号脱敏：独立成词的 9-11 位数字视为 QQ/群号替换为
    `<QQ_NUMBER>`；URL 路径内公开数字（osu score id、bilibili/pixiv id）与
    带单位/小数的数字（`2147483648usd`、`CNY 470548.48`）保留。
    实测全库 1775 处裸数字中，QQ/群号/QQ UID 全部命中。
  - `_UNIQUE_PARAM_RE` 增加 `inviter_uid`（`inviterUid=275180748` 泄露 QQ UID）。
  - 转发块昵称正则从 ASCII+中文白名单改为 `[^\s:]{1,40}`，并重写
    `_looks_like_person_name`：除纯大写 ASCII 标签（PC/TTH/SS/ID）与短数字外，
    日文假名、emoji、方向符、下标（`CH₃N₈`）、全角标点等一律视为昵称。
    全库转发昵称泄露从 174 个唯一昵称 / 865 行降为 0。
- `windows.py`
  - 带转发块（`[转发消息: N条]`）的窗口降级为 contextual_style，不再落入
    style_ready（转发内容属于外部上下文）。
  - 纯系统提示/无内容窗口归入 private_or_rejected。
  - `_COMMAND_RE` 允许前缀后空格：`! rs`、`/ 小黑猫` 等 194 条真实指令
    现在会触发 bot_interaction。
- `full_import.py`
  - 补齐 bot 输出模板：`个人信息—mania/taiko/catch`、replay 轨迹/检测、
    `少女祈祷中...`、pp+ 后台更新提示、`X头像已更新`。
  - `BOT_UINS` 从 1 个扩到 14 个，覆盖导出的历史 bot 账号：
    忧郁小猫猫、KQN、天使果果喵、雨沐×2、小幽幽子、幽幽子、
    Nikaidou Shinku、ATRI1024、全自助火化机、遠野幻想物語、白菜V2.1×2、
    Lazybot测试机。纯 bot 消息不再污染 style_ready。
- `review_precheck.py`：PII_SCANNERS 增加 invite_path、qq_bare；
  转发昵称漏检正则同步放宽。
- `review_sheet.py`：单元格清洗 XML 非法控制字符，XLSX 不再因
  `\x14` 等字符生成失败。

### 最终全量结果（seed 20260805 / review-seed 20260807）

- 消息 1,279,462 条解析 0 失败；窗口 536,898（精确重复 6,241；
  重叠簇 19,178，覆盖 44,447，最大簇 24）。
- 分层：style_ready 28,033 / contextual_style 160,977 /
  bot_interaction 196,731 / ambient_chat 1,935 / private_or_rejected 149,222。
- 预检全过：privacyLeakCount 0、annotatedLeakCount 0、usageTierMissing 0、
  overlapClusterMissing 0、sampleClusterDupes 0、missingSourceRefs 0、
  fullCorpusPiiHitTypes 0；转发昵称专项扫描 0。
- 300 条样本分层：style_ready 35 / contextual_style 114 /
  bot_interaction 90 / ambient_chat 22 / private_or_rejected 39
  （含全部 39 条高风险）。
- 人工审读结论：39 条高风险全部正确脱敏；style_ready 无 bot 输出残留；
  ambient/contextual/bot_interaction 分层合理。
- V2 候选：`reports/V2-style-ready-candidates.jsonl`（35 条，24 条推荐）。
- 43 个单元测试全绿 + mypy 0 错误。

## 2026-08-05 人工批准

用户确认相信 Codex 的审读结论，24 条推荐窗口已在
`reports/V2-style-ready-candidates.jsonl` 中标记 `approved: true`，
作为 V2 小规模 RAG Shadow A/B 的种子批次。其余 11 条保留为候选池，
不进入首批。

## 尚未解决

- 进入 V2：从 style_ready 人工批准一小批高质量窗口，随后小规模 RAG
  Shadow A/B 测试（候选清单已生成，等待用户批准）。
