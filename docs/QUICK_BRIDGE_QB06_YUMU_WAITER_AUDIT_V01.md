# QUICK_BRIDGE_QB06_YUMU_WAITER_AUDIT_V01

- 阶段：QB-06 审计 / 复现 / 设计（**AUDIT ONLY，不改生产行为**）
- 分类：**CONFIRMED_TARGET_BEHAVIOR**（机制在源码 + 真实部署字节码两层证实；生产上是否已发生 = **UNCONFIRMED**）
- 是否值得现在修：**否**（触发条件窄，且无法解释当前桥命令的 60s silent timeout）；给出条件触发点与首选候选设计
- Phase B：无生产改动、无 commit、无 push。

---

## 0. Phase A checkpoint 结果

- 审查后仅提交本轮 quick-bridge 全部 35 个相关文件（latency/timeline instrumentation、P0_1/P0_2/P0_3/P0_3_1、QB-03、P1_1、QB-05、对应 docs/matrices/verifiers）。
- 已排除：`.private/`、`docs/REPOSITORY_HYGIENE_AUDIT.md`、`docs/recommend-semantic-consistency-audit.md`、`docs/trunk-source-boundary-audit.md`。
- commit：`713ea7e2115d97a7beddbfd49270a86a1436b5e4` — `fix: harden quick bridge reliability and yumu dedup handling`
- push：**成功** `origin/fix/onebot-connection-lifecycle`（`1658292..713ea7e`）
- 提交前：`git diff --cached --check` clean、`npm run check` PASS、qb05-dedup 66/66、qb05-safeslot 4/4 离线阶段；两处 QB-05 措辞（safe-pool boundary 承担 rollback fail-fast、30s drift guard defensive；leading-zero 前提改为真实群消息 `group_id > 0` + 无前导零规范十进制）已在提交前修正。

---

## 1. 完整调用链（源码证据）

```
Wuxin callLocalBot
  -> WS ws://127.0.0.1:8388/pub/onebotSocket（X-Self-ID = 每调用随机 8.8e9 池）
  -> Shiro WebSocketServerHandler.handleTextMessage
       （按 X-Self-ID 在 BotContainer.robots 找到会话 Bot）
  -> ShiroAsyncTask.execHandlerMsg -> EventHandler.handler
  -> handler.event.MessageEvent.process（group 分支）
       1) group-event-filter dedup（QB-05，已修：A′ safe-slot 不再误撞）
       2) group-self-bot-event-filter（sender.user_id ∈ robots.keys 则静默返回）
       3) EventUtils.setInterceptor（Yumu 无自定义 interceptor，默认通过）
  -> InjectionHandler.invokeGroupMessage
       （全项目唯一的 @GroupMessageHandler = OneBotListener.handle，@Order(9)）
  -> OneBotListener.handle
       stale gate（time<1e10 秒分支 / >=1e10 毫秒分支）
       -> YumuGroupConfig.isGroupDisabled(groupId)
       -> messageID = "[groupId|sender.userId]subType(messageId)"
       -> idempotentService.executeIdempotent（30s 缓存，并发同 messageID 等待 2s 后阻断）
       -> QQMessageCacheProvider.putMessage
       -> PermissionImplement.onMessage
```

**waiter 检查点**：`PermissionImplement.onMessage` 的**第一行** `AsyncMessageUtil.put(event)`（源码第 80 行），在 `filterMessage`、权限检查与所有 service 分发**之前**。因此任何进入 OneBotListener 的群消息——包括 Wuxin synthetic event——都会先参与 waiter 匹配。

## 2. 精确 waiter 谓词 / scope / lifecycle

`com.now.nowbot.util.AsyncMessageUtil`（object 单例，JVM 进程级 `LockManager`）：

- key 生成：
  - 群消息：`group:<subject.contactID>:<sender.contactID>`（即 **group_id + sender.user_id**）
  - 私聊：`sender:<sender.contactID>`
  - `anyoneCanResponse=true`：`group:<group.contactID>:*`
