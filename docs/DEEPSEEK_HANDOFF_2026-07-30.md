# Wuxin / 雨沐 BP 功能接手文档

更新时间：2026-07-30  
项目目录：`REDACTED_REPO_ROOT`

## 1. 本轮用户遇到的真实问题

服务没有崩溃，也没有明显报错，但 QQ 中的实际交付严重损坏：

- “看看我 BP1”只输出了半段文字。
- “调用雨沐把我的 BP list 展示出来”只输出到 `#2 Sid`。
- 用户追问后，Bot 声称“后面八张贴在这里”，实际没有任何后续内容。
- 当时的 `yumu/bp` 实现宣称返回图片，内部实际上只返回文字列表。

实时数据库中对应记录：

- `2026-07-29T15:47:01Z`：回复仅 103 字，截断于 Sidetracked Day。
- `2026-07-29T15:48:42Z`：回复仅 86 字，截断于 `#2 Sid`。
- `2026-07-29T15:49:26Z`：仅产生一句没有实体内容的承诺。

根因不是 osu! API 没有返回数据，而是：

1. 工具已经取得完整确定性数据；
2. 系统又要求 LLM 把工具结果完整复述一遍；
3. Flash 模型的第二次输出中途停止；
4. QQ 和数据库最终保存的都是 LLM 的残缺复述。

## 2. 已完成的代码改动

### 2.1 工具结果改为确定性交付

涉及：

- `server/bot.ts`
- `server/bots/executor.ts`
- `server/bots/types.ts`
- `tools/bot-harness-verify.mjs`
- `tools/onebot-verify.mjs`

当前设计：

- BP、Recent、Info、Profile、PP+、Skill 等结构化结果使用 `directContent` 单独收集。
- 图片通过 `ToolResult.images` 单独收集。
- LLM 只负责写一句很短的引导或短评，不再负责抄写数据。
- 完整文字和图片由系统在最终发送阶段直接附上。
- `#2 Sid...` 这种数据残片会被替换成稳定引导。
- 确定性结果绕过普通的三段拆分和合并转发路径。
- 数据库保存完整确定性正文；图片写入 `MessageRecord.media.images`。

额外修复：

- osu! 工具查询不再额外发送“正在思考”，避免一次查询出现两条反馈。
- LLM 短引导中的 CQ 码、媒体占位和控制字符会被清除。
- 已取得完整工具结果后，如果第二次 LLM 短引导超时或报错，仍然交付数据和图片。
- 已取得 direct payload 后，后续回合不再允许重复调用工具。
- 普通非确定性工具仍可由 LLM 正常总结。

### 2.2 BP1、BP10 和范围查询

涉及：

- `server/bots/registry.ts`
- `server/bots/guard.ts`
- `server/bots/executor.ts`
- `tools/bp-rank-verify.mjs`

当前行为：

- `看看我 BP1`、`看看我 BP10`：只取目标 BP，优先渲染单张 `panel_E5`。
- `BP1-10`：取指定范围并渲染 `panel_A4`。
- 普通 “BP list” 默认取 BP1-10。
- 单张最多支持 BP100。
- 一次范围查询最多 20 张，防止渲染 payload 和 QQ 单消息过大。
- 如果 LLM 忘记填写 `bp_rank`，会从用户原始消息中的 `BP1`、`BP10`、`BP10-15` 补回。
- 显式工具参数优先于原始消息推断。
- 渲染失败时退回完整确定性文字，不再让 LLM 复述。

### 2.3 真正的雨沐 BP 图片

涉及：

- `server/bots/render.ts`
- `tools/render-bp-payload-verify.mjs`
- `server/bots/executor.ts` 中的调用接线

实现依据：

- yumu-image：  
  `REDACTED_BOTS_ROOT\sources\yumu-image\src\panel\panel_A4.js`
- yumu-bot：  
  `REDACTED_BOTS_ROOT\sources\yumu-bot\src\main\java\com\now\nowbot\service\messageServiceImpl\BPService.kt`

多 BP 使用官方 payload：

```text
path = panel_A4
payload = {
  user,
  history_user,
  scores,
  rank,
  panel: "BS",
  compact: false
}
```

