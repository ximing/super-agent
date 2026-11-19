# Control server

真实 PostgreSQL 控制服务；模型账号、Key 和推理请求都留在用户 Mac。包名 `@super-agent/control-server`，与尚未核实的旧 Orca 服务端目录分开。

## 云端部署

本组件不创建本地数据库，不提供内存生产仓库。用户部署云端 PostgreSQL 后配置：

```text
DATABASE_URL=postgresql://<non-owner-app-user>:<password>@<cloud-host>:5432/<database>?sslmode=verify-ca
MIGRATION_DATABASE_URL=postgresql://<migration-owner>:<password>@<cloud-host>:5432/<database>?sslmode=verify-ca
JWT_SECRET=<at-least-32-random-bytes>
PORT=8787
HOST=127.0.0.1
ALLOW_DEV_AUTH=false
OIDC_ISSUER=https://<identity-provider>/<realm>
OIDC_AUDIENCE=<API-audience>
OIDC_CLIENT_ID=<native-client-id>
OIDC_REDIRECT_URI=superagent://oauth/callback
```

首先用独立 owner 连接 `pnpm --filter @super-agent/control-server migrate`，再用非 owner 的应用连接 `build` 和 `start`。也可明确 `AUTO_MIGRATE=true` 并提供独立 `MIGRATION_DATABASE_URL`；不会使用应用连接自动做DDL。迁移需要建表、扩展 pgcrypto，以及预建 `super_agent_app` 的 admin option（或建角色权限）；业务事务显式切换到无 BYPASSRLS 的应用角色并设置租户上下文，普通客户端无法选租户。自签名云端证书应固定 CA 并验证，不关闭 TLS 校验。

应通过用户云端 HTTPS 反向代理暴露 API。默认不开开发登录；`ALLOW_DEV_AUTH=true` 仅供专门的开发环境，`NODE_ENV=production` 会拒绝该组合。关闭开发认证后，必须配置 OIDC；没有配置不会降级成免登录。

可选云端 S3 兼容对象存储：`S3_ENDPOINT`（HTTPS）、`S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`（也兼容旧短名）。使用 path-style SigV4，不添加默认校验和请求，适配 RustFS。这是云端存储凭据，与用户模型 Key 完全独立。未配置时文件上传/下载明确返回 503。上传签名5分钟有效且只指向 staging。finalize 在行锁内 HEAD 核对大小/ETag，再用签入签名的源 If-Match 条件复制到随机独立 final key，检查完整 XML（包含 HTTP 200 内嵌错误）与 final HEAD 后发布；对 final 只签 GET，重放 finalize 不再复制。元数据以 integrity=server_snapshot 和 finalized_at 标记新快照，历史 ready 明确为 legacy_unverified，既有验收引用不自动改写。用户提供的 sha256 仍仅作为 claim，不冒充已验证摘要。staging 前缀可配置短期生命周期，final 对象按交付保留策略管理。

## Agent Recall 记忆

不再自建向量索引或默认使用本地 PG 记忆内容作为权威。每个用户通过 `PUT /v1/settings/memory {url,token,project?}` 绑定自己的 Agent Recall PAT；先验证 `/api/auth/me`，再以 AES-256-GCM 和租户 AAD 加密保存到独立 RLS 表。`GET /settings/memory` 只返回 configured、url、account、project、version，永不回显PAT或密文。重新绑定需 If-Match。

`MEMORY_ENCRYPTION_KEY` 应为单独稳定的强密钥；未配置时使用 JWT_SECRET 的域分离派生，轮换 JWT_SECRET 后需重新绑定，因此生产建议单独配置。`RECALL_ALLOWED_ORIGINS` 为批准的 HTTPS origin 逗号列表，默认仅 `https://recall.aimo.plus`；禁止任意私网/元数据 URL 和自动重定向。

绑定同一外部 Recall actor 到第二个用户会被唯一约束拒绝，不支持多个用户共用一个全局 PAT。既有记忆直接通过各用户 PAT 从 Recall 读取/召回，不会因绑定自动覆盖或删除；候选提案暂留 PG，显式验证后才写到 Recall。修改调用 Recall 版本API，保留原有tags。未绑定返回503 memory_not_configured，不假装返回空知识库。

## 已实现

- 带撤销检查的客户端会话、刷新轮换、OIDC JWT exchange；明确开关的开发身份入口。
- Ed25519 配对、公钥挑战单次消费、短期设备 token 和 Run ticket。
- PostgreSQL RLS、任务与运行/设备的组合外键、租户事件序列、幂等请求与回报去重。
- 指定电脑/引擎、持久命令派发、accept/renew、保守的失联核对、问题/答案、暂停/取消/切换检查点。
- 主助理租约、消息 inbox、最近对话上下文、稳定计划与主助理用量归因。自由聊天先 propose 目标/产出，等待真实后续用户消息 confirm/reject；确认和任务创建为同一事务，重复确认返回同一批任务，设备不能直接 commit 或绕过确认。
- 通过 Agent Recall 的知识 CRUD、已有记录读取、召回和本地候选提案。
- 用量版本、来源分组费用/Token大盘、预算预留与周期检查规则。费用支持带时区的 from/to ISO 区间（最多366天）及电脑/任务/引擎/模型筛选，默认当月UTC。
- 画面查看与接管命令、视口/帧校验；配置S3时帧本体写私有S3，云端DB每Run只保留最新元数据；无S3时云端DB保留最新一帧。
- 私有对象上传与下载的 S3 签名接口。

鉴权后限流以已验证用户/设备身份独立计数（1200次/分钟），匿名或无效凭证按IP限流（60次/分钟）；不会信任未校验JWT声明。

