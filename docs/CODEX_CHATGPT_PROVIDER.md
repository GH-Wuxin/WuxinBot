# 个人 ChatGPT / Codex 配额接入

WuxinBot 可以通过 OpenAI 官方 Codex App Server 使用当前 Windows 用户的 ChatGPT 登录与 Codex 配额，不需要 API Key，也不会调用或模拟 ChatGPT 网页私有接口。

## 启用

1. 确认 `codex --version` 与 `codex app-server --help` 可以运行。
2. 启动 WuxinBot，打开“模型与推理设置”。
3. 选择“个人 ChatGPT / Codex 额度”。
4. 点击“登录 ChatGPT”，在浏览器完成官方授权，再点“刷新状态”。已有 Codex 登录通常会被直接复用。
5. 选择模型和推理强度，确认“自动降级”开启，然后保存。

默认模型是 `gpt-5.6-luna`，适合高频群聊。Terra/Sol 会使用更强推理，但延迟和额度消耗通常更高。可用模型以本机 App Server 的 `model/list` 返回为准。

## 工作方式

- WuxinBot 启动一个长期复用的 `codex app-server` 子进程，通过 stdio JSONL 协议通信。
- 每次 LLM 调用创建 ephemeral thread，不写入 Codex 对话历史。
- 现有 OpenAI messages 和函数工具定义被放入一次结构化推理请求；结果再还原为 WuxinBot 已有的 `choices[0].message.tool_calls` 格式。
- Codex 自带的 Shell、插件、浏览器、MCP 和多代理能力在这个子进程中关闭。只有 WuxinBot 原有的有界工具执行器可以执行工具。
- 账号令牌由 Codex 自己的凭据存储维护。WuxinBot 数据库只保存可执行文件名、模型名和回退策略。
- 日志会分别显示本轮输入、缓存命中、缓存写入、输出、reasoning 和总 Token；缓存命中是输入 Token 的子集，不应重复相加。
- 额度页按 App Server 返回的 `windowDurationMins` 标注 5 小时/周窗口，并逐个展示不同模型额度桶，不假设 `primary` 或 `secondary` 的固定含义。

## 回退

切换到 Codex 时，后端会保存当时正在工作的 `llmProvider` 和 `model`：

- App Server 未安装、未登录、请求超时或服务异常时，单次调用自动回到旧 API 模型；
- 在 GUI 把供应商切回 DeepSeek/OpenAI 兼容接口即可永久停用 Codex 通道；
- 关闭 WuxinBot 时，App Server 子进程会一并退出；
- 实施前 Git 安全点为 `backup/pre-codex-app-server-20260902`，完整功能分支为 `feature/codex-chatgpt-provider-v01`。

如果旧 API Key 本身不可用，自动降级会明确返回“Codex 失败 + 旧供应商也失败”的组合错误，不会静默吞掉问题。

## 配置

可选环境变量：

```env
LLM_PROVIDER=codex-app-server
CODEX_EXECUTABLE=codex
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=low
CODEX_TIMEOUT_MS=90000
```

通常只需在 GUI 配置。`CODEX_EXECUTABLE` 可以是绝对路径；启动 WuxinBot 的 Windows 用户必须与完成 ChatGPT 登录的用户相同。

## 验证

```powershell
npm run codex:verify
npm run codex:probe
npm run codex:smoke
```

- `codex:verify` 不联网，验证消息、工具调用和配置回退契约；
- `codex:probe` 只打印是否登录、套餐类型与模型数量，不输出邮箱或令牌；
- `codex:smoke` 会实际消耗少量 Codex 配额，验证普通回复和工具调用。

Codex App Server 仍属于实验接口。WuxinBot 因此默认保留旧供应商，并把 App Server 错误纳入自动降级路径。App Server 不完全等价于 Chat Completions：`temperature` 与精确的 `max_tokens` 当前不直接映射，工具选择通过结构化输出适配。
