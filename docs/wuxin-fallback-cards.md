# 外部查询失败时的备用卡片

外部 Bot 查询失败、返回空结果或端点不可用时，受支持的查询可以使用 Wuxin 自己的卡片。外部 Bot 成功返回时保留原始结果，备用流程不会另找第二个外部 Bot 生成图片。

## 支持范围

| 查询 | 行为 |
| --- | --- |
| 最近成绩、最近通过 | 支持序号；先筛选通过记录，再取序号。通过查询最多检查最近 100 条 |
| BP 列表 | 支持 1–100 名的单项和范围，列表每页 8 条 |
| 指定谱面成绩 | 保留原 BID 和 Mods 条件 |
| 玩家资料 | 公开 osu!standard 统计 |
| PP+ | 使用已有缓存或已完成任务；该备用流程不启动新计算 |

缺少字段显示 `—`，真实零值保留为零。玩家或谱面不匹配时停止交付；缺少对应 Mods 的星数时不拿 NM 星数代替，也不补造 FC/SS 估算或技能维度。

没有成绩、不支持的操作和明确指定的非 standard 模式会得到错误卡片。本地渲染失败时改为说明实际错误的文字。

## 图片与缓存

卡片使用 1280 × 720 布局，复用玩家能力卡片的字体与浏览器渲染器，版本标识为 `WUXIN_QUERY_CARD_V2`。它展示查询数据，不代表执行了 Skill Profiler 分析。

成绩卡使用谱面背景，BP 列表各页共用第一条成绩的背景；玩家和 PP+ 卡片可使用玩家封面。头像和背景下载受时限约束，缺少图片时仍能显示已有数据。

PNG 位于 `DATA_DIR/wuxin-query-cards`。清理按 256 个文件、128 MiB 和七天保留条件执行。具体数据检查与渲染实现见 [wuxinFallback.ts](../server/bots/wuxinFallback.ts)和[wuxinFallbackCard.ts](../server/bots/wuxinFallbackCard.ts)。

## 验证与预览

在仓库根目录运行：

```powershell
node --import tsx tools/wuxin-fallback-verify.mjs
node --import tsx tools/wuxin-fallback-bg-verify.mjs
node --import tsx tools/wuxin-fallback-routing-verify.mjs
npm run score:command:verify
npm run evidence:verify
```

测试使用隔离数据和模拟接口。运行前用 `WUXIN_PRODUCTION_DATA_DIR` 指明需要保护的正式数据目录；直接运行 evidence 验证器时还应给出独立的 `DATA_DIR`。

需要预览时设置 `FALLBACK_PREVIEW_DIR`，再为 `wuxin-fallback-verify.mjs` 添加 `--render`。背景预览还需将 `FALLBACK_BG_FILE` 指向本地谱面 JPEG，再运行 `wuxin-fallback-bg-verify.mjs --render`。预览中的成绩和玩家字段是测试数据。

`FALLBACK_VERIFY_ROOT` 可让路由验证器加载指定安装目录的后端，测试数据仍需隔离。
