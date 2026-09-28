# WuxinBot Desktop

WuxinBot Desktop 是现有 React 控制台的 Electron 外壳。它不依赖浏览器标签页，窗口关闭后客户端进程退出，并可按配置停止它管理的本地服务。

浏览器 WebUI 启动入口已移除；React renderer 源码仍保留，用于 Desktop 的开发和重新打包。

## 启动

开发模式：

```powershell
npm run desktop:dev
```

生成 Windows 安装包：

```powershell
npm run desktop:build
```

安装包输出在 `dist/WuxinBot Desktop Setup 1.0.3.exe`。

## 运行控制

控制台的 **运行控制** 页面提供：

- Windows 登录时启动 Desktop；
- 打开 Desktop 时启动各组件的总开关；
- 关闭窗口时停止已管理进程的总开关；
- 一键启动、停止和重启；
- PostgreSQL、MariaDB、PP+、PP+ Aggregate、yumu-image、雨沐、猫猫、消防栓、LazyBot、NapCat、Skill Profiler、WuxinBot 的独立启用开关；
- 每个组件独立的自动启动开关；
- 每个组件独立的启动、停止、重启和启动参数编辑；
- 当前 PID、路径缺失状态和桌面操作日志。

配置保存在 Electron 的 userData 目录 `desktop-runtime.json`。v2 只保存用户覆盖项（`processOverrides`），每次启动重新生成当前版本默认项；未修改的路径和参数可以随版本更新。将配置改回当前默认值会移除相应覆盖项。环境变量逐项合并，覆盖项中的 `null` 表示删除该默认变量。

旧 v1 配置会自动迁移，原文件保留为 `desktop-runtime.json.v1.backup`。v1 未记录字段来源，迁移只更新可确认的历史默认形态，其他差异保留为用户覆盖项。无法解析或来自更高版本的配置不会被覆盖。

默认情况下：

- `startOnOpen` 关闭，打开客户端不会无提示地启动整套 Bot；
- WuxinBot 的单项 `autoStart` 开启；
- LazyBot 和 Skill Profiler 默认关闭；
- 关闭窗口时停止已管理进程开启。

打开“打开客户端时启动已启用组件”后，只有同时打开“自动启动”的组件会在客户端启动时运行；点击“启动已启用组件”则会启动所有已启用组件。

## 进程安全边界

Desktop 根据可执行文件和命令行识别外部服务，但不会将它们接管。单项停止、一键停止、重启及退出清理只作用于本窗口实际启动的进程树；没有启动归属时也不会执行 `stopCommand`。归属通过启动记录、父子关系和进程创建时间确认，启动器退出后的子进程仍可跟踪，复用的旧 PID 不会被当成原进程。退出清理仍尊重总开关及各组件的 `stopOnClose`。

端口开放不等于目标服务已启动：还必须确认监听 PID 属于目标进程或本窗口启动的进程树。Windows HTTP.sys 代监听的端口使用活动请求队列确认实际服务 PID，不将系统 PID 4 当成目标服务。无关监听者显示“端口占用”，不会被停止；无法确认归属时也不会报告启动成功。就绪检查在 20 秒内持续重试，首次连接失败不会结束等待；超时、启动错误和异常退出会报告失败，仍存活的本窗口进程可手动停止或重启。
