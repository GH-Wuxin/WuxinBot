# WuxinBot / 本地 osu! Bot 累计改动与完整交接

最后整理：2026-08-02（Asia/Shanghai）  
主项目：`REDACTED_REPO_ROOT`  
本地 Bot 部署：`REDACTED_BOTS_ROOT`  
当前分支：`refactor/wuxin-cleanup-20260731-224209`  
当前 Analyze 格式版本：代码仍为 `79`；`v80` 已开始修改但尚未完成、测试或启用  
当前 Analyze 模型：生成器与 reviewer 均为正式版 `deepseek-v4-flash`

> 这是一份累计总账，不是一份“已经全部验收通过”的声明。它把本轮长对话中完成、推翻、修复和仍未完成的工作统一记录下来，供以后的人或模型直接接手。若本文与更早的设计文档冲突，以当前代码、最新真实回归产物和本文的“当前状态”章节为准。

## 1. 范围与安全说明

本文综合了以下证据：

- 当前 Git 历史与工作区 diff；
- `docs/HANDOFF_GPT56SOL_2026-08-01.md`；
- `docs/OSU_ANALYZE_CONTINUOUS_HANDOFF_2026-08-01.md`；
- `docs/OSU_ANALYZE_REVIEW_DESIGN_2026-08-01.md`；
- `docs/微调后黄金实例.txt`；
- `napcat-local-bots` 下的部署、启动和迁移记录；
- `artifacts/osu-analyze-evals` 中保留的真实回归结果；
- 当前源码、测试脚本与运行状态。

本文不会记录 OAuth client secret、旧版 API key、数据库密码、OneBot token 或其他敏感值。凭据仍由本机私密配置负责，交接时不要把其内容复制进聊天、Git 或公开文档。

## 2. 最终形成的系统是什么

现在不是“一个聊天机器人加几个命令”，而是三层组合：

1. NapCat 使用 QQ `REDACTED_QQ_002` 作为 pippi 的发言账号，接收 OneBot 事件；管理员 QQ 为 `REDACTED_QQ_001`。
2. WuxinBot 是唯一接 LLM、记忆、persona、自然语言路由和 osu! Analyze 的 Harness。
3. 雨沐、猫猫、消防栓、LazyBot 仍保留原来的确定性查询与图片渲染。Wuxin 可以通过本地桥接调用它们，也有自己的 `query_osu` 确定性数据链。

主要消息链：

```text
QQ / NapCat
  -> server/onebot.ts
  -> server/bot.ts
     -> /w osu 命令：server/osu/commands.ts
     -> 快捷命令：server/bot/quickRouter.ts
        -> Wuxin 内部 query_osu
        -> localBridge 直连原 Bot，保留原图
     -> 普通聊天：pippi persona + 日常 osu! 知识 + DeepSeek
```

osu! Analyze 链：

```text
osu! API v2 + 本地 PP+ + osu!oracle 分类
  -> collector.ts 并行采集
  -> analyzer.ts 计算确定性事实与用户可见数据区
  -> 七栏独立短评
  -> 独立结论
  -> reviewer 分 hard / quality 复审
  -> 必要时局部重写或局部 fallback
  -> 保存报告、来源、重试和拒绝记录
```

## 3. 本轮累计完成的工作

### 3.1 四个 osu! Bot 的本地部署与 NapCat 接入

在 `napcat-local-bots` 下完成了雨沐、猫猫、消防栓、LazyBot 及其依赖的本地部署：

- 雨沐 OneBot 端口 `8388`；
- 消防栓 OneBot 端口 `8800`；
- 猫猫 OneBot 端口 `7700`；
- LazyBot OneBot 端口 `1145`；
- LazyBot 使用 MariaDB `3306`；
- 雨沐/消防栓使用 PostgreSQL；
- PP+ 聚合服务使用 `127.0.0.1:9001`；
- 所有对外监听均尽量限制在本机回环地址。

具体做过：

