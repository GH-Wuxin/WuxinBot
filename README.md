# Wuxin — QQ 群聊 AI 机器人

一个本地运行的 Windows QQ 群聊 AI 机器人，带中文控制台 GUI，通过 NapCat / OneBot 接入 QQ，可连接 DeepSeek 或其他 OpenAI 兼容 API。

## 快速开始

1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ)，并登录你的机器人 QQ 小号。
2. 在 [Releases](https://github.com/GH-Wuxin/WuxinBot/releases) 下载最新版本（推荐 full 包内置 Node.js），解压，双击 启动Wuxin.bat
3. 在”模型”页选择接口供应商（默认 DeepSeek，也支持 OpenAI 兼容接口），输入 API 地址和 API Key
4. 在「QQ连接」页输入你自己的qq号（owner）以及用作bot的小号，点击「自动检测」，然后保存并连接。

## 运行要求

- Node.js 20+
- NapCat，或其他兼容 OneBot v11 的客户端
- DeepSeek API Key，或其他 OpenAI 兼容供应商的 API Key

## 主要功能

- **多群支持**：每个群可单独设置回复模式，包括静默、只在 @ 时回复、轻度参与、自然群友。
- **成员策略**：支持管理员、信任成员、重点关注、少回应、黑名单、成员定制提示词等。
- **长期记忆**：支持语境感知的个人画像、群聊氛围画像、群友关系画像。
- **自动模型切换**：复杂任务可自动升级到更强模型。（也就是调用DS V4 Pro）
- **联网搜索**：可接入 SearXNG 等真实搜索源，基于搜索结果回答而非瞎编。
- **场景预设**：一键切换上课、出门、睡觉、活跃、安静、调试等模式。
- **备份系统**：支持每 8 小时自动备份，也可在 GUI 中手动备份和恢复。
- **决策沙盒**：不用真的发 QQ 消息，也能测试机器人是否会回复、为什么回复。
- **思考状态提示**：可配置四种模式（关/简短/详细/仅慢请求显示），默认 3 秒延迟。
- **画像分层**：长期画像与近期动态两层，单日高频话题不覆盖长期人格。
- **身份锚点防护**：防止 bot 被正确 @ 后仍回复「at 的不是自己」。
- **社交记忆**：自动信任分 + 群聊氛围画像 + 群友关系画像。

## 架构

```
NapCat QQ → OneBot WS → server/onebot.ts → server/bot.ts → LLM → OneBot HTTP → QQ
                                  ↑
React GUI ← Vite :5173 ← Express :8787 ← server/store.ts → %APPDATA%/Wuxin/db.json
```

## 指令

所有指令都使用 `/w` 前缀，也支持 `/wuxin`。在 QQ 群里发送：

```text
/w help
```

即可查看当前可用指令。

## 配置

- **数据位置**：默认存储在 `%APPDATA%\Wuxin\db.json`，也可以通过 `DATA_DIR` 环境变量自定义。
- **API 设置**：在 `.env` 中设置 `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_API_BASE_URL`。
- **完整环境变量**：见 `.env.example`；外部 Bot 桥接、NapCat 与渲染器配置见 [docs/EXTERNAL_INTEGRATION.md](docs/EXTERNAL_INTEGRATION.md)。
- **控制台密码**：设置 `ADMIN_PASSWORD`（或在 GUI 中设置管理密码）后，所有本地管理 API 都需要认证；浏览器会在首次打开时提示输入，并仅在当前标签页保存凭据。
- **OneBot 设置**：在 GUI 的「QQ连接」页面配置 HTTP / WebSocket 地址。

## 开发

推荐使用项目自带的 `portable-node`（Node 22）运行；`启动Wuxin.bat` 与
`tools/restart-wuxin.ps1` 都会自动优先使用它。请勿用系统 Node 20 手动启动，
否则可能出现并发连接崩溃（Node 20.11 的 happy-eyeballs 缺陷）。

```bash
npm run build      # 构建前端
npm run typecheck  # 检查已类型化的服务端模块
npm run check      # 类型检查 + 构建 + 基础/安全验证
npm run sanity     # 运行基础集成测试
npm run structure  # 检查模块结构
```
## 开发说明

本项目是一个 AI 辅助开发实验项目。作者本人并非专业程序员，代码主要由 AI 工具生成、修改和重构；人工部分主要负责需求设计、功能测试、问题反馈、版本管理与最终整合。

因此，本项目可能存在代码风格不统一、实现方式不够优雅等问题。欢迎提出 issue、建议或 pull request。（甚至这段话都是GPT写的）
## 许可

WuxinBot 主体代码采用 MIT License，见根目录 [LICENSE](./LICENSE)。

`server/osu/matchRating.ts` 与 `server/osu/match.ts` 派生自
[yumu-bot/yumu-bot](https://github.com/yumu-bot/yumu-bot)（Apache-2.0）。
来源 commit、修改说明与许可证全文见
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与
[LICENSE.yumu-bot](./LICENSE.yumu-bot)。
