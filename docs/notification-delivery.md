# 通知投递与主动提醒

更新：2026-11-19。服务端路由、持久 outbox、APNs/Expo 适配代码与云 TEST 回归已完成；本批次服务端已部署生产镜像0211b3a9（2026-11-19），新客户端安装包尚未发布。未配置真实厂商凭据、未完成关闭 App 后真机送达验收时，不能宣称通知可用。本文不把提醒调度等同持续观察或个性化主动决策。

## 事件到提醒

当前源事件支持待回答问题/未知结果需核对、交付待验收、任务失败及周期提醒，分别映射 needs_input、awaiting_review、task_failed、schedule_reminder。每租户持久事件游标与通知/每注册设备 outbox 同事务提交；重启后补读，状态回报重复不会重复生成同一运行的提醒。问题与后续 waiting_input 回声合并。发送前再校验是否仍可处理：已回答、验收通过、取消或被新 Run 替换的工作抑制过时提醒。

通知 payload 只有固定通用标题/正文、notification_id 和可选 task_id，不带用户任务标题、对话、工具参数/结果、URL、Recall 内容或原始 provider 错误。点击后进入已鉴权工作台读取真实业务内容，不把对象 ID 当授权。

周期规则仍为 interval_minutes≥5 的 remind_and_confirm：到时只生成提醒与待确认方案，真实用户确认后才执行。网站/系统事件订阅、复杂日历规则、周期授权自动行动及持续偏好学习尚未实现。通知静默时段已实现，不代表这些主动规则也已实现。

## 客户端 API

所有路径带 /v1，需有效用户 session；服务端从已验证身份取租户和 session，客户端不能自报归属。

| 接口 | 请求与响应 |
| --- | --- |
| POST /clients/push-registrations | `{provider,platform,token,environment?,project_id?}` → 安全 registration |
| GET /clients/push-registrations | `{items:registration[]}` |
| DELETE /clients/push-registrations/:id | 仅当前 session 的注册，可禁用，外租户/其它 session 返回404 |
| GET /settings/notifications | `{enabled,quiet_hours,version}` |
| PUT /settings/notifications | `{enabled,quiet_hours}`，If-Match 当前 version，旧版本412 |
| GET /notifications | 当前租户持久通知列表 |

provider/platform 只接受 apns/macos、expo/android。APNs token 为十六进制，按小写归一后计算摘要；Expo token 按格式校验。安全 registration 含 id/provider/platform/enabled/environment/project_id/version/status(registered/unconfigured/disabled)，不返回 token、hash 或密文。相同 session/目标重复 POST 复用同一注册和 version，不废弃已排队提醒。

quiet_hours 为 null 或 `{timezone:'Asia/Shanghai',start:'22:00',end:'08:00'}`，校验 IANA 时区与不同 HH:mm，按真实时间计算跨午夜和 DST；静默期间延后新提醒，不重发已送交 provider 的通知。enabled=false 抑制后续投递。初次注册从当前流游标开始，不追发全部历史事件。

## 隔离与可靠投递

003_push_delivery.sql 新增带 FORCE RLS 的注册、偏好和 delivery 表；全局 token owner 定位表只含摘要/归属，不含 token 或通知正文，不暴露产品 API。注册 token 以 AES-256-GCM、租户 AAD 加密，密钥由 MEMORY_ENCRYPTION_KEY（未配置则 JWT_SECRET 域分离派生）提供；生产应使用独立稳定密钥。

同一物理 token 只投当前 owner。注册/换账号/注销与发送使用同一 token advisory 锁顺序，已声明但未发送的旧 owner 投递不能越过成功换账号；退出或撤销 session 在同事务禁用其注册。已被 provider 接受的通知无法追回。所有发送前再校验 session、owner、注册 version 和通知有效性。

扫描使用持久 claim/期限与行锁，重启可恢复；网络请求在数据库事务外，持有会话级 token 锁及迁移共享 gate，设置请求超时，finally 释放锁/连接。每进程 provider 请求串行、有每租户批次上限。业务调度与通知投递是独立的 single-flight 循环，慢 provider 不能阻塞后续任务派发；关闭时等待两条循环退出。

状态包括 pending/sending/retry/unconfigured/receipt_pending/provider_accepted/failed/suppressed。有限指数退避带抖动，最多8次发送尝试，提醒24小时过期；配置缺失不调用 provider、不假报成功，5分钟后再检查。失效 token 禁用注册；错误只记录受限分类码。

Expo send 的 ticket 不是送达：先保存 receipt_pending，后续查询 receipt，查询传输故障独立退避并保留 ticket，不重新 send；错误预算耗尽或过期标记失败。APNs HTTP/2 使用 provider JWT（缓存复用），接受回执只记 provider_accepted，不宣称设备显示、用户已读或操作完成。opened/actioned/真实设备显示证明尚无完整闭环。

## 云端配置与验收

只在云 serverenv 配置：

- APNS_KEY_ID、APNS_TEAM_ID、APNS_TOPIC、APNS_PRIVATE_KEY_FILE、APNS_ENVIRONMENT（sandbox/production）。私钥文件只在云机器，不能写仓库或日志。
- EXPO_PROJECT_ID、可选 EXPO_ACCESS_TOKEN。当前 Android 通道为 Expo 及其配置的设备推送能力，不宣称已有独立直连 FCM/国内厂商适配器。
- 原生安装包需匹配签名、entitlement、bundle/topic、Expo 项目及运行环境，客户端需要真实设备权限与注册能力。可选环境变量存在不代表已配好凭据。

当前自动化验证含：通用 payload 脱敏、去重/过时抑制、跨午夜/DST、回执与退避、失效 token、无配置禁止发送、实际 PostgreSQL 重启恢复/多租户与 owner 转移/注销并发、HTTP 路由与版本冲突、慢 provider 不阻塞业务调度。provider 传输使用注入 mock，没有给真实设备发送测试消息。

仍需用户配置与验收：有效 APNs/Expo 凭据和发布签名、目标 Mac/Android 的注册、前后台/关闭窗口/进程终止/弱网送达、点击后严格回到本人对象。国内网络及目标 Android 系统策略需实测；provider_accepted 不满足这些退出条件。
