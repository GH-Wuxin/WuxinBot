# Wuxin osu! Analyze 持续迭代与交接记录

最后更新：2026-08-01（Asia/Shanghai）  
项目：`REDACTED_REPO_ROOT`  
当前格式版本：`ANALYSIS_FORMAT_VERSION = 79`  
当前模型：生成器与独立 reviewer 均为正式版 `deepseek-v4-flash`  
当前状态：v79 九人真实回归与人工审读已完成；结果未通过，不能宣称功能已经定稿，也不能进入用户八人盲测。

这份文档是当前 osu! 玩家全量分析功能的主交接文档。它记录从最初的“API 数据加一段 LLM 总结”到现在的分栏生成、机械事实门、独立复审和真实回归体系。旧文档仍可用于追溯背景，但其中一部分设计已经被后续实测推翻，冲突时以本文和当前代码为准。

## 1. 产品目标

Analyze 不是 LazyBot/猫猫式的确定性查询面板。它要让 pippi 根据官方 API、PP+ 与谱面分类数据，看懂“这个账号为什么像这个人”，形成接近人物志或球探报告的评价。

最终输出同时需要满足：

- 所有数字与关系可由当前输入核验；
- rank、账号总 PP、BP 结构、Mods、PP+、Recent、谱面分类共同参与判断；
- 顶尖玩家、普通玩家、稀疏萌新得到明显不同的反应分量；
- pippi 鲜活、自信、懂 osu!，有少女感和一点最强者的小得意；
- 不写客服、主持人、冷分析师、追星者或合规审查员口吻；
- 短评负责产生观察，结论负责跨栏综合，不能逐行复读数字；
- 不靠用户名特判，不把真实测试玩家塞进 Prompt，不复制黄金样本文案。

人工黄金样本：`docs/微调后黄金实例.txt`。

## 2. 用户已经明确拍板的要求

### 2.1 模型

- 暂停使用 `deepseek-v4-pro`。当前 Pro 是 preview。
- 生成器固定使用正式版 `deepseek-v4-flash`。
- reviewer 也固定使用正式版 `deepseek-v4-flash`。
- 后续切模型必须重新跑完整回归，不能只比较单次文风。

### 2.2 pippi 人设

pippi 是本项目世界观中替 Auto 模组完成完美游玩的隐藏最强玩家。她知道人类比自己弱很多，但认真看待人类成绩，不施舍鼓励，也不拿 Auto 标准压人。

理想表现：

- 判断直接，有真实情绪；
- 遇到夸张成绩会明显惊讶，普通账号也会认真找到值得说的地方；
- 偶尔有一点雌小鬼或最强者的小得意，但不能每句卖萌、反问或嘲讽；
- 明确自称时只能说 `pippi`，不能把 `Auto` 当名字；
- 消息本身由 pippi 发出，不输出 `pippi：`、署名或“作为 pippi”；
- 人格来自观察角度与说话节奏，不能靠“挑眉、凑过去看屏幕”等舞台动作支撑。

### 2.3 用户明确不喜欢的文风

- 每个玩家都用“很整齐、很好看、别把自己当普通路人”等模板句；
- “不是 X，而是 Y”“与其 X 不如 Y”及类似先否定再改口；
- 把程序数字换个说法后再念一遍；
- 每栏都补“数据不足、不能说明、原因未知”的免责尾巴；
- 一份报告连续六七次强插 `pippi：`；
- 冷淡的“清晰自我定位、作为旁观者我尊重”等分析师话术；
- 追星式“最迷人、塔尖的孤独”、动作式“想凑过去看屏幕”；
- 为了人格而羞辱萌新、贬低其他玩家或施舍鼓励。

### 2.4 osu! 术语底线

