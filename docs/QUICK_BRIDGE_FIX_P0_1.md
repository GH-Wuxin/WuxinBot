# QUICK_BRIDGE_FIX_P0_1 — KANON_BRIDGE_IDENTITY_COLLISION

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：bug fix（仅 Wuxin 桥接层，未改 Kanon 源码，未改其他 QB 项）
- 相关审计：`docs/QUICK_BRIDGE_RELIABILITY_AUDIT_V01.md` + matrix JSON（QB-01）

## 0. 修复结论与历史归因

- **CONFIRMED FIXED**：已复现的 Kanon 桥接身份碰撞缺陷——合成桥接事件的 `event.user_id` 等于所连 Kanon 客户端的 `X-Self-ID` 时被 Kanon 静默丢弃、Wuxin 零帧等满 60s——在 Wuxin 桥接层消除。
- **NOT CLAIMED**：历史 V01 的 60022.88ms 样本是否同因，**仍未确认**（原始 `event.userId` 未保存）。本修复只针对已复现的缺陷，不重写该历史结论。

## 1. 旧身份模型

`server/bots/localBridge.ts`（修复前）：

```ts
function bridgeSelfId(botId: string): string {
  if (botId === 'yumu') return String(8_800_000_000 + crypto.randomInt(0, 100_000_000));
  return SPIKE_SELF_ID; // env BRIDGE_SELF_ID || '1000000003'
}
```

- kanon（以及 hydrant/lazybot）：进程内**恒定** `1000000003`（或 `BRIDGE_SELF_ID` 覆盖）。
- 同时 `buildEvent` 注入 `user_id = Number(context.userId) || 0`。
- 当 `context.userId === '1000000003'`（或与 `BRIDGE_SELF_ID` 相同）时：`X-Self-ID = event.user_id` → Kanon `Server.cs` 自消息过滤器静默 return → 零帧 → 60s 超时。V01_1 已复现（60036.42ms，Kanon 日志只有连接无消息行）。

## 2. 新身份模型

`server/bots/localBridge.ts`（修复后）：

- **yumu 不变**：每调用随机 `8800000000..8899999999`。
- **hydrant/lazybot 不变**：`BRIDGE_SELF_ID || '1000000003'`。
- **kanon 每调用安全身份**：
  - 默认：从保留池 `7700000000..7799999999`（1 亿个，与 yumu 池不相交）随机取一个**未激活**且 **≠ Number(context.userId)||0** 的 id。
  - 显式 `BRIDGE_SELF_ID` 存在时：若它**不冲突**（≠ 逻辑 sender 且当前无其他激活调用占用）则照旧使用（保留部署显式配置语义）；若冲突，则**日志说明后本调用改用保留池安全身份**，不静默忽略。
  - 分配时登记到进程内 `activeKanonSelfIds`；调用以任意方式 settle（成功/超时/关闭/错误/构造失败）即释放，供后续调用复用。
- `buildEvent` 不变：`event.self_id = Number(selfId)`、`event.user_id = Number(context.userId)||0`、`sender.user_id` 同 `user_id`、kanon `message` 恒为 array。逻辑 sender 完整保留。

## 3. 不变量（新增）

```text
KANON_BRIDGE_INVARIANT:
  ∀ kanon call C, let h = C.X-Self-ID, u = C.event.user_id:
    h ≠ String(u)                       // 修复 QB-01：不可能自消息过滤
  ∧ h ∉ activeKanonSelfIds_other(C)     // 并发调用之间身份唯一
  ∧ C.event.self_id = Number(h)
  ∧ C.event.user_id = Number(context.userId) || 0   // 逻辑 sender 不变
```

释放时机：`callLocalBot` 的 `finish()`（所有 settle 路径）与同步 `new WebSocket` 抛错路径。

## 4. 并发行为

- 默认（无 env）：同一 `localBridge` 模块实例内的并发 kanon 调用分配互不相同的池内 id；6 路并发离线回归验证 6 个 id 全唯一、全不与各自 sender 冲突、事件字段全正确。
- 显式 `BRIDGE_SELF_ID` 并发：第一调用占用该 id，后续并发调用日志说明后改用池内安全 id，不会两个调用共用同一 identity。
- 进程多实例（测试/多进程部署）各自维护 active set；随机池 1e8 范围跨进程碰撞概率 1e-8/对，且 Kanon 支持同 selfID 多连接共存，唯一风险仍是 sender 等于他实例 identity 的自过滤——被本调用“≠ sender”不变量覆盖。

## 5. ENV OVERRIDE 行为