`compact:false` 是有意选择：复刻普通 QQ 雨沐的双栏 Card_C 样式；`compact:true` 是 Tencent 路径使用的五栏样式。

关键兼容修复：

- 每条 score 内的 `user` 改为 MicroUser，避免重复十份完整用户对象。
- 真实 BP10 payload 从约 205,750 B 降到约 58,053 B，低于渲染服务 128 KiB 限制。
- legacy 字符串 Mods 被转换为 `{ acronym }` 结构，否则 yumu-image 会把 HD/HR 画成错误的 NM 样式。
- Mod 后星数继续使用 osu! 官方 beatmap attributes 结果。

有效的真实隔离渲染成品：

`REDACTED_REPO_ROOT\data\yumu-renders\bp-direct-verify-env.webp`

该图已目视确认：

- BP1-10 齐全；
- Acc、PP、BP 名次正常；
- 显示 Mod 后星数；
- HD/HR 图标和颜色正常；
- 用户 supporter 图标与 STB 成绩类型图标正常；
- 没有破图。

不要使用下面这个旧测试产物判断生产问题：

`REDACTED_REPO_ROOT\data\yumu-renders\bp-direct-verify-init.webp`

它是在隔离测试没有先加载 yumu-image `.env` 时生成的，因此静态资源根为空并出现破图；生产 `main.js` 会先加载 `.env`。

## 3. 已由各专项验证通过的项目

各修改代理分别报告以下验证已通过：

- `npm run typecheck`
- `npm run check`
- `tools/bot-harness-verify.mjs`
- `tools/onebot-verify.mjs`
- `tools/bp-rank-verify.mjs`
- `tools/render-payload-verify.mjs`
- `tools/render-bp-payload-verify.mjs`
- `tools/render-protocol-verify.mjs`
- 安全检查

但是用户在最终总验收前中止了 Codex，因此 DeepSeek 必须在当前合并后的文件状态上重新跑一次完整验证，不能只依赖上述分支内结果。

## 4. DeepSeek 接下来只需要做什么

### 第一步：保护现场

- 不要 `git reset --hard`。
- 不要 `git checkout --`。
- 不要 `git clean`。
- 不要覆盖整个文件。
- 当前工作树包含大量用户、DeepSeek 和 Codex 的共同改动；只做增量修复。
- 不要删除或重写人格 Prompt、模型配置、osu! 绑定和现有机器人配置。

先执行：

```powershell
cd /d REDACTED_REPO_ROOT
git status --short
git diff --check
```

PowerShell 中如果 `cd /d` 不可用，使用：

```powershell
Set-Location -LiteralPath 'REDACTED_REPO_ROOT'
```

### 第二步：跑合并后的完整回归

建议依次执行：

```powershell
npm run typecheck
node --import tsx tools/bot-harness-verify.mjs
node --import tsx tools/onebot-verify.mjs
node --import tsx tools/bp-rank-verify.mjs
node --import tsx tools/osu-fixture-verify.mjs
node --import tsx tools/render-payload-verify.mjs
node --import tsx tools/render-bp-payload-verify.mjs
node --import tsx tools/render-protocol-verify.mjs
node --import tsx tools/security-verify.mjs
npm run check
```

如果某脚本实际使用 `tsx tools/...` 才能运行，以 `package.json` 和现有同类命令为准，不要修改业务代码来迁就错误的启动方式。

### 第三步：检查本地服务

上次确认的服务结构：

- Wuxin 后端：`127.0.0.1:8787`
- Wuxin → yumu-image 渲染 WebSocket：`127.0.0.1:8389`
- 官方雨沐使用的渲染端口：`127.0.0.1:8388`
- NapCat HTTP：`127.0.0.1:3000`
- NapCat WebSocket：`127.0.0.1:3001`
- Bot QQ：`REDACTED_QQ_002`
- 管理员/所有者 QQ：`REDACTED_QQ_001`

Wuxin 之前通过 `tsx watch server/index.ts` 运行，修改文件后会自动重载。最终仍要确认：

- 8787 和 8389 正在监听；
- 8389 有已认证 yumu-image 客户端；
- OneBot 已连接；
- `/api/health` 为正常；
- 没有重复 Wuxin 后端。

读取管理密码只允许在本机变量中使用，绝对不要把值打印到终端日志、聊天或文档。

