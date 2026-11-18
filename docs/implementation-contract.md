# 实现集成契约（开发共享）

本文件固定第一轮并行开发的接口形状。实现可修正文档，但跨模块变更先通知协调者；类型见 `packages/protocol/src/index.ts`，路径均有 `/v1` 前缀，JSON 字段统一 snake_case，列表响应 `{items:[]}`。时间 UTC，金额字符串。

## 公共约定

- Auth Bearer token；API 错误 `{error:{code,message,retryable}}`。更新对象通过 If-Match，创建/动作 Idempotency-Key。
- 本机开发可以显式 `ALLOW_DEV_AUTH=true` 提供 `/auth/dev {email,name?}` 返回 AuthSession；生产必须关闭此入口并用 OIDC exchange。不能默认公网免鉴权。
- `/auth/config` 返回 `{mode:'oidc'|'development',issuer?,client_id?,authorization_endpoint?,token_endpoint?,redirect_uri?}`。`/auth/exchange {access_token}`、`/auth/refresh {refresh_token}` 返回 AuthSession，`/auth/logout` 撤销。
- 列表：GET `/devices`、`/tasks`、`/messages?task_id=`、`/questions?status=open`、`/memories`，对应共享类型。
- POST `/messages {client_message_id,text,task_id?,execution_preference?:{engine,device_id,selection_mode:'pinned'}}` 返回 Message；全局 message 交主助理，若直接创建结构化 Task 可用下述路径。
- POST `/tasks {title?,goal,engine,model_id?,device_id}` 返回 Task；明确客户端交办构成任务范围的授权来源。
- GET `/tasks/:id`、`/tasks/:id/runs`；POST `/tasks/:id/actions {action:'pause'|'resume'|'cancel'|'switch'|'retry',target?:{engine,device_id,model_id?}}` 返回 `{action_id,status:'accepted'}`。
- POST `/tasks/:id/inputs {text}`；POST `/questions/:id/answers {answer,version}`。
- GET/PUT `/settings/execution` 使用 ExecutionSettings；用户只能选择自己的设备。
- POST `/memories {title,content,type,site?}` 返回 Memory；PATCH/DELETE `/memories/:id`；教学输入可直接标 verified，节点提案为 candidate。
- GET `/costs/summary` -> CostSummary；GET `/costs/series` -> ListResponse<CostPoint>；GET `/costs/breakdown?group_by=device|engine|task` -> ListResponse<CostBreakdown>；GET `/costs/records` -> `{items:[]}`；GET/PUT `/budgets` -> Budget。
- 费用接口接受 `from`/`to`（带时区 ISO 时间），默认 UTC 当月；最大 366 天，要求 from <= to。
- GET/PUT/DELETE `/settings/memory` 绑定本人 Recall；PUT `{url,token,project?}`，返回只含账号、状态、版本，不返回 PAT。相同 Recall 账号不得绑定两个产品用户；未绑定返回明确 503。
- Recall 是已发布记忆的内容、检索与版本权威；节点先产生 candidate，用户审核后发布到 Recall。PG 只存绑定、候选及产品元数据，不另建向量记忆库。
- GET `/events?after=` -> `{items:ServerEvent[],cursor:string}`；客户端可先用 2 秒增量轮询，WSS 后续共用事件源，不要创建不可用的按钮。

## 节点与服务端