- 配置 osu! OAuth v2 和旧版 API 所需的私密参数；
- 完成 LazyBot `1.2.0` 构建、Java 21 preview 参数、管理员权限、绑定和渲染验证；
- 将 LazyBot 的 PP+ 请求改到本机 Aloic PP+ 聚合服务，避免依赖已失效或不稳定的官方旧端点；
- 补齐雨沐图片渲染所需资源和 yumu-image 链；
- 排查猫猫 IAM 绑定失败，确认当时公共 IAM `502` 属于上游服务器故障；后来猫猫服务器/配置恢复后不再把它当作本地部署缺陷；
- 修复猫猫 osu!std 星数使用旧算法的问题，统一到当前 Mod 调整后的星数链；
- 部署 PP+ 与猫猫旧版 Info V1 所需服务，并处理首次初始化竞争导致的 PP+ 零值问题；
- 保留各 Bot 原生图片风格，没有强制统一面板。

对应历史文档：

- `REDACTED_BOTS_ROOT\DEPLOYMENT_STATUS.md`
- `REDACTED_BOTS_ROOT\LAZYBOT_HANDOFF.md`
- `REDACTED_BOTS_ROOT\PPPLUS_INFO_V1.md`

### 3.2 开机自启动与稳定性

完成了统一启动入口，让数据库、PP+、四个 Bot、图片渲染器和 NapCat 按依赖顺序启动：

- 登录 Windows 后由启动文件夹中的 `NapCat-Bots.lnk` 触发；
- 原来独立的 NapCat 启动项已移出，防止 QQ/NapCat 启动两次；
- 启动器会检查端口和进程，重复执行不会再拉起第二套服务；
- 每次启动生成 `logs/startup-*.log`；
- 修复 PostgreSQL 后台进程继承统一启动器输出句柄，导致脚本永不结束的问题；
- 从所有目标端口关闭的状态做过完整冷启动验收，历史记录约 114 秒全部就绪；
- Wuxin 自身新增 `restart-wuxin.ps1`，并统一使用项目内 Node 22，避开系统 Node 20 的网络栈崩溃；
- 增加服务守护、备份/恢复演练和一键 `verify-all` 回归。

### 3.3 Wuxin 的 osu! API 内核

最初的阶段 A 已完成并经过多轮修复，核心位于 `server/osu/`：

- OAuth Client Credentials token manager；
- osu! API v2 客户端；
- 玩家、谱面和成绩的 TTL 缓存；
- 玩家资料、BP、Recent 等采集；
- PP+ 聚合服务客户端；
- osu!oracle 的 BP 谱面类型分类；
- 数据预处理、统计摘要与持久化；
- `/w osu bind`、Analyze 和控制台 API。

当前产品主要面向 osu!std。taiko/catch/mania 不得拿 std 数据冒充。

### 3.4 Mod 调整后星数修复

早期发现 DT 后显示的仍是 DT 前基础星数，后来将星数链统一到共享的 `server/osu/scoreMetrics.ts` / `starRating` 逻辑：

- 优先使用成绩或 API 返回的 Mod 调整后 difficulty attributes；
- DT/NC、HR/EZ 等会影响难度或速度的 Mod，不再直接展示 beatmap 基础星数；
- 渲染、文本 BP、Analyze 和测试使用同一选择逻辑；
- 加入 fixture，确保例如 7.48★ 的 Mod 后结果不会退回 4.90★ 基础值；
- 合并了两套重复的星数 enrichment 实现，减少以后再漂移的可能。

### 3.5 PP+ 本地链、归一化和可靠性

PP+ 经历过几轮关键修复：

- 本地聚合服务地址默认 `127.0.0.1:9001`；
- 首次请求可能计算最多约 200 个 BP，因此 `player/info` 超时放宽至 5 分钟；
- PP+ 服务重启后本地 token 可能早于缓存失效，收到 `401` 时清 token 并重新认证一次；
- 不再在首次 `GET /player/info` 失败后盲目调用只消费 Recent 的 update 路径；没有近期 pass 的合法玩家不应因此永远没有 PP+；
- 错误会写明 HTTP、返回码或 JSON 异常，不再无声返回空；
- LazyBot 原图为了 530px 条形图会把每维截到上限；Wuxin 的文本/数据链取消 clamp，`15` 只作为 expertPlus 基准线，允许出现大于 15 的真实归一化值；
- 控制台雷达图改为动态刻度，并用虚线标出 `15` 基准线；
- 控制台规范路由改为 `/api/osu/player/:id/pplus`，同时保留误发布的 `/ppplus` 兼容别名；
- `ppTotal` 不再被误当成第七个 PP+ 维度输出。

