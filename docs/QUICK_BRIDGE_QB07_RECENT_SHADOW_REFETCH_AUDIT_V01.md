# QUICK_BRIDGE_QB07_RECENT_SHADOW_REFETCH — 审计与设计结论

- 阶段：QB-07 调查 / 量化 / 设计（**未改生产行为**）
- 最终分类：**DESIGN_REQUIRED**
  - 子分类：**CONFIRMED_REDUNDANT_WORK**（image-only bridge 成功后确有 observer shadow refetch）
  - 当前必要性：**CURRENT_ARCHITECTURE_REQUIRED**（在当前 bridge 只回 rendered output 的协议下，该 refetch 是保留 follow-up 语义的唯一途径）
- 生产修改：**无**。无 commit，无 push。

---

## 1. 精确 call graph（源码位置 + 实际控制流）

### 1a. Kanon recent 正常成功
```
matchQuickCommand(!re) -> handleQuickCommandInner
 -> bridge callLocalBot('kanon','!re <user>', group 770099)      quickRouter.ts:543-632
 -> reply.text 非空 -> sendMessage(text+image)                    quickRouter.ts:637-645
 -> record(`[kanon] ${bridgeText}`, reply.images)                 quickRouter.ts:647-649
 -> 无 shadow fetch（文本直接进 context）
```

### 1b. Yumu recent 正常成功（image-only）
```
matchQuickCommand(!r) -> handleQuickCommandInner
 -> bridge callLocalBot('yumu','!r <user>', group 770099)        quickRouter.ts:632
 -> reply.text 为空 / images 非空 -> sendMessage(image)           quickRouter.ts:637-645
 -> bridgeText 为空 -> recordShadow('recent', bridgeUser, reply.images, bpSelection)
    void IIFE -> buildQuickShadowSummary                          quickRouter.ts:495-513, 650-661
      -> getUser(username)  + getUserRecentScores(user.id,'osu',1) quickMemory.ts:108-128
      -> formatInternalScoreLine -> recordQuickContext(summary, images)
 -> 这就是 DUP_SHADOW_RECENT 的实际调用点与触发条件：
    桥成功、且桥只回图片、且 def.capability/shadowUser 存在。
```

### 1c. LazyBot → Yumu recent fallback
```
SLASH lazybot recent -> quickRouter bridge lazybot 失败
 -> def.capability='recent' -> executeInternalBotCommand('lazybot','recent')
 -> executor case 'recent': bridgeBot = 'yumu'（cross-target 保留）
    P0_2 marker 是 'lazybot' ≠ 'yumu'，所以允许跨目标桥            executor.ts:1723-1762
 -> yumu image-only 成功 -> executor 返回
    { content: '<user> 最近一次 osu! 成绩：', images: [panel] }
 -> quickPayload 发图 -> record(content placeholder, images)
 -> 该路径没有 shadow refetch，但 follow-up context 只有占位文本（既有语义缺口）
```

### 1d. bridge 失败后 executor / Agent fallback
```
quickRouter bridge yumu 失败（bridgeAlreadyAttemptedFor='yumu'）
 -> executeInternalBotCommand('yumu','recent')                    quickRouter.ts:823-836
 -> P0_2：executor 看到 marker == 'yumu' -> 跳过第二次同目标桥     executor.ts:1729-1736
 -> resolveInternalPlayerTargetDetailed(binding id)
 -> loadInternalOsuUser -> getUserById                             executor.ts:1687-1715
 -> getUserRecentScores(user.id,'osu',1)                           executor.ts:1764-1767
 -> enrichScoreStarRatings（NM 无额外请求）
 -> formatInternalScoreLine -> （可选 renderScoreCard）
 -> quickPayload(result) -> record(content, images)                quickRouter.ts:848-861
 -> REQUIRED_FALLBACK：1 次语义 recent fetch；无 shadow。
```

### 1e. image reply / text reply
- 文本路径（Kanon 文本、内部 fallback 文本）：observer 复用已产生的文本，**不再 fetch**。
- 图片-only 路径（Yumu panel、其它 image-only bridge）：observer 无法从 rendered output 提取事实 → shadow refetch。

