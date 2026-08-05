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

## 提交记录（refactor/wuxin-cleanup-20260731-224209）

- 461ac00 chore(corpus): scaffold community-corpus base pipeline and ignore generated outputs
- 17153dc feat(corpus): full redaction for tokens, group ids, profiles, forwards, invites
- 8e84877 feat(corpus): topic-aware window segmentation, dataset split, near-dup dedup
- 7a5bbbb feat(corpus): secure annotated review export, XLSX sheet, precheck
- 4544ab7 test(corpus): 39 unit tests green, mypy clean; freeze legacy corpus-build.mjs

## 尚未解决

- 300 条人工审核（understandable ≥80%、effective ≥75%、trigger ≥95%、
  bot/spam ≤5%、privacy 0）；当前自动预检通过，等待人审打分回填。
- 人审不通过时按回填结果只修通用机制，再重抽新 300 条。