### 第四步：隔离模拟，不向真实 QQ 发消息

用 `/api/simulate` 测试以下两条：

```text
[CQ:at,qq=REDACTED_QQ_002] 调用雨沐把我的 BP list 展示出来
[CQ:at,qq=REDACTED_QQ_002] 看看我 BP1
```

使用一个假的测试群号，例如 `9999999999`，用户号使用已绑定账号的 `REDACTED_QQ_001`。

验收：

#### BP list

- 返回一张真正的 `panel_A4` 图片；
- 图中有 BP1-10；
- 双栏官方 QQ 样式；
- HD/HR 图标正确；
- 星数是 Mod 后星数；
- 没有 `#2 Sid` 截断；
- 没有“后面八张稍后贴”；
- 没有额外“正在思考”。

#### BP1

- 只返回 BP1；
- 使用单成绩 `panel_E5`；
- 面板位置显示 BP1；
- 不生成十条文字列表；
- 不截断。

模拟接口不会向真实 QQ 发消息，但会写入测试上下文。完成后清掉假群号对应的测试上下文，不要清理真实群历史。

### 第五步：由用户在 QQ 手动复测

隔离测试全部通过后，只告诉用户可以复测，不要由脚本主动向真实群发消息。

建议用户手动发送：

```text
@pippi 调用雨沐把我的 BP list 展示出来
@pippi 看看我 BP1
```

真实 QQ 最终标准：

- 每个请求只出现一条最终反馈；
- BP list 为图片；
- BP1 为单成绩图片；
- 没有思考提示；
- 没有重复查询；
- 没有残缺文字和空头承诺。

## 5. 重点检查的文件

```text
server/bot.ts
server/bots/types.ts
server/bots/registry.ts
server/bots/guard.ts
server/bots/executor.ts
server/bots/render.ts
tools/bot-harness-verify.mjs
tools/onebot-verify.mjs
tools/bp-rank-verify.mjs
tools/render-bp-payload-verify.mjs
```

检查时特别注意：

- `directContent` 不得被后续 LLM 覆盖。
- 图片不得塞回 LLM 消息让模型复述。
- LLM 短引导失败不能丢失已经取得的数据。
- direct payload 后不得再次调用同一工具。
- 工具查询不得触发 thinking notice。
- 最终 CQ 图片只能由受信任的结构化图片数组生成。
- DB 中图片写入 `media.images` 时不得保存超长 inline base64。
- `BP1` 的原始消息兜底识别不能覆盖显式 `bp_rank`。
- 多 BP 必须是 `compact:false`。
- 渲染失败必须保留完整文字 fallback。

## 6. 不要顺手处理的事情

本轮只处理 BP 查询和交付链。不要顺手修改：

- pippi 人格和 Prompt；
- Flash/Pro 模型选择；
- OAuth、API Key、OneBot Token；
- PP+ 服务；
- 猫猫、消防栓、LazyBot 的其他功能；
- 自启动脚本；
- GUI；
- 真实 QQ 群配置。

当前线上模型上次看到仍是 `deepseek-v4-flash`、普通回复上限约 300 tokens。不要为了绕过 BP 截断而盲目增大 token；本轮修复的核心就是让确定性结果不依赖模型输出长度。

## 7. 安全约束

- 不得输出 osu! OAuth Secret。
- 不得输出 LLM API Key。
- 不得输出管理密码。
- 不得输出 OneBot Token。
- 不得把 `API.txt` 内容写入日志或聊天。
- 不得在隔离验收前向真实群发测试消息。
- 不得把“返回文字”伪装成“图片功能已实现”。

## 8. 完成后的汇报模板

只需向用户简洁汇报：

```text
已经完成最终合并验证。

- BP list：雨沐 panel_A4 图片正常，BP1-10 完整。
- BP1：单成绩 panel_E5 正常。
- 每个请求只发送一次最终结果。
- 不再经过 LLM 复述，因此不会截断。
- 隔离测试通过，没有向真实群发消息。

现在可以在 QQ 里手动复测两条指令。
```

如果仍有问题，必须给出：

1. 失败的具体测试命令；
2. 实际返回；
3. 预期返回；
4. 对应代码位置；
5. 是否影响真实 QQ；
6. 下一步最小修复。