- **参与匹配的字段只有 group_id 与 sender_id**；message content、message_id、self_id、event.time、sub_type、nickname、图片全部不参与。
- scope：**process-global**（对象单例的三个 ConcurrentHashMap），既不是 bot-global 也不是 request-local。
- 消费方式：`put()` 遍历全部 key，对每个匹配 key 调用 `completeFuture`；`completeFuture` 有 `!future.isDone` 守卫 → **每 key consume-once；不同 key 之间是 broadcast**。`put()` 不阻止事件继续走正常 dispatcher（**peek-style，非 consume-and-stop**）。
- 同 key 注册：`registerFuture` 直接覆盖旧 future → 同 key 后注册者胜出，旧 waiter 被 orphan（bytecode probe 实测）。`getOrCreateFuture` 对已存在 future（含已完成的）直接返回。
- 过期/取消/替换：
  - `AsyncLock.await(timeout)` / `doubleCheck` 的 `future.get(timeout)` 超时返回 null → `onOverTime`；
  - `doubleCheck` 在 finally 清理 key；
  - `getLock` 只在 `unlock()` 且已过期时经 `cleanupIfExpired` 清理；不 unlock 则过期 key 可残留（内部卫生问题，非本桥面）。
  - 无显式 cancellation API；同一 key 并发 doubleCheck 被 `tryLock` 拒绝（“操作正在进行中”）。
- 多 waiter：不同 key 各自收到同一事件（broadcast）；同 key 共享一个 future，后注册替换旧。
- callback 抛错：异常沿等待线程从 `doubleCheck` 传播（bytecode probe 实测），不吞；finally 仍清理。

Yumu 中 waiter 使用者（全部源码枚举）：BindService、SBBindService、CustomService、ServiceSwitchService、UpdateTriggerService、MatchListenerService、BestHistoryRecoverService、GuessService、MaiScoreService、MapPoolService。

## 3. 状态机

| 状态 | waiter | 正常 dispatcher | Wuxin frames | 60s silent | 错误关联 | 状态污染 |
|---|---|---|---|---|---|---|
| no waiter | put 空转 | 正常 | 正常 | 否 | 否 | 否 |
| waiter 不匹配 | future 保持 pending | 正常 | 正常 | 否 | 否 | 否 |
| waiter 命中 synthetic event | future 完成，事件进入 waiting thread | **继续正常分发（peek）** | 正常 | 否 | **是：等待流把命令文本当“用户回答”** | **是：真实用户 pending prompt 被消费/取消** |
| waiter 消费后 | 回调用 synthetic 内容执行 | 已独立进行 | 正常 | 否 | 是（如 interactiveBind 会把 `!r <user>` 当 osu 用户名查询） | 是 |
| callback 成功 | — | 正常 | 正常 | 否 | 是 | 是 |
| callback 抛错 | 异常传回等待线程，key 清理 | synthetic 分发不受影响 | 正常 | 否 | 真实用户在原事件链收到错误回复 | 清理 |
| waiter 并发过期 | onOverTime | 正常 | 正常 | 否 | 否 | doubleCheck 清理；getLock 需 unlock |
| 多匹配 waiter | 不同 key broadcast；同 key 后注册胜 | 正常 | 正常 | 否 | 每个 distinct waiter 都看到同一 synthetic 文本 | 多流同时反应 |
| 真实事件 vs synthetic race | 先到者完成 key；后者无法重放（isDone） | 两个事件都正常分发 | 正常 | 否 | waiter 看到先到者 | 竞态结果不定 |
| 两个 Wuxin 调用互抢 | 第一个消费 waiter，第二个被 waiter 忽略 | 两个命令都分发 | 两个都收到自己帧 | 否 | waiter 看到第一个命令文本 | 同上 |

## 4. Identity overlap（重点证明）

**正向（真实 waiter 被 synthetic 消费）：成立。**
- quickRouter 桥恒用虚拟群 `770099` + 逻辑 sender → 与真实 waiter 重叠需要该虚拟群存在 pending prompt（本部署基本无真实流量，风险低但非零）。
- executor 的 recent 回退桥（lazybot→yumu 跨目标、或直接 internal 调用）使用 `groupId: context.groupId || '770099'` → **真实群号** + 逻辑 sender。同一群同一用户若存在 pending prompt（如 bind 确认、custom 删除确认、猜歌等），Wuxin synthetic command event 会**先于命令分发完成该 waiter**。
- JVM probe 用真实部署字节码实测：`getLock(770099,900000099)` 被 synthetic group event 完整消费；`put` 后 dispatcher marker 仍执行。

**反向（Wuxin 建立的 waiter 消费真实事件）：当前不成立。**
- 六个当前桥接命令 `recent / bp / bs / pm / etx / rating` 的 service 文件（RecentBestService、BPService、PPMinusService、EliteronixDuelRatingService、SeriesRatingService）**零 `AsyncMessageUtil` 调用**（verifier 静态断言）。
- Wuxin 侧 callLocalBot/quickRouter/executor 也不注册 Yumu waiter。
- 结论：反向 = **IMPOSSIBLE（当前命令面）**；若未来桥接 `bh/guess/bind` 等交互命令则变为 SOURCE_POSSIBLE。

