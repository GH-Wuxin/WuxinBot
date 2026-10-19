# 原型搬进 React 控制台：现状与步骤

## 目标
原型（`console/`，预览 http://127.0.0.1:5188）的视觉与版式，原样搬进 React 控制台（`src/`）。
数据、接口、状态、按钮行为全部沿用现有代码，不重写接线。

## 已完成
- `91c27e5` 外壳改为顶部胶囊导航（沿用 `navigate` / `onPauseToggle` / `onStopAll`）
- `ee713ba` `console/app.css` 复制为 `src/styles/prototype.css`，整份包在 `.proto-shell` 作用域内，已在 `App.jsx` import
- `d185723` 总览 hero 的临时样式层（后续会被原型结构替代）

## 关键事实
- 原型的页面 HTML 不在 `console/index.html` 里，`index.html` 只有外壳
- 每个页面是 `console/app.js` 里的函数，返回拼接的 HTML 字符串，例如 `PAGES.overview`
- 配套工具函数：`pageHead` `card` `kv` `chip` `listRow` `grid4` `avatar` `switchEl` `esc`
- 这些函数只返回字符串，不含业务逻辑，可以原样复制

## 下一步（按顺序）
1. 手工复制 `esc` / `chip` / `kv` / `card` 到 `src/lib/protoRender.js`，每搬 2 个跑一次 `node --check`
2. 再搬 `pageHead` / `grid4` / `listRow` / `avatar` / `switchEl`
3. 搬 `PAGES.overview` 的函数体，把 `DATA.*` 与写死的数字换成本页 props，渲染进 `<div class="proto-shell">`
4. 构建 + 截图，与 5188 原型并排比对；不一致就是复制漏了
5. 逐页重复：群聊、osu!、日志、运行控制，其余页面

## 注意
- 不要用脚本自动抽取函数（已试过，重复声明导致语法错误）
- 原型里的按钮 onclick 要换成 React 现有的 handler
- 每页改完必须跑一遍该页操作，确认功能未变