周期规则当前固定 `mode:remind_and_confirm`：到点产生主助理提醒/方案，仍等待用户确认后执行。它不使用合成的周期消息充当用户确认。人工接管需先等旧Run停止，同电脑其他活跃或未知Run会阻止接管；有效人工控制也阻止新Run。控制/查看租约到期会持久下发释放/停止查看，原任务保持暂停。

## 受管团队和交付验收

`002_team_orchestration.sql` 新增同租户任务依赖边、交付/验收和 Coordinator 事件。已应用的 `001_initial.sql` 保持不可变；版本 ledger 校验内容，后续 schema 变化用新迁移。迁移独占锁与业务共享锁互斥，图变更在行锁前按租户串行，保护确认、派发、回报和取消竞争。

计划条目支持 `depends_on_keys` 和 `parent_item_key`，确认时原子映射为 Task ID；依赖图和父树分别检测环，父子归属不隐含执行顺序。未通过验收、失败、取消或未知结果的依赖阻止下游派发。任务取消传播到子树和依赖后继，活跃 Run 等待实际停止；未被 accept 的启动可直接作废。已完成的历史结果不因取消重写。

Worker 的 Run `succeeded` 只表示执行结束，Task 进入 `awaiting_review`。用户或当前 Coordinator 经独立 reviews API 逐条验收，引用真实同 Task/当前 Run 的 checkpoint、step、artifact；Worker run ticket 不能自验收。空标准使用“目标完成且有可核对结果”。Coordinator 不能仅引用 Worker 原文自动接受，不能核实可选择 `needs_input`；根节点实现负责新的只读 reviewer runtime 和真实产物读取。用户最终验收通过才变为 Task `succeeded` 并释放依赖。

`/assistant/events` 是持久、幂等的完成/失败/验收事件队列；context 给出该计划完整状态，complete 原子保存汇总回复并消费事件。事件独立用量以 request key/revision 入账。后续再规划绑定 source event，新方案仍需真实用户确认。取消待确认方案会永久退出 pending，旧确认不能创建任务；取消意图与终态跨新回报 envelope 保持，不重新提交交付或放行依赖。节点只能读取当前任务与已验收依赖的产物，上传/finalize 权限仍限当前 Run。

检查点写入要求有效设备身份、Run ticket、epoch 与租约，只允许 active/stopping 最末保存。首个 completed 检查点按内容 hash 冻结；有效票据的同内容重放仅返回原 ID。已提交交付读取固定 checkpoint/artifact 快照，不能被较晚记录替换。

工具步骤只保存/广播工具名、固定标题、状态、时间与安全错误码；丢弃参数、结果、页面、URL及原始错误。`result_unknown` 明确保留，不将副作用超时伪装成失败。已存历史步骤同样通过白名单投影，浏览器能力槽位按真实 0/1 保留。

## 通知

003_push_delivery.sql 新增RLS注册/偏好/投递队列及仅摘要的全局token归属。登录session绑定注册，token租户AAD加密，注销/会话撤销与换账号锁序保护旧账号投递。通用文案不含业务正文；问题回声去重、过时提醒抑制、IANA静默/DST、有限重试和Expo回执均持久化。业务和通知使用独立single-flight循环；APNs接受不代表设备已显示。环境变量与真机验收见[通知方案](../../docs/notification-delivery.md)。本批次代码/TEST和生产部署完成；真实厂商配置及设备送达仍需验收。

## 验证

`pnpm --filter @super-agent/control-server test` 包含不依赖数据库的鉴权、Recall适配与费用口径单元测试。真实集成测试只有设置 `TEST_DATABASE_URL` 与独立 `TEST_MIGRATION_DATABASE_URL` 时运行，否则显式 skip/配置错误；这些 URL 必须指向用户提供的专用云端测试库。测试会迁移并创建独立随机用户记录，不会启动 Docker、本地 PostgreSQL 或生产替代仓库。根目录已配置文件时可用 `node --env-file=.env.test node_modules/tsx/dist/cli.mjs --test apps/control-server/test/*.test.ts`，不要打印该文件内容。

已在用户专用云端测试库（非owner应用角色、独立owner迁移）和私有测试S3上通过41项测试（0 fail、0 skip，2026-11-19最终回归）：双用户RLS/接口隔离、设备签名和挑战重放、幂等任务派发、聊天确认后原子创建任务、费用回报去重/未知金额、团队依赖与独立验收、事件费用/汇总幂等、取消复活/证据替换/旧确认竞争拒绝、真实S3条件复制快照与旧PUT覆盖隔离、通知outbox/回执/过时抑制/账号切换注销隔离/慢provider不阻塞业务、工具时间线脱敏、会话撤销、数据库临时连接故障503且无效Token仍401、首帧404续期提交/跨原30秒窗口采集、人工接管过期释放、未知结果阻塞与核对恢复、S3签名上传/完成/私有下载及Recall独立账号绑定。Recall upstream测试使用mock，不读写用户真实记忆；加密与隔离则通过真实PG验证。

## 目前限制

- 事件与设备命令采用持久 REST 补读，前端增量轮询；尚无 WebSocket/视频传输实现，后续可接同一事件/命令源。
- S3帧使用 `frames/<tenant>/<run>/<frame_id>` 不可变对象，避免旧元数据对应新像素；用户应为 `frames/` 前缀配置短期生命周期（建议1天）。
- 本组件不含供应商计费查询或平台钱包；费用是设备报告/估算，未知不记零。
- OIDC需要上游Token包含稳定sub、issuer和API audience；原生客户端使用PKCE。通知持久outbox、APNs/Expo发送/回执、注册与偏好API已接入并通过TEST；真实厂商配置、签名及关闭应用后的设备送达尚未验收，未配置明确unconfigured。详见[通知方案](../../docs/notification-delivery.md)。