- `BRIDGE_SELF_ID` 对 hydrant/lazybot 完全不变。
- 对 kanon：
  - 安全值 → 原样使用（`p01-env-override-normal` 断言 header=424242）。
  - 与逻辑 sender 相同或已被激活调用占用 → **不抛错、不静默**：`console.error` 明确记录冲突，本调用改用保留池安全 id（`p01-env-override-colliding` 断言 header≠1000000003 且事件 user_id 仍为 1000000003）。
- 这样显式部署配置在可安全使用的场景下保持原语义；冲突时优先安全。

## 6. 设计检查结论（实现前代码证据）

- A/B：旧选择见 §1；进程/调用级均为常量（env 控制）。
- C：Kanon **不要求**跨调用稳定 self id——`X-Self-ID` 仅存入 per-connection Socket；回包按客户端 Guid 路由；命令行为用 `elevated`（config），与 self id 无关。
- D：Kanon 接受任意非 null `X-Self-ID` 字符串；`7.7e9` 为 int64 内 JSON number，Kanon `CQEventBase.SelfId long?` 与 `X-Self-ID string` 均兼容。
- E：Kanon 支持同时多个不同 self id 连接（客户端字典按 Guid 键）。
- F：新方案 `h ≠ u` 显式保证；active set 防 Wuxin 并发复用；与 yumu 池不相交；与真实 NapCat 连接身份不同的 sender 不受影响（若 sender 恰好等于真实连接 selfID，Kanon 仍会正确过滤——那是 Kanon 自消息语义，不在本缺陷范围）。
- G：`self_id` 数值 int64 安全；JSON 序列化为 number；Kanon 比较用 `GetRawText()`（number 与同值 string header 相等），本实现比较 Number 相等后取字符串池 id，满足。

## 7. 回归覆盖（`tools/quick-bridge-reliability-verify.mjs`，166 断言全绿）

1. `p01-collision-regression`：sender=`1000000003`、命令 `!re [SHK]Wuxin` → header∈池且 ≠1000000003，`event.user_id/sender.user_id` 保持 1000000003，`event.self_id=header`，命令原文正确，回复 `collision fixed`，ACK echo 正确。
2. `p01-normal-kanon-call`：普通 sender 900000099 行为不变。
3. `p01-concurrent-kanon-calls`：共享模块实例 6 路并发，6 个 header 全唯一、池内、≠各自 sender、sender 保留、全部有回复。
4. `p01-env-override-normal` / `p01-env-override-colliding`：见 §5。
5. 原有 24 个 reply-protocol fixtures 继续通过：image-only `send_msg`、echo ACK、text reply、timeout、close/error、settle-once、timer delta=0。
6. 原有 f01 断言已从“header==1000000003”更新为“kanon 安全池 + 不等于 sender”。

## 8. Live 验证（2026-08-16，Kanon 端点可用，各 1 次）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 碰撞样本（`handleQuickCommand` E2E，sender=1000000003，`!re [SHK]Wuxin`） | 60036.42ms，0 帧，60s 超时，fallback `recent_error` | **6193.48ms**，bridge:kanon 成功，1 个 314,921B image 帧，可见 send 6183.45ms |
| 正常控制（sender=900000099，同命令） | 8570.72ms（V01_1 正常样本） | **5376.57ms**，bridge:kanon 成功，1 image |

Kanon `log-20260816.log` 确认两条消息均收到：
`10:54:54 ← 收到OneBot用户 1000000003 的消息 !re [SHK]Wuxin`
`10:55:08 ← 收到OneBot用户 900000099 的消息 !re [SHK]Wuxin`
（修复前同 sender 1000000003 只记录连接开/关、无消息行。）

WS 打开、Kanon 收到消息、至少一个回复帧、无 60s 零帧超时——全部满足。

## 9. 未触碰项

- QB-02（kanon dedup 第二次桥接）、QB-03（open-but-silent 全超时）、QB-04（settle vs timeout）**未修改**；本次实现不依赖它们。
- 未改 Kanon 源码、路由优先级、别名、fallback 顺序、超时、cache、队列、生命周期、LLM、观察语义。
- 未做通用四 bot 身份框架；hydrant/lazybot 行为逐字不变。

## 10. Files changed

- `server/bots/localBridge.ts`：新增 kanon 安全身份分配（`KANON_SELF_ID_START/SIZE`、`activeKanonSelfIds`、新 `bridgeSelfId(botId, requestedUserId)`、释放逻辑、注释）。
- `tools/quick-bridge-reliability-verify.mjs`：f01 断言更新 + 5 个 P0_1 回归 fixture + 6 路并发回归。
- `docs/QUICK_BRIDGE_FIX_P0_1.md`：本文件。

未 commit，未 push。
