# community-corpus V0

osu! 社区语料管线试验集（import-only）。本目录独立于 WuxinBot 主体，
不修改 Analyze V89，不包含向量检索 / RAG / 微调 / WuxinBot 接入。

## 职责

V0 只做四件事：

1. 从 QCE chunked-jsonl 导出中确定性采样 30,000 ~ 50,000 条消息；
2. 在 `raw/` 保留原始行的只读副本并生成 `manifest.json`（SHA-256 / 格式 / 大小 / 消息数）；
3. 标准化为 `normalized/messages.parquet`，群号和成员 ID 使用带 salt 的 HMAC 匿名化；
4. 生成 `reports/import-report.json` 质量报告。

## 目录结构

```text
community-corpus/
  community_corpus/       # 管线代码
  tests/                  # 测试与 fixture
  raw/                    # 采样后的原始行副本（只读，运行生成）
  normalized/             # messages.parquet（运行生成）
  reports/                # import-report.json（运行生成）
  .salt                   # HMAC secret（首次运行自动生成，勿提交）
```

## 安装

```bash
python -m pip install -r requirements.txt
```

## 使用

```bash
# 直接给 QCE 导出目录（多个用逗号分隔）
python -m community_corpus.cli \
  --sources "%USERPROFILE%\.qq-chat-exporter\exports\group_REDACTED_GROUP_002_20260805_114156_chunked_jsonl" \
  --sample-size 50000 \
  --seed 20260805

# 也可以给 exports 根目录，自动发现全部 group_*_chunked_jsonl
python -m community_corpus.cli --sources "%USERPROFILE%\.qq-chat-exporter\exports" --sample-size 40000

# 指定输出目录 / salt 文件
python -m community_corpus.cli --sources ... --out-dir G:\somewhere --salt-file G:\somewhere\.salt
```

`sample-size` 必须在 30000 ~ 50000 之间。固定 `seed` 与固定输入保证同一输入
重复运行结果一致（原始副本字节级一致、parquet 行一致）。

## 匿名化

- 群号：`HMAC-SHA256(salt, "group:" + group_id)`
- 成员：`HMAC-SHA256(salt, "sender:" + uin_or_uid)`
- 提及：`HMAC-SHA256(salt, "mention:" + uin_or_uid)`
- 昵称、QQ 号、uid 不写入标准化输出；`text_raw` 保留原文，但 `has_pii` /
  `pii_types` 会标记 QQ 号 / 手机号 / 邮箱风险。
- `.salt` 丢失后重新生成会导致全部 hash 变化；请备份。

## messages.parquet 字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| message_id | string | 原始消息 ID |
| group_id_hash | string | HMAC 群号 |
| sender_id_hash | string | HMAC 成员 ID |
| timestamp | int64 | epoch 毫秒 |
| reply_to_id | string | 被回复消息 ID（无则为空） |
| message_type | string | text/reply/forward/json/video/.../unknown |
| text_raw | string | 原始文本 |
| text_clean | string | 去除媒体占位符 / 回复前缀后的文本 |
| mentions | list<string> | HMAC 提及 ID |
| media_type | string | none/image/video/audio/file/... |
| has_media | bool | 是否带媒体 |
| is_bot | bool | 发送者是否 pippi（REDACTED_QQ_002） |
| is_system | bool | 是否系统消息 |
| bot_output_like | bool | 内容级 bot 输出识别（如消防栓“个人信息—osu!”完整格式），
  不依赖发送者账号 |
| recalled | bool | 是否撤回 |
| has_pii / pii_types | bool / list<string> | PII 标记 |
| source_file / source_offset | string / int64 | 定位回 `raw/` 的原始行（1 起） |

## 测试

```bash
cd community-corpus
python -m unittest discover -s tests -v
```

测试覆盖：HMAC 稳定性与原始 ID 不外泄、时间戳、reply 绑定、unknown 保留、
原始条数可核对、media/clean 文本、PII 标记、raw 只读与 manifest、报告结构。

## 验收口径

- 试验集导入无崩溃；
- `normalized/` 中无原始成员 ID；
- 99%+ 消息被标准化或明确记录为 unknown；
- 任意标准化消息可通过 source_file/source_offset 定位回原始记录；
- 测试、报告全部通过。

---

# community-corpus V1（全量窗口语料）

V1 在 V0 之上做全量标准化、会话/窗口切分、文本匿名化与确定性分区。
V0 的 `normalized/messages.parquet` 保持冻结，不被 V1 覆盖。

## 新增输出

```text
normalized/full/messages.parquet   全量消息（1,279,462 行，3 群）
normalized/full/sessions.parquet   会话（8 分钟间隔，31392 个）
windows/v1/windows.parquet         窗口（547946 个，含 usage_tier 与 overlap_cluster_id）
reports/full-import-report.json    全量导入报告（消息/类型/时间/reply/媒体/Bot/PII/失败）
reports/window-report-v1.json      全量统计报告
reports/manual-review-v1.jsonl     固定种子人工抽查样本（300 条）
reports/manual-review-v1-review-sheet.csv
                                  人工审核打分表（由 JSONL 派生，非正式产物）
reports/manual-review-v1-annotated.jsonl
                                  逐行安全标注（含 message_id/角色/媒体类型）
reports/manual-review-v1-review-sheet.xlsx
                                  易读审核表（冻结表头/自动筛选/中文列名）
reports/manual-review-v1-precheck.json
                                  300 条自动预检（隐私一票否决 + 分层/簇完整性）
```

## 运行

```bash
python -m community_corpus.v1.cli \
  --sources "%USERPROFILE%\.qq-chat-exporter\exports" \
  --seed 20260805 \
  --review-seed 20260807 \
  --salt-file REDACTED_REPO_ROOT\community-corpus\.salt
```