注意：PP+ 上游仍可能偶发 `HTTP 500: lol server goes boooom`，必须区分上游暂态错误与本地 Analyze bug。

### 3.6 `query_osu` 确定性工具与原 Bot 桥接

Wuxin 原先倾向让 LLM 决定调用某个外部 Bot，后来重构为明确的数据工具和桥接层：

- `query_osu` 提供 `bp`、`recent`、`info`、`profile`、`ppplus/pplus`、`skill`、`bp_type` 等只读能力；
- LLM 涉及实时 osu! 数据时必须先调用真实工具，不能靠记忆或聊天上下文编数字；
- BP 支持单张 `#N`、范围和最多 BP1–100；
- BP 类型比例必须来自 osu!oracle，禁止 LLM 自己猜 aim/stream/alt/tech 比例；
- 快捷路由支持猫猫/雨沐的 `!`、LazyBot 的 `/`、消防栓的无前缀或特殊触发；
- 修复 `!` 指令别名冲突，采用最长 alias、猫猫优先的规则；
- 私聊中的 LazyBot 裸 `/` 命令不再被 Wuxin 主命令层提前吞掉；
- 直接桥接原 Bot 的本地 OneBot 端口，保留原始图片输出；
- 修复 image-only 回复、原版 E5 Recent 面板、图片已发出后异常导致二次发送等问题；
- 修复 WudiLib `echo` 应答与 settle race；
- 桥接使用虚拟群 `770099`，避免原 Bot 在真实群被禁用时连桥接调用也沉默；
- 当前未提交修复又为雨沐每次调用生成独立 self id，避免并发 reverse-WS session 互相抢走回复；
- Wuxin 内部查询与外部原 Bot 来源有元数据，便于知道实际由谁执行、是否使用渲染器。

### 3.7 统一绑定

用户绑定入口统一为：

```text
/w osu bind <username>
/w osu clear bind
```

累计修复：

- 一次性从雨沐、消防栓、LazyBot 导入 23 条已有绑定到 `db.osuBindings`；
- 支持数字 ID、字符串 ID、用户名和对象式旧格式；
- 快捷路由在命令没写玩家时自动注入发起人的绑定；
- 修复只注入 osu ID 导致旧 Bot 不认识的问题：优先解析并保存用户名；
- 分析他人账号不会覆盖请求者自己的技能或绑定；
- LazyBot 是特殊情况：其 `/ppp` 会先按发送者 QQ 查 MariaDB `token` 表，即使命令里已经带用户名。为此新增 `server/bots/bindingSync.ts`：绑定时 UPSERT LazyBot token 表，解绑时 DELETE；同步失败只记日志，不破坏 Wuxin 主绑定；
- GUI 的绑定/解绑接口也接入同一 LazyBot 同步。

真实运行数据库是：

```text
REDACTED_USERPROFILE\AppData\Roaming\Wuxin\db.json
```

`REDACTED_REPO_ROOT\data\db.json` 是旧文件，不能把它当作生产库。

### 3.8 osu! 控制台 GUI

新增并逐步完善专用 osu! 控制台：

- 独立 osu! 页签和官方风格单色图标；
- 玩家抽屉：profile、BP、Recent、PP+、谱面类型、badge、Analyze；
- 大数字概览压缩，支持 9 位 total hits 等字段；
- PP+ 雷达图动态上限及 15 基准线；
- Analyze 可由控制台触发，绕过 QQ 群的 4 小时冷却，适合测试；
- 修复服务崩溃/重启后磁盘里残留 `status=running` 导致永远不能重跑的问题。现在只有本进程内的 `consoleAnalysesRunning` 才能阻止重复启动，任务结束后在 `finally` 清除。

