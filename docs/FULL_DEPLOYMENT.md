# WuxinBot Full Deployment Guide

本文档说明如何从空环境部署到接近维护者本地 reference stack 的完整功能状态。

---

## 1. Scope

### 1.1 三种部署级别

| 级别 | 范围 | 适用场景 |
|------|------|----------|
| **Core** | WuxinBot + OneBot + LLM | 最小可运行：QQ 收发消息、LLM 对话、确定性路由 |
| **Full Feature** | Core + osu! API + PP+ + 渲染 + KB + 外部 Bot | 完整功能：osu! 工作流、图片面板、知识库、外部 Bot 桥接 |
| **Reference** | Full Feature + 维护者兼容的组件版本与补丁 | 尽可能复现维护者本地的完整功能行为 |

### 1.2 "功能复现"不等于"复制维护者数据"

本文档描述的是**组件部署与配置**，不包含：

- QQ 聊天记录、用户记忆、关系画像
- `db.json` 运行时数据
- API Key、Token、Cookie、密码
- 私有群配置、owner QQ 号
- 维护者的 `.env` 文件内容

部署完成后，你需要自己创建 QQ Bot 账号、申请 osu! OAuth、配置 LLM API Key。

---

## 2. Deployment Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                        QQ 群聊 / 私聊                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ OneBot v11
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  NapCatQQ (OneBot HTTP :3000 / WebSocket :3001)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  WuxinBot (:8787)                                               │
│  ├─ server/onebot.ts        ← OneBot 连接层                     │
│  ├─ server/bot.ts           ← 消息路由 & LLM 编排               │
│  ├─ server/bots/executor.ts ← 有界工具循环                       │
│  ├─ server/bots/localBridge.ts ← 外部 Bot WebSocket 桥接        │
│  ├─ server/bots/renderServer.ts ← yumu-image 渲染服务           │
│  ├─ server/osu/             ← osu! 工作流                       │
│  └─ server/bot/             ← LLM / Memory / KB / Reasoning     │
│                                                                  │
│  GUI: Vite (:5173 dev / :8787 static)                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐
│  LLM         │  │  osu! API v2 │  │  External Bots (optional)    │
│  (DeepSeek   │  │  (client     │  │  ├─ YumuBot (:8388)          │
│   or any     │  │   credentials│  │  ├─ KanonBot (:7700)         │
│   OpenAI-    │  │   OAuth)     │  │  ├─ Hydrant  (:8800)         │
│   compatible)│  │              │  │  ├─ LazyBot   (:1145)        │
└──────────────┘  └──────────────┘  │  └─ yumu-image renderer      │
                                    └──────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  PostgreSQL  │  │  MariaDB     │  │  PP+         │
│  (Yumu,      │  │  (Kanon,     │  │  (aggregate) │
│   Hydrant)   │  │   LazyBot)   │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

### 组件说明

| 组件 | 作用 | Core 必需 | Full Feature 必需 |
|------|------|-----------|-------------------|
| NapCatQQ | OneBot v11 实现，连接 QQ | Yes | Yes |
| WuxinBot | 核心 Agent 运行时 | Yes | Yes |
| LLM | OpenAI-compatible 端点 | Yes | Yes |
| osu! API | 玩家数据、成绩、谱面 | No | Yes |
| YumuBot | 外部 Bot（雨沐） | No | Optional |
| KanonBot | 外部 Bot（猫猫） | No | Optional |
| Hydrant | 外部 Bot（消防栓） | No | Optional |
| LazyBot | 外部 Bot | No | Optional |
| PP+ | pp+ 数据聚合 | No | Optional |
| yumu-image | 图片渲染器 | No | Optional |
| PostgreSQL | YumuBot / Hydrant 数据库 | No | If using Yumu/Hydrant |
| MariaDB | KanonBot / LazyBot 数据库 | No | If using Kanon/LazyBot |
| KB | 知识库（默认关闭） | No | Optional |

---

## 3. Reference Component Matrix

> 以下版本号来自本地 `napcat-local-bots/sources` 目录的实际 git 状态（2026-08-08 验证）。
> 标注 **TODO** 的条目需要维护者补充。