- Best Performance 面向玩家写 `BP`，不写 `Top`；
- accuracy 写 `Acc` 或准确率，不写 `PA`；
- cursor 写光标，不写准心；
- `HD` 不翻译成“隐身模组/隐身图”，也不是谱面自带；
- `HDDT` 不能误写成 `DDT`；
- `NM` 只表示该成绩未启用 Mod，不等于裸实力、真实实力或更诚实；
- 串图、跳图、串批、pp 图、刷 pp、农 pp 是允许的社区语言；“农图、藏图、甜品图、串图选手”等不自然词已禁用；
- NF/SO 不能被解释成“为了够到更难的图”；
- `play_count` 是游玩次数，不是点击次数；`play_time` 是累计游玩时长，不是在线时长。

## 3. 当前数据和报告结构

### 3.1 确定性数据层

`server/osu/analyzer.ts` 的 `analyzeData` 负责把 API 与附加服务数据转为：

- `safeFacts`：只给 LLM/reviewer 使用的核准事实；
- `safeBody`：用户可见的确定性数据区块；
- `safeSectionFallbacks`：每栏局部安全短评；
- `safePippiFallback`：结论失败时的确定性安全结论；
- `safeFallback`：整份报告的最终安全版本；
- `knowledgeContext`：按当前数据命中的 osu! 知识块。

用户可见报告固定为八个节点：

1. 账号档案；
2. BP 总览；
3. BP5；
4. Mods；
5. PP+ 六维；
6. Recent；
7. 谱面类型分布；
8. 结论。

### 3.2 七栏短评

七个非结论节点分别生成一条短评。内部 JSON 使用：

```json
{
  "profile": {
    "evidence": "本栏最关键的核准事实",
    "judgment": "真正值得说的观察",
    "comment": "最终显示给玩家的短评"
  }
}
```

最终只显示 `comment`。`evidence/judgment` 的目的，是迫使模型先选证据、再形成判断，减少看到数字就复读。

每栏独立记录来源：`llm`、`fallback` 或 `none`。整组来源可为 `llm`、`mixed`、`fallback`、`none`。

### 3.3 结论

结论单独生成，不是第八条同类短评。要求：

- 必须使用核准的全球 rank 或账号总 PP 判断分量；
- 至少覆盖三类非档案栏目；
- 找出最有辨识度的整体印象，同时保留一个次结构、反差或未知；
- 不复制前文短评，不逐栏报数；
- 角色反应必须落到当前账号，而不是万能夸奖。

### 3.4 独立 reviewer

reviewer 与 pippi 人格完全隔离，输入完整报告与 `verified_facts`，对八个 section 分别返回：

```json
{
  "section": "mods",
  "result": "REJECT",
  "kind": "hard",
  "reason": "把 HDDT 说成唯一提速组合，但包含统计还有其他 DT 成绩"
}
```

`hard`：数字、关系、身份、Mod 语义、能力/动机/机制编造等事实安全问题。  
`quality`：模板复读、没有综合、角色过冷、遗漏关键矛盾等成品质量问题。

当前最多四轮复审：

- hard reject：只重写或局部 fallback 被拒部分；
- quality reject：走定向质量编辑器，保留原稿中已成立部分；
- 第四轮仍有 hard reject：不得输出被明确判错的文本；
- 第四轮只有 quality reject：保留 LLM 成品，但必须在 `reviewLog` 暴露，不能冒充验收通过。

v79 新增：初次七栏生成若有任一栏已经落入 fallback，会在生成结论前自动再走一次定向质量编辑，避免机械数据行轻易混入成品。

## 4. 关键实现文件和累计改动

### `server/osu/analyzer.ts`

累计主要改动：

