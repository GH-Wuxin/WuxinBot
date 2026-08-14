# DSML 工具调用标记防护修复报告（Remediation V04）

- 日期：2026-08-14（V04 修订于同日）
- 仓库：`G:\QQ-AI-ChatBot`（WuxinBot），分支 `refactor/wuxin-cleanup-20260731-224209`
- 状态：**FIXED_AND_VERIFIED（未提交，未部署）**
- 性质：对 2026-08-12 未提交批次（防幻觉/防 DSML 泄漏主题）中**自带测试不通过**的缺陷的修复 + 三轮独立复审后的加固（V02/V03/V04）

本文是给接手 Agent 的交接文档。磁盘状态是权威；本文如有与代码不一致处，以代码与测试为准。

---

## 0. 修订记录

| 版本 | 内容 |
|---|---|
| V01 | 核心闭合标签根因修复（normalizeDsmlTags）、`message?.content` 空值修复、required-tool 空引导兜底、KB 基线重固化；三个 verifier + kb-verify + verify-all 67/67 |
| V02 | 复审指出 3 个 P1 + 1 个 P2 缺口与 2 处文档失实。修复：ASCII 竖线检测、截断 fail-closed（数量配平）、引导重试 + 诚实文案、工具 schema 白名单；verify-all 67/67 |
| V03 | 复审指出数量配平可被错配标签绕过。修复：栈式结构校验（同名闭合 + LIFO）应用于 strip；补错配/乱序回归；unexposed-tool 直断言 executor=0；新增引导重试成功端到端回归；verify-all 67/67 |
| V04 | 复审指出结构校验**只在 strip 生效**：`<tool_calls><invoke name="query_osu"><parameter name="capability">bp</parameter></tool_calls></invoke>` 剥离为空但仍被 parse 解析成 query_osu/bp 并真实调用了 executor（实测 LLM=2 / executor=1）。修复：`parseToolCallMarkup` 复用同一结构校验，非法结构返回 `[]`；三个错配用例同时断言 `parse=[]`；新增 exposed-tool + malformed-markup 的 runToolLoop 回归（executor 必须为 0）。verify-all 见 §6 |

## 1. 背景

08-12 有一批未提交改动（工具调用标记防护 + persona 防幻觉规则 + `!pr #N` 解析），目的是修复 08-12 生产事故：模型把 `query_osu` 的调用以 **DSML 文本**写进 `content`，被原样发给了用户。

接手时发现该批未提交代码**自己的回归测试是红的**：

```
query-osu-policy-verify:     28 passed, 3 failed
natural-chat-delivery-verify: 4 passed, 3 failed
```

## 2. 诊断（已最小复现，V01）

对 `server/bots/guard.ts` 的实测（输入用生产事故形态）：

| 输入形态 | looksLikeToolCallMarkup | stripToolCallMarkup | parseToolCallMarkup |
|---|---|---|---|
| 普通 XML `<tool_calls><invoke …></invoke></tool_calls>` | ✅ 命中 | ✅ 干净 | ✅ 解析出 1 个调用 |
| **真实 DSML** `<｜DSML｜tool_calls>…<｜DSML｜/parameter>` | ✅ 命中 | ❌ 残留参数值 | ❌ 返回 `[]` |
| 全角双竖线变体 `<｜｜tool_calls>…<｜｜/parameter>` | ✅ 命中 | ❌ 残留参数值 | ❌ 返回 `[]` |

后果链：剥离不干净 → 参数值泄漏；解析失败 → 无法转结构化调用；`executor.ts` 对无结构化 `message` 的响应解引用崩溃；`bot.ts` 引导语剥空且无直发载荷时整条回复失败。

## 3. 根因（V01 已确认）

成对标签正则假设闭合标签是 `</tag>`（斜杠紧跟 `<`）。真实泄漏形态是**竖线在斜杠之前**：`<｜DSML｜/tag>`（markupAscii 后为 `<|DSML|/tag>`），以及不带 DSML 字样的 `<｜｜/tag>`。检测层正常，问题集中在剥离与解析两层。

## 4. V01 修复内容

### 4.1 `server/bots/guard.ts`

新增归一化函数，`stripToolCallMarkup` 与 `parseToolCallMarkup` 都先经它处理：

