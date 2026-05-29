# Wuxin QQ AI ChatBot

QQ 群聊 AI 机器人，通过 NapCat OneBot 协议接入 QQ，带中文 React GUI 控制台。

## Quick Start

```bash
npm run dev          # 同时启动 server(:8787) + vite(:5173)
npm run build        # 构建前端到 dist/
npm run sanity       # 集成测试 (会读写真实 db.json，测试后自动还原)
npm run structure    # 模块结构检查 (duplicateImports 应为 0)
```

启动脚本: `启动Wuxin.bat` (portable-node + 自动构建 + 端口清理 + 打开浏览器)

## Architecture

```
NapCat QQ → OneBot WS(:3001) → server/onebot.ts → server/bot.ts → LLM → OneBot HTTP(:3000) → QQ
                                      ↑
React GUI ← Vite :5173 ← Express :8787 ← server/store.ts → %APPDATA%/Wuxin/db.json
```

## Tech Stack

- **Runtime**: Node.js 20+, ESM (`"type": "module"`), TypeScript via tsx (no compile step)
- **Backend**: Express 5.2.1, ws 8.20.1
- **Frontend**: React 19.2.6, Vite 5.4.21, lucide-react
- **LLM**: openai SDK 6.38.0 (DeepSeek + OpenAI-compatible APIs)
- **Data**: JSON file (`%APPDATA%\Wuxin\db.json`), no SQLite

## File Structure

```
server/
  index.ts          Express API routes + backup/health/group-profile
  bot.ts            主流程: processIncoming(), decideReply(), 所有 /w 指令
  store.ts          JSON DB: readDb/writeDb/updateDb, DATA_DIR, 默认数据
  onebot.ts         WebSocket 接收 + HTTP 发送 + 合并转发
  health.ts         内存健康状态 (连接/LLM/暂停/错误/重算进度)
  backup.ts         DB 备份/恢复/轮转 (每8h自动, 最多10份)
  types.ts          TypeScript 接口定义 (BotEvent, Db, MemoryEntry 等)
  bot/
    cleaning.ts     CQ 码解析, 消息清洗, 图片提取, 卡片占位
    llm.ts          统一 LLM 层 (DeepSeek/OpenAI-compatible), 多模态图片
    prompt.ts       buildPrompt, 复杂度评分, 自动模型选择, 定价
    reply.ts        输出清洗, 分段发送, 改写, 合并转发, isWeirdReply
    memory.ts       个人画像 (语境感知, 风险分级, 长期/近期分层, 图片摘要)
    groupProfile.ts 群聊画像 (V2自动更新, LLM+手动编辑)
    signals.ts      互动信号抽取 (纯规则, 不调LLM)
    trust.ts        自动信任分 (规则评分, 三档升降级)
    relationshipProfile.ts  关系画像 (pair维度, 敏感关系硬约束)
    search.ts       SearXNG 搜索适配器, extractSearchQuery, 超时控制
    commands.ts     权限角色, 指令解析, 日志
    deepseek.ts     废弃 (兼容重导出)
    commandHandlers.ts  备用 (未接入主流程)
src/
  App.jsx           单文件 React GUI (86KB, 9个页面)
  styles.css
tools/
  sanity.mjs        集成测试 (读写真实 db.json, 测试后还原)
  structure-report.mjs  模块结构检查
```

## Key Patterns

### 数据库
- 单 JSON 文件, `readDb()` → mutate → `writeDb()` 原子操作
- `normalizeDb()` 补全缺失字段, 合并默认权限/角色
- `publicDb()` 脱敏 (apiKey/oneBotAccessToken/adminPassword 不返回明文)
- 数据目录: `process.env.DATA_DIR || %APPDATA%\Wuxin`

### LLM 调用
- `callLLM(messages, options)` — 统一入口, 支持 overrideModel/timeoutMs/searchMode
- `completeChat(messages, options)` — 底层, 返回 `{ text, usage }`
- DeepSeek 官方接口 (`api.deepseek.com`) 强制纯文字, 不走多模态
- `openai-compatible` + visionMode=auto/on 时支持图片 (image_url 格式)
- 本地/内网图片默认转 data URL

