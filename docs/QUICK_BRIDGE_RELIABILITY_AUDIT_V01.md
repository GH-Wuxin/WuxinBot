# QUICK_BRIDGE_RELIABILITY_AUDIT_V01

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：只审计、只观察、离线为主；未优化、未改路由/身份/超时/观察语义；未 commit/push
- 产出：
  - `docs/QUICK_BRIDGE_ALIAS_COLLISIONS_V01.json`（Phase A）
  - `docs/QUICK_BRIDGE_FALLBACK_GRAPH_V01.json`（Phase E）
  - `docs/QUICK_BRIDGE_RELIABILITY_MATRIX_V01.json`（Phase B/F/G/I/J）
  - 本文件
  - `tools/quick-bridge-reliability-verify.mjs`（Phase C 离线回放回归守卫，129 assertions，仅本地合成 WS，无生产流量）

## 0. 结论摘要

1. **121 个 quick 定义、422 个别名**；38 个 active，其中 **20 个桥接**（yumu 6、kanon 5、hydrant 3、lazybot 6）。
2. **11 个域内别名冲突**；运行时胜者与直觉不同的主要是：`!re/!pr/!recent` → **kanon**（不是 yumu）、`!bp` → **kanon**（不是 yumu）、`!info` → **kanon bridge**（不是 yumu internal）、`!score` → **kanon**（同一 capability 但 botId=kanon）、`!search`/`!badge`/`!get bg`/`!todaybp` → kanon 文档态定义遮蔽 yumu 定义（均不可执行）。
3. **身份模型确认**：Kanon 有唯一已知的静默自消息过滤器 `event.user_id ∈ connected_client_self_ids`（CONFIRMED，V01_1 复现）。Yumu 的 `sender.user_id ∈ robots.keys` 自 bot 过滤器因 Wuxin 每调用随机 self-id 实际不会命中。Hydrant/LazyBot 无自消息事件过滤器。
4. **离线回放**：24 个合成 WS fixture + timer 生长检查，129/129 断言通过；生产 `callLocalBot` 在 20 种回复形态下 settle/timeout/ACK/关闭行为正确，settle 一次、无未处理 rejection、socket 关闭、timer 归零。
5. **Fuzz**：别名 10,000 例 runtime vs pure 0 不一致；桥事件构造+回复提取 10,000 例 0 violation；绑定注入 3,000 例 0 violation。无 fuzz failure。
6. **最坏链式延迟**：kanon/yumu `recent` 理论可见最坏 ≈ **212.4s + 渲染**；context-ready 再 +45s ≈ **257.4s**。超过 30/60/90/120s 阈值。
7. **最高风险**（S1）：Kanon 身份碰撞静默丢弃（CONFIRMED）；Kanon dedup 锁会让 60s 超时后的第二次桥接再次 60s 静默（STRONG）；所有桥接命令在 open-but-silent 时烧满 30/60s 且无下游执行证据（CONFIRMED）。
8. 本轮未做任何优化。未 commit，未 push。

## 1. Phase A — 清单与别名冲突

- 生成脚本读取 `quick.meta.ts` 的 `finalizeQuickDef` / `quickParseDomain` / `canonicalQuickSyntax`，并用真实 `matchQuickCommand` 语义计算胜者。
- 关键数字：121 defs；422 aliases；38 active；20 bridged；11 collisions。

| 冲突别名 | 域 | 胜者 | 被遮蔽者 | 是否改变回退家族 |
|---|---|---|---|---|
| re / pr / recent | ! | kanon:recent (proxy) | yumu:recent (proxy) | 否（都走 recent）但语义不同：kanon `pr` 不含 fail |
| bp | ! | kanon:bp (proxy) | yumu:bp (proxy) | 否 |
| info | ! | kanon:info (proxy) | yumu:info (local) | 是：桥接 kanon vs 内部 yumu |
| score | ! | kanon:score (local) | yumu:score (local) | 否（同 capability，botId 不同） |
| badge | ! | kanon:badge (doc-only) | yumu:badge (doc-only) | 否（都不可执行→LLM） |
| get bg | ! | kanon:getbg (doc-only) | yumu:getbg (doc-only) | 否 |
| todaybp | ! | kanon:todaybp (doc-only) | yumu:todaybp (doc-only) | 否 |
| search | ! | kanon:search (doc-only) | yumu:explore (doc-only) | 否 |
| 我的年度osu! | none | hydrant:annual | 同 def 的两个别名规范化后相同（intra-def 重复） | — |

