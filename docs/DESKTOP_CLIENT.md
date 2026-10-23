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

安装包输出在 `release/WuxinBot Desktop Setup 1.0.3.exe`。

## 迁移后的固定数据目录

安装版支持在 EXE 旁的 `resources/wuxin-paths.json` 配置 `desktopDataDir`（启动配置与 Electron 状态）和 `productionDataDir`（业务数据库）。模板见 `desktop/wuxin-paths.example.json`。迁移已有数据后，填写真实绝对目录；目录必须已存在，非法或缺失的配置路径会阻止启动，避免静默创建空库。该文件属于本机部署配置，更新安装产物时应备份并保留。

显式环境变量 `WUXIN_DESKTOP_DATA_DIR`、`WUXIN_PRODUCTION_DATA_DIR` 和 `DATA_DIR` 优先于部署文件；运行控制中为组件保存的环境变量覆盖也需一起核对。没有部署文件时，保留原有 AppData 默认行为。服务端 `.env` 不负责设置 Electron 启动前的目录。

Windows 打包应用可能将 AppData 文件操作重定向到包的私有目录。在此类终端中看到或建立的 Junction，并不证明从普通桌面启动时会使用同一份数据。迁移必须从打包工具环境之外直接启动 EXE，核对实际群聊、历史记录、模型配置及 osu! 绑定；端口和健康接口正常不足以证明数据接对。

命令行后台维护可在启动 Electron 前设置 `WUXIN_DESKTOP_START_HIDDEN=1`；`WUXIN_DESKTOP_START_ALL=1` 仅在本次启动全部已启用组件，不改变自动启动偏好。外部数据库应先正常关闭，再结束 Desktop。旧 BAT 入口已移除，使用 Desktop 或已核实目录和数据路径的管理脚本。

生产数据保护同时识别 `WUXIN_PRODUCTION_DATA_DIR`、旧 AppData 入口及其 Junction 真实目录。验证必须使用独立测试数据目录；`npm run runtime:paths:verify` 检查这些保护，并验证 Oracle 的可配置脚本和 Python 路径。

应用图标从 `build/icon-source.png` 统一生成；`npm run build` 自动导出多尺寸 ICO 和 PNG。来源及生成提示词见 `build/ICON.md`。

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

打开页面后会立即检测本机已有进程，并每 2.5 秒刷新，也可以点击“重新检测”。通过脚本、命令行或先前客户端启动的组件会显示“已在运行”和实际 PID；此功能不依赖“打开客户端时启动”开关。一键启动会跳过已就绪的组件，不重复创建实例。

识别支持旧目录 Junction、同一项目入口使用不同 Node／Java／Python／.NET 运行环境、.NET 可执行文件与 DLL 两种启动方式，以及仍可确认父子关系的外部服务进程。仅有相同进程名或相同端口不足以确认组件；使用相对入口且无法确认项目位置时，仍需按配置的运行环境识别。系统检测失败会保留上次结果并提示重试，不会将检测失败显示为“已停止”。

运行环境识别会核对实际执行入口，包括 tsx 启动器和加载器子进程；监视、备份等程序仅在参数中引用组件文件不会被当作组件。编辑启动命令、工作目录或入口参数时，相关路径识别规则同步更新并保存；额外的自定义匹配条件保留。

启动过程中仍可停止本窗口进程，尚未生成 PID 的启动也可取消。一键停止会取消当前批次尚未执行的启动，单项停止只取消对应组件；外部服务仍保持运行。启动面板按实际结果区分就绪、失败和取消，超时且仍存活的进程显示“未就绪”，只有全部目标就绪才显示“启动完成”。

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

## 验证

`npm run desktop:verify` 验证进程识别、已有服务重开、参数伪匹配、路径编辑与重载、批量取消、重复启动保护、端口归属和停止边界；`npm run desktop:ui:verify` 使用无窗口 Chromium 验证启动页的初始检测、已有进程提示、刷新、启动期间停止、失败与取消结果及错误恢复。UI 测试使用独立浏览器会话和模拟数据，不连接生产 API；可用 `WUXIN_TEST_BROWSER` 指定浏览器可执行文件。