### 3.9 性能、并发与可观测性

完成过的稳定性工作：

- 同群不同成员可并行；同成员连续消息会合并，避免重复入库和双倍经验；
- 禁用 DeepSeek API 默认隐藏思考，历史实测普通回复延迟由约 10.8 秒降到约 3.4 秒，并减少空回复；
- Analyze 设队列上限和瞬时失败重试；
- osu!oracle 按谱面缓存、预热，并为慢分类配置可见超时；
- 渲染缓存、补星并发和 A4 面板进行调优；
- health 增加 osu! 429、渲染失败、LLM 延迟/失败等指标；
- 增加意图路由、安全、OneBot、渲染、BP 范围、星数、绑定、知识和 Analyze fixture。

### 3.10 pippi 全局人格与 osu! 知识库

用户最终决定 pippi 人设应覆盖所有场景，不只 Analyze。当前做法是分层注入：

- `server/bot/persona.ts` 保留 pippi 核心身份、事实边界和场景规则；
- 所有 casual、command、serious、analysis 场景都会注入一份紧凑的 osu! 永久核心知识；
- `server/bot/prompt.ts` 根据当前消息检索更详细的主题知识，只注入命中的内容；
- 新增 `server/osu/knowledge/`：
  - `core.ts`：BP/PP/rank、属性、判定、核心 Mods、谱面状态、常见 pattern、stable/lazer；
  - `mods.ts`：EZ、FL、TD、HT/DC、NF、SO、SD/PF、DA、CL、RX/RL/AP/AT 等；
  - `topics.ts`：weighted PP、DT/HT clock rate、AR/OD、评级、pattern 和分析证据边界；
  - `sources.ts`：osu! wiki 与 API 来源；
  - `types.ts` / `index.ts`：结构和导出。

知识库的目的不是让模型背百科，而是防止以下低级错误反复出现：

- 把 HD 写成“隐身图/隐身模组”；
- 把 BP 写成 Top；
- 把 alt 直接翻译成跳图；
- 把 NM 写成裸实力或真实实力；
- 把 NF/SO 当成玩家为了挑战更难图；
- 把 PP+ 维度直接翻译成未经证明的具体操作能力；
- 把 API 聚合均值扩写为单张同难度谱面的表现。

## 4. osu! Analyze 的完整迭代历史

### 4.1 最初版本：数据摘要 + 一段 LLM 总结

最初只把玩家资料、BP100、Recent、PP+ 等整理成结构化摘要，让 LLM 写一段人物评价。问题很明显：报告像客服或数据播报，pippi 只是在复读数字，所有玩家都被套进同一种“稳定型玩家”模板。

### 4.2 报告拆成八个节点

后来固定为：

1. 账号档案；
2. BP 总览；
3. BP5；
4. Mods；
5. PP+ 六维；
6. Recent；
7. 谱面类型分布；
8. 结论。

七个非结论节点各生成一条短评，结论独立生成。短评内部要求先给 `evidence`、再给 `judgment`、最后给用户可见 `comment`，目的是迫使模型先选证据再说话。

### 4.3 人设方向的多轮推翻

尝试和随后撤回过的方案包括：

- 每一栏都强制输出 `pippi：`：已删除，因为消息本来就是 pippi 发的，显得突兀；
- 报告尾部署名：已删除；
- 强制全篇第二人称：已取消。只有能确认分析对象是发起者本人时才自然用“你”，分析第三方使用用户名或中性称呼；
- 每栏强制卖萌、反问或雌小鬼语气：已取消，造成反问泛滥、人格噪声和低情商；
- “对我来说不失误是默认状态”等 Auto 标准：已禁止。pippi 可以有最强者自信，但不能拿理论完美操作施舍或压低人类成绩；
- “作为旁观者，我尊重这种清晰的自我定位”等冷分析师口吻：已明确淘汰；
- 固定“不是 X，而是 Y”反转句式：用户强烈反感，已作为风格风险处理；
- 每栏都声明数据边界：已压缩，只允许在真正关键处出现，整份最好最多一次。

