# 实现集成契约（开发共享）

本文件固定当前跨组件接口形状。2026-11-19 及此前段落仍是当时已实现、且旧客户端继续使用的兼容接口。2026-11-20 交互回执见文末同名一节：代码已落地，迁移 004 尚未应用到云端数据库，生产部署与真机验收见[实施状态](implementation-status.md)。实现可修正文档，但跨模块变更先通知协调者；类型见 `packages/protocol/src/index.ts` 与 `packages/protocol/src/interaction.ts`，路径均有 `/v1` 前缀，JSON 字段统一 snake_case，列表响应 `{items:[]}`。时间 UTC，金额字符串。

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
- GET/PUT/DELETE `/settings/memory` 绑定本人 Recall；PUT `{url,token,project?}`，返回只含账号、状态、版本和 `project`，不返回 PAT。请求体没有 `project` 时保留已保存的项目；JSON `null` 或空字符串才清除；非空字符串写入新项目。只改 URL 或 Token 不会把项目写成 null。项目只决定以后任务能搜索和读取哪一组记忆，不改写记忆正文。已有绑定时 PUT 需要 If-Match，版本不符返回 412。相同 Recall 账号不得绑定两个产品用户；未绑定返回明确 503。Token 仍按租户加密，响应和日志不回显。
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
- POST `/node/runs/:id/checkpoint {checkpoint}` 要求有效 Run ticket、epoch/租约且 Run 仍 active/stopping；首个 completed 内容 hash 冻结，同内容重放返回原 ID，不允许替换已交付快照；POST `/node/runs/:id/frames` body Frame；GET `/runs/:id/frame` 返回本人最新 Frame 或 404；授权Run有效时，即使首帧尚未产生，匹配当前登录session且未关闭的view也先提交30秒续期，再返回404。S3画面读取在租户事务外执行，返回Frame白名单，不返回object_key。
- POST `/runs/:id/views {}` 开启按需采集，DELETE `/views/:id` 关闭；POST `/views/:id/control {}` 请求暂停与接管；POST `/views/:id/inputs {frame_id,viewport_version,type,x?,y?,text?,keys?}`；DELETE `/views/:id/control`。
- 接管输入 x/y 为原始截图像素；节点按实际截图尺寸与 CSS viewport 换算。拒绝过期帧、错误 viewport_version、越界坐标和已改变的窗口尺寸。
- 主助理：POST `/assistant/lease/claim {}`、`/assistant/lease/renew {epoch}` -> `{epoch,lease_valid_for_ms}`；GET `/assistant/inbox` -> `{items:Message[]}`；POST `/assistant/plans {source_message_id}`（或互斥的 `{source_event_id}`） -> `{id,state,tasks:Task[]}`；POST `/assistant/plans/:id/commit {items:[{item_key,title,goal,engine,device_id}]}`；POST `/assistant/messages {source_message_id,content,task_id?}`。
- 用户已经说清的交办直接执行：`POST /assistant/plans/:id/propose` 仍先保存方案，接着 `POST /assistant/plans/:id/start` 用这条用户消息本身作为授权创建任务，不再等第二句「确认」。目标不清、定时提醒（`schedule_id`）和失败后的新后续方案仍停在 `awaiting_confirmation`。`POST /assistant/plans/:id/confirm` 或 `/reject {source_message_id}` 继续接受方案之后的真实确认或拒绝。仍在等待的方案由登录用户点 `POST /plans/:id/actions {action:'confirm'}` 开始，或 `{action:'cancel'}` 取消，不需要再发一条「确认」消息。用户如果仍然只回复「确认」，且上一句目标还没形成待确认方案，就按那句目标开工，不回答「没有计划」。旧 commit 不能绕过这些规则。
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
- 观察证据由 ToolBroker 上传，不由模型声明“已核实”。`evidence_kind` 为 `page_capture`、`screenshot` 或 `memory_retrieval`，`provenance` 只能是 `tool_broker`。网页证据含 `captured_at`、去掉用户信息和查询串的 `source_url`、正文或快照、截断与脱敏标志。截图证据不依赖 `POST /runs/:id/views`。记忆证据含查询、范围、版本和来源 ID，不复制无关记忆全文。自动验收若本 Run 有成功的 `browser_*` 或 `memory_*` 步骤，device reviewer 的 accept 必须引用已冻结的观察产物；否则 422。人工验收仍可使用检查点，但不能把工具成功当成业务成功。