- 重构 `analyzeData` 的安全事实、确定性正文、局部 fallback 与结论 fallback；
- 增加账号写作焦点，按本次事实提示模型优先关注 rank、低 Acc 覆盖、稀疏样本、特殊 Mod 等；
- 增加 PP+ 15 基准线与超出幅度；15 是 LazyBot 旧 `expertPlus` 显示基准，不是上限；
- 增加 Mod 包含统计，HDDT 同时计入 HD 和 DT，避免完整字符串误算；
- 增加谱面分类第一/第二类、差值与样本成熟度；
- 增加知识路由、Prompt 构造、分栏 JSON 解析、双重编码解包；
- 增加中文数量正规化与用户可见术语清理；
- 增加短评、结论、完整报告、reviewer JSON 的多层校验；
- 增加 pippi 风格冷却与近期句子骨架复用检查；
- 报告长度上限放宽到 6000，单栏机械上限 260；v79 将普通短评最低长度降至 14，空 Recent 降至 8，避免为凑字数制造免责声明。

### `server/osu/commands.ts`

累计主要改动：

- Analyze 队列与控制台触发；
- 七栏先生成、结论后生成；
- 生成器和 reviewer 的模型常量分离，当前都为 Flash；
- 分栏来源、结论来源、每轮 trace、rejected draft、validation reasons 全部落库；
- reviewer 最多四轮，只重写被拒部分；
- hard/quality 两类编辑路径分离；
- quality 编辑失败时保留原 LLM 来源，不伪装成成功或 fallback；
- hard reject 到最终轮时只降级被拒组件，不破坏已经 PASS 的栏目；
- v79 新增初始 fallback 栏自动质量编辑；
- 格式版本由 77 → 78 → 当前 79，用于缓存隔离。

### `tools/osu-fixture-verify.mjs`

离线回归从基础归一化测试扩展为 17 组，覆盖：

- PP+ 正常与超过 15；
- 无 PP+、空 Recent、均衡账号、稀疏账号、世界第一；
- 官方 Mod 调整后星数优先级；
- 绑定格式兼容；
- 术语、数字、Mod 语义与身份边界；
- PP+ 不得翻译成具体操作能力；
- NF/SO、NM、EZ 等特殊 Mod 边界；
- 低 Acc 多数时“整体未收稳”与 BP1 局部干净可同时成立；
- 中文约数、账号年龄换算、游玩次数历史推断；
- 分类数量、精确 Mod/包含口径、BP1 非 100% 不得写“打满”；
- 活跃玩家人口档位、Acc+游玩次数伪关系；
- reviewer hard/quality 解析和局部重写来源。

### `tools/osu-analyze-eval.mjs`

真实批量评测脚本：

- 默认九人黄金回归；
- `--set=provided` 运行用户提供的八人盲测；
- 每人触发控制台 Analyze、轮询完成、保存完整文本与公开元数据；
- 输出目录：`artifacts/osu-analyze-evals/<时间>-<label>`；
- `manifest.json` 保存模型、格式版本、来源、reviewLog、生成 trace、PP+/Recent 状态。

## 5. 历轮迭代记录

真实输出均保存在 `artifacts/osu-analyze-evals`。目录从 baseline、iteration-1 一直保留到当前 iteration-13，没有清理。

### 基线到 iteration 3：先解决“能分析”

- 建立账号档案、BP、Mods、PP+、Recent 与分类的确定性数据区块；
- 从单段总结改为分栏短评 + 综合结论；
- 注入 pippi 世界观与 osu! 常识；
- 去掉 `pippi：` 和报告署名；
- 从强制第二人称改为：只在确认分析对象是发起者本人时自然使用“你”，第三方账号使用用户名或中性称呼。

### iteration 4–7：解决“像模板和复读机”

- 强制每条短评完成归纳、对比、异常或评价，单纯改写数字无价值；
- 将人格密度从每个节点强插改成：每栏仍有现场短评，但说话动作、句式和情绪必须变化；
- 限制连续反问、舞台动作、固定萌系口癖；
- 增加 rank/pp 的反应分量，避免 mrekk 与普通玩家同一种语气；
- 引入风格冷却，阻止近期成品句子骨架和“多看两眼、方向一致”等表达高频复用；
- 逐步将机械免责声明从每栏移走，只在真正关键的未知处保留。

### v74–v76：事实门与独立审查成型