当前 pippi 目标：自信、活泼、有少女感，偶尔有一点最强者的小得意；能惊讶、好奇、吐槽和认可，但不能追星、羞辱、施舍鼓励、动作表演或机械撒娇。

### 4.4 从复读改为“短评产生判断”

用户明确要求每条短评至少完成一件事：归纳、对比、发现异常、提出有根据的评价或轻度猜测。单纯把“HD 55 张”改成“记录没有隐藏重心”没有价值。

因此逐步加入：

- rank 和总 PP 必须影响反应强度，mrekk 与普通玩家不能同一口气；
- Mods 要区分精确组合和包含统计；
- BP5 要看孤峰、跨度、挤在同一分段、Acc/星数/Mod 反差；
- PP+ 只评价相对形状，不直接宣布真实能力；
- Recent 可轻松一点、可以有好奇，但不能编疲劳、练图、摆烂等现实原因；
- 分类不能只抓第一类，也要看第二类、差距和样本成熟度；
- 萌新不能被嘲讽或假夸，要认真识别第一张高 Acc、第一张孤峰、第一次特殊 Mod 等小亮点。

### 4.5 事实门、fallback 与 reviewer

随着模型更自由，开始出现数字和关系编造，于是加入三层保护：

1. 确定性 `safeFacts/safeBody`：代码计算所有可验证数字；
2. `validateAnalysisContent` 等机械门：拦未知数字、错误 Mod、身份错置、现实原因、明显关系错误；
3. 与 pippi 完全隔离的 reviewer：按 section 判 `hard` 或 `quality`，只重写被拒部分。

当前每栏记录 `llm/fallback/none` 来源，结论单独记录来源；生成 trace、rejected draft、validation reasons、reviewLog 都写入 `osuAnalyses`，批量评测的 `manifest.json` 也保留这些元数据。

早期“万能句 fallback”会让所有玩家再次模板化，后来改为准确但朴素的局部 fallback。不能把 fallback 结果误当成 LLM 已学会。

### 4.6 v74–v76

- reviewer 从整体润色改为逐 section 判决；
- short comments 和 conclusion 分开生成、重试；
- hard/quality 分离，文风问题不再把整份报告直接打回安全模板；
- 修复双重编码 JSON 泄漏；
- 修复精确 Mod 与包含统计混淆；
- 修复 Mod 后星数；
- 结论要求 rank/PP 锚点与至少三类非档案证据。

### 4.7 v77 / iteration 11

真实回归已经基本能生成完整 LLM 报告，但人工审读发现：把 13★ 当“日常”、编“靠堆次数”、把 NM 价值化、PP+ 能力化、空 Recent 编故事，以及萌新结论忽略真实小亮点。

产物：

```text
artifacts/osu-analyze-evals/2026-08-01T15-13-45-966Z-iteration-11-flash-v77
```

### 4.8 v78 / iteration 12

收紧数字白名单、历史/动机推断、星数日常化、追星动作、NM 价值化、PP+ 能力化等；也修复“尚未稳定”被稳定性规则反向误杀。

真实回归仍发现：分类数量错、HDDT 被称唯一提速、BP1 99.27% 被写成打满、活跃玩家人口档位编造、Acc/游玩次数/注册时长被拼成能力或稀有度。

产物：

```text
artifacts/osu-analyze-evals/2026-08-01T15-35-52-944Z-iteration-12-flash-v78
```

### 4.9 v79 / iteration 13：当前最近完整回归

v79 增加分类逐项核对、BP1 满准检查、精确 Mod/包含统计关系、PP+ 小数检查、人口档位禁用、Acc+体量伪关系检查、fallback 栏质量编辑等。

离线 typecheck 与 17 组 fixture 当时全绿，但九人真实回归未通过：

