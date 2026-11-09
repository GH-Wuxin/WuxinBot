# 本地聊天语料整理工具

本目录将 QCE 导出的 chunked-jsonl 聊天记录整理为结构化文件、会话窗口和人工审阅样本。它独立运行，WuxinBot 不会自动读取原始导出或生成的报告。

## 安装

在仓库根目录打开 PowerShell：

```powershell
cd community-corpus
python -m pip install -r requirements.txt
```

下面的 `D:\QQ-exports` 是示例导出目录，请替换为自己的路径。一个根目录可以包含多个 `group_*_chunked_jsonl` 导出；多个输入目录可以用逗号分隔。

## 抽样导入

V0 抽取 30,000–50,000 条消息，保留原始行副本，并生成字段标准化结果和导入报告：

```powershell
python -m community_corpus.cli --sources 'D:\QQ-exports' --sample-size 40000 --seed 20260805
```

主要输出为 `raw/`、`normalized/messages.parquet` 和 `reports/import-report.json`。固定输入与种子用于复现抽样。

## 全量导入与窗口

V1 读取全部输入，划分会话和窗口、处理文本中的隐私字段、生成数据分区及审阅样本，不覆盖 V0 的抽样文件：

```powershell
python -m community_corpus.v1.cli --sources 'D:\QQ-exports' --seed 20260805 --review-seed 20260807
```

| 输出 | 用途 |
| --- | --- |
| `normalized/full/messages.parquet` | 全量标准化消息 |
| `normalized/full/sessions.parquet` | 会话及来源关系 |
| `windows/v1/windows.parquet` | 窗口、分类、重叠簇和数据分区 |
| `reports/full-import-report.json` | 导入结果与缺失数据 |
| `reports/window-report-v1.json` | 窗口统计 |
| `reports/manual-review-v1.jsonl` | 人工审阅样本 |
| `reports/manual-review-v1-precheck.json` | 自动预检查结果 |

会话默认以 8 分钟间隔切分，可用 `--gap-minutes` 调整。`usage_tier` 区分可独立理解的表达、依赖上下文的表达、Bot 互动、闲聊和不宜使用的内容。重叠窗口通过 `overlap_cluster_id` 关联，分区时保持同簇一致。

两种导入都支持 `--out-dir` 与 `--salt-file`。默认写入本目录下的生成文件夹；指定输出位置时，也需将它们排除在版本控制之外。

## 人工审阅

先查看实际生成的导入与预检查报告，再阅读样本。导出缺少引用目标、媒体内容或用户信息时，应保留缺失状态；不同输入的统计会不同。

可生成标注文件和表格：

```powershell
python -m community_corpus.v1.review_annotate --review reports/manual-review-v1.jsonl --windows windows/v1/windows.parquet --messages normalized/full/messages.parquet --output reports/manual-review-v1-annotated.jsonl
python -m community_corpus.v1.review_sheet --input reports/manual-review-v1.jsonl --output reports/manual-review-v1-review-sheet.csv
```

审阅时检查窗口能否理解、互动是否真实、引用对象是否正确，以及是否包含隐私。自动检查不能替代对实际输出的阅读。

## 数据与隐私

`.salt` 用于群号和成员标识的 HMAC 转换，丢失后重新生成会改变标识。保管它以及原始导出，勿提交到仓库。

标识转换不等于正文匿名化。`raw/` 和包含 `text_raw` 的标准化文件仍可能含原始私密内容；`has_pii` 是风险标记，不会自动删除正文。V1 窗口中的 `text_sanitized` 经过额外处理，但公开样本前仍应核对正文、引用与元数据。

`raw/`、`normalized/`、`windows/`、`reports/` 和 `.salt` 已列入本目录的 `.gitignore`。报告按输入重新生成，不保留某次私人导入的统计作为项目说明。

## 测试与后续使用

仍在 `community-corpus` 目录中运行：

```powershell
python -m unittest discover -s tests -v
```

测试覆盖标识转换、解析、来源定位、窗口划分和隐私标记。批准后的表达样本可用于[知识库构建](../docs/KNOWLEDGE_BASE_V41.md)；运行时的精选短语则由 [banterBank.ts](../server/bot/banterBank.ts)维护。
