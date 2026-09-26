# QUICK_ROUTER_FIX_P1_1 — EVIDENCE CORRECTION (NO FIX REQUIRED)

- 日期：2026-08-16
- 仓库：`G:\QQ-AI-ChatBot`
- 分支 / HEAD：`fix/onebot-connection-lifecycle` @ `1658292`
- 性质：**证据纠正 / 审计**。未实现 executability-priority，未激活任何命令，未修改生产代码。
- 产物：
  - 本文件
  - `docs/QUICK_ROUTER_P1_1_COLLISION_AUDIT_V01.json`
  - `tools/quick-router-p11-alias-verifier.mjs`（41 断言 + 10,000 例归一化 fuzz）

## 0. 结论

**NO PRODUCTION BUG / NO FIX REQUIRED.**

当前注册表中 **不存在** 任何 `NONEXEC_EXECUTABLE` collision。所谓“documentation-only 的 Kanon 定义遮蔽了可执行 Yumu 定义”的前提与代码不符：

- `!search`：候选 `kanon:search`（documentation_only）与 `yumu:explore`（documentation_only）。
- `!badge`：候选 `kanon:badge`（documentation_only）与 `yumu:badge`（documentation_only）。
- `!get bg`：候选 `kanon:getbg`（documentation_only）与 `yumu:getbg`（documentation_only）。
- `!todaybp`：候选 `kanon:todaybp`（documentation_only）与 `yumu:todaybp`（documentation_only）。

因此这四个别名当前走 LLM fallthrough 的原因是**全部候选都不可执行**，不是“可执行候选被遮蔽”。实现 executability-priority 在当前注册表下会改变 **0** 个运行时胜者（由离线 verifier 验证），故按用户决策不实现。

## 1. 全量 11 个 normalized-alias collision 表

| 域 | normalized alias | 候选（registry 顺序） | 可执行 | execution.kind | 胜者 | 分类 |
|---|---|---|---|---|---|---|
| ! | re | kanon:recent, yumu:recent | 是 / 是 | proxy / proxy | kanon:recent | EXECUTABLE_EXECUTABLE |
| ! | recent | kanon:recent, yumu:recent | 是 / 是 | proxy / proxy | kanon:recent | EXECUTABLE_EXECUTABLE |
| ! | pr | kanon:recent, yumu:recent | 是 / 是 | proxy / proxy | kanon:recent | EXECUTABLE_EXECUTABLE |
| ! | bp | kanon:bp, yumu:bp | 是 / 是 | proxy / proxy | kanon:bp | EXECUTABLE_EXECUTABLE |
| ! | score | kanon:score, yumu:score | 是 / 是 | local / local | kanon:score | EXECUTABLE_EXECUTABLE |
| ! | info | kanon:info, yumu:info | 是 / 是 | proxy / local | kanon:info | EXECUTABLE_EXECUTABLE |
| ! | search | kanon:search, yumu:explore | 否 / 否 | documentation_only | kanon:search | **NONEXEC_NONEXEC** |
| ! | badge | kanon:badge, yumu:badge | 否 / 否 | documentation_only | kanon:badge | **NONEXEC_NONEXEC** |
| ! | get bg | kanon:getbg, yumu:getbg | 否 / 否 | documentation_only | kanon:getbg | **NONEXEC_NONEXEC** |
| ! | todaybp | kanon:todaybp, yumu:todaybp | 否 / 否 | documentation_only | kanon:todaybp | **NONEXEC_NONEXEC** |
| none | 我的年度osu! | hydrant:annual 的两个别名规范化后相同 | 否 / 否 | documentation_only | hydrant:annual | INTRA_DEFINITION_NORMALIZATION_DUPLICATE |

计数：EXECUTABLE_EXECUTABLE **6**，NONEXEC_EXECUTABLE **0**，NONEXEC_NONEXEC **4**，INTRA_DEFINITION_NORMALIZATION_DUPLICATE **1**。

## 2. 需要纠正的表述

- ❌ 旧前提：“A later Yumu definition for the same normalized alias is executable.”
- ✅ 纠正：四个冲突里 Yumu 候选同样是 `documentation_only`；当前无任何 executable 候选被 shadow。
- ✅ 更准确措辞：“`!search` / `!badge` / `!get bg` / `!todaybp` 是 documentation-only 与 documentation-only 的同名平局，按 registry 顺序由 Kanon 定义胜出；随后因该定义不可执行而 `handled:false` 回 LLM——这是所有候选均不可执行的结果，不是 executability 被遮蔽。”
- 保留既有历史结论：QUICK_BRIDGE_RELIABILITY_AUDIT_V01 的 collision 表本身（“均不可执行”）不需要改动。

## 3. 为什么拒绝全局重排 registry

`KANON_DEFS` 早于 `YUMU_DEFS` 是已审计并有意保留的可执行-可执行优先顺序：`!re/!pr/!recent → kanon`、`!bp → kanon`、`!info → kanon`、`!score → kanon`。全局重排会改变这些行为；本阶段既无证据支持，也被明确禁止。当前也没有任何 executability-priority 的必要（0 个受影响胜者）。

## 4. 回归 / 证据

`tools/quick-router-p11-alias-verifier.mjs`（**41/41**）：
- 断言 11 个 collision 的 registry 派生胜者与运行时 `matchQuickCommand` 完全一致。
- 断言分类计数：6 / 0 / 4 / 1。
- 断言四个点名别名均为 NONEXEC_NONEXEC，胜者保持 `kanon:*`。
- 10,000 例确定性归一化 fuzz（大小写/全角/空白/中文标点/共享前缀/`#N`/BP 范围/`~/查`/多词别名），运行时 matcher 与纯 resolver **0 差异**——即“executability-priority 若实现也是 no-op”的运行时证据。

未做任何 live bot 调用（路由审计不需要）。

## 5. Files added/modified（本阶段）

- 新增 `tools/quick-router-p11-alias-verifier.mjs`（审计用，无生产副作用）。
- 新增 `docs/QUICK_ROUTER_P1_1_COLLISION_AUDIT_V01.json`。
- 新增 `docs/QUICK_ROUTER_FIX_P1_1.md`（本文件）。
- **生产代码零改动。**

## 6. 建议下一项修复

在可执行-可执行优先顺序之外，下一个有明确源码证据、且属于 Wuxin 侧、无需目标 bot 改动的确定性候选是 **QB-05：Yumu 同秒 `(time, group_id, sender)` 重复过滤**（源级确认：Shiro `group-event-filter:true` + `time` 为秒级；连续两次相同 sender/group 的桥接调用在同秒内会被静默丢弃并烧满 60s）。建议先做小范围设计/证据阶段（例如每调用唯一 sender 身份、时间粒度或去重规避方案），再实现；同时 QB-08/QB-09 观察上下文一致性仍在中风险队列。

## 7. Explicit confirmation

No production behavior change. No commit. No push.