| 玩家 | 主要残留问题 |
|---|---|
| mrekk | HD 被写成隐身；人格仍偏分析员；免责声明偏多 |
| cryshina | 残句；编“靠星数和长度硬砸”；PP+ 被翻成速度/耐力能力 |
| oliwakami | “挑软柿子”“往 9★ 迈一步”“三种玩法站得住”；结论复读 |
| Wuxin | 编活跃玩家档位；Acc 与体量拼接；结论复制短评 |
| Ben Jiang | Acc 与账号体量拼接；无群体数据却称特殊 Mod 不常见 |
| NakanoOoOo | 编出“NF 那张 PF”；空 Recent 把 BP100 称为长期样貌；局部 fallback |
| ElicyAnn | 编百万级人口档位；把两个聚合均值写成同难度图最近更差 |
| 13451b | 星数范围被称中等偏下；NF/NM 星数关系无依据；PP+ 能力化 |
| ahahhaha | 相邻 3.0pp 被说成大于首尾 3.6pp；alt 错写跳图；单张 Acc 扩成整体准头 |

产物：

```text
artifacts/osu-analyze-evals/2026-08-01T15-56-13-672Z-iteration-13-flash-v79
```

结论：reviewer 显示 PASS 不能代替人工审读，v79 不能宣称完成。

### 4.10 v80：已经动手但尚未完成

当前 `server/osu/analyzer.ts` 中已经部分应用 v80 通用修复：

- 撤回会诱导“超过绝大多数活跃玩家/大众区间”的旧 rank 档位知识；
- #1/#2 保持明显特殊，前百/前千/前万逐级降低反应，后续只按精确 rank 评价；
- 禁止编造人口百分位、中坚、大众区间或固定称号；
- Prompt 增加：Recent/BP 均值接近不等于同难度单图；相邻差不能大于 BP5 首尾跨度；alt 不等于跳图；NF/PF 只有精确组合存在时才能写同一成绩；HD 不翻译成隐身；
- Prompt/validator 开始拦“挑软柿子、往 9★ 迈一步、三种玩法都站得住、靠星数和长度砸出来”；
- validator 已部分加入残句、Acc+体量、人口档位、无依据罕见度、空 Recent 长期样貌、同难度扩写、选图动机和 alt 误译检测。

但 v80 尚未完成以下内容：

- 特殊 Mod 泛化关系门：NF/SO/PF/SD/HT/EZ/FL 不得被拼成不存在的同一成绩；
- PP+ 与单张成绩能力化的完整检查；
- 结论复制前文的架构修复；
- 初次结论不应再注入七栏完整 comment 原文；
- `commands.ts` 需要增加同报告长公共子串/高重合句检测；
- fixture 尚未补齐；
- `ANALYSIS_FORMAT_VERSION` 仍是 79，尚未升 80；
- 尚未 typecheck、跑 fixture、重启服务或做九人真实回归。

因此当前运行服务仍应视为 v79 运行态；磁盘里的 analyzer 已包含未启用、未验证的 v80 半成品。接手者不能直接把它称为 v80 完成版。

## 5. 已明确废弃或暂缓的方案

- `deepseek-v4-pro`：当前为 preview，已按用户要求暂停。Analyze 生成与 reviewer 均用正式版 `deepseek-v4-flash`。
- 实时比赛解说系统：从当前开发计划卸下。用户认为比赛系统可能只是添头，现阶段不继续投入。
- 每个玩家套固定档位词：废弃。不能写硬编码的“传奇档、中坚、大众区间”。
- 用户名特判或把黄金玩家写进 Prompt：严格禁止。
- 每栏强制 pippi 插话、固定反问次数、固定少女口癖：废弃。
- 万能 fallback 人格句：废弃。
- “每份报告都给训练建议”：废弃。Analyze 以评价为主，建议至多一两句且保守。
- 图片 Analyze 面板：第一版不做，确定性精美图片仍由原 Bot 承担；Analyze 以文字人物志为主。
- 四 Bot 年度总结重写：非活动期暂缓。
- 雨沐 match 观战：保留桥接方案，暂不 TS 重写。

Git 中已删除但尚未提交的旧文档：

- `docs/DEEPSEEK_HANDOFF_2026-07-30.md`
- `docs/PIPPI_PERSONA_IMPLEMENTATION_PLAN.md`

它们是按此前“清理已用完/被替代文档”的要求删除的。若只需追溯，仍可从 Git 历史读取；不要为了找资料直接 reset 整个工作区。

