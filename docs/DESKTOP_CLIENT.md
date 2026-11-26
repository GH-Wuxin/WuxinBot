# Desktop 使用与维护

WuxinBot Desktop 提供控制台窗口，并管理 WuxinBot、NapCat 和已配置的本地组件。初次安装和基本连接配置见 [README](../README.md#开始使用)。

## 启动与打包

在仓库根目录安装依赖后，可使用以下命令：

```powershell
npm run build
npm run desktop
```

开发界面使用 `npm run desktop:dev`。生成 Windows 安装包使用 `npm run desktop:build`，文件位于 `release/`，版本取自 [package.json](../package.json)。

后端可以提供构建后的控制台页面，但本机进程控制依赖 Desktop。`npm start` 只启动后端；如果 Desktop 已经启动了同一数据目录的后端，就不需要再执行它。

## 运行控制

在“运行控制”页检查组件路径，再启动需要的服务。页面会检测已运行的实例，显示就绪状态、PID 和启动日志；路径缺失或启动失败会显示原因。修改启动命令时，也应检查工作目录、参数和环境变量。

新安装的默认设置如下：

- “打开客户端时启动已启用组件”关闭。
- WuxinBot 的单项自动启动开启；Kanon、LazyBot 和 Skill Profiler 默认禁用。
- “关闭窗口时停止已管理进程”开启。

打开客户端自动启动总开关后，只有同时启用并设置了自动启动的组件会启动。点击“启动已启用组件”则会启动所有已启用组件。

页面每隔约 2.5 秒检查状态，也可以手动刷新。一键启动跳过已就绪的实例；批量启动过程中可以取消尚未启动的组件。

## 已有进程与端口占用

Desktop 会按实际程序、入口参数和进程关系识别组件。已在其他地方启动的服务可以被识别，但普通停止、重启和退出清理只作用于本窗口启动的进程树。

端口被其他进程占用时，页面会列出占用者。用户选择“停止占用进程并启动”并确认后，Desktop 才会尝试结束该进程及其子进程；执行前重新核对 PID 和端口归属。常规启动不会自动结束占用者。

就绪检查默认等待 20 秒。超时后仍存活的进程显示为未就绪，可查看日志判断是继续等待、补充配置还是停止服务。数据库组件有自己的关闭流程，应正常关闭后再结束桌面程序。

## 迁移后的固定数据目录

业务数据与 Desktop 状态是两套目录。业务数据默认使用 `%APPDATA%\Wuxin`；Desktop 的用户目录保存窗口状态、日志及 `desktop-runtime.json`。

安装版可通过 `resources/wuxin-paths.json` 指定 `productionDataDir` 和 `desktopDataDir`，模板见 [wuxin-paths.example.json](../desktop/wuxin-paths.example.json)。目录须已存在；路径无效时会停止启动。更新安装文件时保留这个本机配置。

`WUXIN_DESKTOP_DATA_DIR`、`WUXIN_PRODUCTION_DATA_DIR` 和 `DATA_DIR` 等显式环境变量优先于部署文件。还需核对组件保存的环境变量覆盖项。服务端 `.env` 在后端启动时读取，不能设置已经启动的 Electron 的数据目录。

迁移数据后，从平时使用的桌面入口启动一次，核对群设置、模型、聊天记录和 osu! 绑定。Windows 打包应用可能重定向 AppData；在另一终端看到的路径或 Junction 不一定代表桌面进程实际读取的位置。

后台维护可在启动 Electron 前设置：

| 变量 | 用途 |
| --- | --- |
| `WUXIN_DESKTOP_START_HIDDEN=1` | 后台启动，不显示主窗口 |
| `WUXIN_DESKTOP_START_ALL=1` | 本次启动全部已启用组件，不修改自动启动偏好 |

## 配置、备份与图标

`desktop-runtime.json` 保存用户对默认组件的修改。恢复默认值会移除相应覆盖项；环境变量逐项合并，其中 `null` 表示移除默认变量。旧配置升级前会保留副本，无法解析的配置不会被静默覆盖。

业务数据库、发送档案和 Desktop 配置需分别保留。数据库备份范围见 [README](../README.md#数据与隐私)；QQ 登录资料及外部组件数据库有自己的备份方式。

图标源文件和生成命令见 [图标说明](../build/ICON.md)。

## 验证

```powershell
npm run desktop:verify
npm run desktop:ui:verify
npm run runtime:paths:verify
```

这些检查覆盖进程识别、启动取消、端口归属、界面反馈和数据目录保护。界面测试使用无头浏览器与模拟接口；可用 `WUXIN_TEST_BROWSER` 指定浏览器程序。