### 1f. quick reply 完成后的 observer/context shadow work
- `recordShadow` 是 fire-and-forget void IIFE（quickRouter.ts:501-512），不阻塞 `handleQuickCommand` 返回。
- `recordQuickContext` 把 user 消息 + assistant 摘要写入 `db.messages`（`inContext: true`），quickMemory.ts:32-90。
- 后续自然语言 turn 由 `recentGroupMessages`（prompt.ts:185-189，filter `inContext !== false`）读到该摘要 → “第一把怎么回事”依赖这里。

## 2. 量化真实重复（verifier 实测，非推断）

| 路径 | primary | observer/fallback | 分类 | 语义 recent fetch 次数 |
|---|---|---|---|---|
| Yumu image-only 成功 | 目标侧 recent render（Wuxin 不可见/不可复用） | Wuxin 侧 getUser + getUserRecentScores | **OBSERVATION_SHADOW_REFETCH** | 2（目标 1 + Wuxin 1） |
| Kanon 文本成功 | 目标侧 render（文本+图） | 复用 bridge text；Wuxin 侧 0 fetch | 无重复 | 1 |
| bridge 失败 → executor | bridge 尝试失败 | getUserById + recent（+NM attributes=0） | **REQUIRED_FALLBACK** | 1 |
| LazyBot→Yumu | lazybot 尝试 + yumu 尝试 | 无 Wuxin recent fetch | **REQUIRED_FALLBACK（跨目标，不计 duplicate）** | 目标侧 1 |
| Agent / query_osu recent | 内部 executor | 工具结果直接进 LLM context | 独立 fetch | 1 |

- P0_2 已经消掉的：bridge 失败后 executor 对**同一 target 的第二次 bridge**（verifier 断言连接数=1）。
- QB-07 剩余“重复”：**只在 image-only bridge 成功路径**存在 shadow refetch（Wuxin 侧 1 次语义 recent + 1 次 user resolution）。
- text 与 image 路径**不同**：text 复用，image-only 才 refetch。
- cross-target fallback **不计 duplicate**（verifier 单列 lazy=1 / yumu=1）。

## 3. authoritative result 结论

- **bridge 成功时 Wuxin 实际只拥有 `LocalBotReply { text, images, frames }`——rendered output**。verifier shape phase 实测 keys 就是这三项；无 domain 对象跨越桥。
- **executor 内部路径有 structured score**（`rawScores` + enrich 后的 score），但 `InternalBotCommandResult { content, images?, final? }` 在格式化文本后**丢弃**了该对象；不过该路径本来就不 refetch，所以不影响 QB-07。
- image path：生成图片前的数据在目标 bot 内部，Wuxin 拿不到。
- quickRouter 交给 observer 的只有 `capability/username/images/bpSelection`（source-verified）；**没有任何 domainResult handoff**。
- observer 需要：username + 一条 recent 文本摘要（当前实现）；更丰富的 follow-up 需要 structured score，但当前上下文摘要文本已够回答“第一把”。
- **没有 rendered-text reparsing**：quickMemory 从不读 `reply.text`（verifier 断言）。
- 结论：**当前 bridge 协议从根上只返回 rendered text/image**。要在 image-only 成功路径实现“fetch 一次、renderer 与 observer 共用同一 authoritative result”，必须让 renderer 消费 Wuxin 侧 structured fetch（改变可见渲染来源），或扩展 bridge 协议回传 domain 数据（目标侧/协议变更）。→ **DESIGN_REQUIRED**，不硬改。

## 4. 设计选项（仅设计）

- **D1 扩展 bridge 协议**：`LocalBotReply` 增加可选 `domainResult/observationPayload`（目标能提供时）——满足理想，但当前四个目标端都不经 OneBot WS 回传 domain 数据，属于目标侧协议扩展。
- **D2 单一 Wuxin authoritative fetch + 内部 renderer**：一次 recent fetch 同时喂 renderer 与 observer；改变可见面板来源（丢失原 bot 渲染），需产品决策。
- **D3 延迟观察**：image-only 成功只记录 `username+capability` 占位，follow-up turn 由 LLM 调 `query_osu recent`（INDEPENDENT_FOLLOWUP_FETCH）。消除 post-success refetch，代价是即时 context 细节减少、follow-up 增加一次工具 fetch。最小，但仍是语义权衡。
- **D4 request-scoped `QuickExecutionResult { reply, domainResult?, observationPayload? }`**：正确的未来契约；当前只有 executor 内部路径能填充，而该路径已无 refetch，所以单靠它无法解决 image-only bridge 路径。