## 6. 当前关键文件与职责

| 文件 | 当前职责 |
|---|---|
| `server/osu/auth.ts` | osu! OAuth token 管理 |
| `server/osu/api.ts` | osu! API v2 客户端 |
| `server/osu/cache.ts` | TTL 缓存 |
| `server/osu/collector.ts` | profile/BP/Recent/PP+/分类采集 |
| `server/osu/scoreMetrics.ts` | 成绩 Mod 后星数等共享指标 |
| `server/osu/pplus.ts` | PP+ 认证、请求、归一化 |
| `server/osu/analyzer.ts` | 确定性事实、报告数据区、Prompt、validator、fallback、review parser |
| `server/osu/commands.ts` | `/w osu`、Analyze 队列、生成/复审/持久化 |
| `server/osu/knowledge/` | 日常和 Analyze 共用 osu! 知识库 |
| `server/bot/persona.ts` | pippi 全局人格和场景层 |
| `server/bot/prompt.ts` | 普通聊天 Prompt 与主题知识检索注入 |
| `server/bot/quickRouter.ts` | `!`、`/`、消防栓风格快捷指令 |
| `server/bots/executor.ts` | `query_osu` 内部确定性执行 |
| `server/bots/localBridge.ts` | 本地直连四原 Bot，收文字和图片 |
| `server/bots/bindingSync.ts` | Wuxin 绑定同步到 LazyBot MariaDB |
| `server/index.ts` | 控制台 API、绑定、Analyze 触发、健康状态 |
| `src/components/osu.jsx` | osu! 控制台玩家抽屉和 PP+ 雷达图 |
| `tools/osu-fixture-verify.mjs` | Analyze/术语/关系/PP+/星数离线回归 |
| `tools/osu-analyze-eval.mjs` | 九人真实回归和用户八人盲测 |
| `tools/run-all-verifies.mjs` | 一键完整回归入口 |

## 7. 当前工作区状态

截至本文整理时，工作区很脏，不能 reset/checkout/clean：

```text
M server/bot/persona.ts
M server/bot/prompt.ts
M server/bot/quickRouter.ts
M server/bots/executor.ts
M server/bots/localBridge.ts
M server/index.ts
M server/osu/analyzer.ts
M server/osu/collector.ts
M server/osu/commands.ts
M server/osu/pplus.ts
M src/components/osu.jsx
M tools/osu-fixture-verify.mjs
M tools/quick-router-verify.mjs
?? server/bots/bindingSync.ts
?? server/osu/knowledge/
?? tools/osu-analyze-eval.mjs
?? docs/若干新交接、设计与黄金样本文档
?? artifacts/
D docs/DEEPSEEK_HANDOFF_2026-07-30.md
D docs/PIPPI_PERSONA_IMPLEMENTATION_PLAN.md
```

当前未提交 diff 约为 2800 行新增、1300 行删除，主要集中在 `analyzer.ts` 与 `commands.ts`。其中混有已经验证的 v79、其他功能修复和未完成的 v80，接手者必须按文件和功能拆分判断，不能整包当作一个已完成提交。

当前健康检查显示 Wuxin 正常运行、OneBot 已连接；当时可见的服务进程属于 `tsx server/index.ts` 链。PID 是瞬时信息，重启前必须重新查询，不能照抄旧 PID。

## 8. 验证工具与标准操作

离线最小验证：

```powershell
cd REDACTED_REPO_ROOT
npm run typecheck
node --import tsx tools/osu-fixture-verify.mjs
```

完整项目验证：

```powershell
npm run verify-all
```

九人黄金真实回归：

```powershell
node tools/osu-analyze-eval.mjs --label=<iteration-label>
```

用户提供的八人盲测池：

```text
Akari Date
windpipeey
[SHK]Mriyu
MALISZEWSKI
Junmoyan
Miko_Parsley
qqfrr
lolol233
```

运行命令：

```powershell
node tools/osu-analyze-eval.mjs --set=provided --label=provided-flash
```

盲测只能在九人黄金回归真正合格后运行，且不能把这些玩家写入 Prompt 或加特判。

