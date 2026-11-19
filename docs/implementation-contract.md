# 实现集成契约（开发共享）

本文件固定当前跨组件接口形状（2026-11-19）。新增受管团队、交付验收及通知的代码与云 TEST 已实现；生产部署状态单独见[实施状态](implementation-status.md)。实现可修正文档，但跨模块变更先通知协调者；类型见 `packages/protocol/src/index.ts`，路径均有 `/v1` 前缀，JSON 字段统一 snake_case，列表响应 `{items:[]}`。时间 UTC，金额字符串。

## 公共约定

- Auth Bearer token；API 错误 `{error:{code,message,retryable}}`。更新对象通过 If-Match，创建/动作 Idempotency-Key。
- 本机开发可以显式 `ALLOW_DEV_AUTH=true` 提供 `/auth/dev {email,name?}` 返回 AuthSession；生产必须关闭此入口并用 OIDC exchange。不能默认公网免鉴权。
- `/auth/config` 返回 `{mode:'oidc'|'development',issuer?,client_id?,authorization_endpoint?,token_endpoint?,redirect_uri?}`。`/auth/exchange {access_token}`、`/auth/refresh {refresh_token}` 返回 AuthSession，`/auth/logout` 撤销。
- 列表：GET `/devices`、`/tasks`、`/messages?task_id=`、`/questions?status=open`、`/memories`，对应共享类型。
- POST `/messages {client_message_id,text,task_id?,execution_preference?:{engine,device_id,selection_mode:'pinned'}}` 返回 Message；全局 message 交主助理，若直接创建结构化 Task 可用下述路径。
- POST `/tasks {title?,goal,engine,model_id?,device_id}` 返回 Task；明确客户端交办构成任务范围的授权来源。
- GET `/tasks/:id`、`/tasks/:id/runs`；POST `/tasks/:id/actions {action:'pause'|'resume'|'cancel'|'switch'|'retry',target?:{engine,device_id,model_id?}}` 返回 `{action_id,status:'accepted'}`。
- Run 列表的 `summary` 是短进度摘要，`result_text?:string|null` 返回该 run 已提交交付所固定检查点的完整报告；尚未提交交付时才读取最新 completed 检查点；控制端详情优先显示完整结果，不把报告截为 500 字，不下发检查点内部绑定/工具元数据。
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
- POST `/node/reports {messages:WireMessage[]}` -> `{accepted:string[],rejected?:{message_id,code}[]}`。原始消息以当前 doc schema 为基础，接受 run.state、usage.report、command.ack、step.updated、tool.receipt。步骤只投影白名单生命周期元数据，不能广播工具参数、结果、URL 或原始错误。
- POST `/node/reconcile {runs:[{run_id,lease_epoch,state}]}` 返回当前合法运行信息；只有 accept 成功才开始模型。重复 command_id 不再次执行。
- 节点 run 专用请求都发 `Authorization: Bearer <device token>` 加 `X-Run-Ticket: <run ticket>`；主助理请求加 `X-Assistant-Epoch`。
- POST `/node/memory/search {query,limit?,types?,site?}` -> `{items:Memory[]}`；POST `/node/memory/read {id}` -> Memory；POST `/node/memory/proposals {title,content,type,site?,sources?}` -> Memory。
- POST `/node/runs/:id/questions {text,options?}` -> Question；节点 renew control 可返回 `{action:'answer',text}`。
- POST `/node/runs/:id/checkpoint {checkpoint}` 要求有效 Run ticket、epoch/租约且 Run 仍 active/stopping；首个 completed 内容 hash 冻结，同内容重放返回原 ID，不允许替换已交付快照；POST `/node/runs/:id/frames` body Frame；GET `/runs/:id/frame` 返回本人最新 Frame 或 404。
- POST `/runs/:id/views {}` 开启按需采集，DELETE `/views/:id` 关闭；POST `/views/:id/control {}` 请求暂停与接管；POST `/views/:id/inputs {frame_id,viewport_version,type,x?,y?,text?,keys?}`；DELETE `/views/:id/control`。
- 接管输入 x/y 为原始截图像素；节点按实际截图尺寸与 CSS viewport 换算。拒绝过期帧、错误 viewport_version、越界坐标和已改变的窗口尺寸。
- 主助理：POST `/assistant/lease/claim {}`、`/assistant/lease/renew {epoch}` -> `{epoch,lease_valid_for_ms}`；GET `/assistant/inbox` -> `{items:Message[]}`；POST `/assistant/plans {source_message_id}`（或互斥的 `{source_event_id}`） -> `{id,state,tasks:Task[]}`；POST `/assistant/plans/:id/commit {items:[{item_key,title,goal,engine,device_id}]}`；POST `/assistant/messages {source_message_id,content,task_id?}`。
- 自由聊天必须先确认：POST `/assistant/plans/:id/propose {items,summary}` 保存 `awaiting_confirmation`，不创建 Task；item 含 `item_key`、目标、`deliverables:string[]`、引擎、设备及可选 `depends_on_keys:string[]`、`parent_item_key`。每计划最多20项，分别校验依赖环与父树环，确认时原子生成 Task 关系。GET `/assistant/plans?state=awaiting_confirmation`；POST `/assistant/plans/:id/confirm` 或 `/reject {source_message_id}` 必须引用真实后续用户消息，由服务端校验并幂等创建任务。旧 commit 不能绕过确认。
- GET `/assistant/context` 返回最近对话、未完成任务和待确认计划，规划时恢复上下文。唯一待确认计划可输入“确认/开始执行”，多个时输入“确认 <计划前8位>”；模型不能自己生成确认消息。
- GET/POST `/schedules`、PATCH/DELETE `/schedules/:id` 管理定时关注。POST `{title,goal,engine,device_id,interval_minutes}`，最短 5 分钟；更新/删除带 If-Match。首版 `mode=remind_and_confirm`：定时提醒并形成待确认计划，用户确认后才执行。
- 附件：GET `/artifacts?task_id=&run_id=`，POST `/artifacts/uploads {name,mime,size,task_id?}` -> `{artifact_id,upload_url,upload_headers,max_size,expires_at}`，签名 PUT 后 POST `/artifacts/:id/finalize {}`，GET `/artifacts/:id/download` -> `{url,name,mime,expires_at}`。设备携当前 run ticket，仅列出/下载当前 task 的用户输入、历史 run 产物和已验收依赖的冻结产物；只能 finalize 本 run 上传。对象存储传输不带产品 Bearer，50 MiB 边界，禁止重定向。
- Worker 统一工具增加 `artifacts_list`、`artifacts_download {id,path}`、`artifacts_upload {path,name?,mime?}`，所有本机文件受当前任务目录边界限制。
- 原生接管文字输入 `type:'text'` 由服务端归一为 `type` 再发节点；两种名字均接受，帧与租约校验不变。
- 服务端不包含模型客户端或模型凭据字段，模型请求直接来自 Mac。设备能力配置包括本机引擎可用模型；模型名不写死到任何客户端。