## 记忆范围与运行预算

- `POST /tasks`、`POST /messages` 和已确认计划项可带 `memory_scope:{project,sites,global_preference,statuses,max_version}`。任务列表和任务详情同时返回顶层 `memory_scope` 与 `budget`。省略 `memory_scope` 不是放开全部记忆。`sites` 为空时不能读取空站点记忆，也不是通配。用户消息上的范围是计划和子任务的授权上限：项目必须相同（上限未指定项目时才可以收窄到一个项目）；站点必须是子集；`global_preference` 只能从开收到关；状态必须是子集；上限写了 `max_version` 时请求也必须写并且不更大。省略的计划项继承该上限；子项再被父项的有效范围封顶。扩大范围返回 422 `memory_scope_exceeds_grant`，普通规划、事件再规划和确认创建任务使用同一条规则。消息没有范围时上限是关闭的：不限项目、无站点、全局关、只读 verified。确认摘要追加“实际生效的记忆范围”。扩大范围要发一条带新范围的用户消息，不靠默认放开全部记忆。Worker 的全局偏好必须同时满足任务范围 `global_preference=true`、记忆 `scope_kind=global`（或适用性 global）以及执行设置 `memory_global_read=true`。`PUT /settings/execution` 省略 `memory_global_read` 时保留原值，显式 `false` 关闭。Planner 带 `task_id` 时使用该任务范围，并可以看见 candidate；不带任务时只有上述全局偏好。用户消息上的范围若与同一 `client_message_id` 的已有消息不同，返回 409。用户自己的 `GET /memories/:id` 仍可管理本人记忆。
- 任务成功或失败都写本地复盘候选，来源是 `model_inference`，不自动 `verified`，不发布到 Recall。标题相同不是语义冲突，不会自动标成 conflict。用户在验收里拒绝并写下纠正时，另写一条 `user_statement` 候选。工具产物只作为证据引用，不把模型摘要改成已观察事实。`GET /memories/:id/related` 使用当前用户的 Recall `/api/memories/recall`，返回 `search_mode:agent-recall` 和 `semantic_conflict:user_decision`；只有上游给出数值 `score` 时才带 `semantic_score`，没有分数就不声称做了语义冲突检测。合并、替代和拒绝仍由用户调用关系接口。长期偏好可用 PATCH `{preference_enabled:false|true}` 关闭或恢复，关闭后 Worker 检索不到它，用户自己仍可查看。`POST /memories/:id/relations` 需要 If-Match，`relation` 为 `conflicts|supersedes|expires`，并用 `operation_key` 幂等。它只写产品侧关系，不修改、发布或删除 Recall 正文。若记录属于当前用户绑定的 Recall 但还没有产品侧 overlay，关系请求在授权通过后用 `INSERT ... ON CONFLICT DO NOTHING` 初始化 overlay（治理版本从 0 起）；任意 ID、其他项目或上游不存在的记录返回 404，并且不插入行。已核验记忆可以设置未来的 `valid_until`。关系使用行锁，`governance.version` 单独递增；并发添加不同冲突会合并。`supersedes` 在同一事务里更新双方。可选 `governance_version` 与锁内版本不一致时返回 409。
- 节点记忆缓存键包含范围指纹和 generation。401/403/404 和凭据失效类 503 删除对应缓存并返回错误，不回放旧正文。只有传输失败可以返回 `stale=true`、`fresh=false` 且正文为空的结果。`GET /node/events?after=` 供设备续读 `memory.changed`；成功重连后按游标补齐并清空受影响缓存。
- 观察产物带 `fresh`。`memory_retrieval` 即使命中列表为空，也保留整体 `fresh`、`stale`、`stale_reason` 和 `observed_at`。三个时间分开：`observed_at` 是原始观察，`retrieved_at` 是缓存读取，`generated_at` 是证据生成。`fresh=false` 不能充当当前事实。网页正文和截图的 URL 必须来自同一次捕获里解析成功的 `http`/`https` 地址。解析失败、空地址、`about:blank` 或其他协议都不能判为来源稳定；请求 URL 不能回填为捕获来源。此时产物为 `source_url:null`、`source_uncertain:true`、`fresh:false`、`stale:true`，不能通过 `isIndependentObservation`。捕获期间网址变化会重采一次，仍然不一致则 `source_uncertain=true`，不把前一页正文标成后一页来源。自动 accept 所引用的观察产物必须已被本次 reviewer 读取。网页证据对正文里的 URL 副本做同样的认证参数清理。
- 活动根标识只有一种写法，并同时用作首次预留的 `operation_key` 与 `activity_id`：执行 `run:<runId>`，聊天规划 `assistant:<messageId>`，定时规划 `proactive:<messageId>`，交付审核 `review:<deliveryId>`，事件协调 `event:<eventId>`，一次网页观察命令是 `proactive:observation:<commandId>`。显式新尝试把根标识加上 `#N`（N 从 2 起），`prior_activity_id` 仍是根。用量、心跳、释放和结算使用服务器返回的那条尝试标识，不把 `#2` 记回根，也不把省略的标识在已有未过期尝试时记到根上。`run_id` 只保存真实 Run。定时规划的用量类别是 `proactive`，交付审核是 `review`，失败汇总和事件协调是 `assistant`，执行和子任务是 `worker`。成功、失败、崩溃恢复和断线重传都保留类别、`occurred_at` 和 `request_key`。相同 `usage_revision` 不重复记账，也不改写原类别。
- `POST /assistant/budget/reserve` 在助理、审核、主动规划和事件汇总调用模型前执行，并与 Worker 派发共用同一租户预算锁。同一 key 返回原预留，不重复占额。返回的 grant 只有同时满足这些条件才是可执行授权：`limits` 存在、`status=reserved`、`expires_at` 仍在未来、`activity_id` 与本次操作键一致，并且调用方设备与预留 `device_id` 一致（两边都有设备时）。`expired`、`released`、`settled`、过期或别的电脑拿到的记录只能查询和恢复结果，`executable=false`，不能再发起模型调用。节点缺少 `limits` 或可执行 grant 时直接失败，不回退类别默认额度。新的尝试必须显式 `new_attempt:true`，且只在原预留已终态、同一家族没有未过期的 `reserved` 时创建；新键是 `${root}#N`，`prior_activity_id` 指向原来的活动，并重新走过预算准入。重复的 `new_attempt` 返回这条仍有效的尝试，不另开预留，也不靠更换随机键绕过上限。用量接口接受这条真实尝试标识：`activityRootId` 必须等于该消息、交付或事件的根，并且已有属于这台电脑的预留；根标识在 `#N` 仍有效时返回 422 `activity_mismatch`。`POST /assistant/budget/heartbeat {activity_id}` 和 `POST /assistant/budget/release {activity_id}` 只处理这一条仍属于调用方设备的预留。助理回复或事件完成会按根标识关闭家族里每一条仍为 `reserved` 的尝试，每条只用自己的用量结算。分类额度只统计该类别；任务总额度另外约束执行用量。新 Run 拿到的是扣掉该任务历史消耗后的剩余 Token、模型次数和工具步。运行时长按这一次活动计算，不从任务创建时间累计，提高时长也不会清掉其他维度的已用量。
- `PUT /budgets` 和 `PUT /tasks/:id/budget` 都需要 If-Match。默认 `mode` 是 `merge`：省略的金额、分类或单个限额保留；显式 `null` 只清除该字段；`mode:'replace'` 才整份替换。任务额度可以高于默认值，但不能超过产品上限。`GET /tasks` 返回的 `budget` 是已保存的任务覆盖，不是把缺省维度填成空。提高对应维度后，用响应里的新 `version` 重试。`GET /budgets` 和 `GET /costs/summary` 分开返回已发生金额、未知次数、预留金额和预留中未知笔数。预留金额为 0 只表示没有已知金额的有效预留，不表示未知费用免费。`GET /costs/breakdown?group_by=category` 按执行、助理、验收、主动规划分组。
- 预算预留继续使用 `budget_reservations`。预留金额不是实际费用；未知预留的 `amount` 为 null，不按 0 计入，也不写成已结算。有效预留在同一事务和预算锁内只有一个定义：状态为 `reserved`，且未过 `expires_at`，或对应 Run 仍处于活动状态，或该活动自己的 `heartbeat_at` 仍在 45 秒内。另一条主助理租约不能保护已经失去心跳的无主活动。准入、汇总和调度器使用同一规则；已知金额占用美元额度，未知金额在配置了月金额时让下一次准入返回 `budget_unknown`。没有配置美元额度时仍执行 Token、模型次数、工具步和运行时间限制。完成后按该活动的用量关闭预留：没有用量是 `released`/`awaiting_usage`，含未知金额是 `released`/`unknown`，全部已知才是 `settled`。关闭不把用量抄进预留金额。崩溃清理为 `expired`/`open`。迟到用量仍入账并标记 `late_usage`，`occurred_at` 保持首次真实发生时间。续租可返回 `control.action=pause`、`reason` 和 `recovery`。`dollar_cap` 固定为 `not_enforced`。已发出的 Grok 请求在断连、超时或取消后记一笔可去重的未知尝试；发送前失败不伪造供应商调用。Codex 内部回合和 Grok CLI 隐藏轮次不构成供应商账户硬限额。