- POST `/device-pairings {name,public_key}` -> PairingStart；POST `/device-pairings/claim {code}` -> `{device_id}`（用户身份）；POST `/device-pairings/poll {pairing_id,polling_secret}` -> PairingResult。
- POST `/devices/auth/challenge {device_id}` -> `{nonce,challenge,expires_at}`；POST `/devices/auth/token {device_id,nonce,signature}`（Ed25519, signature base64）-> `{access_token,expires_in}`；challenge 原文完整签名，服务端单次消费。
- PUT `/devices/:id/capabilities` body Capabilities；POST `/node/heartbeat {}` 更新当前设备；GET `/node/commands` -> `{items:WireMessage[]}`。
- POST `/node/runs/:id/accept {command_id,lease_epoch}` -> RunContext；POST `/node/runs/:id/renew {lease_epoch}` -> `{run_ticket,lease_valid_for_ms,control?:{action,text?}}`。
- POST `/node/reports {messages:WireMessage[]}` -> `{accepted:string[],rejected?:{message_id,code}[]}`。原始消息以当前 doc schema 为基础，接受 run.state、usage.report、command.ack；步骤/工具回执另扩展 kind。
- POST `/node/reconcile {runs:[{run_id,lease_epoch,state}]}` 返回当前合法运行信息；只有 accept 成功才开始模型。重复 command_id 不再次执行。
- 节点 run 专用请求都发 `Authorization: Bearer <device token>` 加 `X-Run-Ticket: <run ticket>`；主助理请求加 `X-Assistant-Epoch`。
- POST `/node/memory/search {query,limit?,types?,site?}` -> `{items:Memory[]}`；POST `/node/memory/read {id}` -> Memory；POST `/node/memory/proposals {title,content,type,site?,sources?}` -> Memory。
- POST `/node/runs/:id/questions {text,options?}` -> Question；节点 renew control 可返回 `{action:'answer',text}`。
- POST `/node/runs/:id/checkpoint {checkpoint}`；POST `/node/runs/:id/frames` body Frame；GET `/runs/:id/frame` 返回本人最新 Frame 或 404。
- POST `/runs/:id/views {}` 开启按需采集，DELETE `/views/:id` 关闭；POST `/views/:id/control {}` 请求暂停与接管；POST `/views/:id/inputs {frame_id,viewport_version,type,x?,y?,text?,keys?}`；DELETE `/views/:id/control`。
- 接管输入 x/y 为原始截图像素；节点按实际截图尺寸与 CSS viewport 换算。拒绝过期帧、错误 viewport_version、越界坐标和已改变的窗口尺寸。
- 主助理：POST `/assistant/lease/claim {}`、`/assistant/lease/renew {epoch}` -> `{epoch,lease_valid_for_ms}`；GET `/assistant/inbox` -> `{items:Message[]}`；POST `/assistant/plans {source_message_id}` -> `{id,state,tasks:Task[]}`；POST `/assistant/plans/:id/commit {items:[{item_key,title,goal,engine,device_id}]}`；POST `/assistant/messages {source_message_id,content,task_id?}`。
- 自由聊天必须先确认：POST `/assistant/plans/:id/propose {items,summary}` 保存 `awaiting_confirmation`，不创建 Task；item 含目标、`deliverables:string[]`、引擎和设备。GET `/assistant/plans?state=awaiting_confirmation`；POST `/assistant/plans/:id/confirm` 或 `/reject {source_message_id}` 必须引用真实后续用户消息，由服务端校验并幂等创建任务。旧 commit 不能绕过确认。
- GET `/assistant/context` 返回最近对话、未完成任务和待确认计划，规划时恢复上下文。唯一待确认计划可输入“确认/开始执行”，多个时输入“确认 <计划前8位>”；模型不能自己生成确认消息。
- GET/POST `/schedules`、PATCH/DELETE `/schedules/:id` 管理定时关注。POST `{title,goal,engine,device_id,interval_minutes}`，最短 5 分钟；更新/删除带 If-Match。首版 `mode=remind_and_confirm`：定时提醒并形成待确认计划，用户确认后才执行。
- 服务端不包含模型客户端或模型凭据字段，模型请求直接来自 Mac。设备能力配置包括本机引擎可用模型；模型名不写死到任何客户端。

## 文件归属与开发规则

- 协调者：根配置、packages/protocol、scripts、infra、README 与文档集成。
- Server worker：apps/control-server；提供 Fastify 可测试 app factory、migration 与真实云端 PostgreSQL 集成测试。apps/server 与 db 保留给未知状态的先前外部工作，不编辑。
- Node worker：apps/node、packages/runtime-*、packages/tool-broker、spikes；本机 SQLite、真实运行时、CSI、配对 CLI。
- macOS worker：apps/macos；Swift 原生可构建应用与 API 客户端，不创建网站。
- Android worker：apps/android；React Native 原生工程/Expo 开发构建与 API 客户端，不创建网页替代原生。
- 不修改其他负责人的文件。不修改根 lockfile，各组件 package.json 就绪后通知协调者统一 pnpm install。不要删除原始设计。无外部服务时实现可测试适配器并显式报告限制，不冒充通过生产环境验证。
- 云端数据库、对象存储、OIDC 和服务镜像；禁止拉取/启动本机 Docker 或本机数据库。节点 SQLite 仅是本机持久执行日志。
