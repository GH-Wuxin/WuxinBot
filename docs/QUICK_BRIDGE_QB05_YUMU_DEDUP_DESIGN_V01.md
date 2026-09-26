# QUICK_BRIDGE_QB05_YUMU_DEDUP_DESIGN_V01

- 阶段：QB-05 设计/证据 → **实现已落地（A′ deterministic safe-slot allocator）**
- 结论：**A′ — SAFE_WUXIN_ONLY_FIX_EXISTS，已实现于 `server/bots/localBridge.ts`**
- 证据等级：dedup 机制 **CONFIRMED**；A′ 实现已通过离线单元/黑盒/回退验证 + 受限实时双调用验证
- 生产行为变更：**仅 QB-05 范围内的 yumu 合成 event.time 分配**；无 commit，无 push。

---

## 0. 决策摘要

**已实现 A′：yumu-only deterministic safe-slot allocator（`time%1000 ∈ [0,99]`，每秒 100 槽，耗尽/漂移超限在发送前失败走既有回退）。**

- 只使用 13 位毫秒 time 中 `time % 1000 ∈ [0,99]` 的安全槽 → key 第 11 位恒为 `'0'` → 与合法真实秒级 `time+group_id+user_id` key 空间**严格不相交**（leading-zero lemma，证明与假设见 §22b）。
- 同一进程内槽严格单调、绝不复用；每池秒 100 槽，第 101 次在发送前失败。
- `group_id`、顶层 `user_id`、`sender.user_id`、`message`、`raw_message`、`message_id`、`self_id` 保持现状；kanon/hydrant/lazybot 不变。

---

## 1. 精确 Yumu dedup 谓词（Phase A）

Shiro **2.5.3**（Yumu 部署依赖），类 `com.mikuac.shiro.common.utils.GroupMessageFilterUtils`：

```
key = String.valueOf(event.time) + String.valueOf(event.group_id)
      + String.valueOf(event.user_id)          // 无分隔符的纯拼接
now = System.currentTimeMillis()
removeExpired: cache.removeIf(value < now)     // 惰性清理
if (cache.containsKey(key) && cache.get(key) + intervalMs >= now)
    return false                                // 静默丢弃
cache.put(key, now + intervalMs)
return true
```

`com.mikuac.shiro.handler.event.MessageEvent.process` 的 group 分支：

```
if (TRUE.equals(shiro.groupEventFilter)) {
    if (!GroupMessageFilterUtils.insertMessage(event, shiro.groupEventFilterTime)) return;  // 无日志
    if (shiro.groupSelfBotEventFilter && botContainer.robots.containsKey(event.sender.userId)) return;
}
```

证据：