精确重启 Wuxin：

```powershell
$targets = Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'server[/\\]index\.ts' }
$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Process -FilePath 'REDACTED_REPO_ROOT\portable-node\node.exe' `
  -ArgumentList @('REDACTED_REPO_ROOT\node_modules\tsx\dist\cli.mjs', 'server/index.ts') `
  -WorkingDirectory 'REDACTED_REPO_ROOT' -WindowStyle Hidden
```

不要宽泛结束所有 Node；其他 Bot、Vite 或工具也可能使用 Node。

测试 Analyze 只走控制台，不向群 `REDACTED_GROUP_001` 发消息。需要观察日志时不要使用没有重定向的隐藏启动方式，否则 `console.error` 不会进入项目日志。

## 9. 下一位接手者的最优先任务

1. 不改其他模块，先完成 v80 半成品。
2. 在 `validateAnalysisContent` 完成特殊 Mod 关系门、PP+ 能力化和单张成绩能力化检查。
3. 改结论生成架构：初次结论只看 verified facts 与写作焦点，不再喂七栏完整文案。
4. 在 `commands.ts` 增加结论复制同报告短评的检测；事实短语重复允许，完整句/长公共子串复制拒绝。
5. 将结论控制在约 120–200 汉字，负责综合；七栏只在真正有趣之处强化少女反应。
6. 补 fixture：残句、HD→隐身、人口档位、Acc+体量、BP5 差值、长度撑分、alt→跳图、均值→同难度单图、虚构 NFPF、真实 NFPF 放行、结论复制与合法事实短语重复。
7. 全部完成后将 `ANALYSIS_FORMAT_VERSION` 升为 `80`。
8. 跑 typecheck + fixture；精确重启；跑九人真实回归并逐份人工审读。
9. 九人完全合格后才跑八人盲测，至少完整审读一名普通中段和一名稀疏/矛盾玩家。
10. 最后运行 `npm run verify-all`，更新主交接和 18 项验收证据。

## 10. 不能违反的产品底线

- 所有数字来自当前 API/PP+/分类输入，LLM 不编造；
- 每次 Analyze 独立，不引用上一名玩家或上一份报告；
- 不按用户名特判；
- BP 不写 Top，HD 不写隐身，alt 不等于跳图；
- 不能从聚合均值推成“同难度的图”；
- 不能把 PP+ 六维直接当作具体手法能力；
- 不能给普通 rank 编活跃玩家百分位或人口档位；
- 不能把 Acc、游玩次数、注册时长硬拼成能力或毅力；
- pippi 要鲜活，但事实自由度不能靠放松事实门换来；
- reviewer PASS 不等于人工验收通过；
- 最终输出应主要来自 LLM 正常链路，不能靠 fallback 拼出表面完整；
- 生成器和 reviewer 暂时都使用 `deepseek-v4-flash`，不要切回 preview Pro；
- 不修改 Express 基础框架、osu! API 基础实现、PP+ 协议或无关 Bot 来“顺手解决”Analyze 文风；
- 不向真实大群做批量测试；
- 不对脏工作区执行 reset、checkout、clean，也不要提交或覆盖不属于当前任务的用户改动。

## 11. 接手时应先读什么

建议顺序：

1. 本文；
2. `docs/微调后黄金实例.txt`；
3. `docs/OSU_ANALYZE_CONTINUOUS_HANDOFF_2026-08-01.md`；
4. 最新 `artifacts/osu-analyze-evals/*/manifest.json` 与九份报告；
5. `server/osu/analyzer.ts`；
6. `server/osu/commands.ts`；
7. `tools/osu-fixture-verify.mjs`；
8. 如涉及运行环境，再读 `napcat-local-bots/DEPLOYMENT_STATUS.md` 与 `STARTUP.md`。

最后再次强调：当前最核心的未完成项不是部署，也不是 PP+，而是让 v80 同时解决事实关系错误、结论复制和 pippi 人格稳定性，并通过九人真实人工审读与八人盲测。做到这一步前，不能把 osu! Analyze 宣称为大功告成。