**self_id / event.time / message content / message_id 都不能隔离 waiter**：Yumu 事件包装层（`qq/event/Event.kt` 只暴露 bot；`qq/onebot/event/MessageEvent.kt` 只暴露 subject/sender/message/rawMessage/textMessage）根本不把 self_id/time/message_id 传给 waiter；key 也只用 group/sender。

## 5. Source-level collision matrix

| 维度 | command-like text | arbitrary plain text | reply/notice/non-message | 条件 |
|---|---|---|---|---|
| same group / same user | **SOURCE_CONFIRMED consume** | **SOURCE_CONFIRMED consume** | IMPOSSIBLE（无 GroupMessageHandler） | 存在 `group:<g>:<u>` 或 `sender:<u>` waiter |
| same group / different user | SOURCE_CONFIRMED 不匹配 group key | 同左 | IMPOSSIBLE | — |
| different group / same user | group key 不匹配；**`sender:<u>` 锁匹配** | 同左 | IMPOSSIBLE | 取决于 waiter key 类型 |
| same identities / different self_id | SOURCE_CONFIRMED 不能隔离 | 同左 | IMPOSSIBLE | self_id 不进 key |
| same identities / different event.time | SOURCE_CONFIRMED 不能隔离 | 同左 | IMPOSSIBLE | time 不进 key |
| same identities / different message_id | SOURCE_CONFIRMED 不能隔离 | 同左 | IMPOSSIBLE | message_id 只影响 listener 幂等 |

bytecode probe 将其中 consume/不匹配/consume-once/broadcast 项全部提升为 **runtime bytecode confirmed**（对真实 AsyncMessageUtil，不是复制 predicate）。

## 6. 是否能解释真实 60s silent timeout

**不能**（对当前六个桥命令）：

- `put()` 是 peek-style，**不会吞掉或截断命令分发**；被 waiter 命中的 synthetic 命令仍正常执行并回帧。
- 六个桥命令自身不注册 waiter，因此 synthetic 调用不会进入 `getLock(...).await()` 阻塞。
- 已知 60s silent 原因仍是：QB-05 同秒 dedup（已修）、群配置关闭、pending prompt/lock 吞命令（QB-06 的另一面：若未来桥接交互命令，service 内部 await 会把该桥调用挂成 open-but-silent）、上游慢、ACK 失败。

**未来最短 failure path（若桥接交互命令）**：`BestHistoryRecoverService.handleMessage` 内 `getLock(event, 30s).await()` → synthetic 命令发出提示帧后等待 follow-up → 真实用户继续发消息才完成，Wuxin 60s 超时。当前不在桥接面。

## 7. 受限 runtime 验证

未走 Tencent。使用了比 mock 更强的验证：**编译并运行 Java 探针，动态代理实现 Yumu 事件接口，直接调用运行 jar 内的真实 `AsyncMessageUtil` 字节码**：

- 19/19 通过：no-waiter no-op；matching consume；dispatch continues；different group/sender/non-group 不匹配；内容（命令/OK/普通文本/空串）不隔离；多 waiter 仅匹配者完成、同 key 后注册胜出；consume-once；过期边界与清理；callback 抛错传播与清理。
- 未做全栈 live waiter 复现：需要真实 service 流程进入 pending prompt，且**严禁向真实 QQ 群发测试消息** → 保留 SOURCE_CONFIRMED（机制）/ bytecode RUNTIME_CONFIRMED，**不宣称生产已发生**。

## 8. 候选设计比较

| 候选 | 是否破坏真实 prompt | 是否破坏 binding/permission/history/stats | 改 Yumu? | 严格隔离? | OneBot semantics | 兼容性 | 规模 | 结论 |
|---|---|---|---|---|---|---|---|---|
| A synthetic target-aware bypass/exemption | 否（按合成 self-id 段/Universal 角色白名单） | 否（仅跳过 put） | 是 | **是** | 真实流量不变 | 高 | 小-中 | **条件首选** |
| B waiter namespace/source tagging | 否 | 否 | 是 | 是 | 真实流量不变 | 中（升级时 pending waiter） | 中-大 | 过度 |
| C request-scoped synthetic identity | sender 变更：真实 prompt 语义破坏 | 是 | 否（仅 Wuxin） | 是 | 违反 user_id==sender.user_id | 差 | 小 | 拒绝 |
| D dispatcher 顺序调整 | 风险（命令前缀答案被跳过） | 否 | 是 | 否（启发式） | 真实流量改变 | 中 | 小 | 拒绝 |
| E bridge 独立 ingress | 否 | 否 | 是 | 是 | 真实流量不变 | 高 | 大 | 长期架构选项 |
| F 保持现状 | N/A | N/A | 否 | 否（记录残余） | 不变 | N/A | 无 | **当前推荐** |