## 观察规则、进度与接任

- 固定间隔提醒仍是 `POST /schedules`，`mode` 为 `remind_and_confirm`。它不会被观察规则复用。观察规则是 `kind:observation` 的独立文档：`GET/POST /observation-rules`，`PATCH /observation-rules/:id` 需要 If-Match。文档 `version` 每次写入都增加。`config_version` 只在名称、目标、启停、设备、引擎、项目、网站、来源、匹配、地址、条件、冷却或任务标识变化时加一；`last_status`、历史、建议和冷却时刻不算配置变化。`source:task_result` 只在指定任务的 status、delivery 或 reason 真正变化时写一条待确认建议；同一指纹不重复建议。`source:page` 只在目标电脑在线、有浏览器槽位、没有活动执行、没有人工接管、也没有待处理检查命令时下发 `observation.check`。命令载荷带 `command_id`、`rule_id`、`config_version`、设备、引擎、地址、网站、条件和项目。设备忙或离线记为 suppressed，不计失败。
- 网页观察不使用主助理租约。指定设备用自己的设备凭证调用 `POST /node/observations/:id/budget/reserve|heartbeat|release|usage`。预留前要核对命令身份、设备、未过期、规则仍启用，且 `config_version` 与命令和规则一致；否则 409 `observation_inactive`，不占额度也不记账。活动标识是 `proactive:observation:<commandId>`，类别 `proactive`。模型调用前必须拿到可执行 grant。没有 grant 时不回退默认额度。用量按返回的尝试标识持久化，同一 `request_key` 重传不重复记账，未知金额保持 null。完成、失败、取消和重启都释放该尝试；重启不再次调用模型。`POST /node/observations/:id/report` 必须带同一 `command_id` 和 `config_version`。同一命令重复回报不新增建议，更早的 `sent_at` 不覆盖较新状态。规则停用、删除或配置版本变化后，旧命令不能生成建议。确认建议时再次检查规则仍启用且建议上的 `config_version` 仍是当前配置；通过后才 `createTask`，记忆范围等于规则上的项目和站点，全局偏好关。忽略建议不创建任务。观察规则不会变成一条用户消息。
- `GET /events?after=` 和 `GET /node/events?after=` 按租户读取 `sa_events`，游标是数字 `stream_seq`。`GET /v1/events/stream` 是登录用户的 SSE：单次连接最多约 25 秒，断线后用 `Last-Event-ID` 或 `after` 补齐。Mac 与 Android 保存该用户的数字游标，重连时带上，按 `stream_seq` 去重，并保留较慢的 REST 刷新。步骤事件仍只含生命周期字段，不含工具参数、凭据或未脱敏正文。产品任务图是 Task 的父子和依赖；引擎没有发出原生 SubAgent 事件时不展示另一棵树。
- 记忆检索产物的验收引用的是产物 ID。独立正文读取记录的是命中记忆的 ID 和版本。只有先读过该 `memory_retrieval` 产物，并且它每一条当前命中（非过期、版本一致）都被读过正文，才能用这篇产物 accept。读到别的记忆、错误版本或过期命中不能满足这一条。截图仍只有 `supportsVision()` 为真且请求体包含该图片字节时才能当作已读；Grok API 模式在配置了本机密钥时可以这样发送图片，Grok CLI 和 Codex 仍是 `unsupported`。这不是一次真实模型看图验收。
- `GET /tasks/:id/takeover?device_id=&engine=` 返回接任检查：旧租约是否仍有效、未知结果是否已核对、目标引擎是否在线就绪、浏览器槽位、网站登录（服务端永远是 unknown）、冻结产物是否有 `server_snapshot` 和 sha256。`ready` 只在每项都是 pass 时为真。`POST /tasks/:id/takeover` 必须 `acknowledge_login:true`，并且 authority、reconciliation、engine、artifacts 不能是 fail；通过后才走原有的显式 switch。没有静默替换正在执行的 Worker 程序。模型账号和凭据仍只在用户自己的 Mac 上。