```ts
function normalizeDsmlTags(value: string): string {
  return value
    .replace(/<([^>]*?)\|{1,2}\s*DSML\s*\|{1,2}([^>]*?)>/gi, '<$1$2>')
    .replace(/<(\s*)\|{1,2}/g, '<$1')
    .replace(/\|{1,2}\s*>/g, '>');
}
```

### 4.2 `server/bots/executor.ts`：`message?.content` / `message?.reasoning_content` 可选链。

### 4.3 `server/bot.ts`：外层标志 `requiredToolLed`；required-tool 空引导兜底（V01 为「查好了。」，V02 已改为诚实文案，见 §9.3）。

### 4.4 `tools/fixtures/kb-legacy-prompts.json` 基线重固化（`kb-capture-legacy.mjs`）：persona 刻意变更后必须重固化，否则 kb-verify A1 门变红。以后任何刻意 prompt 变更都必须同步重捕获。

## 5. V02 复审发现的缺口与修复

### 5.1（P1）ASCII 竖线 DSML 绕过检测 —— 已修

`<|DSML|tool_calls>` 形态此前 `detected=false`。修复：`TOOL_MARKUP_OPEN_RE` / `DSML_PIPE_RE` 的管道字符类从 `｜` 改为 `[｜|]`，且 `looksLikeToolCallMarkup` 对**原始文本与其 ASCII 归一化形态各测一次**。回归：`markup-detect-ascii-pipe` / `markup-strip-ascii-pipe` / `markup-parse-ascii-pipe`。

### 5.2（P1）截断/不闭合标记泄漏参数值 —— 已修（fail-closed）

成对删除遇到预算耗尽/流式中断产生的截断文本时会留下裸参数值（如 `pp_calc`）。V02 先做了开/闭标签**数量配平**；V03 复审指出数量配平可被**错配标签**绕过（`<parameter name="capability">pp_calc</invoke>`：开=1 闭=1，数量相等但名称不符，剥离后仍残留 `pp_calc`）。

V03 最终实现：`stripToolCallMarkup` 在归一化后先做**栈式结构校验** `validateToolMarkupStructure`——按顺序扫描每个工具标签，开标签入栈、闭标签必须与栈顶同名（LIFO）、自闭合标签 `<parameter …/>` 合法跳过、结尾栈必须为空。`tool_call`/`tool_calls` 归一为同一族名（与成对删除正则的家族语义一致）。任何错配、乱序、缺失或多余闭合 → 整体返回 `''`。

**V04 关键补丁**：该校验同样应用于 `parseToolCallMarkup`——结构非法的标记返回 `[]`，绝不能被解析成可执行调用。V03 的"彻底闭环"结论因此被推翻过一次：strip 路径已闭环，但 parse 路径在 V03 仍可把错配文本里的 `<invoke>…</invoke>` 子串解析成合法调用并真实调用 executor。V04 起两条路径共用同一结构门。

回归（`query-osu-policy-verify.mjs`）：`markup-strip-mismatched-close` / `markup-parse-mismatched-close`、`markup-strip-mismatched-open` / `markup-parse-mismatched-open`、`markup-strip-lifo` / `markup-parse-lifo`（三个错配用例均同时断言 `strip=""` 且 `parse=[]`），加上 V02 已有的截断用例。运行时回归（`natural-chat-delivery-verify.mjs`）：`runToolLoop-dsml-malformed-no-exec`——工具已暴露但 DSML 结构错配时，注入 executor 探针断言执行次数 === 0 且输出中性兜底。

### 5.3（P1）无载荷时误导性「查好了。」—— 已修

- `executor.ts`：required-tool 引导语为纯标记且**没有直发载荷**时，先做一次带纠正指令的引导重试（明确禁止再输出工具调用标记）；仍失败才返回空。
- `bot.ts`：required-tool 空引导且无图时，兜底文案改为诚实重试提示 `这次查询我这边没整理好，你稍后再试一次？`，不再谎称「查好了」。普通聊天空内容仍保持硬报错不变。
- `natural-chat-delivery-verify.mjs`：期望同步更新为该诚实文案。

### 5.4（P2）文本 DSML 可调用本轮未暴露的工具 —— 已修

`executor.ts` 解析文本调用后，先按本轮 `tools` schema 的工具名白名单过滤（`exposedNames`），未暴露的工具名被丢弃，绝不进 executor。回归：`runToolLoop-dsml-unexposed-tool`——V03 起该用例**注入 `executeToolCallFn` 计数探针并直接断言执行次数 === 0**（仅统计 LLM 调用次数无法证明"绝不进入 executor"）。