- reviewer 从“整体润色”改成独立逐 section 判决；
- short comment 与 conclusion 分开生成和重试；
- 引入 hard/quality 分类，避免文风问题把整份报告打成安全 fallback；
- 修复内部 JSON 双重编码泄漏；
- 修复 Mod 包含统计与精确组合混淆；
- 修复 DT/NC 等 Mod 调整后的星数显示，优先使用 API/计算得到的实际游玩星数；
- 结论强制 rank 或账号总 PP 精确锚点，并要求至少三类非档案证据。

### v77 / iteration 11

九人真实回归目录：

`artifacts/osu-analyze-evals/2026-08-01T15-13-45-966Z-iteration-11-flash-v77`

主要成果：

- 九人结论均由 LLM 生成；
- 除 `13451b` 的 `top` 外，七栏来源基本保持 LLM；
- ElicyAnn 结论已经能同时利用 BP、Mods、PP+、分类与 Recent。

人工审读发现的关键漏判：

- mrekk 被写成“把 13★ 当日常”；
- cryshina 出现“靠堆次数”“难度下限是一种态度”“暂时没留下新痕迹”；
- Wuxin 出现“不靠堆量刷出来”；
- Ben Jiang 把 PP+ 写成“稳定瞄准、短板”，空 Recent 被猜成“不急着追成绩”；
- NakanoOoOo 把 NM 写成主场/硬打，把 PP+ 翻译成具体能力；
- 13451b 的“整体还没收稳”被稳定性正则误伤；
- ahahhaha 结论没有突出 BP1 99.27%，并把 PP+ 翻成点按/瞄准能力。

### v78 / iteration 12

真实回归目录：

`artifacts/osu-analyze-evals/2026-08-01T15-35-52-944Z-iteration-12-flash-v78`

本轮改动：

- 修复稳定性门：明确排除“没/未/不/尚未/还没稳定”，并允许 BP1 局部干净；
- 数字白名单从 floor/ceil/round 收紧为原值与 toFixed(1/2)，防止 123 次被写成“100 多次”；
- 同步拦截堆量历史、星数态度/日常、空 Recent 故事、追星/动作人格、NM 价值化、PP+ 能力化、BP5 状态故事；
- 清理句末孤立引号；
- 新增相应 fixture。

真实结果：

- mrekk、oliwakami、Wuxin 等多数报告保持 LLM；
- cryshina 结论错误回退；
- Ben Jiang 的 top/recent、ahahhaha 的 top 出现局部 fallback；
- reviewer 仍漏掉多处事实错误，因此 v78 明确不通过。

人工审读发现：

- Wuxin 的 87 张 stream 被夸成“BP 里全是 stream”；
- Ben Jiang 的分类 7/6/6 被写成“各 7 张”；
- NakanoOoOo 把 HDDT 说成唯一提速存在，实际还有 DT 等成绩；
- ahahhaha 的 BP1 为 99.27%，却被写成“打满”；
- 多份报告编造“活跃玩家中坚、前百分之十、超过绝大多数活跃玩家、大众区间”；
- 多份把总 Acc、游玩次数、注册时长拼成能力、维持过程或群体稀有度；
- old design 中的 rank 档位知识被实测证明会诱导无来源人口比较，后续已撤回。

### v79 / iteration 13（当前）

真实回归目录：

`artifacts/osu-analyze-evals/2026-08-01T15-56-13-672Z-iteration-13-flash-v79`

本轮已实现：

- classification 数量按 label 逐项核对；在 PP+ 等跨栏短评里说“全是 stream”也会检查；
- “aim、stream、alt 各 N 张”逐项对照，不再因 N 恰好存在于另一类而漏过；
- BP1 非 100% 时禁止“打满/满准”；
- 检查精确 Mod 与包含统计，HDDT 不能在仍有其他 DT/NC 时被称为唯一提速组合；
- PP+ 精确小数不能改成中文“九点二五”；
- 禁止无来源活跃玩家百分位/中坚/大众档位；
- 禁止总 Acc、游玩次数、注册时长拼成能力或维持过程；
- 修复“BP 星数上限”被 PP+ 15 基准线门误伤；
- 降低机械最短字数，并对初始 fallback 栏增加自动质量编辑；
- reviewer 明确检查重复免责声明、前文复制、追星动作和固定反转句式。