## V1 管线

1. 全量导入：读取全部 QCE chunked-jsonl，沿用 V0 salt 做 HMAC 匿名化，
   孤立代理项（lone surrogate）替换为 U+FFFD，保证 UTF-8 parquet 可写。
2. 会话：组内按时间排序，间隔 >8 分钟切新会话；超长会话按 250 条分段；
   跨会话 reply 引用补进 `context_message_ids`。
3. 窗口：先按话题边界切段，段内取最大合法窗口（3-12 条），再按
   `usage_tier` 分为五层：
   - `style_ready`：文本本身足够理解，可直接用于社区语感 RAG；
   - `contextual_style`：有社区表达价值，但依赖图片/Bot 结果/额外上下文；
   - `bot_interaction`：命令、查分结果、Bot 回复及其后续人类反应；
   - `ambient_chat`：群聊碎片、短反应、接梗和多话题环境；
   - `private_or_rejected`：隐私/高风险/广告/无意义刷屏，不进入生产。
   `temporal_burst` 不再按固定 8 分钟平移拼接；命令与 Bot/系统输出强制断段；
   高度重叠窗口不删除，按 message_ids Jaccard / trigger+时间+内容近似度生成
   `overlap_cluster_id`（检索侧同一簇最多返回一条，见
   `retrieval_dedupe_windows`）。
   窗口内仅保留 `text_sanitized`；`text_raw` 只用于本地溯源。
4. 匿名化：QQ/手机/邮箱/IP/邀请链接/凭据/私有 URL 参数/身份证/银行卡/
   昵称/实名自述/@提及/位置/Discord 等 profile 字段/转发作者名替换为占位符；
   pp/rank/acc/beatmap 等 osu 数字与术语不误删。
5. 分区：按群内会话时间顺序 70/15/15 切 train/review/eval，会话不跨分区，
   高重叠窗口必然同分区。

## 已知数据缺口

- reply 目标缺失：QCE 导出不包含 reply 消息所引用的原始消息
  （抽查 1000 个引用，0 个存在于原始导出），因此 `reply_chain` 窗口数为 0。
  报告中的 `dataGaps` 记录该缺口；若后续补充更完整的导出，此类型窗口
  可直接产出，无需改代码。
- 媒体依赖窗口：约 55% 的窗口依赖图片/视频触发。媒体依赖不等于 rejected，
  统一归入 `contextual_style`；训练/检索时建议保留媒体占位提示。

## V1 验收口径

- 约 128 万条消息全部处理，解析失败 0；窗口共 547,946（精确重复剔除 4,210；
  高度重叠不删除，37,196 个重叠簇覆盖 82,941 个窗口）；
- 分层规模：style_ready 24,059 / contextual_style 238,690 /
  bot_interaction 194,872 / ambient_chat 1,257 / private_or_rejected 89,068；
- 全部窗口可经 `source_refs` 回溯到原始 JSONL 行（已抽查 5000 条，0 失败）；
- 窗口 `text_sanitized` 无手机/邮箱/IP/凭据/身份证/银行卡/QQ 号/邀请链接
  残留（全量双引擎扫描 0 命中）；
- bot 输出型窗口 23,267 个（4.24%），已分流到 `bot_interaction` 层，
  审核表 `annotated_lines` 中标为 `[bot]`；
- 300 条审核样本自动预检全部通过：0 隐私泄露（样本与全量）、0 审核表泄露、
  0 分层缺失、0 簇缺失、0 样本簇重复、0 溯源缺失；
- 同一输入 + seed 输出完全一致（测试覆盖 fixture，全量亦无随机源）；
- 隐私与安全是唯一一票否决；普通窗口质量（可独立理解/有效互动/触发关系/
  纯 bot 占比）仅作 V2 style_ready 人工批准参考，不再作为 V1 门槛。

## 人工审核表

```bash
python -m community_corpus.v1.review_annotate \
  --review reports/manual-review-v1.jsonl \
  --windows windows/v1/windows.parquet \
  --messages normalized/full/messages.parquet \
  --output reports/manual-review-v1-annotated.jsonl

python -m community_corpus.v1.review_sheet \
  --input reports/manual-review-v1.jsonl \
  --output reports/manual-review-v1-review-sheet.csv
```

CSV/XLSX 每行一个窗口，含 usage_tier / overlap_cluster_id，末尾带五项
参考打分列（understandable、effective_interaction、
trigger_reply_correct、bot_system_spam_only、privacy_leak）和 notes；
仅由 JSONL 派生，不改变样本本体。其中只有 privacy_leak 是一票否决项。

```bash
python -m community_corpus.v1.review_quickstart \
  --review reports/manual-review-v1.jsonl \
  --annotated reports/manual-review-v1-annotated.jsonl \
  --output reports/manual-review-v1-quickstart.md
```

快速指引会列出高风险、媒体依赖、命令密集/低反应候选窗口，
并附审核步骤与验收口径，方便直接开始人工审核。

`annotated_lines` 列把每行标注为
`S2[bot,text] ...` / `S1[human,media:image]` 形式，便于区分原文中的人、
bot 输出、系统消息和媒体消息；`manual-review-v1-annotated.jsonl` 还保留
逐条 message_id、角色、消息类型与媒体类型，供程序化审核。

筛选列：`bot_line_count` / `system_line_count` / `human_text_line_count`
分别统计窗口内 bot、系统、真人文字行数；`has_bot_output=1` 表示含 bot
输出，`human_only=1` 表示纯人类窗口（无 bot、无系统行），可直接筛选。
