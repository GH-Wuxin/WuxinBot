# WuxinBot — osu! 社区 QQ 群聊机器人（pippi）

WuxinBot 是一个本地运行的 Windows QQ 群聊 AI 机器人。它的外显人格是
**pippi**——一个懂 osu!、活泼自信的少女。项目通过 NapCat / OneBot v11
接入 QQ，连接 DeepSeek（或任意 OpenAI 兼容接口）与 osu! API v2，
既能自然聊天，也能查成绩、分析玩家、推荐谱面、观战比赛。

## 功能亮点

### osu! 原生能力

- **玩家分析**：`/w osu analyze` 输出完整分析（BP、PP+、技能维度与结论），
  `/w osu recent` 对比近期成绩给出短评；支持 std / taiko / catch / mania。
- **推图推荐**：基于玩家真实 top 成绩做实时协同过滤——找到同分段玩家正在刷的图，
  再按难度窗口与 mod 偏好排序；支持自然语言筛选（BPM、AR、星数、mod），
  自动冷却与 7 天防重复。
- **比赛观战**：`!ml` 监听多人比赛并推送开局与回合成绩，`!ra` 查询系列 rating。
- **快捷指令生态**：兼容社区熟悉的 `!p` / `!bp` / `!bs` / `!s <BID>` / `!pp` /
  `!skill` / `!rec` / `荐图` / `~` / `查 @某人` / `/rd` 等指令，统一绑定
  QQ 与 osu! 账号。

### 自然群聊

- 每个群独立回复模式：静默、仅 @、轻度参与、自然群友。
- 长期记忆：个人画像、群聊氛围画像、群友关系画像，自动更新并可在 GUI 管理。
- 无上限的 pp 制等级：N 级 = N×100pp；`/w lv`、`/w top` 查看，升级时由
  pippi 生成个性化祝贺。
- 自定义称呼与交互风格（`/w nick`、`/w style`）、自动模型切换、
  SearXNG 联网搜索、思考状态提示、场景预设。

### 管理与运维

- 成员策略：管理员、信任成员、重点关注、少回应、黑名单。
- 群参数：回复频率上限、发言冷却、暂停 / 恢复、人设编辑与基线保存。
- 决策沙盒：不发真实 QQ 消息即可测试机器人是否会回复、为什么回复。
- `/w why` 解释最近一次回复或未回复的原因。
- 自动备份（每 8 小时）与 GUI 手动备份 / 恢复。

### 控制台 GUI

React + Vite + Express 的中文控制台，包含总览、群聊、成员、记忆、关系、
画像日志、osu、模型、权限等页面，可在浏览器中完成全部配置。

## 架构

```text
QQ 群消息
  → NapCat / OneBot v11（HTTP + WebSocket）
  → server/onebot.ts → server/bot.ts（意图识别 / 路由 / 记忆 / 人设）
  → LLM（DeepSeek / OpenAI 兼容接口）
  → 回复：直接发送，或经 yumu-image 渲染成图片

可选：Yumu / Kanon / Hydrant / LazyBot
  → 各自 OneBot WebSocket server
  → Wuxin 作为第二客户端直连调用（server/bots/localBridge.ts）

React 控制台 GUI ← Vite :5173 ← Express :8787 ← server/store.ts → %APPDATA%\Wuxin\db.json
```

## 快速开始

### 环境要求

