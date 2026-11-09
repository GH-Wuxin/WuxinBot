# Kanon Mod 图标

本目录提供 Kanon 成绩卡片使用的 DC、DA、CL 和 Unknown 图标资源。DC、DA、CL 各有一张 257 × 77 主标牌和两张 60 × 60、118 × 118 方形图标；Unknown 为一张灰色问号主标牌。

[work](work)包含十张部署用 PNG，[svg](svg)保留可编辑源文件，尺寸、颜色和文字位置见 [design-spec.json](design-spec.json)。配色参考 Kanon 已有资源，具体图片来源和修改方式见 [ATTRIBUTION.md](ATTRIBUTION.md)。

## 安装

备份目标资源后，将这里 `work/` 的内容合并到 Kanon 安装目录的 `work/` 中，保持以下层级：

```text
work/mods/{DC,DA,CL,Unknown}.png
work/mods_v2/1x/{DC,DA,CL}.png
work/mods_v2/2x/{DC,DA,CL}.png
```

同时保留 [ATTRIBUTION.md](ATTRIBUTION.md) 和 [osu-resources-LICENCE.md](osu-resources-LICENCE.md)。如果部署另有源资源目录，也应同步对应文件，避免重新安装后丢失修改。

这组文件只替换图片。支持按文件变化失效缓存的渲染器会在后续卡片中使用新图片；其他版本需按其缓存机制刷新或重启。已经发送的卡片不会改变。

## 范围与检查

检查主成绩卡片中的新旧图标混排、Mod 参数及未知缩写，并核对两个方形尺寸的透明背景和加载结果。使用列表或开发卡片的部署还需验证对应模板；不能由主卡片结果推断所有模板都兼容。

本资源包只覆盖列出的 Mod。图形、字体来源和上游许可证按随附声明保留，仓库主许可证不替代这些资源的许可。