**建议**：维持现状；授权修复时优先 D1（协议扩展）或 D2（渲染源统一），D3 作为低成本降级方案；不因“容易实现”擅自改动。

## 5. QB-08 观察记录

- **QB-08 REMAINS**。
- verifier yumu phase：shadow recent 人为延迟 500ms，`handleQuickCommand` 在 ~110ms 已返回并完成 visible send；context-ready 在 shadow 完成后才出现。即 visible 先于 context-ready，与本轮修改前一致（本轮零生产修改）。
- 不能写 `ALSO_RESOLVED_BY_QB07`（无该证据）。

## 6. 必做 verifier 覆盖（全部通过）

`tools/quick-bridge-qb07-shadow-refetch-verify.mjs`，7 个 phase / **39 项断言全过**：

- A fetch-count：Yumu image-only = shadow `getUser×1 + recent×1`，且桥连接恒 1；Kanon 文本 = 0 Wuxin fetch；内部 fallback = recent×1 且 P0_2 第二桥为 0；lazybot→yumu = 必要跨目标 fallback 单列。
- B follow-up context：shadow 摘要确实写入 db.messages assistant（“第一把”信息仍在），证明不是靠删除记忆获得 1-fetch（我们也没有获得 1-fetch）。
- C quick latency：route 不等待 observer（106ms vs 500ms shadow delay）。
- D failure isolation：shadow API 500 → visible 成功、单桥、fallback generic record、无 unhandled rejection。
- E concurrency：两用户 + 同用户连续两次，摘要不串线（2 Alpha / 1 Beta）。
- F fallback：LazyBot→Yumu 保留（lazy=1, yumu=1），成功 fallback 后无 shadow refetch（记录占位文本）。
- shape：桥回包仅 rendered；shadow 无 domain handoff；无 rendered-text reparsing。

## 7. 回归

- `git diff --check`：clean
- `npm run check`：PASS（typecheck + vite build + sanity + security）
- P0_2 verifier：23/23
- quick-router verifier：121/121
- bot-harness verifier：PASS
- QB-07 verifier：7/7 phases（39 checks）
- verify-all 未重跑：本阶段无生产改动，按任务要求只跑必要项。

## 8. 文件与 git 状态

- 新增：`docs/QUICK_BRIDGE_QB07_RECENT_SHADOW_REFETCH_AUDIT_V01.md`、`docs/QUICK_BRIDGE_QB07_RECENT_SHADOW_REFETCH_MATRIX_V01.json`、`tools/quick-bridge-qb07-shadow-refetch-verify.mjs`
- 生产修改文件：**无**
- 无 commit，无 push；HEAD 仍为 `713ea7e…`（上一阶段已推送的 Phase A commit）。
- 未跟踪项仍为：`.private/`、`REPOSITORY_HYGIENE_AUDIT.md`、`recommend-semantic-consistency-audit.md`、`trunk-source-boundary-audit.md`，加本阶段三个 QB-07 文件。

## 9. 最终报告要点

1. **QB-07 最终分类**：`DESIGN_REQUIRED`（机制：`CONFIRMED_REDUNDANT_WORK`；当前：`CURRENT_ARCHITECTURE_REQUIRED`）。
2. **修复前精确 fetch graph**：见 §2 表（Yumu image-only 是唯一 shadow refetch 路径；2 次语义 recent，其中 1 次为 observer）。
3. **修复后精确 fetch graph**：本阶段未实现修复，graph 不变；候选 D1/D2 可达 1-fetch，D3 把成本移到 follow-up。
4. **authoritative result**：桥路径只有 rendered output；内部 executor 有 structured score 但已格式化为文本，且该路径无需 shadow。
5. **renderer/observer 共享**：当前无法共享（桥只回 rendered）；只有 D1/D2 才能实现。
6. **rendered-text reparsing**：不存在，也禁止。
7. **follow-up context**：保持（shadow 摘要仍写入）。
8. **visible latency**：无变化（本轮未改）。
9. **QB-08**：`QB-08 REMAINS`（verifier 证据：visible 先于 context-ready）。
10. **verifier / 回归**：7/7 与 §7。
11. **生产修改文件**：无。
12. **git status**：见 §8。

**报告结束。**