## 受管团队与独立验收

详细字段、事件和不变量见[团队与交付方案](team-and-delivery.md)，共享 DTO 以 `packages/protocol` 为准。

- Task 增加 `blocked`，可带 `plan_id/parent_task_id/root_task_id/depends_on_task_ids/deliverables/delivery_status`；父子归属与执行依赖分别建模。只有依赖 Task `succeeded` 且交付 `accepted` 才能派发下游。
- Worker 的 Run `succeeded` 将 Task 置为 `awaiting_review`，不直接宣布业务完成；空交付标准默认“目标完成且有可核对结果”。
- GET `/tasks/:id/evidence` 与当前 Coordinator 的 GET `/assistant/tasks/:id/evidence` 返回 `TaskEvidence`：安全 Task/Run、交付快照、标准、完整 result_text、checkpoint 引用、ToolStep、ArtifactMetadata、历史 reviews。无 object key、模型绑定或票据。
- POST `/tasks/:id/reviews`、`/assistant/tasks/:id/reviews`，带 If-Match(Task.version) 与 Idempotency-Key，body 为 `{run_id,verdict:'accept'|'reject'|'needs_input',summary,checks:[{deliverable_index,passed,evidence_refs:[{kind:'artifact'|'step'|'checkpoint',id}]}]}`。accept 必须逐条覆盖标准并引用真实同 Task/当前 Run 的交付证据；Worker 不能用 Run ticket 自验收。
- Coordinator 使用 fresh 只读 reviewer，实际读取 `integrity=server_snapshot` 的产物后才可自动接受；不可读、legacy、二进制或无法独立验证的业务状态转 `needs_input`。人工可最终核对。reject/needs_input 不自动重做副作用。
- GET `/runs/:id/steps` 返回 ToolStep：`{id,run_id,tool,title,status,started_at,completed_at,error_code,created_at,version}`。状态含 `result_unknown`；工具名/标题及错误码由服务端白名单映射。
- GET `/assistant/events?status=pending` 返回持久 CoordinatorEvent；GET `/assistant/events/:id/context` 提供原始授权消息、所属计划及该计划全部任务（最多20个，含终态）的安全状态与最多8k结果摘要。
- POST `/assistant/events/:id/complete {message?,review_id?,follow_up_plan_id?}` 原子消费事件并保存汇总；POST `/assistant/events/:id/usage` 使用实际 request_key/usage_revision 归因 review/assistant 成本，不伪造用户消息。
- POST `/plans/:id/actions {action:'cancel'}` 带版本和幂等键；待确认方案原子退出 pending，旧确认也不能再创建任务。任务取消传播子树及依赖后继；Run 晚到的新 envelope 不能清除取消意图、重复提交交付或复活 Task。
- 新附件经 staging PUT → HEAD + 条件 CopyObject → 随机独立 final key → 完整 XML/final HEAD 校验后 ready；旧 PUT 无法修改 final。列表、下载及 evidence 均投影 `integrity:'server_snapshot'|'legacy_unverified'`、`finalized_at`；ready 重放不复制，历史对象不静默改写。sha256 仍是客户端 claim。

