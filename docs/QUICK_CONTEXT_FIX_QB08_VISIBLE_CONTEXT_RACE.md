# QUICK_CONTEXT_FIX_QB08_VISIBLE_CONTEXT_RACE — 实现与验证

- 阶段：QB-08 调查 + 局部修复（**已改 Wuxin 本地生产代码**）
- 最终分类：**CONFIRMED_LOCAL_RACE**（已局部修复）
- 修改范围：`server/bot.ts`、`server/bot/quickRouter.ts`、`server/bot/quickMemory.ts`、新增 `server/bot/quickContext.ts`
- 未修改 target bot / bridge protocol；visible quick latency 不等待 shadow；未实现 QB-07 D1/D2/D3
- 无 commit，无 push。

## 1. 最短实际 failure path（修复前）

```
T0 user !re
T1 visible quick reply sent（handleQuickCommand 返回）
T2 user "第一把怎么回事"
T3 shadow observation ready（buildQuickShadowSummary + recordQuickContext 完成）
T1 < T2 < T3
```
修复前第二 turn 在 T2 构建 LLM context 时，db.messages 里只有 T0 的 user 记录，没有 assistant 摘要 → follow-up 看不到“第一把”的事实。shadow 成功时行为是 **MISSING_CONTEXT**（临时缺失，后续补写）；shadow 失败时是 **FALLBACK_TO_GENERIC_LLM**（只有“面板见图片”占位）。

## 2. 修复设计（B+C+D 混合）

- **visible 不等待**：quickRouter 在 sendMessage 之后立即（同步）写 **user 消息 + assistant placeholder**（带 `pendingQuickId`），占住对话槽位；然后 fire-and-forget 注册 pending promise。
- **in-place hydration**：shadow 完成后 `hydrateQuickContextPending` 只更新同一条 assistant 记录，**不追加、不覆盖、不重排**。
- **next-turn bounded drain**：普通 conversational turn 在 `readDb()`/`buildPrompt()` 之前调用 `settlePendingQuickObservations(event)`，只 await **同 group+user** 且**在 turn 开始前已 visible** 的 pending 条目；无 pending 时零开销。
- **bounded wait**：`QUICK_CONTEXT_PENDING_WAIT_MS`，默认 30000ms（证据：shadow 链是两次串行 osuFetch，每次自带 15s timeout；token fetch 无 timeout 是必须设上界的原因）。**该默认值标为需要配置决策**，可用 env 覆盖。

## 3. 同步 key / lifecycle / cleanup / failure

- key：group 消息 `group:<groupId>:<userId>`；private 消息 `private:<userId>`。
- 语义关联：只等“同会话身份、已经 visible、turn 开始前注册”的条目；A 用户不会等 B 用户，群 A 不会等群 B。
- 新 quick operation 永远注册新条目 + 新 placeholder，不覆盖旧条目；两个 quick command 连续时槽位顺序 = visible 顺序。
- lifecycle：注册 → shadow 完成 → hydrate → promise settle → 条目移除。
- cleanup：settle 自删；防御性上限每 key 16 条、全进程 256 条、15 分钟 sweep。
- failure：shadow/API 失败时 hydrate fallback 占位（不追加错误）；promise 恒 settle → follow-up 永不挂死；无 unhandled rejection。
- process restart：placeholder 已持久化在 db（follow-up 至少有通用占位 + 图片）；pending registry 是 process-local，重启后不等待、不 hydration → 残留边界文档化。

## 4. 修复前后 timeline

修复前：
```
T1 visible sent
T2 follow-up reads context  -> 缺 assistant 摘要（MISSING_CONTEXT）
T3 shadow 完成才补写 db（可能排到 follow-up user 消息之后，顺序也错）
```
修复后：
```
T1 visible sent + user/assistant placeholder 槽位 + pending 注册
T2 follow-up 到达 -> settlePendingQuickObservations 等待同 key pending（bounded）
   -> shadow 完成并 hydrate 原槽 -> readDb -> buildPrompt 看到正确摘要
T3 对普通路径无 pending 时 T2 等待 = 0ms
```
verifier 实测（shadow 延迟 600ms）：visible=108ms；followup_wait_ms=619ms；drain 后摘要可见。

## 5. Latency policy

- `quick_visible_latency`：**不变**（verifier race-wait：visible 108ms，shadow 600ms，visible 未等待）。
- `followup_wait_ms`：
  - 无 pending：0ms（verifier）。
  - 已 ready：0ms（verifier）。
  - pending 且 shadow 600ms：619ms（bounded 30s 内）。
  - timeout policy=60ms（env）且 shadow 500ms：follow-up 61ms 返回，background 随后 hydrate。
- 精确默认超时仍需决策（`QUICK_CONTEXT_PENDING_WAIT_MS`，当前默认 30000ms，理由见上）。

## 6. QB-07 是否保持不变

**保持不变。** QB-07 verifier 在本修复后重跑 7/7（39 checks），fetch graph 完全一致：
- Yumu image-only 仍 shadow fetch 1 次 recent + 1 次 user；bridge 连接 1；
- Kanon text 0 Wuxin fetch；
- 内部 fallback 1 次 recent，P0_2 第二桥仍被抑制；
- lazybot→yumu 跨目标 fallback 单列。
- QB-07 分类仍为 DESIGN_REQUIRED；本修复只是让异步 shadow 的结果在 follow-up 前被等待/hydrate，不改变任何 fetch。

## 7. Verifier

`tools/quick-context-qb08-visible-race-verify.mjs`：**8/8 phases**（30 checks）：
- race-wait 7/7：visible 先发、follow-up bounded wait、摘要可见、QB-07 fetch 不变、registry 清空；
- already-ready 2/2：已 ready 零等待；
- shadow-failure 5/5：placeholder fallback、不挂死、无 unhandled；
- ordering 5/5：!r + !bs 连续时槽位顺序保持、各自 hydrate、不覆盖；
- isolation 3/3：不同用户/不同群零等待，同用户等待自己的；
- concurrent-drain 2/2：并发 follow-up 共享同一 shadow，fetch 仍 1 次；
- no-pending-timeout 4/4：普通路径零开销 + 超时上界 + 后台 hydrate；
- static-hook 6/6：hook 位于 buildPrompt 之前、placeholder/hydrate/key/process-local/no-visible-wait 源码断言。

## 8. 回归

- `npm run check`：PASS（typecheck + vite build + sanity + security）
- `git diff --check`：clean
- QB-08 verifier：8/8
- QB-07 verifier：7/7（fetch graph 未变）
- P0_2：23/23
- quick-router：121/121
- bot-harness：PASS

## 9. 生产修改文件

- `server/bot/quickContext.ts`（新增：pending registry + bounded drain）
- `server/bot/quickMemory.ts`（新增 placeholder + in-place hydration，原 record 路径复用同一 helper）
- `server/bot/quickRouter.ts`（recordShadow 改为 placeholder + 注册 + hydrate）
- `server/bot.ts`（conversational turn 在 buildPrompt 前 drain 同 key pending）
- 新增 verifier：`tools/quick-context-qb08-visible-race-verify.mjs`
- 新增 docs：本文件

## 10. git status

HEAD 仍为 `713ea7e…`（已推送）。工作树含上述 4 个生产文件修改（其中 `quickMemory.ts`、`quickRouter.ts` 本身也含此前未提交的 QB-07 审计阶段之前的改动）与新增文件；未 commit、未 push。

**报告结束。**
