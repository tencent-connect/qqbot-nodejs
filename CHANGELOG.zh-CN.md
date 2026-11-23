# 1.0.6 (2026-11-23)

### 新特性

* **sdk:** 新增 `bot.connectionState` 与 `connection` 事件，无需自行组合多个事件即可读取或监听连接状态
* **sdk:** 新增 `bot.ping` 与 `bot.lastHeartbeatAt`
* **sdk:** 消息事件新增 `msg.author` 对象，可读取发送者头像；平铺的发送者字段标记废弃，未映射字段无需 `as any` 即可读取
* **gateway:** 连接假死时自动检测并重连，不再无限挂起
* **gateway:** 服务端要求重连时恢复原会话，并补齐断线期间的消息

### 问题修复

* **gateway:** 服务端要求重连时不再丢弃会话，修复断线期间消息丢失的问题

### 行为变更

* `ConnectionState` 新增 `resuming`、`QQBotEventMap` 新增 `connection`，穷举 switch 需同步更新

# 1.0.5 (2026-10-12)

### 新特性

* **gateway:** 连不上时启动立即失败并给出原因，不再无限等待
* **gateway:** 新增 `disconnected` 事件，告知掉线原因以及 SDK 是否会自动恢复
* **gateway:** 重连可配置 —— 可限制重试次数并调整退避间隔；无法恢复的情况（机器人被封禁、仅限沙箱等）会明确上报一次
* **sdk:** 新增 `bot.getCredentials()`，便于直接使用底层接口

### 问题修复

* **gateway:** 连接刚建立就被踢出时不再重置重试次数，避免配置有误的机器人陷入快速重连循环
* **gateway:** 修复若干会导致连接卡死或误判的问题：回调抛异常、握手被静默丢弃、平台要求的重连被当作永久失败
* **token:** 重启机器人不会再误取消新会话的令牌刷新

### 行为变更

* 现在会一直重试直到确认无法恢复（此前重试 100 次后放弃）。如需硬性上限，请设置 `reconnect.maxAttempts`。

## 1.0.4 (2026-07-14)

### 问题修复

* **token:** 获取访问令牌增加超时，失败时带上 HTTP 状态码与服务端返回内容，不再只报笼统错误
* **token:** 修复若干会导致令牌刷新卡住、或误报崩溃日志的边界问题

## 1.0.3 (2026-07-13)


### 新特性

* **sdk:** 新增通用 send() 方法、API 网关、rawEvent 及 P1 消息能力
* **media:** uploadMedia 自动从 localPath/URL 填充 fileName
* **media:** 上传前预检 fileData 大小
* **middleware:** 并发守卫合并支持
* **middleware:** 增强类型定义与缓冲回复
* **concurrency:** 新增 maxProcessingMs 超时中止机制
* **concurrency:** 新增 urgentPredicate 优先刷新
* **quote-ref:** 优先使用 msg_elements 而非已存储的 entry
* **quote-ref:** 新增 enrichEntry 与 extend entry
* **api:** acknowledge interaction 支持 data 参数
* **sanitizer:** 支持新的表情标签格式
* **slash:** 新增按命令授权检查
* 导出 webhook 传输类型
* 更新 mention-gate


### 问题修复

* **slash:** 修复群聊 @bot 检测时 rawEventType 判断问题
* **media:** COS 分块上传改用原生 https
* **media:** 直接传递 Uint8Array 给 fetch body
* **middleware:** 优化 mention-gate 逻辑


## 1.0.2 (2026-06-10)


### 新特性

* **qqbot:** 支持 tokenPrefetch 选项，用于同步/异步 token 初始化


## 1.0.1 (2026-05-20)


### 新特性

* **middleware:** 新增 concurrencyGuard，按目标串行处理
* **middleware:** 新增 ctx.abort() 和 ctx.signal 支持异步取消
* **middleware:** typingIndicator 新增输入状态保活
* **middleware:** MiddlewareContext 新增 receivedAt 用于延迟测量
* **concurrency:** 新增合并策略与依赖反转派发
* **slash:** 新增 allowFrom 选项控制命令访问权限
* **event:** C2C 入站消息暴露 messageScene
* **transport:** 新增 webhook 示例并更新文档
* 数据流中间件管线
* 检查 slash 作用域


### 问题修复

* **webhook:** 异步派发防止长耗时处理程序导致 ACK 超时
* **webhook:** 调试输出中记录完整事件载荷
* **stream:** 即使 flush 进行中也确保发送 DONE 帧
* **streaming:** 捕获节流 flush 错误防止 unhandledRejection
* **streaming:** 修复限流重试风暴
* **concurrency-guard:** 中止时驱逐排队等待者防止过期回复


# 1.0.0 (2026-04-30)


### 新特性

* 初始化 QQ 开放平台 Node.js SDK
