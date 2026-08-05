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

## 尚未解决

- 人工只审隐私与分层合理性（privacy_leak=0 必须；质量列仅参考）。
- 进入 V2：从 style_ready 人工批准一小批高质量窗口，随后小规模 RAG
  Shadow A/B 测试。
