# 应用图标

源图为 [icon-source.png](icon-source.png)。图案参考 [osu!lazer 标志](https://github.com/ppy/osu/blob/master/assets/lazer.png)的粉色圆形和白色边缘，使用 WuxinBot 的 `w!` 字样。该源图于 2026-10-22 使用图像生成工具制作，透明背景版本保存在仓库中。

在仓库根目录运行以下命令可重新导出图标：

```powershell
node tools/build-desktop-icons.mjs
```

`npm run build` 也会执行这一步。生成结果为 `build/icon.ico`、`build/icon.png`、`public/icon.ico` 和 `public/icon.png`，供程序、安装包和控制台使用。

ICO 包含 16、20、24、32、40、48、64、96、128、256 像素版本，PNG 为 512 像素。修改源图后重新生成这些文件即可，构建不依赖图像生成工具或本机用户目录。