- 运行时胜者与直觉不符：`!re/!pr/!recent`、`!bp`、`!info`、`!score` 均归 kanon（EXCLAMATION_DEFS 注释说明是刻意顺序）；`!search` 看似可用实际是 documentation-only。
- 修改顺序一定是行为变更；本审计未改。

## 2. Phase B — 身份模型（详见 matrix JSON）

| Bot | 桥 X-Self-ID | event user_id | event group_id | 消息形态 | 目标侧静默过滤器 |
|---|---|---|---|---|---|
| yumu | 每调用随机 8800000000–8899999999 | Number(ctx.userId)\|\|0 | Number(ctx.groupId)\|\|770099 | string；有 atTargets 时 array | `sender.user_id ∈ robots.keys`（默认开）；duplicate(time,group,user) 5s（开）；idempotency；group config；pending prompt |
| kanon | `BRIDGE_SELF_ID` 或固定 `1000000003` | 同上 | 同上 | 恒 array | **`GetRawText(user_id) ∈ connected client X-Self-ID`（CONFIRMED）**；dedup same-sender+same-msg；group config |
| hydrant | 同上 | 同上 | 同上 | string；有 atTargets 时 array | group config；私聊 message_id 重复；非法 mode；ApiAccessException |
| lazybot | 同上 | 同上 | 同上 | string；有 atTargets 时 array | raw_message/time/group_id/message null；stale>25s；group config；in-flight dedup；unknown cmd；limiter timeout |

确认的碰撞谓词（目标源码）：

```text
KANON_DROP_IF  GetRawText(event.user_id) IN connected_client_self_ids
               -> silent return (Server.cs:225-227; reproduced live V01_1)

YUMU_DROP_IF   sender.user_id IN botContainer.robots.keys
               -> silent return (Shiro MessageEvent.process, groupSelfBotEventFilter=true)
YUMU_DROP_IF   duplicate(time, group_id, sender.user_id) within 5000ms
               -> silent return (group-event-filter:true)

HYDRANT_DROP_IF group-bot-config[group_id]["hydrant"] == false -> silent (Hydrant.cs:204-206)
LAZYBOT_DROP_IF group-bot-config[group_id]["lazybot"] == false -> silent (CommandListener.java:72)
```

- 两个并发桥客户端碰撞：yumu self-id 随机碰撞概率 1e-8/对，且命中时是“新 socket 被关”快速失败；kanon/hydrant 同 self-id 可共存、按连接路由；lazybot 同 self-id 第二个被关。
- 真实 QQ 碰撞：仅 kanon 谓词真实可达——发消息者 QQ 恰为 `1000000003`，或等于任何已连接客户端 self-id（如 NapCat 3861208813 时只有 bot 自己）。
- 合成 harness 碰撞：kanon CONFIRMED（V01_1）；yumu 在复用固定 self-id 时会快速失败而非静默。

## 3. Phase C — 离线回放

`tools/quick-bridge-reliability-verify.mjs`（新增，默认只跑本地随机端口合成 server，不 import 时无副作用；production runtime 不 import）：

- 24 fixtures 覆盖需求清单 1–20 + 4 个补充（空 message、缺 file 的 image、face-only、settle 前迟到帧）。
- 关键结果：
  - `send_msg` / `send_group_msg` / `send_private_msg` 均被 `extractReplyFrame` 接受；string 与 array 均正确。
  - 带 echo 的 action 帧被 ACK（`{status:'ok',retcode:0,data:{message_id:0},echo}` 原样 echo，包括数字 0）；无 echo 不 ACK。
  - action-only → 烧满 timeout；close-without-reply → 快速 reject `无回复`。
  - **回复落在 timeout 前 3s 内会被丢弃**（settle 需 3000ms，overall timer 先赢）——fixture 14 确认。
  - 迟到帧（settle 前）会把 settle 从 3000ms 重新起算（fixture 23：总 5.9s）；settle 后 socket 已关，迟到帧无法到达。
  - settle 只发生一次；所有路径 socket 关闭；`process._getActiveHandles` Timeout delta 全部为 0；无 unhandled rejection。

## 4. Phase D — Fuzz