**推荐**：现在选 **F**。理由：(1) 当前桥命令不注册 waiter；(2) 消费是 peek-style，不吞命令、不解释 60s silent；(3) 重叠需要真实用户在恰好被桥的 group/sender 存在 pending prompt，本部署主要暴露面是 lazybot→yumu recent 回退（真实群）；(4) 任何 Wuxin-only 方案要么破坏语义（C），要么只是概率缓解。**触发条件**：未来桥接交互命令或扩大真实群桥接 → 在 Yumu `PermissionImplement.onMessage` 的 `put` 之前按合成 self-id 段 / `X-Client-Role: Universal` 做白名单豁免（候选 A，严格隔离，先设计后实现）。

## 9. 证据边界 / 最终分类

- **CONFIRMED_TARGET_BEHAVIOR**：Yumu 在命令分发前按 group/sender 消费 waiter 是目标侧既定的 peek 语义；机制被源码 + 真实字节码探针确认。
- **不是** CONFIRMED_LOCAL_BUG：Wuxin 侧没有错误代码路径；也没有证明“生产上已发生”。
- **不是** PROTOCOL_LIMITATION / INVALID_PREMISE / INSUFFICIENT_EVIDENCE：证据足以描述行为。
- 触发前提（生产发生）必须同时满足：真实用户在 Yumu 有 pending waiter + 同一 group/sender 恰好收到 Wuxin bridge event（quickRouter 虚拟群 / executor 真实群）。

## 10. 输出文件

- `docs/QUICK_BRIDGE_QB06_YUMU_WAITER_AUDIT_V01.md`（本文件）
- `docs/QUICK_BRIDGE_QB06_YUMU_WAITER_MATRIX_V01.json`
- `tools/quick-bridge-qb06-waiter-verify.mjs`（7/7 wrapper + 19/19 真实字节码探针）

## 11. Verifier 结果

```
PASS bytecode-probe-19-checks      （真实 Yumu AsyncMessageUtil 字节码）
PASS bytecode-probe-individual-count (19 PASS lines)
PASS source-put-before-command-filter
PASS source-bridged-commands-never-register-waiters
PASS source-waiter-users-enumerated
PASS wuxin-quickrouter-uses-virtual-bridge-group
PASS wuxin-executor-fallback-uses-real-group
7/7 wrapper checks；JVM WaiterProbe 19/19
```

## 12. 最终报告项

1. **Phase A commit SHA / push**：`713ea7e…b5e4`；push **成功** 到 `origin/fix/onebot-connection-lifecycle`。
2. **QB-06 最终分类**：`CONFIRMED_TARGET_BEHAVIOR`（生产发生 = UNCONFIRMED）。
3. **精确 waiter predicate / scope / lifecycle**：`group:<group_id>:<sender_id>`（或 `sender:<id>`、`group:<gid>:*`）；进程级；put-before-dispatch；peek/broadcast + per-key consume-once；同 key 覆盖注册；doubleCheck finally 清理 / getLock unlock 才清过期；callback 抛错传播。
4. **最短 failure path**：真实用户 pending prompt（如 bind/confirm）→ 同一 group/sender 的 Wuxin synthetic event 先被 waiter 消费 → prompt 被取消或按命令文本误执行；**synthetic 命令本身仍正常回帧**。
5. **source/runtime 证据**：源码清单见 §1/§2；runtime = 真实部署字节码 JVM 探针 19/19；无 Tencent、无全栈 live waiter 复现。
6. **是否解释真实 60s silent**：当前桥面**否**；未来桥接交互命令时，getLock().await() 才是该 timeout 机制。
7. **是否值得修**：现在**否**；条件触发时按候选 A 修（Yumu 侧白名单跳过 put）。
8. **推荐候选**：现在 F；未来 A。
9. **verifier**：wrapper 7/7 + bytecode 19/19。
10. **新增文件**：上述三个文件；**生产行为零改动、无 commit、无 push（Phase B）**。

**报告结束。**
