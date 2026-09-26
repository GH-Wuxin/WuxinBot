# 2026-09-05 健康审查修复与回退说明

## 基线与交付状态

- 本地修复基线：`3c6aeac`（`refactor/prompt-review-slim-v01`）。
- 对应公开代码基线：`main@e5a4dd4`。公开与私有开发历史不相同，不能直接把本分支历史推到公开 main。
- 修复前备份引用：`backup/pre-health-fixes-20260905`。
- 隔离修复分支：`fix/health-runtime-20260905`。
- 第一批提交：`24edd35`，运行时生命周期、图片边界、写失败缓存恢复。
- 第二批提交包含本文件：逐调用账本、调用预算、工具交付语义及组合回归。
- 未切换正在运行的应用，未 Push。未改生产配置、登录凭据、模型选择或聊天数据库。

## 本轮修复

| 编号 | 已实现的边界 |
| --- | --- |
| F01 | 单一 drain worker；最外层处理完成后驱动队列；提前返回/异常清理；重放重验暂停、屏蔽、群参与模式和私聊 owner。 |
| F02 | 初始化握手屏障；ready 与进程存活分离；旧进程事件隔离；进程退出及时拒绝 turn；兼容 item/completed 的最终输出。 |
| F03 | OneBot/下载响应体全程超时及流式大小限制；探针不重叠；整批图片准备共用时间上限；本地图片读取缓冲区限额。 |
| F04 | 可选通知在异步边界捕获发送错误；正式交付开始前停止通知计时器。 |
| F05 | 自动历史图片回看必须匹配消息类型、群和发送者，且不允许 inContext=false；明确引用路径保持独立。 |
| F06 | 将写盘失败纳入缓存失效。**没有实现跨分片事务或崩溃原子提交。** |
| F07 | 每个逻辑模型 invocation 独立记账，成功/失败与 QQ 交付分离；保留真实 provider/model、用途、requestId、已知/未知 usage；汇总保留缓存/推理字段；补查合并附件与证据；部分已记账合并不重复累加。 |
| F08 | Codex 声明本适配器未提供的参数能力；逐次 effort 映射；同轮沿用已成功的备用供应商；共享调用次数/时限与全进程并发限制。 |
| F09 | 工具路径也遵守通知配置；模型生成失败至多一次通用错误通知；QQ 开始交付后的错误记为失败或状态未知，不盲目重发。 |
| F10 | 保留原始工具参数；损坏 JSON、null、数组、标量、空字符串不能被转换成默认查询。V2 转换层同样不得把坏参数补成空对象。 |
| F11 | 外部机器人仅进度文本不能标记成功，保留进度用于诊断。 |
| F12 | 区分已有直出载荷的短评与唯一可见文本合成；后者失败时交付安全过滤后的有限完整源数据行。 |

## 预算与账本的准确含义

当前保守默认值在 `server/llmPolicy.ts`：同一入站处理最多 12 个逻辑模型调用，180 秒共享时间预算，进程内最多 4 个进行中的模型调用。空回复重试和供应商降级使用同一预算。新工具启动前检查共享 deadline。

这不是硬 Token 上限，也不是整个 QQ 交付或任意工具的强制取消机制：正在运行的非 LLM 工具保留自身超时；SDK 内部 HTTP 重试没有独立可见的 token usage，账本记录一个逻辑调用。预算满时明确失败，而不继续启动模型请求。

依据 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)，使用现有 `turn/start.effort` 参数；本适配器不声称支持 `maxTokens` 或 `temperature` 的硬控制。`thinking=disabled` 映射为 `low`，trace 明确注明这不等于关闭推理。通用旧 API 的 model 字段不覆盖 Codex 配置，显式逐次覆盖使用 `codexModel`。

同轮降级记忆不是跨用户、跨时间的全局熔断器；下一用户轮次可以重新尝试修复后的 Codex。没有修改登录流程，也没有借验证消耗真实 ChatGPT/Codex 额度。

