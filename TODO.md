# 经验等级系统 TODO

## 设计定稿

### 群管自动识别
- OneBot `sender.role` = `owner`/`admin` → 实时判定为该群 admin 级别
- 不写入 DB，换人当群管自动跟着变
- 群主和管理员在 bot 中视为同一级别
- 群管权限仅限本群，去别的群是普通成员
- 群管**不能** `/w op`（只有 bot owner 能 op）
- bot owner (`settings.ownerQq`) 最高权限，群管不能 ban/mute bot owner
- 群管可用指令：`/w mode` `/w rate` `/w cooldown` `/w status` `/w ban` `/w trust` `/w focus` `/w quiet` `/w group profile *` `/w nick @某人` `/w style @某人`
- 群管不可用：`/w op` `/w model` `/w search` `/w prompt` `/w group add` 全局设置类

### 等级表
| Lv | 头衔 | XP | 解锁效果 |
|----|------|-----|----------|
| 0 | 🌱 新人 | 0 | — |
| 1 | 💬 群友 | 50 | 回复权重 +10 |
| 2 | 🎯 活跃群友 | 150 | 权重 +15, 记忆 ×0.8, bot 称呼联动, `/w nick` |
| 3 | ⭐ 老熟人 | 350 | 权重 +20, 对话 3min, `/w me` 看画像, `/w style` |
| 4 | 👑 核心群友 | 700 | 权重 +25, 记忆 ×0.6, 对话 5min, `/w me` 完整导出 |

### 指令
- `/w lv` — 自己等级
- `/w lv @某人` — 他人等级
- `/w top` — 当前群排行榜（仅本群成员）
- `/w nick <称呼>` — 设置称呼（Lv.2）
- `/w nick @某人 <称呼>` — 管理员设置（owner/admin）
- `/w style <内容>` — 设置个人风格（Lv.3）
- `/w style @某人 <内容>` — 管理员设置
- `/w style clear` / `/w style @某人 clear` — 清除
- `/w me` — 查看自己画像（Lv.3）

### XP 机制
- **XP 全局累计**，按 QQ 号为主键，不按群独立清零。不同群里是同一个人的等级。
- 两层结构：`userExperience[qq]`（全局，决定等级）+ `groupExperience[groupId][qq]`（群内，用于 /w top 排行和群聊氛围分析）
- 每日上限 30，只增不减
- 来源：有效消息 +1（日限15）、活跃天里程碑 +5（每3天）、多人互动 +3（日限1）、@他人 +2（日限6）
- 连续活跃加成：3天×1.2、7天×1.5、14天×2.0
- 降级：30天不活跃 → 每7天扣10% XP，降到上一级门槛时降级，最低Lv.0

### 内容过滤
- LLM 语义判断为主，不硬编码过多规则
- 基本安全边界：空内容、明显超长、控制字符、prompt 注入式内容拒绝入库
- 目标是"别死板"，不是"完全无防护"

### 升级恭喜
- LLM 生成个性化恭喜语（基于画像+等级）
- 群内按群配置开关（默认开）
- 不需要冷却机制，只需避免同一次升级事件重复触发

---

## 冲突分析（老功能联动修改）

### 必须同步修改
| 位置 | 问题 | 修改 |
|------|------|------|
| `store.ts` defaultCommandPermissions | 缺 `lv`/`top`/`nick`/`style`/`me` 权限键 | 新增 5 个键（lv=top=guest, nick=style=trusted, me=trusted） |
| `bot.ts` helpDefs | 缺新指令帮助条目 | 新增 `等级` 分组 |
| `bot.ts` isGroupAdmin 判定 (L349-353) | 只看 DB 里的 policy/allowCommands/commandRoleId | 新增 `sender.role === 'owner'/'admin'` 自动判定 |
| `bot.ts` processTrustSignal (L413) | 用旧 trustScores | 改为调用 XP 引擎 |
| `bot.ts` decideReply (L260,275) | `trustInteractionBonus` 读旧 trustScores | 改为读 `experience[level]` |
| `bot.ts` handleOwnerCommand | `/w op` 群管也能用 | 群管禁止 `/w op` |
| `index.ts` setInterval evaluateTrustScores (L426) | 每 4h 重算信任分 | 改为 XP 降级检测（30天不活跃） |
| `memory.ts` trustInteractionBonus (L344,462) | 读旧 trustScores | 改为读 experience level |
| `App.jsx` 权限页 | 指令列表缺新指令 | 自动从 commandPermissions 读取，无需手动改 |
| `App.jsx` 成员页 | 不显示等级 | 新增等级 emoji + XP 进度条 |
| `App.jsx` 设置页 | 无升级恭喜开关 | 新增 `levelUpNotifyEnabled` 设置项 |

