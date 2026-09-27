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

配置保存在 Electron 的 userData 目录 `desktop-runtime.json`。首次启动会根据当前本机目录生成默认项；修改后的路径和参数会写入该文件，不再创建旧的启动文件夹脚本或计划任务。

默认情况下：

- `startOnOpen` 关闭，打开客户端不会无提示地启动整套 Bot；
- WuxinBot 的单项 `autoStart` 开启；
- LazyBot 和 Skill Profiler 默认关闭；
- 关闭窗口时停止已管理进程开启。

打开“打开客户端时启动已启用组件”后，只有同时打开“自动启动”的组件会在客户端启动时运行；点击“启动已启用组件”则会启动所有已启用组件。

## 进程安全边界

Desktop 只根据保存的可执行文件路径、命令行片段和端口识别目标进程。停止操作在 Windows 使用 `taskkill /T` 结束目标进程树，不按进程名盲杀普通 QQ。NapCat 的默认匹配范围限定在 NapCat Shell 目录内。