| Campaign | 用例数 | 种子/范围 | 结果 |
|---|---|---|---|
| alias：runtime `matchQuickCommand` vs pure `resolveQuickCommand` | 10,000 | LCG `0x9e3779b9`；空白/全角/中文标点/大小写/共享前缀/`#N`/BP 范围/@/空/长参数 | **0 mismatch** |
| bridge：真实 `callLocalBot` 对合成 server（事件构造 + 回复提取 + ACK + settle） | 10,000 | LCG `0x51f15e01`；6 actions、4 echo 形态、string/array/missing、6 段类型、malformed/empty/无关帧 | **0 violation**（2048 resolve / 7952 no-reply，0 timeout，0 echo mismatch） |
| binding injection：真实 `matchQuickCommand`+`handleQuickCommand` 捕获注入事件 | 3,000 | LCG `0x6d2b79f5`；39 个文本 × 6 绑定 × 2 atTargets | **0 violation**（1401 次桥接尝试，命令/身份/形态全对） |

- Minimized fuzz failures：**无**（前两轮 harness mirror 的“violations”是测试镜像未建模 at-target 绑定与 yumu 随机 self-id；修正后 0）。

## 5. Phase E — 回退图（详见 fallback graph JSON）

20 张图，三种形态：

1. **recent 双桥形态**（kanon:recent、yumu:recent）：桥 #1 失败/空 → 内部再次解析玩家 + `loadInternalOsuUser`（getUser HTTP）→ **桥 #2 同 bot 同目标 60s** → 失败后 recent HTTP + enrich + render。lazybot:recent 的桥 #2 会改走 **yumu**（executor `botId==='kanon'?'kanon':'yumu'`）。
2. **内部能力形态**（bp/bplist/info/card/pplus）：桥 #1 → getUser → domain fetch → render/text。
3. **LLM fallthrough 形态**（yumu pm/etx/rating、kanon update）：桥 #1 失败/空 → `handled:false` 回 LLM 管线；无 query_osu 确定性重试。

重复外部工作（8 项，分类）：

| ID | 分类 |
|---|---|
| DUP_BRIDGE_FALLBACK（recent 双桥，且 Kanon dedup 会让桥#2 在超时场景再次静默 60s） | COMPATIBILITY_LEGACY |
| DUP_SHADOW_RECENT / DUP_SHADOW_BP / DUP_SHADOW_PPLUS / DUP_SHADOW_PROFILE | REQUIRED |
| DUP_PLAYER_RESOLUTION（router 注入解析 + executor 再次解析/getUser） | ACCIDENTAL |
| DUP_THIRD_RECENT_FETCH（双桥失败后再 recent HTTP） | ACCIDENTAL |
| DUP_COMMAND_LOG_AND_CONTEXT_WRITES | REQUIRED |

## 6. Phase F — 超时/静默矩阵（详见 matrix JSON）

- kanon/yumu/hydrant 快速命令桥超时 **60s**；lazybot **30s**；executor 桥 #2 恒 **60s**。
- open-but-silent / action-only / malformed → **烧满 timeout**；close-without-reply → 快速失败。
- 理论最坏可见延迟（Wuxin 侧 HTTP 上限：getUser≤30s、recent≤15s、attributes≤47.4s、pplus≤10s；render 无上限）：
  - kanon/yumu recent 双失败链：`60 + 30 + 60 + 15 + 47.4 + render` ≈ **212.4s + render**
  - 同链 context-ready（shadow 再来 getUser+recent）：≈ **257.4s + render**
  - hydrant `~` 失败链：`60 + 30` ≈ 90s；lazybot `/plus`：`30 + 30 + 10` ≈ 70s
- **超过 30s / 60s / 90s / 120s 的路径全部存在**：30s（任何一次静默桥超时）、60s（任何一次静默桥超时）、90s（hydrant 链）、120s（kanon/yumu recent 双桥链，可达 212s+）。

## 7. Phase G — 观察一致性（详见 matrix JSON）

- 38 个 active 命令逐个分类；16 个 bridged image-capable 命令走 `recordShadow` 火忘异步 shadow。
- 关键发现：VISIBLE_CONTEXT_RACE（16/20 bridged）、shadow 可观察到比面板更新的数据、help/ping/dice/bind/unbind 完全无 quick context（quick 路径在 bot.ts 记录历史前返回）、失败回复被当作成功 context 记录（`查询失败：...`）、pm/etx/rating/update 的 image-only context 是泛化文本。

## 8. Phase H — 本轮 live 调用（2 次，已用 2/3 配额）

| 时间 | 场景 | 原因 | 结果 |
|---|---|---|---|
| 2026-08-16 00:48:47Z | yumu `!r [SHK]Wuxin` ×2，同 sender `900000099`/group `770099`，间隔 150ms | 验证 yumu 同秒 duplicate filter（QB-05） | 两次都成功（9.69s / 10.54s，各 1 图）；yumu 日志显示两次连接时间 00:48:47.979 与 00:48:48.121 跨秒，`time` 字段不同，未触发同秒过滤——与谓词一致但未在同秒命中。配额限制不再重试；QB-05 保持 STRONG |