### 不需要改但需确认兼容
- 画像系统：`memoryThresholdMul` 从 level 读取，数值不变，兼容
- 群聊画像：不受影响
- 搜索：不受影响
- 备份系统：`db.experience` 新字段自动包含在备份中
- 决策沙盒：不受影响
- `/w refresh`/`/w recalc`：重算画像时不涉及 XP

---

## 实现任务

### 群管自动识别
- [x] 0a. sender.role 读取 — `oneBotToInternal` 提取 role 字段，`BotEvent` 新增 `senderRole`
- [x] 0b. 权限判定改造 — `processIncoming` 中群管自动获得 admin 级别
- [x] 0c. 权限隔离 — 群管不能 `/w op`/`/w group add`/全局设置类

### 经验等级系统
- [x] 1. 数据结构 — `db.experience` + `db.users` 新增 customName/customStyle + `db.settings` 新增 levelUpNotifyEnabled
- [x] 2. store.ts — defaultCommandPermissions 新增 lv/top/nick/style/me 权限键
- [x] 3. XP 引擎 — `server/bot/experience.ts`：processXpGain、evaluateLevel、decayInactive、getLevelBonus
- [x] 4. 每日上限 + 连续活跃加成
- [x] 5. 降级机制 — 30天不活跃检测 + 每7天扣10%
- [x] 6. trustInteractionBonus 改造 — trust.ts 读取 experience level，保留旧函数签名兼容
- [x] 7. bot.ts 接线 — processTrustSignal 改为 XP 引擎，decideReply 读 level
- [x] 8. index.ts — setInterval 改为 XP 降级检测
- [x] 9. 指令 /w lv — 查询等级、XP、进度条、已解锁
- [x] 10. 指令 /w top — 当前群排行榜
- [x] 11. 指令 /w nick — 设置/查看/清除称呼，管理员可 @他人
- [x] 12. 指令 /w style — 设置/查看/清除个人风格，管理员可 @他人
- [ ] 13. 内容过滤 — LLM 判定 nick/style 是否不当（当前有基本长度限制，待加 LLM 审核）
- [x] 14. /w me — Lv.3 解锁查看画像
- [x] 15. 升级恭喜 — LLM 生成 + 群内开关（levelUpNotifyEnabled）
- [x] 16. Bot 称呼联动 — buildPrompt 注入 customName，LLM 自然使用
- [x] 17. buildPrompt 注入 — 用户等级 + customName + customStyle
- [x] 18. helpDefs 更新 — 新增等级分组
- [x] 19. GUI 成员页 — 等级 emoji + 等级名 badge
- [x] 20. GUI 设置页 — 升级恭喜开关
- [x] 21. 验证测试 — tools/experience-verify.mjs（3 次全过）
- [ ] 22. 文档更新 — CHANGELOG / HANDOFF / HANDOFF-DIARY

### 数据模型（两层）

```
db.experience[qq]        — 全局，决定等级（XP、level、dailyXp、streakDays…）
db.groupExperience[groupId:qq] — 群内，用于 /w top 排行（msgCount、xpInGroup…）
db.users[] 新增          — customName (Lv.2)、customStyle (Lv.3)
db.settings 新增         — levelUpNotifyEnabled (默认 true)
```
