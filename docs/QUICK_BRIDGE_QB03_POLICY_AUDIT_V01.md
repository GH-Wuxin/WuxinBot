# QUICK_BRIDGE_QB03_POLICY_AUDIT_V01

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：POLICY / EVIDENCE 阶段。**未实现任何 fail-fast/watchdog/重试/协议变更。**
- 证据基线：V01 / V01_1 / QUICK_BRIDGE_RELIABILITY_AUDIT_V01 / P0_1 / P0_2 / P0_3 / P0_3_1
- 产物：
  - `docs/QUICK_BRIDGE_QB03_STATE_MATRIX_V01.json`
  - `docs/QUICK_BRIDGE_QB03_POLICY_MATRIX_V01.json`
  - 本文件
  - `tools/quick-bridge-qb03-policy-verify.mjs`（离线策略评估，33 断言）

## 0. 结论

**当前证据不支持任何 Wuxin-only 的早失败（early-fail）策略安全上线。**

- Wuxin 能观测到的状态只有：连接建立、open、事件已发送、入站帧类别、有效回复、close/error、超时。
- 目标侧“是否收到事件 / 是否开始执行 / 后端是否挂起 / 后端是否完成”全部是 **TARGET_ONLY**，Wuxin 在没有新协议的情况下不可观测。
- 因此“无帧 N 秒”本质上是在用**最弱证据**（时间）对**最强的慢路径**（合法慢命令）做早失败：
  - Yumu 实测成功可见延迟 p95 ≈ **35s**（V01，n=8）；
  - Hydrant 上游 osu API 默认 ~100s、Puppeteer 截图回退无显式超时；
  - LazyBot 上游 HTTP 无超时（可无限合法静默）；
  - Kanon 上游 Flurl 默认 ~100s（n=4 成功首帧 3.16–5.54s，样本太小且结构性慢路径存在）。
- 任何“>阈值成功即证伪”的硬看门狗，对 5s/10s/15s/30s 都能被已知或结构上可能的合法成功证伪。

**推荐策略：`KEEP_CURRENT_TIMEOUT_FOR_NOW`（现阶段不要修 QB-03）。**
最安全的长线方向是 **最小目标侧 receipt/progress 协议**（仅设计，见 §8），先让 Wuxin 能区分
“事件从未进入目标”与“目标已接受但执行慢”。

## 1. Wuxin 可观测 vs 目标侧状态

### Wuxin 直接可观测（S 状态机）

`S0 CONNECTING` → `S1 OPEN_NOT_SENT` → `S2 SENT_ZERO_FRAMES` → `S3 SENT_ACK_ONLY` → `S4 SENT_UNRELATED_FRAMES` → `S9 VALID_REPLY_RECEIVED` → `S10 CLOSED_NO_REPLY` → `S11 ERROR_NO_REPLY`

- `S3/S4` 由 Wuxin 帧分类得出；当前桥接命令中，ACK-only/unrelated-only 状态**不携带命令进度语义**（详见 §6）。
- `S10/S11` 是强失败证据（close/error 无内容 → 立刻 reject，已经如此，不需要新策略）。

### 仅目标侧可见（TARGET_ONLY / NOT_AVAILABLE_TO_WUXIN）

`S5 TARGET_RECEIPT_CONFIRMED_NO_REPLY`、`S6 TARGET_EXECUTION_STARTED_NO_REPLY`、`S7 TARGET_BACKEND_PENDING`、`S8 TARGET_BACKEND_FINISHED_NO_REPLY`，以及各 bot 日志中的收到/分发/HTTP 起点/HTTP 返回。

**这些状态今天 Wuxin 拿不到；任何基于它们的策略都等于协议变更，本阶段不实现。**

## 2. 各 bot 静默原因（详见 state matrix JSON）

