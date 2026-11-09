# OneBot、模型与 osu! 集成

WuxinBot 的 QQ 连接、模型和外部 Bot 分别配置。基础启动步骤见 [README](../README.md#开始使用)，组件启停见 [Desktop 使用说明](DESKTOP_CLIENT.md)。

## OneBot v11

安装并登录 [NapCatQQ](https://github.com/NapNeko/NapCatQQ)，或使用兼容 OneBot v11 的客户端。WuxinBot 通过 WebSocket 接收事件，通过 HTTP 发送消息和查询回执。

在控制台“集成”页填写 Bot QQ、Owner QQ、HTTP 地址、WebSocket 地址及访问令牌。本机默认地址为 `http://127.0.0.1:3000` 和 `ws://127.0.0.1:3001`，须与 OneBot 客户端一致。

已有 NapCat Shell 实例可以使用仓库脚本配置本地接口。先登录目标 QQ，再在仓库根目录执行，替换目录和账号：

```powershell
.\tools\enable-napcat-local-onebot.ps1 -NapCatDir 'D:\NapCat' -QQ '机器人QQ号' -HttpPort 3000 -WsPort 3001
```

脚本会备份并修改对应的 `config/onebot11_<QQ>.json`。Desktop 的 NapCat 启动路径、工作目录和 QQ 数据目录仍需在“运行控制”中核对。

## 模型

在“模型 → 账号与模型”中设置供应商、API 地址、模型名和密钥。源码首次启动也可通过仓库根目录的 `.env` 初始化：

```dotenv
LLM_PROVIDER=openai-compatible
LLM_API_BASE_URL=https://你的模型服务地址/v1
LLM_MODEL=供应商提供的模型名
LLM_API_KEY=你的密钥
ADMIN_PASSWORD=你的管理密码
```

DeepSeek 通道使用 `LLM_PROVIDER=deepseek`。模型名称、图片输入和推理参数是否可用，取决于所选服务与模型；保存后用实际对话验证。项目内的模型别名由代码维护，见 [模型配置](../server/bot/llm.ts)。

Codex App Server 使用独立的登录和模型配置，见 [Codex 接入](CODEX_CHATGPT_PROVIDER.md)。

`.env` 中的模型和管理密码是新数据库的初始值。已有数据库保留保存过的设置，修改配置后应在控制台核对实际值。远程模型会接收本轮所需上下文，密钥及真实配置不应提交到仓库。

## osu! API 与分析服务

在“osu!”页填写 OAuth Client ID 和 Secret，或首次启动前配置：

```dotenv
OSU_CLIENT_ID=你的客户端ID
OSU_CLIENT_SECRET=你的客户端Secret
```

玩家和成绩查询使用 osu! API v2。PP+、Skill Profiler、外部 Bot 及渲染器是独立服务，启用相应功能前需配置并确认它们可用。官方资料搜索的开关和覆盖范围见 [搜索说明](OSU_SEARCH.md)。

## 外部 Bot

WuxinBot 通过本地 WebSocket 调用外部 Bot，取得文字或图片后，再由自己的 QQ 账号发送结果。当前集成的默认端点如下；部署时以各组件实际配置为准。

| 组件 | 默认端点 | 相关依赖 |
| --- | --- | --- |
| Yumu | `ws://127.0.0.1:8388/pub/onebotSocket` | yumu-image 渲染器 |
| Kanon | `ws://127.0.0.1:7700/` | Kanon 的配置与图片资源 |
| Hydrant | `ws://127.0.0.1:8800/` | `Hydrant.ServerAccessToken` |
| LazyBot | `ws://127.0.0.1:1145/lazybot` | 绑定同步所用的 MariaDB |

后端通过以下变量定位外部组件配置：

| 变量 | 用途 |
| --- | --- |
| `BOTS_ROOT` | 外部 Bot 部署根目录；独立启动后端时默认取当前工作目录下的 `external-bots` |
| `LAZYBOT_CONFIG_PATH` | LazyBot 的数据库配置 |
| `HYDRANT_CONFIG_PATH` | Hydrant 的访问令牌配置 |
| `GROUP_BOT_CONFIG_PATH` | 各群外部 Bot 开关文件 |
| `BRIDGE_SELF_ID` | 非 Yumu 桥接会话使用的账号标识 |

默认配置相对 `BOTS_ROOT` 存放于 `configs/private/lazybot/application.yaml`、`configs/private/hydrant/appsettings.json` 和 `configs/group-bot-config.json`。Desktop 会向自己启动的后端传入部署根目录及部分配置路径，因此也要检查“运行控制”中的环境变量覆盖项。

在“群聊”页分别设置各群使用的 Bot。绑定指令 `/w osu bind` 会尝试同步 LazyBot；同步依赖不可用时，WuxinBot 自身的绑定仍保留。

部署后检查各服务实际监听的地址，限制在本机或受控网络，并按组件要求配置令牌。

## 结果和失败处理

外部 Bot 成功返回时保留它的原始结果。支持的查询可以在外部调用失败后使用 Wuxin 自己的备用卡片；其他情况返回实际错误。适用范围和图片预览方法见 [备用卡片说明](wuxin-fallback-cards.md)。

图片发送失败时，先区分外部查询、图片生成和 QQ 发送哪个环节失败，再检查对应服务。OneBot 的 HTTP 成功不代表消息业务成功，WuxinBot 还会核对 `status/retcode` 和消息回执。

本仓库包含两项可选组件维护说明：

- [PP+ 聚合服务补丁](../patches/README.md)：首次查询任务接口与客户端兼容关系。
- [Kanon Mod 图标](../patches/kanon-mod-icons/README.md)：资源覆盖方式和来源声明。

相关检查可运行 `npm run onebot:delivery:verify`、`npm run score:command:verify` 和 `npm run pplus:verify`。许可证见 [第三方声明](../THIRD_PARTY_NOTICES.md)。