新增事件 `kind=llm-call` 是计数事实；`reply-delivery` 等业务事件单独表示交付。已记账业务事件的计费字段为零，原聚合量保留在 `observedUsage` 中，避免旧版本回退后再次累计 Token。旧版本仍可能把零用量诊断行计为请求，因此新旧版本的“请求数”口径不能直接比较。旧数据不重算，未知用量不能事后补出，5000 条事件保留上限未改变。写盘失败有明确日志，但没有新增持久化补账 WAL，断电/磁盘故障下仍不能宣称账本绝对不丢。

## 验证记录

通过 `npm run check`（类型、构建、sanity、usage、Codex、osu-only、API 重试、安全、搜索、Agent V2、证据、运行时、分片存储、request trace）。后续小修再运行受影响的类型及真实模块回归。

新增直接导入真实模块的脚本：

- `tools/health-runtime-verify.mjs`：握手并发、旧进程退出、真实 completeCodex turn 退出及时失败并保留已知用量、队列所有权、私聊图片、慢响应体、大小限制、ENOSPC 缓存恢复、通知 Promise 拒绝。
- `tools/health-accounting-verify.mjs`：本机 HTTP 模拟供应商的真实 SDK 调用，后轮失败仍保留首轮用量，去重、缓存未知分母、混合已记账恢复、V2 坏参数、工具结果合并、合成失败、外部 bot 进度、预算及 Codex 失败后的同轮降级复用。
- `tools/health-delivery-verify.mjs`：真实 `processIncoming` 的 slow 通知发送失败、QQ 发送失败仍计费且不重发、模型错误通知、排队中暂停与锁清理。

保留原证据不变量及 300 回合确定性对抗回归。全量脚本还执行了队列压力与既有 2000/3000 个时序竞争场景；不把这些离线测试等同真实 QQ/Codex 负载测试。

### 广泛回归没有全绿

首次 `npm run verify-all`：**98/118 通过**，约 348 秒。之后新增了一份交付验证脚本，未把第一次计数冒充最终全量通过率。

本次引入/契约改变的失败已定向解决并复测通过：

- Phase D：没有用量时保留旧空结构，历史 trace/fingerprint 原样不动。
- repeated-history：无直出载荷时的正确终态不再是空文本。
- rewrite-telemetry-analyze：修复旧 usageEvents 中 null 项的容错。
- natural-chat-delivery：mock 补齐实际使用的 SSE 和 forwardNodes，保留成功合成不倾倒报表的断言，补安全摘录兜底契约，10/10 通过。

其余失败在修复前基线同样复现，不属于“全部已修复”：

`agent-tool-surface-hardening-cross-run`、`bp-range-route`、`bp-type-analysis-guard`、`db-consistency`、`experience`、`external-exposure`、`kb`、`match-listener-race`、`onebot`、`osu-fixture`、`processIncoming-deterministic-route`、`profile-log`、`prompt-review-slim-p1b`、`quick-bridge-qb07-shadow-refetch`、`reasoning-wire`、`search-routing`。

其中 `kb` 与 `prompt-review-slim-p1b` 在隔离工作树还缺少未纳入 Git 的私有语料/基线文件，与原仓库的失败原因不完全一致；两份脚本还在此 Windows Node v24.19.0 上出现相同的 libuv 退出断言。其他失败包含固定旧调用次数、停用功能的旧断言及已有业务测试失败。没有通过跳过这些脚本或放宽旧断言宣称全绿。`tools/health-baseline-compare.mjs` 可接收一个修复前 checkout 做逐项复核，FAILS_ON_BOTH 只代表两侧非零，不自动证明根因相同。

## 回退

代码没有数据库格式迁移。保留备份分支，勿用 hard reset 丢掉后续工作。先检查工作树和目标提交：

```powershell
git status --short
git log --oneline backup/pre-health-fixes-20260905..fix/health-runtime-20260905
```

对修复提交按新到旧使用 `git revert`。在第二批修复刚提交、HEAD 仍为该提交时，可执行：

```powershell
git revert --no-edit HEAD 24edd35
```

以后已有新提交时，应使用交付时记录的精确提交号，不再照抄 HEAD。回退后重新构建并在用户授权时切换/重启实例；Git 回退不回滚聊天记录或删除已发生的调用账本。公开 main 发布仍应走现有干净导出流程，不能连同私有历史直接 Push。
