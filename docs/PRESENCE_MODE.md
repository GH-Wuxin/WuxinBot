# Pippi 常驻感知（presence）

## 定位

常驻感知不是“回复更积极”模式，而是一层后台内心生活：

- 每条启用群的群消息都会进入感知
- 大多数消息不会立刻被表达
- 感知会缓慢改变 Pippi 的心情、精力、兴趣、对群友的印象、未完成话题和群文化
- 回复数量不因开启感知而增加

## 开关

- 设置项：`presenceEnabled`
- 默认：**关闭**（新安装保持关闭，由操作者决定）
- 当前生产环境：已手动开启
- 控制台：模型 → 对话与上下文 → 常驻感知（火力全开）

## 模型

- 感知和内心整理固定使用 **Flash**
- 即使主模型被设成 Eco，感知层也会去掉 `-eco` 后缀，不使用 Eco
- 不设 token 预算；保留调用次数、单飞、去重、退避等安全保护

## 工作方式

1. 每条符合条件群消息进入内存队列，并产生极小的确定性状态变化
2. 每 5–8 条消息批量调用 Flash 生成 observation
3. 每 20–30 分钟或累计足够 observation 后，生成一次 reflection
4. reflection 将 observation 内化为长期印象、心情、未完成话题和群文化
5. 生成回复时只注入一小段“最近注意到”的背景；明确要求不要强行引用、不要每轮提

## 安全保护

- 同一群单飞：batch 和 reflection 不会并发重入
- 消息去重：同一 messageId 只观察一次
- 队列上限：pending 80、observation 120、threads 8、culture 12、noticing 12
- 失败退避：模型调用失败后 5 分钟内不重复重试
- 证据约束：observation 只能引用本批真实 messageId；人物只接受本批真实 userId
- 不发送消息、不参与回复决策
- 仅在 `mention` / `light` / `natural` 且启用的群观察；不观察 osu-only、silent、私聊或指令消息

## API

`GET /api/presence` 返回当前 mood/energy/interest、各群 observation 数量、最近 observation、open threads 和 culture。

## 验证

`npm run presence:verify` 覆盖：默认关闭、逐条观察、去重、reflection、prompt 约束、伪造 ID 拒绝。