### 5.6 引导重试路径的端到端锁定（V03 新增）

V02 的 required-tool 引导重试（首轮纯 DSML → 带纠正指令重试）实测有效，但原 verifier 只断言最终诚实兜底文案——即使重试被删掉，测试仍可能通过。V03 新增 `natural-dsml-retry-success` 端到端用例：mock 首轮引导返回 DSML、纠正重试返回自然语言 `查到你的 BP1 了，是一张跳图。`，断言交付文本包含该自然结果、无任何标记、且引导+重试共 ≥2 轮。

### 5.5 文档失实修正

- fixture 描述更正：`natural-chat-delivery-verify.mjs` 的 `DSML_LEAK_TEXT` 是**全角双竖线**形态（`<｜｜tool_calls>`，不带 DSML 字样）；`query-osu-policy-verify.mjs` 现覆盖四种形态：普通 XML、全角单竖线 DSML（08-12 生产形态）、全角双竖线、ASCII 竖线。此前报告把它写成单竖线且未锁回归——V02 已全部锁住。
- 删除「括号外散落的 `|DSML|` 片段由 keyword 清理正则兜底」这一错误声明（该正则只处理标签括号内）。正确表述见 §10 边界。

## 6. 验证证据（V04）

| 检查 | 结果（V04） |
|---|---|
| `tools/quick-router-verify.mjs` | 121/121 PASS |
| `tools/query-osu-policy-verify.mjs` | **45/45 PASS**（markup 系列含 ASCII/单竖线/双竖线/截断/错配×3(strip+parse 双断言)/乱序回归） |
| `tools/natural-chat-delivery-verify.mjs` | **10/10 PASS**（executor 零执行直断言×2、引导重试成功端到端、错配结构不执行） |
| `tools/kb-verify.mjs` | 56/56 PASS |
| `tsc --noEmit` | PASS |
| `git diff --check` | PASS（仅 CRLF 提示） |
| `npm run verify-all` | **67/67 PASS**（V04 收尾最终一轮，88.0s） |

最小复现（V02 后）：

```text
ASCII 管道  → detected: true / stripped: "" / parsed: [{query_osu, {capability:"bp"}}]
单竖线 DSML → detected: true / stripped: "" / parsed: [{query_osu, …}]
截断 DSML   → strip 返回 ""（fail-closed，参数值不残留）
```

## 7. 生产影响与部署边界

- **当前运行中的生产进程（pid 29588，2026-08-14 12:09 启动）仍运行修复前代码**。本修复只存在于工作区，**重启后才会生效**。
- 红线：先提交后部署。**本报告不含提交动作**；提交与重启需用户明确授权。
- 提交前建议顺序：用户审阅本报告 → 提交到当前分支 `refactor/wuxin-cleanup-20260731-224209`（不推送、不动 GitHub 公开分支）→ 再重启后端。

## 8. 本次未做（刻意边界）

- 未提交任何内容；未 `reset/checkout/clean`；未推送。
- 未触碰：生产 db、`.env`、`.private/`、08-08 三份审计文档、`!pr #N` 修复（保持原样）。
- GitHub 公开分支（`origin/main`）未同步；本地与 GitHub 的差异（本地多 191 提交 / GitHub 独有 11 提交，其中 `5f2d2da` 的内容已以未提交形式存在于本地）维持原状，同步方案另行决策。
- 检测层语义不变（`looksLikeToolCallMarkup` 的行为与 V01 相同，仅扩大字符覆盖面）。

## 9. 已知边界（留给后续）

- 归一化与清理只处理**标签括号内**的装饰与标记；括号外的散落 `|DSML|` 片段**不会被移除**（它不是调用标记，删除可能误伤正常文本；V02 已删除此前错误的兜底声明）。如后续要求连装饰碎片也清理，需单独设计文本级规则并补回归。
- `normalizeDsmlTags` 的裸竖线替换（`<|`、`||>`）仅在「已判定为工具调用标记」的文本上执行，正常聊天文本不经过它。
- DSML 解析出的调用 ID 用 `dsml_<时间戳>_<随机>` 生成，仅用于当轮消息协议，不落盘、不影响确定性审计。
- 截断 fail-closed 策略：不配平的标记文本整体丢弃（返回空串），宁可少回也不泄漏参数值；这是有意取舍。