- `runtime/m2/com/mikuac/shiro/2.5.3/shiro-2.5.3.jar` 中两个 class 的 `javap -p -c` 字节码（逐指令比对）；
- 上游源码交叉验证：[MisakaTAT/Shiro `GroupMessageFilterUtils.java`](https://raw.githubusercontent.com/MisakaTAT/Shiro/master/src/main/java/com/mikuac/shiro/common/utils/GroupMessageFilterUtils.java)；
- 实时复现见 §4。

## 2. 时间精度 / 窗口

| 项 | 值 |
|---|---|
| key 中的 time | payload 的 `time` 原始 `Long` 字符串；Shiro **不做任何取整** |
| Wuxin 当前实际精度 | `Math.floor(Date.now()/1000)` → **1 秒**（`localBridge.ts` buildEvent） |
| 去重窗口 | `group-event-filter-time: 5000`，单位 **毫秒** |
| 窗口计时基准 | **首次事件到达 JVM 的时刻**（`currentTimeMillis`），不是 event.time |
| 丢弃条件 | `首次到达时刻 + 5000 >= 第二次到达时刻`（等于也丢） |
| 缓存寿命 | 5000ms；仅在下次 insert 时惰性清理（`value < now` 才移除） |
| 缓存范围 | **JVM 静态进程级** `ConcurrentHashMap`，所有 WS 会话共享（真实 NapCat 会话与 Wuxin 桥会话同一张表） |
| 字段边界 | key **无分隔符** → 数字串不按字段对齐。构造反例：`key(1786861450123,770099,900000099) === key(1786861450,123770099,900000099) === "1786861450123770099900000099"`（见 §22b） |

## 3. 参与 key 的字段

参与：`event.time`、`event.group_id`、顶层 `event.user_id`。

**不参与**：`message`、`raw_message`、`message_id`、`self_id`、任何 nonce 字段、`sender.user_id`（`sender.user_id` 只用于 dedup 通过**之后**的 group-self-bot 过滤：`sender.user_id ∈ robots.keys` 时再静默返回）。

## 4. 静默丢弃行为

`insertMessage` 返回 false → `MessageEvent.process` 直接 `return`：

- 不抛异常、不调用 Yumu 监听器、不产生任何回复帧；
- **无任何日志**（`[Event]` 是 debug 级且 Yumu 根日志为 info；drop 路径本身没有 log 语句）；
- Wuxin 侧表现为：WS open → 事件发出 → 0 个有用帧 → 烧满 60s。

## 5. 消息文本是否参与

**否。** 实时复现用两个不同命令（`!ymd20` / `!ymd6`）证明：文本不同仍被丢。

## 6. self_id 是否参与

**否。** yumu 自 8.8e9 随机池每调用已唯一（会话路由需要），但对 dedup 无任何作用。

## 7. 逻辑 sender 是否参与

部分参与，必须拆成两个字段看：

- 顶层 `event.user_id` → **参与 dedup key**；
- `sender.user_id` → 不参与 key，但用于 dedup 之后的 group-self-bot 过滤，以及 Yumu 全部语义（绑定/权限/等待器/历史/统计）。

Wuxin 当前两个字段都等于逻辑 QQ sender。

## 8–9. 并发 / 与真实事件的碰撞面

| # | 碰撞面 | 可能？ | 结果 |
|---|---|---|---|
| 1 | 两个并发 Wuxin 桥调用 | 是 | 同秒同键，第二个静默丢；`contains→put` 非原子，恰好同时到达的竞态可让两个都过（无害） |
| 2 | 两个快速顺序调用 | 是 | **实时 CONFIRMED**（300ms 间隔第二个 0 帧） |
| 3 | 桥调用 vs 真实 QQ 事件 | 是 | 静态进程级缓存跨会话共享；quickRouter 桥恒用 770099，executor recent 回退用真实群号 |
| 4 | 重试/回退 vs 原调用 | 同请求同目标：否（P0_2 已抑制）；lazybot→yumu 跨目标：对 5s 内既有 yumu 键可能 | 跨目标新事件可撞旧键 |
| 5 | 同秒不同命令 | 是 | **实时 CONFIRMED 丢弃**（文本不在 key） |
| 6 | 同秒同命令 | 是 | 同键，与 #5 等价（离线矩阵覆盖） |
| 7 | 不同群 | 同位数：否；**字段边界错位：可能**（key 无分隔符，见 §22b 构造反例与分类） | group_id 在 key，但数字串边界可错位 |
| 8 | 不同用户 | 同位数：否；**字段边界错位：可能**（§22b 的 different-user 类） | 顶层 user_id 在 key，但数字串边界可错位 |
| 9 | pending prompt / waiter | 是（潜在） | 被 dedup 丢弃的事件不会执行 `AsyncMessageUtil.put`，等待器永远等不到；当前 6 个桥接命令不使用 doubleCheck/getLock，属潜在面 |

## 10–11. 同命令 / 不同命令碰撞结果

- 同命令同秒：丢（同键，源码直证 + 离线矩阵 #1）。
- 不同命令同秒：丢（**实时 CONFIRMED**：`!ymd20` 11ms 回复 "2"；`!ymd6` 0 帧静默）。

## 12. event.time 变异评估

**允许，但必须加约束。** 依据：整个 Yumu 应用只有两个消费者能看见 `event.time`：

1. Shiro 2.5.3 dedup key（纯字符串拼接）；
2. `OneBotListener.kt` 的陈旧门：

```kotlin
if (groupEvent.time < 1e10) nowTime /= 1000   // <1e10 按秒；>=1e10 按毫秒
if (nowTime - groupEvent.time > 30) return    // 静默陈旧丢弃
```

Yumu 自己的事件包装 API（`qq/event/Event.kt`、`qq/event/MessageEvent.kt`）**根本不暴露 time**，业务代码读不到它。因此合成 time 对绑定/权限/历史/回复路由无影响。

约束（硬化后，最终规格 = A′）：

- 改毫秒（13 位）后陈旧门按毫秒比较：`now - time > 30` 即丢。A′ slot0 未来余量 2000–2999ms → **每调用飞行预算 = 余量+30 ≥ 2030ms**（slot99 为 2099–3098ms +30）。
- 陈旧门**只查过旧、不查未来**（对未来无上界）；A′ 的槽池天然把正常路径余量压进 2000–3098ms。**rollback fail-fast 由 safe-pool boundary 承担（水位超出当前池即发送前失败）；30000ms drift guard 是防御性/future-proof 保留，在当前控制流下基本不可达**。
- 时钟回拨：槽单调水位保证**绝不复用槽**；墙钟落后于水位时发送前失败（回退），墙钟追回后继续消费同一池的剩余槽或进入新池。
- 分配后在途发生**向前跳钟**：当且仅当跳变量超过该调用飞行预算会被丢；这是无法由分配器防御的时钟异常边界。
- 未来时间戳当前目标完全容忍（陈旧门只查“过旧”），Yumu 业务包装 API 不暴露 time。

## 13. sender identity 变异评估

**拒绝。** `sender.user_id` 是 Yumu 的语义身份：绑定（`BindDao.getBindFromQQOrNull(event.sender.contactID)`）、权限/管理员（`CheckAspect`、`PermissionImplement.isBlock`）、waiters（`group:<gid>:<sender>`）、命令历史（`QQMessageCacheProvider`）、统计（`ServiceCallStatistic.userID`）全部用它。改它必然破坏用户语义。

“只改顶层 `user_id`、保留 `sender.user_id`”可绕 dedup 且当前 group 路径不读顶层字段，但违反 OneBot `user_id == sender.user_id` 协议不变量，是脆弱的欺骗式设计 → 仅列为后备，不推荐。

## 14. self identity 变异评估

对 dedup 无效（self_id 不在 key）。现有 yumu 每调用随机 self-id 是会话路由必需（Shiro `robots` 按 X-Self-ID 索引，`wait-bot-connect=0` 下重复 self-id 第二个连接被关），与 QB-05 无关。

## 15. nonce/request-id 可行性

**Wuxin-only 不可行。** Shiro 2.5.3 过滤器不读取任何 nonce/request-id 字段；Yumu 的 messageId 幂等是过滤之后、且以 `[group|sender]subType(messageId)` 为键的独立机制。加入 nonce 字段会被直接忽略。实现 D 需要改 Shiro/Yumu → 属于目标侧改动。

## 16. 目标侧豁免可行性

可行但**不需要**：

- 全局 `shiro.group-event-filter: false`：同时去掉 NapCat 真实事件的去重保护，过宽；
- Yumu 侧按合成 self-id 段 / `X-Client-Role: Universal` 做白名单豁免：较窄，但属于 Yumu 代码改动；
- Shiro 上游协议加 bypass 字段：上游改动，远超范围。

## 17. binding 影响（候选 A）

无。sender.user_id / group_id 不变，绑定解析路径不变。

## 18. permission 影响（候选 A）

无。权限检查只依赖 sender.contactID 与 group.contactID。

## 19. prompt/waiter 影响（候选 A）

无。waiters 按 group:sender 匹配，候选 A 不改这两个字段；且 A 能保证第二个桥调用正常进入监听器，从而**修复**潜在 waiter 饿死路径（当前实现下同秒第二个事件根本到不了 `AsyncMessageUtil.put`）。

## 20. 实时复现结果（Phase D）

受控同秒复现，**恰好 2 次调用**，虚拟桥群 770099，合成 sender 900000099，无 Tencent 流量。脚本：`G:\My pack\Agent Work\codex_work\tmp\qb05-live-probe.cjs`。

| 项 | call1 | call2 |
|---|---|---|
| 命令 | `!ymd20` | `!ymd6` |
| event.time（两者相同） | 1786861450 | 1786861450 |
| sender / group | 900000099 / 770099 | 900000099 / 770099 |
| self_id | 8800000001 | 8800000002 |
| message_id | 2147000001 | 2147000002 |
| 发送间隔 | — | +300ms |
| WS open 延迟 | 11ms | 6ms |
| 首帧延迟 | 11ms（回复 "2"） | — |
| 帧数 / 回复动作 | 1 / 1 | **0 / 0** |
| 结果 | reply_observed | **silence_window_expired（9s 观察窗 0 帧）** |

Yumu 日志：两条 `Account 880000000x connected`；对 call2 的丢弃**无任何日志行** → 静默丢弃在运行态确认。

归因：**CONFIRMED**（源码谓词 + 有效配置 true/5000 + 运行态丢弃三者一致）。

**实现后受限实时验证（恰好 2 次调用，无 Tencent，不故意耗尽 100 槽）**：同逻辑 sender `900000099`、群 `770099`、同一普通墙钟秒内发出 `!ymd20` 与 `!ymd6`（`quick-bridge-qb05-safeslot-verify` live 阶段）。两者 event.time 分别为 `1786866914000` / `1786866914001`（13 位，X=0/1，同池秒、互不相同），Yumu 均返回 1 帧骰子回复（`6` 与 `5`），timeline 显示两次 `ws_open` + `command_sent`。live 阶段 6/6 通过。

## 21. 源/运行证据分类

- dedup 机制：由 **STRONG 升级为 CONFIRMED**（此前 STRONG 因 150ms 探测跨秒未命中）。
- A′ 分配器/补丁：仍为**设计级**，需按 §24 在合并前做一次实时验收探测（安全槽 13 位 time 被接受、两同秒调用都回复、第 101 次发送前回退）。

## 22. 离线矩阵结果（Phase E）

`tools/quick-bridge-qb05-dedup-verify.mjs`（精确镜像 Shiro 2.5.3 谓词 + Yumu 陈旧门；含 A′ 最终规格验证后 **66/66 通过**）。

| 场景 | 现状（秒） | 候选 A/A′（毫秒） |
|---|---|---|
| 同 sender/同群/同秒/同命令 | 第二个丢 | 第二个过 |
| 同 sender/同群/同秒/不同命令 | 第二个丢 | 第二个过 |
| 不同 sender（同位数） | 过 | 过 |
| 不同 group（同位数） | 过 | 过 |
| 相邻秒 | 过 | 过 |
| 并发（顺序到达模型 + 同毫秒单调保证） | 第二个丢 | 第二个过 |

额外探测：B-split 过；C 仅 self_id 仍撞；D 仅 nonce 仍撞；E 关过滤全过；F 保持现状=丢。陈旧门边界：+2030ms 过（30 边界），+2031ms 丢（31>30）。

## 22b. 两轮硬化结果（本阶段新增，verifier 已扩到 66 项）

### 硬化 1：无分隔符 key 的跨字段碰撞证明

**待证命题**：“13 位合成毫秒键与 10 位真实秒级键不相交”。

**判定：FALSE。** 用户给出的构造反例在真实谓词下严格成立：

```
key(1786861450123, 770099, 900000099)
  = "1786861450123" + "770099" + "900000099"
  = "1786861450123770099900000099"
key(1786861450, 123770099, 900000099)
  = "1786861450" + "123770099" + "900000099"
  = "1786861450123770099900000099"   ← 完全相同
```

两个顺序都在镜像过滤器 5s 窗口内实测丢第二个（verifier A2-2/A2-3）。

**结构分类**（verifier `findRealSplits`）：真实事件秒值在当前纪元固定 10 位，因此与合成键相等的真实三元组必然取 `T_r = 前 10 位`，随后 `G_r = 第 11 位起的 gl 位`、`U_r = 剩余`；合法拆分要求 `G_r`/`U_r` 不以 0 开头且 `U_r ≤ 10 位`。对 quickRouter 路径（`G_s=770099`）得两类：

| 类 | 真实三元组 | 出现条件 |
|---|---|---|
| 同用户 | `T_r = T_s div 1000`；`G_r = dec(X)+"770099"`（9 位，X∈[100,999] → 群号 100770099..999770099）；`U_r = U_s` | 同秒同用户在特定 9 位群发真实消息，且该调用毫秒余数 X 恰等于该群前 3 位 |
| 不同用户 | `T_r = T_s div 1000`；`G_r = dec(X)+"77009"`（8 位）；`U_r = "9"+dec(U_s)`（10 位） | `\|U_s\| ≤ 9` 且真实账号 `9U_s` 在特定 8 位群发消息 |

executor 同群路径：同用户类**不可能**（13 位 vs 10 位 time 与相同 G 后缀）；不同用户类仅在真实群号是**周期 3 且以 X 开头**（如 123123 / 123123123）且 `|U_s| ≤ 7` 时存在。

**前导零引理**（verifier A2-7 穷举验证）：若 `X = T_s mod 1000 < 100`，强制边界第 11 位以 `'0'` 开头；任何真实群消息三元组（`group_id > 0`，且 group/user 为无前导零的规范十进制表示）都不可能合法拆分 → **此时真正不相交**。代价是每秒只有 100 个可用合成 time（需排队/回退），未选中。

**实际 Wuxin-vs-real 残余风险**：

- quickRouter 虚拟群路径：每同秒巧合的条件概率 ≤ **1/1000**（X 须命中特定群前 3 位），且需真实事件落在 `T_s div 1000`（2000ms 余量下即调用所在秒 +2s）这一秒并在 5s 窗口内；期望发生率在本部署流量下可忽略。
- executor 同群路径：同用户碰撞为 0；周期群 + ≤7 位 QQ 号的类实际不会出现（QQ 号通常 9–10 位）。
- 结论：**A 仍安全**，但证据措辞必须由“键空间不相交”修正为“Wuxin-Wuxin 必然唯一；Wuxin-vs-real 有枚举的边界错位类与 ≤1/1000 条件概率上界（相对现状同秒必撞降低 ≥1000 倍）”。

### 硬化 2：分配器压力测试（对 Yumu 真实陈旧门）

| 压力 | 结果 |
|---|---|
| 同毫秒突发 5000 次 | 严格递增、永不为过去、全部在 +10ms 接收延迟下过门；漂移 = 2000+4999 = **6999ms** |
| 飞行预算边界 | 首调用 +2030ms 过 / +2031ms 丢；同毫秒第 6 个调用 +2035ms 过 / +2036ms 丢（每 +1 个突发序号预算 +1ms） |
| 时钟回拨 5s | 时间仍严格递增；漂移 7001ms；过门（差值为负）；约 **5002ms** 墙钟后漂移自然衰减归零 |
| 在途向前跳钟 | 首调用 F=2030ms 过、F=2031ms 丢 → **唯一会被门丢的路径** |
| 未来上界 | 陈旧门**无未来上界**（任意未来值都过）；朴素分配器在 40k 同毫秒突发下漂移 41999ms，**能超过任何固定语义上限** |
| 修订后分配器 | 加 **30000ms 硬上限**：5000 次突发内正常；漂移将超限时**发送前拒绝**（A 变体分析；最终 A′ 中回拨 fail-fast 由 safe-pool boundary 承担，30s guard 基本不可达） |
| 时钟回拨（最终 A′） | 池边界直接 fail-fast，无槽复用，追回后只发新槽 |

**最大安全漂移（对实际门）**：过去漂移 ≤30ms 会被丢；分配器在分配时刻过去漂移恒 ≤0，因此**自身不会越界**。正向漂移门不限；**最终 A′ 的实际约束是 safe-pool 窗口（正常路径 ≤3098ms），30000ms guard 仅作防御性/future-proof 保留**。

**精确不变量（最终 A′ 合并后）**：

1. 每次发出的 T：13 位、`T%1000 ∈ [0,99]`、`2000 ≤ T - wallAtAlloc ≤ 3098`（正常路径），且 T 跨调用严格递增、进程内绝不复用；
2. 门通过 ⇔ `yumuReceiptWall - T ≤ 30`，故每调用飞行预算 `(T - wallAtAlloc) + 30 ≥ 2030ms`；
3. 回拨 fail-fast 由 **safe-pool boundary** 承担（水位超出当前池即发送前失败）；30s drift guard 防御性保留、当前控制流下基本不可达；在途向前跳钟 > 在途预算时最多丢 1 个调用（时钟异常，无法防御）；
4. Wuxin-Wuxin：任意两调用键不同（13 位定长 + 严格递增 + 池内唯一）；
5. Wuxin-vs-real：**严格不相交**（leading-zero lemma；前提：真实 10 位秒、`group_id > 0`、group/user 无前导零规范十进制）。

### 硬化 3：基于 leading-zero lemma 的 A′ 最终规格

把硬化 1 的引理从“观测结论”变成“分配约束”：**只允许 `time % 1000 ∈ [0,99]`**，则合成 key 第 11 位恒为 `'0'`；任何真实群消息三元组（10 位秒 + `group_id > 0` + group/user 无前导零的规范十进制表示）都无法拆分该 key → **Wuxin-vs-real 残余碰撞归零（严格证明）**。

A′ 分配器（确定性 safe-slot）：

```
poolBase  = ceil((now + 2000) / 1000)              // 第一个 slot0 ≥ now+2000 的秒
pool      = [poolBase*1000, poolBase*1000 + 99]    // 每秒恰好 100 个安全槽
t         = poolFirst，或 last+1（严格单调水位要求时）
t > poolLast  → 抛错（本秒 100 槽耗尽，发送前失败 → 既有 fallback）
t - now > 30000 → 抛错（防御性/future-proof guard；当前控制流下基本不可达，回拨 fail-fast 由 t > poolLast 承担）
```

verifier 实测（F-1…F-13，全部通过）：

- slot0 未来余量对全部 1000 个墙钟毫秒相位 ∈ **[2000, 2999]ms**；13 位；X=time%1000 恒 ∈ [0,99]；
- 3s 连续扫描：成功 **301** 次（1+100+100+100），池耗尽快速失败 **2699** 次，发出的值严格递增且唯一；
- 对 1505 个生成 key 做真实三元组拆分搜索：**0 违例**（真正不相交）；
- 同毫秒突发：100 个唯一槽，**第 101 次发送前拒绝**；下一墙钟秒开新池 slot0；
- 陈旧门边界：slot0 预算 = 余量+30（≥2030ms），slot99 再加 99ms，边界精确；
- 回拨 5s：墙钟落后于水位时 fail-fast，追回后只发新的严格递增槽，**无槽复用**；
- 突发对比：A 同毫秒 5000 次全收；A′ 第 101 次拒绝。

**A vs A′ 对比**

| 维度 | A（任意毫秒 + 30s cap） | A′（safe-slot，X∈[0,99]，100/s） |
|---|---|---|
| Wuxin-Wuxin collision | 0（严格递增） | 0（严格递增 + 槽唯一） |
| Wuxin-real collision | 非零残余：≤1/1000 条件概率 + 周期群异用户类 | **0（leading-zero lemma 严格证明）** |
| 吞吐 | 理论无上限（40k/ms 才触 30s cap） | **硬上限 100 桥事件/秒，第 101 次发送前失败 → fallback** |
| wall-clock rollback | 继续分配、漂移增大；>28–30s 才拒绝 | 同池继续消耗（不复用）；跨池回拨 fail-fast 至墙钟追回 |
| burst | 同毫秒任意 N 接受，漂移 = N-1 | 同秒 100 接受，101st 立即拒绝 |
| stale gate | 首调用预算 2030ms | slot0 预算 2030–3029ms（余量相位决定），slot99 +99ms |
| 实现复杂度 | ~8 行（buildEvent 内） | ~12 行 + 把分配移到 `new WebSocket` 之前（发送前失败） |

**决策：采用 A′。** 用每进程 100/s 的硬上限换取 residual key collision 的严格归零，复杂度增量极小；本部署 yumu 桥调用速率远低于 100/s，超限回退路径与既有桥失败回退完全一致。

## 23. 推荐设计（最终规格）

**A′（yumu-only deterministic safe-slot allocator：`time%1000 ∈ [0,99]`，100 槽/秒，耗尽发送前失败）**。

理由：

- 唯一在“不改 sender 语义、不改目标、不改路由/超时/重试”前提下同时满足：
  - **Wuxin-Wuxin：必然唯一**（进程内严格单调槽）；
  - **Wuxin-vs-real：严格不相交**（leading-zero lemma 证明 + verifier 1505 例 0 违例）；
- 代价仅是 100 桥事件/秒的硬上限（第 101 次发送前失败走既有回退），对本部署实际吞吐无感知影响；
- Yumu 当前代码显式支持毫秒分支；业务层完全看不到 time；正常路径未来余量 2000–3098ms；**rollback fail-fast 由 safe-pool boundary（单调水位 vs 当前池上限）承担，30s drift guard 在当前控制流下基本不可达，仅作防御性/future-proof 保留**。

## 24. 已实现的补丁（A′，server/bots/localBridge.ts）

实际实现（`export function yumuSafeTimeMs(nowMs: number = Date.now())`；`nowMs` 参数仅为离线确定性验证而参数化，生产调用不传参）：

```ts
let lastYumuSafeTimeMs = 0;
export function yumuSafeTimeMs(nowMs: number = Date.now()): number {
  const poolBase = Math.ceil((nowMs + 2000) / 1000);
  const poolFirst = poolBase * 1000;
  const poolLast = poolFirst + 99;
  let t = poolFirst;
  if (t <= lastYumuSafeTimeMs) t = lastYumuSafeTimeMs + 1;
  if (t > poolLast) throw new Error('yumu bridge safe-slot pool exhausted (100/s)');
  if (t - nowMs > 30_000) throw new Error('yumu bridge event time drift exceeded');
  lastYumuSafeTimeMs = t;
  return t;
}
```

接入点：`callLocalBot` 中在 `new WebSocket` **之前**、仅 `botId === 'yumu'` 时分配；失败立即 `reject`（并写 timeline `yumu_safe_slot_alloc_failed`），quickRouter/executor 既有 catch 回退原样消费，无未捕获异常、无桥流量。成功后把值经 `buildEvent(endpoint, command, context, selfId, yumuEventTime)` 传入；其余 bot 继续 `Math.floor(Date.now()/1000)`。

### 24a. 必须明确的声明

1. **leading-zero 证明的假设**：真实事件的 `time` 是 10 位十进制秒（当前纪元 `1e9..1e10`，公元 2286 年前成立）；真实群消息 `group_id > 0`，且 `group_id` / `user_id` 使用**无前导零的规范十进制表示**（JSON 数值解析后再序列化即为该形式）；Wuxin 合成 `time` 为 13 位且 `time%1000 ∈ [0,99]`。三者满足时，合成 key 第 11 位恒为 `'0'`，而任何真实三元组的第 11 位必须是 group_id 首位数字（1..9）→ 键空间严格不相交。
2. **30s drift guard 是 Wuxin 防御性/future-proof 策略，不是 Shiro 协议限制**：Shiro/Yumu 陈旧门只丢弃“过旧 >30（毫秒分支）”的事件，对未来无任何上限。当前控制流下**真正承担 rollback fail-fast 的是 safe-pool boundary**（水位超出当前池即发送前失败）；正常路径未来窗口 2000–3098ms，30s drift 检查在该控制流下基本不可达，仅作未来池算法变化时的防御保留。
3. **分配器保证是进程局部的**：`lastYumuSafeTimeMs` 是模块级进程内状态；严格单调、100 槽/池秒、绝不复用，均只在同一 OS 进程内成立。
4. **残留边界（已记录）**：进程快速重启后，新进程的水位归零；若重启发生在目标侧 5s 去重缓存仍存活的窗口内，理论上可能复用一个仍被缓存的槽并导致一次静默丢弃。概率与影响均极小，保留为文档化残留边界，不做跨进程持久化。

## 25. 是否需要目标改动

**否。** `TARGET_SIDE_CHANGE_REQUIRED` 不成立；选 A′ 后目标侧零改动。

## 26. 文件新增/修改

新增：

- `docs/QUICK_BRIDGE_QB05_YUMU_DEDUP_DESIGN_V01.md`
- `docs/QUICK_BRIDGE_QB05_YUMU_DEDUP_MATRIX_V01.json`
- `docs/QUICK_BRIDGE_FIX_QB05.md`（实现记录）
- `tools/quick-bridge-qb05-dedup-verify.mjs`（规格 verifier，66/66）
- `tools/quick-bridge-qb05-safeslot-verify.mjs`（实现 verifier：unit/blackbox/quickrouter-fallback/executor-fallback/live）

修改（生产）：**仅 `server/bots/localBridge.ts`** 新增 A′ 分配器与接入点；`quickMemory.ts`、`quickRouter.ts`、`executor.ts` 仍是此前 P0_1–P0_3_1 的既有修改，本阶段未再改动。临时复现脚本留在仓库外 `G:\My pack\Agent Work\codex_work\tmp\qb05-live-probe.cjs`。

## 27. 回归结果

- `quick-bridge-qb05-dedup-verify`：**66/66**
- `quick-bridge-qb05-safeslot-verify`：**unit 9/9、blackbox 9/9、quickrouter-fallback 5/5、executor-fallback 4/4、live 6/6**（离线 4 阶段 27 项 + 实时 6 项）
- P0_1 `quick-bridge-reliability-verify`：**166/166**
- P0_2 `quick-bridge-p02-recent-verify`：**23/23**
- P0_3/P0_3_1：`settle` **34/34**、`deadline` **23/23**、`deadline-race` **6/6**
- QB-03 `quick-bridge-qb03-policy-verify`：**33/33**（timer count=0）
- `quick-router-verify`：**121/121**
- `npm run check`（typecheck + vite build + sanity + security）：**PASS**
- `npm run verify-all`（QB05_SKIP_LIVE=1，避免重复真实调用）：**81/82**；唯一失败仍为已知基线 `reasoning-wire-verify.mjs`（24 项全过后 `UV_HANDLE_CLOSING` 3221226505，单独复跑签名一致）
- `git diff --check`：clean（exit 0）

## 28. 行为变更确认

本阶段**仅**实现 QB-05 A′：yumu 合成事件时间分配、发送前失败路径与相应 timeline 标记。P0_1/P0_2/P0_3/P0_3_1、QB-03、P1_1 的已关闭结论全部保持不动；路由、超时、重试、watchdog、目标侧零改动。

## 29. 无 commit

**确认。** 无 commit。

## 30. 无 push

**确认。** 无 push。

---

## 附：关键源码位置

| 证据 | 位置 |
|---|---|
| Shiro 谓词 | `napcat-local-bots\runtime\m2\com\mikuac\shiro\2.5.3\shiro-2.5.3.jar` → `GroupMessageFilterUtils.class`、`handler/event/MessageEvent.class` |
| 上游源码交叉验证 | `https://raw.githubusercontent.com/MisakaTAT/Shiro/master/src/main/java/com/mikuac/shiro/common/utils/GroupMessageFilterUtils.java` |
| Yumu 过滤配置 | `sources/yumu-bot/src/main/resources/application.yaml` L84–85；运行 jar `BOOT-INF/classes/application.yaml` 同内容 |
| 运行叠加配置 | `configs/private/yumu/application.yaml`（只有 `shiro.ws.*`，无 filter 键） |
| Spring 优先级依据 | `https://docs.spring.io/spring-boot/reference/features/external-config.html`（additional-location 可覆盖默认位置；缺失键回落到打包配置） |
| Yumu 陈旧门/幂等/群配置 | `OneBotListener.kt` L81–95、`IdempotentService.kt`（30s）、`YumuGroupConfig.kt` |
| 语义链 | `BindService.kt`、`UserIDUtil.kt`、`PermissionImplement.kt`、`CheckAspect.java`、`AsyncMessageUtil.kt`、`QQMessageCacheProvider.kt`、`ServiceCallStatistic.kt` |
| Wuxin 事件构造 | `server/bots/localBridge.ts` `buildEvent`（time=秒，user_id=sender.user_id=逻辑用户） |
| P0_2 抑制 | `server/bot/quickRouter.ts` L542/631、`server/bots/executor.ts` L1729–1762 |

**结束后不再继续任何实现工作。**
