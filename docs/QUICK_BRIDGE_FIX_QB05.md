# QUICK_BRIDGE_FIX_QB05 — A′ deterministic safe-slot allocator（已实现）

- 问题：Yumu/Shiro 2.5.3 `group-event-filter` 的 key 为无分隔符拼接 `time + group_id + user_id`，Wuxin 合成事件使用秒级 time，同秒第二次桥调用会被静默丢弃并烧满 60s（QB-05，已实时 CONFIRMED）。
- 修复：仅 yumu 合成事件使用 **13 位毫秒 time 且 `time % 1000 ∈ [0,99]`** 的安全槽；key 第 11 位恒为 `'0'`，与所有合法真实键严格不相交。
- 文件：`server/bots/localBridge.ts`（唯一生产改动）。

## 实现内容

1. 模块级分配器 `export function yumuSafeTimeMs(nowMs: number = Date.now())`：
   - `poolBase = ceil((now+2000)/1000)`；池 = `[poolBase*1000, poolBase*1000+99]`（每秒恰好 100 槽）；
   - 发出 `poolFirst` 或单调水位 `last+1`；`t > poolLast` → `Error('yumu bridge safe-slot pool exhausted (100/s)')`；
   - `t - now > 30000` → `Error('yumu bridge event time drift exceeded')`；
   - 严格单调，进程内绝不复用槽。
2. `callLocalBot` 在 `new WebSocket` **之前**、仅 yumu 分支调用分配器；失败立即 `reject` 并写 timeline（`yumu_safe_slot_alloc_failed`），quickRouter/executor 既有 catch 回退原样消费；无未捕获异常、无桥流量。
3. `buildEvent` 增加可选 `eventTimeMs`；yumu 传入安全槽值，其余 bot 继续使用 `Math.floor(Date.now()/1000)`。`group_id`、顶层 `user_id`、`sender.user_id`、`message`、`raw_message`、`message_id`、`self_id` 全部不变。

## 必须明确的声明

- **leading-zero 证明假设**：真实事件 `time` 为 10 位十进制秒（当前纪元 1e9..1e10，2286 年前成立）；真实群消息 `group_id > 0`，且 `group_id` / `user_id` 使用无前导零的规范十进制表示（JSON 数值解析后再序列化即该形式）；合成 time 为 13 位且低 3 位 ∈ [0,99]。三者成立时合成 key 第 11 位恒为 `'0'`，而真实 key 第 11 位是 group_id 首位（1..9）→ 严格不相交。
- **30s drift guard 是 Wuxin 防御性/future-proof 策略，不是 Shiro 协议限制**：Shiro/Yumu 陈旧门只丢弃“过旧 >30（毫秒分支）”，对未来无上限。当前控制流下真正承担 rollback fail-fast 的是 **safe-pool boundary**（单调水位超出当前池 `[poolFirst, poolFirst+99]` 即发送前失败）；正常路径未来窗口仅 2000–3098ms，30s drift 检查在此控制流下基本不可达，仅作为未来池算法变化时的防御保留。
- **分配器保证是进程局部的**：水位是模块级进程内状态；跨进程不成立。
- **残留边界（已记录）**：进程快速重启后水位归零；若重启发生在目标侧 5s 去重缓存仍存活窗口内，理论上可复用一个仍被缓存的槽并造成一次静默丢弃。概率与影响均极小，保留为文档化边界，不做跨进程持久化。

## 验证

- `tools/quick-bridge-qb05-safeslot-verify.mjs`
  - unit 9/9：100 槽唯一且 X∈[0,99]、101st 发送前失败、下一池恢复、构造碰撞不可达、回拨 fail-safe + 恢复无复用、未来窗口 2000–3098ms；
  - blackbox 9/9：真实 `callLocalBot` 100 次均产生安全槽事件、101st 拒绝时连接数仍为 100（无 WebSocket 创建）、下一池恢复连接；
  - quickrouter-fallback 5/5：`!pm` 桥分配失败被 quickRouter catch，`handled:false` 回退，零桥流量、零未捕获异常；
  - executor-fallback 4/4：recent 桥分配失败被 executor catch，继续内部回退（mock osu API：token/user/recent 各 1 次），分配器错误不泄漏；
  - live 6/6：**恰好 2 次**真实 Yumu 调用（sender 900000099 / group 770099 / 同一墙钟秒 / `!ymd20` 与 `!ymd6`），event.time `1786866914000`、`1786866914001`（13 位、X=0/1、同池秒互异），两者均进入 Yumu 并各回 1 帧骰子结果。无 Tencent 流量，未故意耗尽 100 槽（离线 only）。
- 规格 verifier `tools/quick-bridge-qb05-dedup-verify.mjs`：66/66。
- 既有 verifier：P0_1 166/166；P0_2 23/23；P0_3 settle 34/34、deadline 23/23、deadline-race 6/6；QB-03 33/33；quick-router 121/121。
- `npm run check` PASS；`npm run verify-all`（QB05_SKIP_LIVE=1）81/82，唯一失败仍为已知基线 `reasoning-wire-verify.mjs`（24 项全过后 `UV_HANDLE_CLOSING`/3221226505，单独复跑签名一致）。
- `git diff --check` clean。

无 commit，无 push。
