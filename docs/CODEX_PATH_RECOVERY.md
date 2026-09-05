# Codex 更新后的路径恢复

Windows 桌面应用更新可能删除旧的 `OpenAI/Codex/bin/<版本>/codex.exe`。
WuxinBot 在每次准备 App Server 请求时解析程序路径：

- `codex` / `codex.exe` 默认发现当前用户 LOCALAPPDATA 下的官方安装目录；无可用安装则保留 PATH 行为。
- 明确配置的官方版本路径仍存在时保持固定；文件消失时才发现同一安装根目录下的新版本。
- 多个候选按程序修改时间降序选择，平局按路径排序；不按不具备版本语义的哈希大小选择。
- 仅扫描一级十六进制版本目录，真实路径必须仍位于同一根目录的预期结构，忽略缺失文件和越界链接。
- 自定义程序路径不会被替换。不修改 settings、凭据或环境变量，不保证未来安装目录结构改变后仍适用。

状态接口保留兼容字段 `authenticated`，新增 `authStatus`：
`authenticated`、`unauthenticated`、`unknown`。调用失败属于未知，不是退出登录。
模型页在未知状态隐藏登录按钮，显示检查错误；刷新失败时清空旧额度，避免展示过期状态。

官方 ChatGPT managed 模式仍负责保存和刷新凭据，本次未增加强制刷新或自动浏览器授权。
参考：https://learn.chatgpt.com/docs/app-server#authentication-modes

验证：`npm run codex:verify` 包含临时安装目录变动、已有路径、自定义路径、平台/PATH 回退、真实 spawn 失败及页面状态映射测试。无需真实模型调用。

修复前部署基线为 `fbb1c1e`，分支 `deploy/health-20260905` 保留。
本修复独立提交；需要回退时对该修复提交执行 `git revert <提交号>`，重新构建并重启后端。
不会改变数据库格式。Git 回退不删除聊天数据或恢复账号凭据。