### 画像系统 (memory.ts, 最复杂的模块)
- 画像写入前必判: subject(self/other/bot/topic) + addressee + observationType
- 长期画像 + 近期动态两层, 近期动态 7天降权/14天移除
- 空画像/占位画像 (`暂无...`) 不算有效画像, 会触发补画像 (30min冷却)
- 图片只以 `image-summary` 低权重样本进入画像
- 画像 JSON 非法时低温重试一次 "只修 JSON"

### 指令系统
- 所有指令 `/w` 前缀 (也支持 `/wuxin`)
- 权限层级: guest(0) < trusted(20) < admin(60) < owner(100)
- Owner 来自 `db.settings.ownerQq`, 全局生效
- 长输出用合并转发 (`sendForwardText`) 不刷屏

### 回复决策 (decideReply)
- 权重系统: policyWeight + attentionLevel + mentioned + isQuestion + ...
- 群模式: silent/mention/light/natural
- 全局暂停/只@模式 覆盖一切
- 并发锁: `activeReplyGroups` 防同群同时回复

## Key Constraints

- **信任成员 ≠ 管理员**: 只给互动待遇 (回复权重+25/窗口5min/记忆0.6×), 不给管理权限
- **关系画像禁写敏感关系**: 情侣/夫妻/父子等词在输出端直接 strip
- **纯人设模式**: `/w sysfacts on` 跳过全部底层注入, LLM 只看到 personalityPrompt
- **长期画像防近因污染**: 短期高频话题先进入"近期动态", 不能一晚覆盖长期画像
- **数据不进 Git**: `.gitignore` 屏蔽 `data/` `.env`, DB 在 `%APPDATA%\Wuxin`
- **备份恢复安全**: JSON 校验 + pre-restore 自动备份 + safeBackupName 防路径穿越
- **图片记忆护栏**: 画像更新 prompt 禁止仅凭图片推断人格/身份/心理状态

## Environment Variables

```
LLM_PROVIDER=deepseek          # deepseek | openai-compatible
LLM_API_KEY=                   # API key
LLM_API_BASE_URL=https://api.deepseek.com
ADMIN_PASSWORD=                # GUI 登录密码
DATA_DIR=                      # 默认 %APPDATA%\Wuxin
PORT=8787                      # Express 端口
```

## Verification Checklist

改动后必须通过:
1. `npm run build` — 前端构建无报错
2. `npm run sanity` — 集成测试 (会临时修改 db.json, 测试后自动还原)
3. `npm run structure` — duplicateImports: 0

## Common Tasks

### 添加新指令
1. 在 `server/bot/commands.ts` 的 `helpDefs` 中添加定义
2. 在 `server/bot.ts` 的 `handleOwnerCommand()` 中添加处理分支
3. 在 `server/store.ts` 的 `defaultCommandPermissions` 中添加权限键
4. 运行 `npm run sanity` 验证

### 修改画像逻辑
- 主文件: `server/bot/memory.ts` (50KB, 最大最复杂的模块)
- 画像字段: summary, traits, speechStyle, behavior, preferences
- 空画像检测: `isEmptyProfileText()` + `hasProfileContent()`
- 样本去重: `sampleKey()` (基于 messageId) + `sampleLooseKey()` (基于群+天+内容)

### 修改 LLM 调用
- 统一入口: `server/bot/llm.ts` 的 `callLLM()` / `completeChat()`
- 多模态: `prepareImageAttachments()` 处理图片附件
- 模型选择: `server/bot/prompt.ts` 的 `autoModelForTask()` + `taskComplexityScore()`

### 修改 GUI
- 单文件: `src/App.jsx` (86KB, 9个页面)
- 代理: vite dev 代理 `/api` 到 `http://127.0.0.1:8787`
- 构建输出: `dist/`
