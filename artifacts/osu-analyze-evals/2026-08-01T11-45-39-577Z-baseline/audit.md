# Analyze 基线审计

本轮为修改 Analyze 生成质量前的生产链基线。九名黄金账号均通过控制台真实 Analyze 顺序运行；输出与生成来源见同目录 `manifest.json`。

## 总体结论

- 事实错误：存在。中文约数绕过了数字校验，例如把 `60,917` 次写成“六十多万次”，并多次错误推算注册年数。
- 推断越界：严重。Recent 被反复解释为“松手、歇着、缓过来”；PP+ 低项被改写成耐力、爆发或长串能力不足。
- 人设过冷：fallback 中明显存在；mrekk 和 Ben Jiang 只剩事实列表。
- 人设过度：大量猫、鱼、猎豹、螺丝、尺子、旧书比喻，角色反应压过判断。
- 数字复读：六个短评普遍复述 2–4 个数字后接同一类比喻。
- 结论模板化：结论被压到约 115 字，常见“X 张 + 两根柱 + 焊在/立得最高”的拼接；mrekk、Ben Jiang 直接 fallback。
- 档次反应失真：mrekk 的 profile 没有抓住全球 #1；世界第一与普通账号共享“档案厚得翻时坐直/放轻手”等模板。
- 缺失数据处理错误：无 Recent 被写成玩家“跑去歇脚”；空白被当成玩家行为。
- Analyze 独立性错误：表达冷却把其他玩家近期成品句直接注入当前 prompt，且基线中可见大量跨账号复用。
- fallback：mrekk、Ben Jiang 触发；不满足主要来自正常生成链的要求。
- 谱面类型：只有确定性数据块，没有对应 LLM 判断，无法形成跨栏互证。

## 逐账号重点问题

| 玩家 | 主要问题 |
|---|---|
| mrekk | 结论 fallback；全球 #1 没有成为 profile 第一判断；PP+ 被写成猎豹和“落地歪”；Recent 编造松手；类型分布无评论。 |
| cryshina | profile 套用“档案厚得坐直”；BP 总览越区抢用 stream 分类；BP5 与 Recent 评论缺失；结论短且复读。 |
| oliwakami | profile 空洞；HDDT/NM/HD 多方向被简化为“速度主食”；PP+ 低项被写成耐力差；Recent 编造放松。 |
| Wuxin | `60,917` 错写“六十多万”；注册年数错误；HD 错写“隐身”；PP+ 低 Speed 被解释成冲刺慢；Recent 编造松手。 |
| Ben Jiang | 结论 fallback；EZDT/HT 没进入结论；PP+ 被写成耐力差；无 Recent 被写成歇着。 |
| NakanoOoOo | 注册年数错误；`86% NM` 被写成九成以上；Accuracy 的辨识度被猫比喻稀释；Recent 编造松手。 |
| ElicyAnn | 注册年数错误；成长账号被写得像成熟稳定账号；HD 错写“隐身”；近期差异被编造为松手。 |
| 13451b | 注册年数错误；明显不稳定却在结论写成“一步没跨歪”；NF 被写成放松；PP+ 低值被断言长串耐力不足。 |
| ahahhaha | 注册时长错误；HR 13/33 被写成“一半以上”；低 PP+ 被用于嘲弄能力；无 Recent 被写成歇脚；没有把 BP1 99.27% 作为核心小亮点。 |

## 生成来源

- 正常结论：7/9。
- fallback 结论：2/9（mrekk、Ben Jiang）。
- 独立 reviewer 发生拒绝：oliwakami、13451b。
- 生成侧机械 validator 有拒绝：mrekk、cryshina、oliwakami、Ben Jiang、ElicyAnn。

结论：当前基线不满足验收条件，必须调整事实结构、独立性、七区块生成、结论长度与 validator 边界后全量重跑。
