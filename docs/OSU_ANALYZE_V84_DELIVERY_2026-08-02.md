# OSU Analyze v84 交付报告（2026-08-02）

最终版本号：`ANALYSIS_FORMAT_VERSION = 84`（83 → 84）
模型：生成器与 reviewer 均为 `deepseek-v4-flash`（未切换，未开 Thinking）

## 1. 本轮做了什么

按用户指令停止"单词/短语/否定前缀/修辞补丁"路线，完成 validator 大减法：

### 删除的旧规则与错误路径
- `causePattern` 动机/状态大词表（练图/手感/放松/刻意/专注/打磨/堆出/急着/敢…）及其引号/否定前缀豁免补丁
- PP+ 能力化系列（unsupportedPplusAbility / concretePplusAbility / 光标瞄准 / 塔尖托住 / 靠 X 吃饭 / 爆发容错）
- 偏好、NM 价值化、Mod 动机/胆量/适应、NF/SO 目的、同一谱面臆测
- 稳定断言（positiveOverallStabilityClaim）、堆量/经历/体量拼接、评级-总Acc拼接
- 萌新词表（成熟风格/闷头打图/训练建议/未来预测）、档位（顶尖/中坚/人口/常见度）
- 追星/舞台动作、社区用语黑名单、星数态度"日常"
- 语义单句补丁（"准确率没掉"豁免、"先于"排除、"稳定度"排除、顿号隔离等）
- `REVIEWER_QUALITY_FLAVORED_REASON` 正则过滤（用正则判断 LLM reason 的语义）
- 剪句伪装路径：失败草稿不再剪句后标记 llm；来源如实标记
- 跨报告历史表达拦截（保持为空）

### 保留的 validator（A 类硬门 + 4 条 B 类通用规则）
见 `docs/VALIDATOR_RULES_AUDIT_2026-08-02.md`：
- 数字白名单、PP+ 维度-数值绑定、Mod 精确/包含数量、分类数量、星数阈值、BP1 满准、统计夸写/忽略、倍数
- 结构/长度/JSON、身份代词、术语（Top/HD/DDT/PA/准心/alt→跳图/在线时长/年龄/次数约数）
- 简报明确未提供内容（设备/身体/replay/谱面细节）
- B 类：空 Recent 具体状态断言、聚合均值→同难度单图、无来源明确群体比较、声称不存在简报中存在的数量

### Reviewer 改为只记录
- 每份报告跑一次独立审查，per-section 意见落 `reviewLog`，不触发重写、不降级
- 生成轨迹每次 attempt 的 raw draft 落 `generationTrace[].draft`

### 修复的 bug
- `normalizeChineseQuantities` 把"3 万 pp"损坏成"3 0 pp"（阿拉伯数字后"万"被转 0）
- 星数 claims 跨短语串线（"每1张成绩上、用 7★"被读成"1 张 7★+"）
- "声称没有 98% 以上"规则漏"都没撑住"变体、误杀"没有惊天动地的单张爆发，却用 98% 以上"（间隔收窄）
- "NM 覆盖全部 BP"、HD 写成"隐身"（任意上下文）漏网

## 2. 最终生成链

```
osu! API v2 + 本地 PP+ + osu!oracle
  → collector.ts 并行采集
  → analyzer.ts 确定性事实 / 数据区 / 局部安全句
  → 七栏短评（LLM，≤3 次尝试，仅硬门拦截）
  → 结论（LLM，≤3 次尝试，仅硬门拦截；第 3 次后仅代词归一化兜底）
  → 组装 + 机械终审（结构/数字/Mod/身份）
  → 独立 reviewer 只记录意见（reviewLog）
  → 持久化 fullText + 来源 + trace + reviewLog
```

Prompt 精简：结论与七栏 prompt 均为精简原则版（约 10-14 条规则 + 数据尺度 + 事实契约），不再堆叠禁令；生成侧保留"舒适区/主场/群体比较/未来预测"等少量明确禁止项（作为生成指引，不是 validator 词表）。

## 3. 回归结果

| 阶段 | 结果 | 产物 |
|---|---|---|
| 三锚点 ×3（A/B） | 9/9 LLM、0 fallback、首稿直通 8/9 | `artifacts/osu-analyze-evals/2026-08-01T20-48-48-077Z-v85-raw-ab-*` |
| 九人黄金回归 | 9/9 LLM、0 fallback | `2026-08-01T21-05-47-198Z-v85-golden-2` |
| 八人盲测 | 8/8 LLM、0 fallback | `2026-08-01T21-10-39-685Z-v85-blind-1` |
| 绑定玩家随机十人 | 10/10 LLM（种子 20260802，候选池 14，排除 17 名已用） | `random-ten-pool-2026-08-02.json` + `v85-random-ten-*` |

随机十人名单（种子 20260802，mulberry32）：telecomadm1145 / Naaahida / b2ari / [SHK]IceTeaNeko / tan-X / CjhSmileFace / Cirno not Baka / owoshuangshi / 159263748abc / Ciel

## 4. 统计

- 结论首稿直通率：8/9（88.9%）
- fallback 率：0（最终批次；CjhSmileFace 曾因"没有惊天动地…却用 98% 以上"误杀掉 fallback，修复通用规则后重跑通过）
- 机械拒绝全部为可证明硬错误（简报外数字、Mod 数量、字段绑定、星数阈值）
- 语义/文风误杀：0
- 后处理退化：修复 normalize 坏字后为 0
- 硬事实漏判修复：4 处（星数串线、98% 变体、NM 全覆盖、隐身）
- 人工审读：27 份最终输出逐份审读（9 锚点 + 9 黄金 + 8 盲测 + 1 重跑），结论互相可区分

## 5. 验证

- `npm run typecheck` 通过
- 18 组 fixture + 4 组新硬门回归全绿
- 服务运行中，OneBot 已连接

## 6. 已知遗留

- 数字白名单无法拦截"字段错绑"（如把星数计数 91 写成 NM 占比）——由 reviewer 记录，后续可加结构化占比核对
- 语义质量（"手感""碰更硬的图""想亲眼看看"等）依赖 reviewer 记录 + 人工审计，不在机械层拦截
- PP+ 上游偶发 HTTP 500（`lol server goes boooom`），采集器有重试
- `/api/osu/player/:id/pplus` 已修复（数组路由 + `/ppplus` 兼容别名），控制台正常

## 7. 修改文件

```text
M server/osu/analyzer.ts    validator 减法、normalize 修复、reviewer prompt、规则合并
M server/osu/commands.ts    审查只记录、trace.draft、格式版本 84、硬门重写循环简化
M tools/osu-fixture-verify.mjs  新边界断言（C/D 类改放行、A/B 类保留、新增 4 组）
?? tools/osu-analyze-random-ten.mjs  随机十人泛化脚本
?? docs/VALIDATOR_RULES_AUDIT_2026-08-02.md
?? docs/OSU_ANALYZE_AB_TEST_2026-08-02.md
?? docs/OSU_ANALYZE_V84_DELIVERY_2026-08-02.md
?? artifacts/osu-analyze-evals/…（v85-* 全部产物）
```

Git 工作区仍包含此前未提交的用户与历史改动（persona/knowledge/quickRouter 等），禁止 reset/checkout/clean。