- **Kanon**：身份碰撞（P0_1 已修）、same-sender/same-command dedup、group config、命令静默路径（!search 空参/!su 非 admin）、上游 osu/IAM/Kagami 慢、回复 ACK 失败。
- **Yumu**：self-bot 过滤、同秒 (time,group,sender) 5s 重复过滤、group config / stale time / idempotency、pending prompt/waiter 吞消息、无 service 匹配/黑名单/静默异常、合法慢执行（osu 30s×重试 + render 20s）、Shiro 出站 limiter / ACK 超时。
- **Hydrant**：group config、非法 mode / 未绑定 / owner-only 静默、ApiAccessException、合法慢上游（osu 100s + 截图回退）。
- **LazyBot**：group config、null/stale 字段、非 `/` 前缀、未知命令、in-flight dedup、出站 limiter、无超时上游 HTTP。

## 3. 延迟证据（只列实际存在的，不虚构分布）

| family | 样本 | FIRST_VALID_FRAME | VISIBLE | FULL_SETTLE |
|---|---|---|---|---|
| kanon | 成功 n=4（V01_1 direct、V01_1 bridge、P0_1 collision、P0_1 control） | 3160 / 5336 / 5539ms（另一样本未记录首帧） | 5370 / 6183 / 8562ms | 5377 / 6193 / 8571 / 6542ms |
| yumu | V01 bridge-success n=8 | 未直接记录；≈ bridge_response−3000ms settle → p50 ≈ 5986ms、p95 ≈ 32033ms（近似，不能当作精确首帧测量） | p50 8990 / p95 35038 / max 35038ms | p50 8996 / p95 35047 / max 35047ms |
| hydrant | 本审计 live probe n=1 `where [SHK]Wuxin` | **3346.5ms** | **6360ms** | **6360ms** |
| lazybot | 0（部署暂停） | — | — | — |

注：n 很小；唯一有分布的是 Yumu n=8。上述 FIRST_VALID_FRAME 与 VISIBLE/FULL_SETTLE 语义不同，不可互换。

## 4. 简单看门狗证伪（离线 verifier 33/33 + 上述证据）

| 规则 | 判定 | 理由 |
|---|---|---|
| 无帧 5s → fail | **UNSAFE** | Yumu p95 ~35s；Hydrant/LazyBot 结构性慢路径；任何 >5s 合法成功即证伪 |
| 无帧 10s → fail | **UNSAFE** | 同上 |
| 无帧 15s → fail | **UNSAFE** | 同上（Yumu p50 ≈ 9s 已被打平，p95 必杀） |
| 无帧 30s → fail | **UNSAFE** | 贴着 Yumu 实测 p95；Hydrant 100s 上游、LazyBot 无界上游是直接反例 |
| 保持现状 | **SAFE** | 保守但无假阴性；病理 30/60s 仍存在（QB-03 未解决） |

离线加速矩阵（10x 缩放）证明：delayed-5s/10s/20s/30s/just-before-timeout 全部在现行 P0_3/P0_3_1 语义下正常 resolve；对应简单看门狗会分别杀死它们（阈值边界 `<=` 不杀）。

## 5. 其他候选策略判定

- **P5 ACK-only X 秒**：UNSAFE——四个 bot 的桥接命令**没有 receipt-ACK**；`send_msg`/`send_group_msg` 本身就是完成信号；ACK-only 只会出现在回归/协议错误场景，不能证明执行卡住。
- **P6 unrelated-frame-only**：UNSAFE——无关帧不带 receipt/execution 语义。
- **P7 health probe**：CONDITIONALLY_SAFE 仅作**调用前预检**（probe 成功 ≠ 命令执行；且桥接本身已证明 transport）。不是 in-flight QB-03 策略。
- **P12 adaptive timeout**：INSUFFICIENT_EVIDENCE——每 family/命令的样本太小。
- **P13 circuit breaker**：CONDITIONALLY_SAFE 但缺少可靠恢复信号，现阶段不需要。
- **P14 immediate retry**：UNSAFE——重复外部工作；Kanon dedup 会让同命令重试静默无用（P0_2 刚移除同请求重复桥）。
- **P1/P2/P3/P4 固定/分类 no-frame timeout**：UNSAFE / INSUFFICIENT_EVIDENCE（见上）。