| Component | Repo | Pinned Revision | Runtime | Database | Modified | Required |
|-----------|------|-----------------|---------|----------|----------|----------|
| **WuxinBot** | [GH-Wuxin/WuxinBot](https://github.com/GH-Wuxin/WuxinBot) | `2dde60f` (verified baseline) | Node.js | - | No | Yes |
| Node.js | [nodejs/node](https://github.com/nodejs/node) | see below | - | - | No | Yes |
| NapCatQQ | [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | QQ 9.9.26 / build 44498 | Node.js | - | No | Yes |
| LLM | OpenAI-compatible | **N/A (SaaS)** | SaaS | - | No | Yes |
| osu! API v2 | [osu-api](https://osu.ppy.sh/docs) | v2 | SaaS | - | No | Full Feature |
| YumuBot | [yumu-bot/yumu-bot](https://github.com/yumu-bot/yumu-bot) | `01c0526` | JDK 21.0.11 | PostgreSQL 16.10 | Yes (1 file) | Optional |
| KanonBot | [desu-life/Bot](https://github.com/desu-life/Bot) | `cf36aa2` | .NET 10.0.302 | MariaDB 11.4.12 | **Yes (23 files, heavy)** | Optional |
| Hydrant | [b11p/OsuQqBotForNewbieGroup](https://github.com/b11p/OsuQqBotForNewbieGroup) | `50a25ce` | .NET 10.0.302 | PostgreSQL 16.10 | Yes (4 files) | Optional |
| LazyBot | [Apeuriox/lazybot-renewal](https://github.com/Apeuriox/lazybot-renewal) | `5c1cd4b` | JDK 21.0.11 | MariaDB 11.4.12 | Yes (7 files) | Optional |
| yumu-image | [yumu-bot/yumu-image](https://github.com/yumu-bot/yumu-image) | `38df704` | Node.js v22.23.1 | - | Yes (3 files) | Optional |
| rosu-pp-java | [Apeuriox/rosu-pp-java](https://github.com/Apeuriox/rosu-pp-java) | `c9c1d3f` | JDK 21.0.11 | - | No | Optional |
| PP+ | [Syriiin/difficalcy-performanceplus](https://github.com/Syriiin/difficalcy-performanceplus) | Docker `ghcr.io/syriiin/difficalcy-performanceplus` | Docker | - | No | Optional |
| PostgreSQL | [postgres/postgres](https://github.com/postgres/postgres) | 16.10 | - | - | No | If Yumu/Hydrant |
| MariaDB | [MariaDB/server](https://github.com/MariaDB/server) | 11.4.12 | - | - | No | If Kanon/LazyBot |

> **dirty** = 本地有未提交修改。所有 dirty 条目在 reference deployment 中必须使用本地修改版本，不能用 pristine upstream。
>
> **WuxinBot revision** = 已验证的 runtime/code baseline，不等于本文档所在 commit。GitHub Release / tag 负责标识包含文档 + reference-stack.json 的发布点。

### Node.js 版本说明

| 角色 | 版本 | 说明 |
|------|------|------|
| **Reference** | v22.14.0 | 维护者本地 portable-node，reference deployment 应使用此版本 |
| **Known tested** | v20.11.1 | 维护者系统 Node，已确认可运行，但非 reference |
| **Minimum supported** | TODO | 仅测过 v20.11.1，不能推广为所有 v20.x |

> 不要将单一 tested version 推广为 `>=` 范围。Reference deployment 应使用 v22.14.0。

---

## 4. Wuxin-specific Modifications

**所有四个外部 Bot 都有本地修改，不只是 Kanon。**

### 4.1 YumuBot — 轻度修改

| 项目 | 值 |
|------|-----|
| Upstream | [yumu-bot/yumu-bot](https://github.com/yumu-bot/yumu-bot) |
| HEAD | `01c0526` |
| Dirty | **Yes — 1 file (pom.xml, 4+ / 1-)** |
| 修改范围 | 依赖版本调整 |
| Database | PostgreSQL（`jdbc:postgresql://127.0.0.1:5432/bot`） |

### 4.2 KanonBot — 重度修改

| 项目 | 值 |
|------|-----|
| Upstream | [desu-life/Bot](https://github.com/desu-life/Bot) |
| HEAD | `cf36aa2` |
| Dirty | **Yes — 23 files (317+ / 157-)** |
| 修改范围 | API、数据库、配置、账号系统、绑定命令、osu! 功能、图片渲染、PP 计算、入口 |
| Database | MariaDB/MySQL（通过 `MySqlConnector`） |

### 4.2 Hydrant — 中度修改

| 项目 | 值 |
|------|-----|
| Upstream | [b11p/OsuQqBotForNewbieGroup](https://github.com/b11p/OsuQqBotForNewbieGroup) |
| HEAD | `50a25ce` |
| Dirty | **Yes — 4 files (62+ / 9-)** |
| 修改范围 | 绑定、PP 查询、入口、核心逻辑 |
| Database | PostgreSQL |

### 4.3 LazyBot — 中度修改

| 项目 | 值 |
|------|-----|
| Upstream | [Apeuriox/lazybot-renewal](https://github.com/Apeuriox/lazybot-renewal) |
| HEAD | `5c1cd4b` |
| Dirty | **Yes — 7 files (67+ / 26-, 1 new file)** |
| 修改范围 | 权限、Token 监控、命令监听、验证、工具类、**新增 GroupBotConfig.java** |
| Database | MariaDB |

### 4.5 yumu-image — 中度修改

| 项目 | 值 |
|------|-----|
| Upstream | [yumu-bot/yumu-image](https://github.com/yumu-bot/yumu-image) |
| HEAD | `38df704` |
| Dirty | **Yes — 3 files (80+ / 67-)** |
| 修改范围 | 配置、入口重构、WebSocket 工具 |

### 4.6 match.ts / matchRating.ts

这两个文件是 WuxinBot 仓库内的代码，派生自 yumu-bot 的 MatchListener / MatchRating 模块。
来源、修改说明与许可证见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) 和 [LICENSE.yumu-bot](../LICENSE.yumu-bot)。

---

## 5. Prerequisites

### 5.1 必需（Core Deployment）

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Node.js** | v22.14.0 (reference) / v20.11.1 (known tested) | Reference deployment 使用 v22.14.0；minimum supported 未正式建立 |
| **npm** | 10+ | 随 Node.js 分发 |
| **Git** | 2.30+ | 克隆仓库 |
| **NapCatQQ** | QQ 9.9.26 / build 44498 | OneBot v11 实现 |
| **LLM API Key** | - | DeepSeek 或其他 OpenAI-compatible 端点 |

### 5.2 可选（Full Feature Deployment）

| 依赖 | 版本 | 说明 |
|------|------|------|
| **osu! OAuth** | - | 在 [osu! 官网](https://osu.ppy.sh/home/account/edit#oauth) 创建应用 |
| **Java/JDK** | 21.0.11 (Temurin) | YumuBot / LazyBot / rosu-pp-java 运行时 |
| **.NET Runtime** | 10.0.302 | KanonBot / Hydrant 运行时 |
| **PostgreSQL** | 16.10 | YumuBot / Hydrant 数据库 |
| **MariaDB** | 11.4.12 | KanonBot / LazyBot 数据库 |
| **Chromium** | - | yumu-image 渲染依赖 |

---

## 6. Recommended Directory Layout

```text
<workspace>/
├── WuxinBot/                    # 本仓库
│   ├── server/                  # WuxinBot 核心代码
│   ├── src/                     # 前端 GUI
│   ├── tools/                   # 测试与验证工具
│   ├── docs/                    # 文档
│   ├── .env                     # 环境变量（不提交）
│   └── package.json
│
├── external-bots/               # 外部 Bot 部署（可选）
│   ├── configs/
│   │   ├── group-bot-config.json
│   │   ├── private/
│   │   │   ├── hydrant/
│   │   │   │   └── appsettings.json
│   │   │   └── lazybot/
│   │   │       └── application.yaml
│   │   └── ...
│   ├── runtime/
│   │   └── mariadb-*/           # MariaDB（Kanon/LazyBot 用）
│   ├── sources/
│   │   └── yumu-image/          # 渲染器
│   ├── yumu/                    # YumuBot
│   ├── kanon/                   # KanonBot
│   ├── hydrant/                 # Hydrant
│   └── lazybot/                 # LazyBot
│
├── data/                        # 运行时数据（不提交）
│   └── Wuxin/
│       └── db.json
│
└── logs/                        # 日志（不提交）
```

> **注意**: 以上路径是通用推荐，不对应维护者本机真实路径。所有路径可通过环境变量覆盖。

---

## 7. Deployment Order

### Step 1: 数据库（Full Feature）

**PostgreSQL 16.10**（YumuBot / Hydrant）:

```bash
# 安装 PostgreSQL 16.10
# YumuBot 默认连接 jdbc:postgresql://127.0.0.1:5432/bot（用户 postgres）
# Hydrant 连接字符串通过环境变量 Xfs_ConnectionString_Postgres 配置
```

**MariaDB 11.4.12**（KanonBot / LazyBot）:

```bash
# 安装 MariaDB 11.4.12
# 创建 kanon / lazybot 数据库
# TODO: 具体初始化脚本
```

**健康检查**: 确认数据库进程运行、端口可连（PostgreSQL :5432、MariaDB :3306）。

### Step 2: PP+ Aggregate（可选）

```bash
# PP+ 使用 difficalcy-performanceplus Docker 镜像
docker run -p 9001:80 ghcr.io/syriiin/difficalcy-performanceplus:latest
```

**健康检查**: 确认 PP+ 端口（默认 9001）可连。

### Step 3: 外部 Bot（可选，Full Feature）

按以下顺序启动：

1. **YumuBot** → 确认 `:8388` 监听
2. **yumu-image renderer** → 确认 WebSocket 连接
3. **KanonBot** → 确认 `:7700` 监听
4. **Hydrant** → 确认 `:8800` 监听
5. **LazyBot** → 确认 `:1145` 监听 + MariaDB 连接

**健康检查**: 每个 Bot 启动后确认端口监听。

### Step 4: NapCatQQ

1. 安装 NapCatQQ
2. 登录 Bot QQ 账号（需要手机扫码）
3. 配置 OneBot HTTP (:3000) 和 WebSocket (:3001)

```powershell
# 使用 WuxinBot 提供的配置脚本
.\tools\enable-napcat-local-onebot.ps1 `
  -NapCatDir <NapCat目录> `
  -QQ <机器人QQ> `
  -HttpPort 3000 `
  -WsPort 3001
```

**健康检查**: 确认 `:3000` 和 `:3001` 监听，NapCat 状态为 ONLINE。

### Step 5: WuxinBot

```bash
cd WuxinBot
npm install
npm run build
```

配置 `.env`（参见第 8 节）。

```bash
npm start
```

**健康检查**:
- `http://127.0.0.1:8787` 可访问
- GUI 显示 OneBot 已连接
- 向 Bot QQ 发送消息，确认收到回复

---

## 8. Configuration Matrix

### 8.1 连接关系图

```text
WuxinBot ──→ NapCat     (WebSocket ws://127.0.0.1:3001)
           ──→ NapCat     (HTTP http://127.0.0.1:3000)
           ──→ LLM        (HTTPS api.deepseek.com or custom endpoint)
           ──→ osu! API   (HTTPS osu.ppy.sh/api/v2)
           ──→ YumuBot    (WebSocket ws://127.0.0.1:8388)
           ──→ KanonBot   (WebSocket ws://127.0.0.1:7700)
           ──→ Hydrant    (WebSocket ws://127.0.0.1:8800)
           ──→ LazyBot    (WebSocket ws://127.0.0.1:1145)
           ──→ yumu-image (WebSocket, internal renderServer)
           ──→ MariaDB    (for KanonBot / LazyBot binding sync)
```

### 8.2 .env 配置

**本文档不重新定义 env schema。** 具体字段以 [`.env.example`](../.env.example) 为唯一事实源。

复制 `.env.example` 为 `.env`，按类别填写：

| 类别 | 必需 | 说明 |
|------|------|------|
| LLM | Yes | `LLM_PROVIDER`、`LLM_API_KEY`、`LLM_API_BASE_URL`、`LLM_MODEL` |
| Server | Yes | `ADMIN_PASSWORD`、`PORT` |
| osu! API | Full Feature | `OSU_CLIENT_ID`、`OSU_CLIENT_SECRET` |
| External Bots | Optional | `BOTS_ROOT`、`HYDRANT_CONFIG_PATH`、`LAZYBOT_CONFIG_PATH`、`GROUP_BOT_CONFIG_PATH` |
| Knowledge Base | Optional | `KB_ENABLED` |

### 8.3 NapCat 配置

NapCat 需要配置：
- **HTTP API**: `http://127.0.0.1:3000`（WuxinBot 通过此端口发送消息）
- **WebSocket**: `ws://127.0.0.1:3001`（WuxinBot 通过此端口接收消息）

在 WuxinBot GUI 的「QQ连接」页面填写上述地址。

---

## 9. Verification Checklist

### 9.1 Core Deployment

- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 成功
- [ ] `npm start` 启动无错误
- [ ] `http://127.0.0.1:8787` 可访问
- [ ] NapCat WebSocket 已连接
- [ ] 向 Bot QQ 发送消息，收到 LLM 回复
- [ ] `/w help` 可正常返回命令列表

### 9.2 Full Feature — osu!

- [ ] `OSU_CLIENT_ID` 和 `OSU_CLIENT_SECRET` 已配置
- [ ] 使用 `/w help` 中的 osu! 示例命令验证内部查询
- [ ] 使用当前 match listener descriptor 中的 canonical example 验证比赛流程

### 9.3 Full Feature — 外部 Bot Bridge

- [ ] YumuBot `:8388` 在线 → 桥接调用返回面板图片
- [ ] KanonBot `:7700` 在线 → 桥接调用返回结果
- [ ] Hydrant `:8800` 在线 → 桥接调用返回结果
- [ ] LazyBot `:1145` 在线 → 桥接调用返回结果
- [ ] 外部 Bot 离线时：桥接调用具有明确超时边界（默认 45s）；调用失败或超时时不影响核心运行时；存在内部等价能力的操作回退至内部实现，否则返回可控错误给用户

### 9.4 Full Feature — PP+ & Renderer

- [ ] PP+ 聚合端口（默认 9001）可连
- [ ] yumu-image renderer 已启动
- [ ] 图片面板渲染正常（BP、match 等）

### 9.5 Full Feature — Knowledge Base

- [ ] `KB_ENABLED=true` 已设置
- [ ] `npm run verify-all` 中 KB 相关测试通过
- [ ] 向 Bot 发送知识库相关问题，确认检索命中

### 9.6 Full Verification

```bash
npm run verify-all
```

确认所有 verifier 通过（允许已知的环境依赖测试跳过）。

---

## 10. Upgrade / Rollback

### 10.1 原则

- **禁止直接跟 latest**。所有 reference component 应 pin 到具体版本/revision。
- 升级单个组件后，先测试再更新 reference-stack.json。
- WuxinBot 升级后必须运行 `npm run verify-all`。

### 10.2 普通更新（跟踪最新代码）

适用于日常开发更新，不需要精确恢复 reference 状态。

```bash
# WuxinBot
git pull
npm install
npm run build
npm run verify-all
npm start

# 外部 Bot（如有新版本）
# 1. 从 reference-stack.json 记录当前 revision
# 2. 拉取/下载新版本
# 3. 测试桥接调用
# 4. 确认无问题后更新 reference-stack.json
```

### 10.3 按 reference-stack.json 恢复 reference revision

适用于需要精确复现维护者本地 reference 状态的场景。

```bash
# WuxinBot — 恢复到 reference commit
git fetch origin
git checkout <reference-revision-from-stack.json>
npm install
npm run build
npm run verify-all
npm start

# 外部 Bot — 逐个恢复到 reference revision
# 1. 读取 reference-stack.json 中各组件的 revision
# 2. 在各组件目录执行 git fetch && git checkout <revision>
# 3. 重新 build 各组件
# 4. 重启所有服务
# 5. 运行 Verification Checklist (第 9 节)
```

> reference-stack.json 中每个组件的 `revision` 字段即为该组件的 reference commit。

### 10.4 Rollback

- WuxinBot: `git checkout <previous-revision>` + `npm install` + `npm start`
- 外部 Bot: `git checkout <previous-revision>` + 重新 build
- 数据库: 从备份恢复（WuxinBot 的 `db.json` 有自动备份）

---

## Appendix A: reference-stack.json

见 [`reference-stack.json`](./reference-stack.json)。

该文件以 machine-readable 格式记录各组件的 repo、revision、upstream base 和 modified 状态。