最终机器结果：

| 玩家 | 七栏来源 | 结论来源 | 最终 reviewer |
|---|---|---|---|
| mrekk | 全 LLM | LLM | 无拒绝 |
| cryshina | 全 LLM | LLM | 无拒绝 |
| oliwakami | 全 LLM | LLM | conclusion quality reject：几乎逐句复用前文 |
| Wuxin | 全 LLM | LLM | conclusion quality reject：拼接前文，没有新综合 |
| Ben Jiang | 全 LLM | LLM | 无拒绝 |
| NakanoOoOo | pplus fallback，其余 LLM | fallback | pplus/conclusion hard reject |
| ElicyAnn | 全 LLM | LLM | 无拒绝 |
| 13451b | 全 LLM | LLM | 无拒绝 |
| ahahhaha | 全 LLM | LLM | 无拒绝 |

人工审读证明 reviewer 仍然漏判，因此“无拒绝”不等于合格：

- mrekk：Mods 把 HD 写成“隐身”，人格仍偏分析员；多栏继续追加边界声明。
- cryshina：账号档案出现残句“世界第二。里已经……”；BP5 编造“靠星数和长度硬砸”；结论把 PP+ 翻成速度/耐力能力，并出现固定反转句。
- oliwakami：把平均星数写成“不挑软柿子”，BP5 写成“往 9★ 迈了一步”，Mods 把构成写成“三种玩法都站得住”；结论复读前文。
- Wuxin：profile 仍把 rank 写成“活跃玩家”档位并将总 Acc 与体量拼接；结论逐句复用短评；多处免责声明口吻。
- Ben Jiang：profile 仍把总 Acc 与账号体量拼接；特殊 Mod 被称作“不算常见”但没有群体数据；结论人格偏淡。
- NakanoOoOo：Mods 出现错误关系“NF 那张 PF”，空 Recent 把 BP100 称为“长期样貌”；pplus 和结论最终 fallback。
- ElicyAnn：继续使用“百万级玩家”人口比较并把 Acc 与游玩次数拼接；Recent 从两个聚合均值推成“同样难度的图最近打得更差”。
- 13451b：把星数范围称为“中等偏下区域”；NF 与 NM 星数关系没有核准数据；PP+ 仍有能力化“后半截塌下去”。
- ahahhaha：BP5 声称 3.0pp 相邻差“比首尾差距还大”，实际首尾跨度为 3.6pp；把 alt 错写成跳图；从单张 99.27% 推成准头；结尾替玩家等待未来样本。

结论：v79 修复了 fallback 恢复能力和一部分显式数字门，但生成侧与 reviewer 仍会漏掉跨句关系、术语翻译、聚合值拼接和人物语气问题。下一轮必须先补通用关系审查，不能直接跑盲测。

## 6. 回归账号

### 九人黄金回归

- mrekk：世界第一与极端高星/DT 结构；
- cryshina：世界第二、stream/Speed/Flow 极端形状、空 Recent；
- oliwakami：普通高段账号、混合 Mods、少量 EZ Recent；
- `[SHK]Wuxin`：HD/HDHR 与高 Acc、stream 分类、PP+ 反差；
- Ben Jiang：NM 主体、EZDT/HT 特殊 Mod、空 Recent；
- NakanoOoOo：极高 Acc、NM 主体但存在多种 DT/NF/PF；
- ElicyAnn：普通中段、高 Acc、aim 主体；
- `13451b`：低 Acc 多数但 BP5 局部较干净；
- ahahhaha：BP33 稀疏萌新、BP1 99.27% 亮点、低 Acc 多数。

运行：

```powershell
node tools/osu-analyze-eval.mjs --label=<iteration-label>
```