## 6. ACK/帧语义（不混淆）

| 信号 | 含义 | 可用性 |
|---|---|---|
| WS open / any action frame | TRANSPORT_LIVENESS | Wuxin |
| 目标日志“收到消息” | COMMAND_RECEIPT | TARGET_ONLY |
| 目标内部 dispatch/HTTP 起点 | COMMAND_EXECUTION / BACKEND_PENDING | TARGET_ONLY |
| `send_msg` / `send_group_msg` | COMMAND_COMPLETION（不是 ACK） | Wuxin |
| Wuxin 回 ACK | 传输层响应，仅解除目标发送阻塞 | Wuxin |

四个 bot 均无心跳/meta 主动帧；均无“收到即回执”。

## 7. 失败证据层级（强→弱）

1. **VERY_STRONG**：socket error；close-without-content；显式目标负响应（当前不存在）。
2. **STRONG**：已发送事件后目标主动 close；已知目标过滤器 + 可关联证据（如 Kanon 身份碰撞，P0_1 已修）。
3. **MEDIUM**：preflight health probe 失败；transport 正常但目标日志确认从未收到（TARGET_ONLY，Wuxin 拿不到）。
4. **WEAK**：无帧 N 秒。
5. **VERY_WEAK**：“该命令通常更快”。

## 8. 目标侧最小协议提案（仅设计，不修改任何 bot）

**提议：向后兼容的 receipt-ACK。**

- 请求：Wuxin 在合成 OneBot 事件里增加可选字段 `echo`/`request_id`（Wuxin 生成、默认关闭）。
- 响应：
  - 目标解析成功、决定处理 → 立即发 `send_msg`？**否**——用最小动作 `action:"bridge_received", echo:<request_id>, params:{accepted:true}`（或复用 `get_status` 风格自定义 action）。
  - 目标判定忽略/拒绝 → `{accepted:false, reason:"dedup|group_disabled|self_message|...}`。
- 执行完成仍走现有 `send_msg` / `send_group_msg`（兼容旧版）。
- 超时语义：receipt 只在区分 “事件没进目标” vs “目标接受但慢”；**receipt 不证明最终完成**，因此 Wuxin 只有在 `accepted:false` 时才可以提前失败；`accepted:true` 后仍保持现有 30/60s 上限。
- 兼容：老目标无 `request_id` 处理时忽略该字段，行为与今天完全一致；Wuxin 默认不带 `request_id`，可配置开启。
- 优先级：Kanon > Yumu > Hydrant > LazyBot（部署暂停）。

## 9. 推荐

- **当前策略：`KEEP_CURRENT_TIMEOUT_FOR_NOW`。**
- 先修的前提条件：目标 receipt-ACK 协议落地并产生 `accepted:false` 证据；或者某一 family 积累足够大的成功延迟样本证明一个具体阈值安全。
- 在此之前，不建议任何生产 early-fail。

## 10. Live 调用

- Hydrant `where [SHK]Wuxin` ×1（虚拟群 770099、合成 sender 900000099、无 Tencent 流量）：成功 6360ms、首帧 3346.5ms、1 text 帧。
- 第一次无 `BOTS_ROOT` 的 Hydrant 调用 401 @ 942ms（鉴权配置缺失，fast-fail；非静默）。
- Kanon/Yumu 未新增调用（V01/V01_1/P0_1 证据已足够）；LazyBot 0（暂停）。

## 11. Verification（本阶段无生产改动）

- `tools/quick-bridge-qb03-policy-verify.mjs`：**33 passed, 0 failed**（15 个合成场景 + 看门狗评估断言）。
- 其余全量桥回归与 verify-all：见执行记录（预期仅 Windows/Node24 `UV_HANDLE_CLOSING` teardown 波动）。

## 12. Explicit confirmation

No production behavior change was made in this phase. No commit, no push.