- 其余 bot 行为引用既有证据：V01（yumu 8×!r + preflight ping）、V01_1（kanon 成功样本 + 碰撞复现 + direct probe）。

## 9. Phase I — 资源/定时器审计（详见 matrix JSON）

- Wuxin 侧：24 fixtures 全部 settle-once、socket 关闭、Timeout 句柄 delta=0、无 unhandled rejection。
- **`data/bot-bridge` 无清理**：实测 279 文件 / 112,318,262 bytes 累积。
- 目标侧：kanon 无超时 ACK 等待 + 未锁 Clients 迭代；yumu 无上限 Bot registry；lazybot 上游 HTTP 无超时；hydrant 每连接实例随断开释放（无跨调用泄漏）。
- recordShadow 火忘任务可越过 route 生命周期（V01 已记录，语义未改）。

## 10. Phase J — 风险排序（Top 10，详见 matrix JSON）

| ID | Severity / Confidence | 标题 |
|---|---|---|
| QB-01 | S1 / CONFIRMED | Kanon 自消息身份碰撞静默丢弃 → 60s 零帧超时 |
| QB-02 | S1 / STRONG | Kanon dedup 锁使超时后的桥 #2 再次静默 60s（120s 链） |
| QB-03 | S1 / CONFIRMED | 所有桥接命令 open-but-silent 时烧满 30/60s 且无下游执行证据 |
| QB-04 | S2 / CONFIRMED | timeout 前 3s 内到达的有效回复被丢弃（fixture-14） |
| QB-05 | S2 / STRONG | yumu 同秒 (time,group,user) 重复过滤可静默丢弃第二次快速调用 |
| QB-06 | S2 / STRONG | yumu pending prompt/lock 可吞掉注入命令 |
| QB-07 | S2 / CONFIRMED | recent 双桥 + 第三次 recent fetch（重复外部工作） |
| QB-08 | S2 / CONFIRMED | VISIBLE_CONTEXT_RACE + shadow 可观察到新数据 |
| QB-09 | S2 / CONFIRMED | help/ping/dice/bind 回复不进入对话上下文 |
| QB-10 | S2 / STRONG | hydrant ACK data:null 会触发 Puppeteer 截图回退（当前 ACK 不会触发） |

全部 S1：QB-01、QB-02、QB-03。

## 11. Verification

- `npm run check` ✅ PASS（typecheck/build/sanity/security）
- `node --import tsx tools/quick-router-verify.mjs` ✅ 121/121
- `node --import tsx tools/bot-harness-verify.mjs` ✅ PASS
- `node --import tsx tools/queue-verify.mjs` ✅ PASS
- `node --import tsx tools/onebot-verify.mjs` ✅ PASS
- `node --import tsx tools/quick-bridge-reliability-verify.mjs` ✅ **129/129**
- `npm run verify-all` ✅ **74/75 passed (143.1s)**；唯一失败 `reasoning-wire-verify.mjs`，单独复跑确认签名：`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94` + exit `3221226505`（与已登记基线一致，非新增）
- `git diff --check` ✅ 干净

## 12. Files added/modified（本审计）

- 新增 `tools/quick-bridge-reliability-verify.mjs`（离线回归守卫）
- 新增 `docs/QUICK_BRIDGE_ALIAS_COLLISIONS_V01.json`
- 新增 `docs/QUICK_BRIDGE_FALLBACK_GRAPH_V01.json`
- 新增 `docs/QUICK_BRIDGE_RELIABILITY_MATRIX_V01.json`
- 新增 `docs/QUICK_BRIDGE_RELIABILITY_AUDIT_V01.md`
- 修改 `server/bots/localBridge.ts`：仅新增两处默认关闭的审计覆盖（`BRIDGE_OUTPUT_DIR`、`BRIDGE_URL_<BOT>`，未设置时行为与原来逐字一致；V01_1 的 timeline 标记保留）
- 临时 fuzz/回放/绑定脚本在 `G:\My pack\Agent Work\codex_work\tmp\`，未进仓库

## 13. Explicit confirmation

- No optimization was implemented（未改身份/超时/路由/fallback/观察/队列/生命周期/LLM/cache）。
- Nothing committed. Nothing pushed.
