# Wuxin — QQ 群聊 AI 机器人

一个本地运行的 Windows QQ 群聊 AI 机器人，带中文控制台 GUI，通过 NapCat / OneBot 接入 QQ，可连接 DeepSeek 或其他 OpenAI 兼容 API。

## 快速开始

1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ)，并登录你的机器人 QQ 小号。
2. 下载 Wuxin-v0.1.0-portable.zip，解压，双击 启动Wuxin.bat
3. 在“模型”页选择接口供应商（默认DS，openai未经测试），输入api地址（Deepseek为api.deepseek.com），在API Key输入你获取的API
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
- **联网搜索**：支持 DeepSeek 内置搜索。(测试中，不稳定）
- **场景预设**：一键切换上课、出门、睡觉、活跃、安静、调试等模式。
- **备份系统**：支持每 8 小时自动备份，也可在 GUI 中手动备份和恢复。
- **决策沙盒**：不用真的发 QQ 消息，也能测试机器人是否会回复、为什么回复。

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
- **OneBot 设置**：在 GUI 的「QQ连接」页面配置 HTTP / WebSocket 地址。

## 开发

```bash
npm run build      # 构建前端
npm run sanity     # 运行基础集成测试
npm run structure  # 检查模块结构
```
## 开发说明

本项目是一个 AI 辅助开发实验项目。作者本人并非专业程序员，代码主要由 AI 工具生成、修改和重构；人工部分主要负责需求设计、功能测试、问题反馈、版本管理与最终整合。

因此，本项目可能存在代码风格不统一、实现方式不够优雅等问题。欢迎提出 issue、建议或 pull request。（甚至这段话都是GPT写的）
## 许可

MIT