- Windows（Node.js 20+，推荐 22；代码已规避 Node 20.11 的并发连接崩溃问题）
- [NapCat](https://github.com/NapNeko/NapCatQQ) 或其他兼容 OneBot v11 的客户端
- DeepSeek API Key（或任意 OpenAI 兼容供应商的 API Key）

### 1. 安装

```bash
git clone https://github.com/GH-Wuxin/WuxinBot.git
cd WuxinBot
npm install
```

### 2. 配置 .env

```bash
copy .env.example .env
```

至少填写：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=你的Key
ADMIN_PASSWORD=控制台密码
OSU_CLIENT_ID=你的osu客户端ID
OSU_CLIENT_SECRET=你的osu客户端Secret
```

完整环境变量见 `.env.example`，外部 Bot 桥接与渲染器配置见
[docs/EXTERNAL_INTEGRATION.md](docs/EXTERNAL_INTEGRATION.md)。

### 3. 接入 QQ

1. 安装 NapCat 并登录机器人 QQ 小号。
2. 运行 `tools/enable-napcat-local-onebot.ps1` 写入本机 OneBot 配置
   （HTTP `127.0.0.1:3000`、WebSocket `127.0.0.1:3001`）。
3. 双击 `启动Wuxin.bat`（或 `npm run dev`），打开控制台
   <http://127.0.0.1:5173>。
4. 在「QQ连接」页填写 HTTP / WebSocket 地址、你的 QQ（owner）与 bot QQ，
   保存并连接。

### 4. 可选：osu! API

在 osu! 官网 OAuth 页面创建应用，填入 `OSU_CLIENT_ID` 与
`OSU_CLIENT_SECRET`，即可使用 analyze / recent / recommend / match 等功能。

## 指令

管理指令使用 `/w` 前缀（也支持 `/wuxin`），在群内发送 `/w help` 可查看
分组帮助与当前权限可用的指令。

| 分类 | 常用指令 |
| --- | --- |
| 系统 | `/w ping` `/w why` `/w my` `/w summarize` `/w help` |
| osu! | `/w osu bind <用户名>` `/w osu analyze` `/w osu recent` `/w osu clear` `/w osu help` |
| 等级 / 画像 | `/w lv` `/w top` `/w nick` `/w style` `/w me` |
| 群管理 | `/w mode` `/w op` `/w ban` `/w trust` `/w focus` `/w quiet` `/w rate` `/w cooldown` `/w preset` `/w prompt` `/w pause` |

同时兼容社区熟悉的快捷指令（按原 Bot 风格路由，可走内部实现或桥接原始 Bot）：

```text
!p / !pr     最近成绩
!bp / !bs    BP（支持名次 / 范围）
!s <BID>     按谱面查成绩
!pp           PP+ 面板
!skill        技能雷达
!ml           比赛观战
!ra           系列 rating
!rec / 荐图   推图推荐
~ / 查 @某人   osu! 信息卡
/rd           谱面难度推荐
```

## 配置

- **数据位置**：默认 `%APPDATA%\Wuxin\db.json`，可用 `DATA_DIR` 环境变量覆盖。
- **模型**：`.env` 中配置 `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_API_BASE_URL` /
  `LLM_MODEL`，控制台「模型」页可运行时切换。
- **安全**：设置 `ADMIN_PASSWORD` 后，所有本地管理 API 均需认证。
- **知识库**：默认关闭（`KB_ENABLED=false`），设计文档见
  [docs/KNOWLEDGE_BASE_V41.md](docs/KNOWLEDGE_BASE_V41.md)。

## 开发与测试

```bash
npm run dev        # 开发模式（后端 tsx watch + 前端 Vite）
npm run build      # 构建前端
npm run typecheck  # TypeScript 类型检查
npm run check      # 类型检查 + 构建 + 基础 / 安全验证
npm run sanity     # 基础集成测试
npm run verify-all # 运行全部验证脚本
```

仓库包含大量针对核心链路的验证脚本（意图识别、快捷路由、osu! 数据、
推荐引擎、队列、备份、知识库等），改动后建议运行 `npm run check` 与
`npm run verify-all`。

## 常见问题

- **Node 版本**：启动代码已规避 Node 20.11 的 happy-eyeballs 并发崩溃；
  若仍遇到问题，建议使用 Node 22。`启动Wuxin.bat` 会优先使用
  `portable-node`（若存在）。
- **发图失败**：图片渲染依赖 yumu-image；确认 `YUMU_NODE` / `YUMU_DIR`
  配置且渲染器已启动，未配置时自动降级为文字回复。
- **知识库未生效**：`KB_ENABLED=false` 是启动级硬开关，数据库总开关
  也需开启；两者都满足才会注入知识。
- **数据目录**：非测试模式要求 `DATA_DIR` 指向明确目录，多实例请勿
  共用同一数据文件。

## 许可与致谢

- WuxinBot 主体代码采用 MIT License，见 [LICENSE](./LICENSE)。
- `server/osu/matchRating.ts` 与 `server/osu/match.ts` 派生自
  [yumu-bot/yumu-bot](https://github.com/yumu-bot/yumu-bot)（Apache-2.0），
  来源 commit、修改说明与许可证全文见
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 与
  [LICENSE.yumu-bot](./LICENSE.yumu-bot)。

> 本项目是 AI 辅助开发实验项目：代码主要由 AI 工具生成、修改和重构，
> 人工负责需求设计、功能测试、问题反馈与最终整合。可能存在代码风格
> 不统一等问题，欢迎 issue 与 PR。