## 通知接口

服务端 outbox、APNs 与 Expo 适配已实现并通过云 TEST/注入传输测试；真实凭据、签名和关闭应用后的真机送达仍需验收，不能用 provider 接受等同用户看到。详细配置、状态与隔离见[通知方案](notification-delivery.md)。

- POST `/clients/push-registrations {provider:'apns'|'expo',platform:'macos'|'android',token,environment?,project_id?}` 绑定当前登录用户及 session；APNs 只配 macOS，Expo 只配 Android。相同 session/目标重复注册不提升 version。
- GET `/clients/push-registrations` 返回 `{items:[{id,provider,platform,enabled,environment,project_id,version,status:'registered'|'unconfigured'|'disabled'}]}`；永不返回 token/hash/密文。DELETE `/clients/push-registrations/:id` 仅撤销当前 session 的注册。
- GET `/settings/notifications` → `{enabled,quiet_hours:null|{timezone,start,end},version}`；PUT 同字段，If-Match 必须为当前版本（不匹配412）。`timezone` 为 IANA 时区，start/end 为不同的 HH:mm，支持跨午夜和 DST。
- GET `/notifications` 返回持久通知列表。通知只带通用文案及对象 ID；问题已回答、交付已验收、取消或被新 Run 替换时抑制过时投递。退出或撤销 session 原子禁用其推送注册；同一设备 token 换账号时不能继续投给旧账号。