### 用户提供的最终盲测池

只有通用规则定稿后才能运行，不得写进 Prompt 或加用户名特判：

- Akari Date
- windpipeey
- `[SHK]Mriyu`
- MALISZEWSKI
- Junmoyan
- Miko_Parsley
- qqfrr
- lolol233

运行：

```powershell
node tools/osu-analyze-eval.mjs --set=provided --label=provided-flash
```

## 7. 每轮必须执行的验证

### 离线

```powershell
npm run typecheck
node --import tsx tools/osu-fixture-verify.mjs
```

### 重启服务

只能停止命令行明确匹配 `server/index.ts` 的 Node，不能宽泛结束其他 Node：

```powershell
$targets = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server[/\\]index\.ts' }
$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath 'REDACTED_REPO_ROOT\portable-node\node.exe' `
  -ArgumentList @('REDACTED_REPO_ROOT\node_modules\tsx\dist\cli.mjs', 'server/index.ts') `
  -WorkingDirectory 'REDACTED_REPO_ROOT' -WindowStyle Hidden
```

服务端口：`127.0.0.1:8787`。测试只走控制台 Analyze，不向群 `REDACTED_GROUP_001` 发消息。

### 完整验收

九人必须逐份人工审读，不能只看 reviewer PASS：

- 七栏和结论均为 LLM；
- 最终 reviewer 无拒绝；
- 无 JSON 泄漏、未知数字、错误分类、Mod 口径错误；
- 无能力、动机、成长经历、Recent 原因脑补；
- 九人整体印象明显不同；
- mrekk 特殊但不踩其他玩家；
- cryshina 独立于 mrekk；
- ElicyAnn 与 13451b 能清楚区分；
- ahahhaha 必须突出 BP1 99.27%，不哄骗、不嘲讽、不提前定型。

九人真正合格后才运行八人盲测。盲测至少完整人工审读一名普通中段与一名稀疏/矛盾账号。最后运行：

```powershell
npm run verify-all
```

## 8. 当前仍未完成的事项

1. v79 仍有 fallback、hard reject、quality reject 与人工漏判；下一轮必须升格式版本，不能进入盲测。
2. 补通用关系门：聚合均值不能变成“同难度单图”结论；相邻差不能和首尾跨度混淆；特殊 Mod 不能拼成不存在的 NF+PF 子集；alt 不能翻译成跳图。
3. 继续压缩免责声明：每份最多一次真正必要的数据边界，空 Recent 不应反复解释。
4. reviewer 需要明确抓残句、前文复用、固定反转、群体档位、单张成绩能力化和替玩家安排未来样本。
5. pippi 人格仍可能偏冷或模板化；事实安全通过不等于产品通过。
6. PP+ 上游偶尔对 oliwakami 返回 HTTP 500 `lol server goes boooom`，采集器有重试；需要区分上游暂态和本地流水线 bug。
7. 旧 `OSU_ANALYZE_REVIEW_DESIGN_2026-08-01.md` 中“#1万内超过绝大多数活跃玩家、#10万外大众区间”等尺度设计已被撤回。当前只按核准 rank 本身反应，禁止无来源人口统计。
8. 当前工作区有大量用户和历史改动，所有 Analyze 改动未提交；禁止 reset、checkout、clean 或清理无关文件。

## 9. 接手者第一步

1. 先读本文、`docs/微调后黄金实例.txt` 和当前 `server/osu/analyzer.ts`/`commands.ts`；
2. 查看最新 `artifacts/osu-analyze-evals/*/manifest.json`，不要只读旧交接的成功描述；
3. 跑 typecheck 与 17 组 fixture；
4. 查询实际服务 PID，不假定文档中的旧 PID；
5. 从最新九人真实输出逐份人工审读，再决定下一刀；
6. 任何新规则都必须可泛化，不得出现用户名、固定玩家成绩或黄金句子特判；
7. 九人和盲测都通过前，不得向用户说“大功告成”。
