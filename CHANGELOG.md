# Changelog

## v1.0.0 (2026-05-23/24)

### 新增（0524）
- **画像分层**：长期画像 + 近期动态两层。单日/单场景高频话题只进入近期动态，不覆盖长期画像
- topic cluster 降权：同一话题短窗口内合并计数，不按消息条数线性放大
- LLM patch 模式：longTermUpdates/recentDynamicsUpdates/preserveExisting/removeOrDowngrade
- 近期动态自然衰减：7天降权/14天移除
- GUI + /w profile show 分层显示
- CHANGELOG.md（给人看的更新日志）

### 新增（0523）
- 决策沙盒：POST /api/sandbox，不写DB，可选群/成员/策略覆盖/画像预览/LLM
- 全局重算 + 进度条：/w refresh、/w recalc，GUI 进度条 + 停止按钮
- 社交记忆层：信号抽取 + 自动信任分 + 群友关系画像
- 群聊画像 V2：自动更新 + 手动编辑 + GUI 面板
- 语境感知画像：样本带上下文快照，profile samples 分层展示
- 场景预设：/w preset（class/away/sleep/active/silent/debug）
- 画像定向重算：/w profile retry @某人 方向
- /w why 诊断命令
- 备份系统：每 8h 自动 + GUI 手动 + 恢复安全校验
- 健康状态页：总览页红黄绿灯 + 每 5s 轮询
- 记忆置信度 + 高风险降级 + profileMeta
- 权限页补全：27 条指令 + 搜索
- /w help 分组 + /w my 权限感知
- 成员页优化：搜索/筛选/排序/彩色标签
- 群聊页优化：识别强化 + 搜索
- 决策沙盒发言人列表：合并配置用户+消息历史
- 长期记忆：语境感知的个人画像 + 群聊氛围画像 + 群友关系画像
- 信任成员自动化（信任分 + 三档升降级 + 定时器）
- 24 个指令权限键

### 修复
- P0：decideReply event 崩溃
- P1：关系画像采样限定 A/B + /w why 权限
- P2：注入收窄 + 接线 + 权限粒度
- 画像 JSON 类型安全修复
- BOM 防护
- 多处 UX 优化（错误信息透传、搜索、危险确认）

### 变更
- 启动脚本统一：启动Wuxin.bat（支持 portable-node）
- 仓库清理：Git 历史清除大文件，.gitignore 完善
- GitHub Release v1.0.0：full 包(232MB) + lite 包(33MB)

---

## v0.1.0 (2026-05-21~22)

### 核心
- 底层拆分：cleaning/llm/prompt/reply/memory/commands
- Diaz→Wuxin 重命名，/d→/w，数据目录分离
- 底层 prompt 重构 + sysfacts 纯人设模式
- 备份恢复 + 健康状态 + 记忆置信度 + 高风险降级
- 成员页/群聊页优化
- 画像护栏（过滤 + 侮辱性标签清洗）
- Git 安全加固 + BOM 防护