## 交互回执与恢复（2026-11-20）

旧客户端可以忽略新增字段。`GET /v1/capabilities` 无需登录，也不读数据库，返回 `{protocol:'2026-11-20', message_processing, action_receipts, workspace_snapshot, chat_fast_path, task_progress}`。任一标志为 false，或旧服务返回 404 时，客户端只保留本地即时消息与局部忙碌，不显示“电脑已接收”。

环境变量 `INTERACTION_MESSAGE_PROCESSING`、`INTERACTION_ACTION_RECEIPTS`、`INTERACTION_SNAPSHOT`、`INTERACTION_FAST_PATH`、`INTERACTION_TASK_PROGRESS` 缺省开启；`0` 或 `false` 关闭对应新行为。关闭不删除已有回执，也不重放模型或业务动作。标志缺省开启，因此新服务处理真实流量前必须先应用迁移 `004_interaction_receipts.sql`；未应用时可把五个变量设为 `0` 或 `false`。001/002/003 不修改。本迁移只建 `sa_message_processing` 与 `sa_task_actions`（FORCE RLS、租户策略、`super_agent_app` 授权）。不回填历史消息。

- POST `/messages` 仍返回 Message。标志开启时，同一事务写入消息、初始处理回执和 `message.created`。消息上可出现 `client_message_id`、`processing_status`、`processing_phase`、`reason_code`、`action_id`。同 `client_message_id` 而正文或记忆范围不同，返回 409 `message_conflict`。
- GET `/messages/:id/processing` 返回处理回执。没有存储行时，已有回复或收件回执则 `historical:'handled'`，否则 `historical:'unknown'`。两种都不编造时间，也不把历史消息重新送进模型。
- GET `/messages/by-client-id/:client_message_id` 返回 `{message, processing}`。不存在为 404。客户端不得因此更换幂等身份。
- POST `/assistant/messages/:id/claim` 在有效主助理租约下认领。同一设备、仍有效的 epoch 复用 `attempt_id`。终态原样返回。另一台电脑持有未过期租约时返回 409 `assistant_lease_held`。过期持有者不能推进终态。节点收到 404 或没有 `attempt_id` 时沿用原规划；`attempt_id` 为 null，或状态已是 handled/failed/interrupted 时不再调用模型。
- POST `/assistant/messages/:id/progress` 只接受当前尝试、报告 ID 和预期版本。原因码来自 `PROCESSING_REASON_CODES`。版本不符 409 `processing_conflict`，尝试不符 409 `attempt_mismatch`。阶段或状态没有变化时不刷新 `last_progress_at`。心跳不写任务进度。
- POST `/assistant/messages` 仍是回复事务。可选 `processing_outcome:'handled'|'interrupted'`。省略时按 handled。已有助理回复则返回该回复并完成处理回执，不开始新的模型尝试。
- POST `/tasks/:id/actions` 仍返回 `{action_id, status:'accepted'}`。标志开启时多一个 `receipt`。`receipt.status` 为 `accepted`、`delivered`、`applying`、`completed`、`failed`、`result_unknown` 或 `superseded`。HTTP 的 accepted 只表示请求已保存。暂停完成要等绑定运行进入 paused；取消要等任务或运行取消；继续或重试要等新运行 dispatched，而不是等任务做完。切换在旧运行已暂停或取消、且更新的运行已 dispatched/starting/running 时完成。丢失或 `result_unknown` 的运行把停止类回执标为 `result_unknown`，原因 `reconcile_required`。租约丢失本身不是 completed。级联取消只给用户点击的父任务保存一份回执。
- GET `/actions/:id` 返回持久回执。新节点用 `action.progress` 报告 `delivered` 或 `applying`，并在请求停止之前入队，不等待画面或模型。旧节点省略 `action_id` 时，服务端只在运行终态能够证明时补结果，不伪造 delivered。旧取消不能停止新运行。续租返回的 `control` 可以带可选 `action_id`。
- GET `/workspace/snapshot` 在一个租户事务里返回游标、未终态或待验收或交付待核对的任务、最近消息、未完成处理回执、未完成及 24 小时内更新的操作回执、待回答问题和设备。
- 事件 `message.processing.changed`、`task.progress.changed`、`action.changed` 与旧事件并存。`run.started` 的 payload 含 `state`；`dispatched` 表示等待电脑接受。游标按数值比较，非法游标 422 `invalid_cursor`。现有服务不返回 410；客户端不能假定游标过期已经实现。
- 整句进度、暂停、继续、取消、重试在标志开启时由服务端确定性处理，不调用模型。多个任务先返回选择，不猜测最新任务。唯一匹配的“选择 <编号前缀>”只返回该任务状态，不执行控制；多个前缀匹配仍先选择。已有待确认方案时，“确认 / 开始执行 / 确认执行 / 取消 / 拒绝 / 不要执行 / 取消执行”仍交给原规划，不在快通道里取消任务。快通道回复写明请求已保存，执行电脑尚未完成该操作。
- 节点在 `chat_fast_path` 为真且句子不是上述方案决定时直接返回，不调用模型，也不再本地执行同一句。能力查询失败不缓存，下一句会再问。标志关闭或查询失败时，节点可以用本机任务列表回答整句状态或控制，仍然不调用模型。

## 文件归属与开发规则

- 协调者：根配置、packages/protocol、scripts、infra、README 与文档集成。
- Server worker：apps/control-server；提供 Fastify 可测试 app factory、migration 与真实云端 PostgreSQL 集成测试。apps/server 与 db 保留给未知状态的先前外部工作，不编辑。
- Node worker：apps/node、packages/runtime-*、packages/tool-broker、spikes；本机 SQLite、真实运行时、CSI、配对 CLI。
- macOS worker：apps/macos；Swift 原生可构建应用与 API 客户端，不创建网站。
- Android worker：apps/android；React Native 原生工程/Expo 开发构建与 API 客户端，不创建网页替代原生。
- 不修改其他负责人的文件。不修改根 lockfile，各组件 package.json 就绪后通知协调者统一 pnpm install。不要删除原始设计。无外部服务时实现可测试适配器并显式报告限制，不冒充通过生产环境验证。
- 云端数据库、对象存储、OIDC 和服务镜像；禁止拉取/启动本机 Docker 或本机数据库。节点 SQLite 仅是本机持久执行日志。