## 通知接口

服务端 outbox、APNs 与 Expo 适配已实现并通过云 TEST/注入传输测试；真实凭据、签名和关闭应用后的真机送达仍需验收，不能用 provider 接受等同用户看到。详细配置、状态与隔离见[通知方案](notification-delivery.md)。

- POST `/clients/push-registrations {provider:'apns'|'expo',platform:'macos'|'android',token,environment?,project_id?}` 绑定当前登录用户及 session；APNs 只配 macOS，Expo 只配 Android。相同 session/目标重复注册不提升 version。
- GET `/clients/push-registrations` 返回 `{items:[{id,provider,platform,enabled,environment,project_id,version,status:'registered'|'unconfigured'|'disabled'}]}`；永不返回 token/hash/密文。DELETE `/clients/push-registrations/:id` 仅撤销当前 session 的注册。
- GET `/settings/notifications` → `{enabled,quiet_hours:null|{timezone,start,end},version}`；PUT 同字段，If-Match 必须为当前版本（不匹配412）。`timezone` 为 IANA 时区，start/end 为不同的 HH:mm，支持跨午夜和 DST。
- GET `/notifications` 返回持久通知列表。通知只带通用文案及对象 ID；问题已回答、交付已验收、取消或被新 Run 替换时抑制过时投递。退出或撤销 session 原子禁用其推送注册；同一设备 token 换账号时不能继续投给旧账号。

## 文件归属与开发规则

- 协调者：根配置、packages/protocol、scripts、infra、README 与文档集成。
- Server worker：apps/control-server；提供 Fastify 可测试 app factory、migration 与真实云端 PostgreSQL 集成测试。apps/server 与 db 保留给未知状态的先前外部工作，不编辑。
- Node worker：apps/node、packages/runtime-*、packages/tool-broker、spikes；本机 SQLite、真实运行时、CSI、配对 CLI。
- macOS worker：apps/macos；Swift 原生可构建应用与 API 客户端，不创建网站。
- Android worker：apps/android；React Native 原生工程/Expo 开发构建与 API 客户端，不创建网页替代原生。
- 不修改其他负责人的文件。不修改根 lockfile，各组件 package.json 就绪后通知协调者统一 pnpm install。不要删除原始设计。无外部服务时实现可测试适配器并显式报告限制，不冒充通过生产环境验证。
- 云端数据库、对象存储、OIDC 和服务镜像；禁止拉取/启动本机 Docker 或本机数据库。节点 SQLite 仅是本机持久执行日志。
