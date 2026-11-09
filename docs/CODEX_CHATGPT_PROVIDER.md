# Codex App Server 接入

WuxinBot 可以通过本机 Codex App Server 使用 ChatGPT 登录后的模型服务。登录流程由 Codex 提供；接口概念和协议以 [OpenAI 官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)为准，本文说明 WuxinBot 已实现的接入方式。

## 配置

1. 在启动 WuxinBot 的 Windows 用户下，确认 `codex --version` 和 `codex app-server --help` 可以执行。程序未加入 PATH 时，使用实际可执行文件路径。
2. 打开控制台“模型 → 账号与模型”，选择 Codex 通道。
3. 点击“登录 ChatGPT”，完成浏览器中的官方授权，再刷新状态。已有的 Codex 登录可以复用。
4. 选择模型和推理强度，核对“自动降级”及备用 API 模型，保存后测试对话。

模型选择器读取 App Server 的 `model/list`。列表和支持的推理强度可能随本机客户端与账号变化，实际调用还须通过服务端权限检查。仓库中的默认模型名是初始配置，不是对账号可用性的保证。

源码首次启动可设置以下环境变量，完整模板见 [`.env.example`](../.env.example)：

| 变量 | 用途 |
| --- | --- |
| `LLM_PROVIDER=codex-app-server` | 选择 Codex 通道 |
| `CODEX_EXECUTABLE` | 程序名或绝对路径，默认 `codex` |
| `CODEX_MODEL` | 所选模型名 |
| `CODEX_REASONING_EFFORT` | 推理强度，默认 `low` |
| `CODEX_TIMEOUT_MS` | 默认请求超时，初始值为 90000 毫秒 |

已经创建数据库后，以控制台保存的配置为准。登录用户和实际运行后端的 Windows 用户应一致，避免读取到另一套 Codex 配置或登录状态。

## 请求与数据

WuxinBot 复用一个 `codex app-server` 子进程，通过标准输入输出传递 JSONL 请求。每次推理创建临时会话，并把模型回答转换为现有的文字或工具调用格式。达到进程生命周期上限或超时后，适配器会回收并重新建立子进程。

此适配器关闭 Codex 的 Shell、浏览器、MCP、插件等内置工具入口。模型选择的 WuxinBot 工具仍由 WuxinBot 检查权限并执行。具体启动参数见 [codexAppServer.ts](../server/codexAppServer.ts)。

ChatGPT 登录凭据由 Codex 保存，WuxinBot 保存程序路径、模型和回退配置。临时会话不作为普通 Codex 历史保存，但 WuxinBot 自己的消息记录、用量和诊断仍按本项目设置处理；推理请求也会发送到模型服务。

用量页按 App Server 返回的数据显示窗口和模型分组。缓存命中属于输入 Token 的一部分，不能再次加到总输入中。账号访问限制来自服务端。

## 自动降级与限制

开启“自动降级”后，Codex 未登录、不可用或调用失败时可转用已保存的 API 通道；备用通道也需要有效配置。失败后可在日志中检查实际使用的供应商及错误，不能只看原先选择的模型。

切回 DeepSeek 或 OpenAI 兼容通道即可停止使用 Codex 推理。关闭后端时会结束它管理的 App Server 子进程。

当前适配器没有提供 `temperature` 和精确输出 Token 上限的硬控制。函数工具通过结构化输出适配，并非直接透传 Chat Completions。需要硬输出上限的自主阅读目前不会使用此通道。

## 验证

```powershell
npm run codex:verify
npm run codex:probe
npm run codex:smoke
```

`codex:verify` 使用模拟服务验证适配器；`codex:probe` 检查登录状态和模型列表；`codex:smoke` 会发出真实推理请求，验证文字与工具调用。后两项应在实际使用 Codex 的用户下运行，输出中不要加入令牌或登录文件内容。
