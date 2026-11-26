# 本地知识库

知识库为聊天补充本地帮助、osu! 概念和经过审核的表达样本，使用 BM25 文本检索。它是可选功能，新安装默认关闭。当前功能状态和权限应查询 `/w help` 或运行时的 `inspect_capabilities`；知识库中的帮助是构建时生成的资料。

## 内容来源

| 集合 | 内容来源 |
| --- | --- |
| `wuxin_self` | 指令注册表生成的语法、权限和帮助，以及维护者编写的功能说明 |
| `osu_domain` | `server/osu/knowledge/` 中的领域资料 |
| `community_style` | 经过筛选和隐私审阅的社区表达样本 |

指令注册表位于 [server/bot/commands](../server/bot/commands)。新增指令时修改对应元数据，帮助和知识库构建复用这些定义。构建会检查示例语法、权限和指令标识。

社区原始聊天不应直接放进知识库。相关导入和人工审阅工具见 [community-corpus](../community-corpus/README.md)。没有本地批准样本时，可以跳过该集合构建。

## 构建

在仓库根目录执行，显式指定目标数据目录：

```powershell
npx tsx tools/kb-build.mjs --data-dir '.\data\kb-preview' --skip-community
```

上例在独立目录生成不含社区样本的预览。正式构建时将 `--data-dir` 改为实际业务数据目录；准备好批准语料后移除 `--skip-community`。

生成文件位于目标目录下：

```text
knowledge/
  CURRENT
  builds/<内容哈希>/
    wuxin_self.json
    osu_domain.json
    community_style.jsonl
    manifest.json
```

构建器先写入临时目录、校验内容，再替换 `CURRENT` 指针。运行时核对清单和文件哈希，通过后才加载内容。

## 开关与更新

| 设置 | 行为 |
| --- | --- |
| 环境变量 `KB_ENABLED=false` | 本次进程启动期间禁用知识库 |
| `settings.kb.enabled` | 运行时总开关 |
| `settings.kb.rollout` | `mode` 为 off、allowlist 或 all；allowlist 使用 `groupIds` |
| `settings.kb.collections` | 分别设置 wuxinSelf、osuDomain、communityStyle |
| `knowledge/DISABLED` 文件 | 文件存在时暂停知识库使用 |

启动时只读取一次 `CURRENT`，固定本次进程使用的构建版本。运行中可以调整数据库中的功能和群范围开关，但替换构建或解除 `KB_ENABLED=false` 后需要重启后端。启动时没有有效构建的进程，也需在构建完成后重启。

这些设置当前保存在业务配置中，状态可通过已认证的 `GET /api/kb/status` 查看。正式启用前先检查生成内容，再用指定群验证，不需要重置原有消息、绑定或记忆。

## 检索与隐私

聊天按知识库自己的路由选择集合，再根据最近的真人文本检索相关片段。显式指令和确定性数据结果不依赖这套检索；加载失败时保留普通回复流程。运行时的按需功能与消息查询另见 [pippi-awareness.md](pippi-awareness.md)。

权限过滤使用指令元数据。社区文本作为表达参考，不应逐句转述或冒充当前群友的发言。日志保存路由、结果标识、耗时和群号哈希，不记录原始检索文本或完整资料。

阈值随构建清单保存。修改语料或阈值后应重新构建并检查结果，文档数量与检索结果以本次构建报告为准。

## 验证与排查

```powershell
npx tsx tools/kb-verify.mjs
npm run typecheck
```

验证覆盖构建、权限、检索、指令示例、禁用行为和内容校验。隔离结果为 `INCONCLUSIVE` 时，表示无法确认生产库未变化，不能当作通过。

状态中的 `KB_CURRENT_MISSING` 表示启动时没有找到有效构建。核对数据目录和 `CURRENT`，构建完成后重启后端。实现见 [knowledgeBase.ts](../server/bot/knowledgeBase.ts)，构建入口见 [kb-build.mjs](../tools/kb-build.mjs)。
