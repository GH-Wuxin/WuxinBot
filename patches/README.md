# PP+ 聚合服务补丁

[ppplus-first-info.patch](ppplus-first-info.patch)为 `lazybot-ppplus` 0.1.15 增加首次查询的任务接口及对应测试。Wuxin 的 [pplus.ts](../server/osu/pplus.ts)使用这些接口，部署时需要匹配的聚合服务版本。

## 应用与构建

在尚未应用补丁的聚合服务源码目录中执行，替换补丁路径：

```powershell
$patchFile = 'D:\WuxinBot\patches\ppplus-first-info.patch'
git apply --check --ignore-space-change $patchFile
git apply --ignore-space-change $patchFile
mvn '-Dmaven.compiler.enablePreview=true' '-DargLine=--enable-preview' package
```

该补丁的目标构建使用 JDK 21。依赖 `me.zhjk:rosu-ppplus:0.2.2`；若本地仓库没有它，可从已有聚合服务包的 `BOOT-INF/lib/rosu-ppplus-0.2.2.jar` 取得原始依赖，再按相同 Maven 坐标安装。补丁没有修改计算器算法。

应用检查失败时先核对目标源码和是否已应用，避免重复覆盖。构建会执行补丁包含的 JUnit 测试。

## 接口约定

- `POST /player/jobs?id=<osuId>` 创建或复用该玩家的任务，返回 queued、running、completed 或 failed。
- `GET /player/jobs/status?id=<osuId>` 只查询任务状态，不初始化玩家。任务不存在时返回业务错误。
- 成功任务通过 `data.result.performances` 返回结果；失败区分无成绩、计算失败和队列已满。两个接口沿用原有 Bearer 认证。
- 旧 `/player/info` 和 `/player/update` 保留，与新接口共享玩家任务锁。下载在数据库事务之外进行，完成后一起保存玩家标记和成绩。

Wuxin 轮询任务并缓存有效 PP+ 结果。认证、计算失败和缺少成绩会向上返回实际状态，不会把缺失结果包装成完整成功卡片。

## 部署与验证

先备份现有程序，部署匹配的聚合服务，再更新 Wuxin 客户端。回滚时也应恢复配套版本，保留当前业务数据库。各服务启停使用实际部署的进程管理方式。

在 Wuxin 仓库中执行：

```powershell
npm run pplus:verify
```

真实首次查询测试应选择尚未在聚合服务缓存中的公开玩家，并使用隔离的 Wuxin 数据。无需删除生产玩家记录来制造首次查询。

其他资源覆盖包见 [Kanon Mod 图标](kanon-mod-icons/README.md)。
