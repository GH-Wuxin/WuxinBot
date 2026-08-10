# WuxinBot 外部集成指南

本文档说明 WuxinBot 与 NapCat / OneBot、LLM、osu! API 以及可选的
Yumu / Kanon / Hydrant / LazyBot 四台外部 Bot 的集成方式。所有部署相关路径
都可以通过环境变量或 `.env` 覆盖，仓库内不包含本机路径。

## 1. 总览

```text
QQ 群消息
  → NapCat / OneBot v11（HTTP + WebSocket）
  → Wuxin server（server/onebot.ts → server/bot.ts）
  → LLM（DeepSeek / OpenAI 兼容接口）
  → 回复：直接发送，或经 yumu-image 渲染成图片

可选：
  Yumu / Kanon / Hydrant / LazyBot
    → 各自 OneBot WebSocket server
    → Wuxin 作为第二客户端直连调用（server/bots/localBridge.ts）
```

## 2. 最小配置（.env）

复制 `.env.example` 为 `.env`，至少配置：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=你的Key
ADMIN_PASSWORD=控制台密码
OSU_CLIENT_ID=你的osu客户端ID
OSU_CLIENT_SECRET=你的osu客户端Secret
```

`server/index.ts` 启动时会通过 `dotenv` 读取仓库根目录的 `.env`。
`tools/*.ps1` 运维脚本也会读取同一个 `.env`（参数 > 环境变量 > `.env`）。

## 3. NapCat / OneBot

1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ)（或任意兼容 OneBot v11 的客户端），
   登录机器人 QQ 小号。
2. 运行 `tools/enable-napcat-local-onebot.ps1` 写入本机 OneBot 配置：

   ```powershell
   .\tools\enable-napcat-local-onebot.ps1 -NapCatDir <NapCat目录> -QQ <机器人QQ> -HttpPort 3000 -WsPort 3001
   ```

3. 在控制台「QQ连接」页面填写 HTTP `http://127.0.0.1:3000` 与
   WebSocket `ws://127.0.0.1:3001`，保存并连接。

### 运维脚本

- `tools/start-napcat.ps1`：启动 NapCat。需要
  `NAPCAT_SHELL_DIR`（NapCat Shell 目录）、`NAPCAT_USER_DATA_DIR`（QQ 数据目录）
  与可选的 `NAPCAT_LAUNCHER_NAME`（为空时自动探测 `NapCatWinBootMain*.exe`）。
- `tools/wuxin-guard.ps1`：守护 Wuxin、NapCat（监听 3001）与 yumu-image。
  yumu-image 需要 `YUMU_NODE` 与 `YUMU_DIR`；未配置时跳过该守护项。
- `tools/restart-wuxin.ps1`：重启 Wuxin，优先使用项目自带 `portable-node`。

## 4. LLM

默认 DeepSeek，支持任意 OpenAI 兼容端点：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=
LLM_API_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

可选 `MIMO_API_KEY` / `MIMO_API_BASE_URL` 作为第二供应商。注意「自动模型切换」
开启时，复杂任务可能调用更强（也更贵）的模型。

## 5. osu! API

Analyze / Recent / Recommend / Match 等功能使用 osu! API v2 的
client credentials 授权：

```dotenv
OSU_CLIENT_ID=
OSU_CLIENT_SECRET=
OSU_API_BASE_URL=https://osu.ppy.sh/api/v2
OSU_TOKEN_URL=https://osu.ppy.sh/oauth/token
```

在 osu! 官网 OAuth 页面创建应用并填入客户端 ID/Secret。PP+（pp+ 相关面板）
是可选的本机服务，可在控制台单独配置。

## 6. 外部 Bot 桥接（可选）

四个原始 Bot 各自运行一个 OneBot WebSocket server，Wuxin 以第二客户端身份
直连并转发指令、取回渲染结果，不经过 QQ 转发：

| Bot | Bridge 端点 | 说明 |
| --- | --- | --- |
| Yumu（雨沐） | `ws://127.0.0.1:8388/pub/onebotSocket` | 渲染经 yumu-image |
| Kanon（猫猫） | `ws://127.0.0.1:7700/` | messageArray |
| Hydrant（消防栓） | `ws://127.0.0.1:8800/` | 需要 ServerAccessToken |
| LazyBot | `ws://127.0.0.1:1145/lazybot` | 绑定同步需要 MariaDB |

### 相关环境变量

```dotenv
# 外部 Bot 部署根目录（默认 ./external-bots）
BOTS_ROOT=

# 单独覆盖某个配置文件
LAZYBOT_CONFIG_PATH=
HYDRANT_CONFIG_PATH=
GROUP_BOT_CONFIG_PATH=

# 非 yumu 桥接会话使用的 self id（默认是公开占位号）
BRIDGE_SELF_ID=
```

默认目录布局（可用 `BOTS_ROOT` 整体替换）：

```text
<BOTS_ROOT>/
  configs/
    group-bot-config.json          # 控制台写入的群级开关
    private/hydrant/appsettings.json
    private/lazybot/application.yaml
  runtime/mariadb-*/bin/mysql.exe  # LazyBot 绑定同步用
  sources/yumu-image/              # 渲染器
```

行为说明：

- **群级开关**：控制台「osu」页面的群 Bot 开关写入 `GROUP_BOT_CONFIG_PATH`
  （默认 `<BOTS_ROOT>/configs/group-bot-config.json`），外部 Bot 读取同一文件。
- **LazyBot 绑定同步**：`/w osu bind` 会同时把绑定镜像进 LazyBot 的
  MariaDB `token` 表。MariaDB CLI 或配置不可用时静默跳过，Wuxin 自身绑定不受影响。
- **Hydrant 鉴权**：`hydrantToken()` 从 `HYDRANT_CONFIG_PATH` 读取
  `Hydrant.ServerAccessToken`；文件不存在时按空 token 处理。
- **降级**：外部 Bot 不在线时，桥接调用超时并回退到 Wuxin 内部实现
  （例如 !ml 的内部 MatchListener）。没有外部 Bot 时大部分功能仍可使用，
  但原始渲染面板（yumu-image 图片）不可用。

### 安全提示

- 所有 Bridge 端点都只监听 `127.0.0.1`，不要暴露到公网。
- `HYDRANT_CONFIG_PATH` / `LAZYBOT_CONFIG_PATH` 指向的文件含访问令牌或数据库
  密码，注意文件权限，不要提交到 git。
- `ADMIN_PASSWORD` 保护所有本地管理 API；生产环境务必设置。

## 7. 第三方许可证

- WuxinBot 主体：MIT（见根目录 `LICENSE`）。
- `server/osu/matchRating.ts`、`server/osu/match.ts`：派生自
  [yumu-bot/yumu-bot](https://github.com/yumu-bot/yumu-bot)（Apache-2.0），
  来源与修改说明见 `THIRD_PARTY_NOTICES.md`，全文见 `LICENSE.yumu-bot`。

## 8. 常见问题

- **Node 版本**：请使用项目自带 `portable-node`（Node 22）。系统 Node 20 存在
  happy-eyeballs 并发连接崩溃问题。
- **数据目录**：默认 `%APPDATA%\Wuxin\db.json`，可用 `DATA_DIR` 覆盖；
  `server/store.ts` 在非 test 模式下要求 `DATA_DIR` 指向明确目录。
- **推送图片失败**：确认 yumu-image 已启动，且 `YUMU_NODE` / `YUMU_DIR` 正确；
  图片输出缓存在 `data/` 下，属运行时数据。
