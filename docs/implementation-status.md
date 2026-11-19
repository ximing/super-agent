# 实施状态

更新：2026-11-19。此文件区分代码、测试与部署，不将单元测试通过等同于生产就绪。

## 当前已验证

- 公共协议包可构建，状态迁移与金额/未知费用 4 项测试通过。
- Mac 节点及两个 Runtime、ToolBroker 均可构建；已验证文件路径与符号链接越界、浏览器独占、Codex JSON-RPC、Grok 本地工具循环、取消、SQLite 去重与重启不重放。
- 真实本机 Codex 0.170.0 只读探测通过：初始化、模型列表、只读 thread 创建/归档和 dynamicTools 定义接受；未因此启动付费模型回合。
- 控制服务与节点构建通过；服务端 21 项 + 跨组件 4 项测试在同一轮并行回归 **25/25、0 skip**，使用真实专用云 test 数据库和私有 S3。覆盖隔离、签名重放拒绝、确认与计费幂等、会话撤销、记忆绑定、接管回收、文件权限、版本迁移和 DDL/业务互斥。数据库连接故障明确返回可重试 503。
- 跨组件测试使用真实 NodeAgent/SQLite/Fastify 与云 PG；模型使用明确 FakeRuntime，CSI 使用明确 mock。验证聊天确认前无 Task、确认后仅一个 Task 到指定第二台电脑/Grok、重启去重、澄清上下文、暂停接管与 Retina 坐标换算。
- Android typecheck、5 项 API/安全配置测试和 763 modules Hermes JS 导出通过。独立 release APK 已由最新 GHA 构建通过，CI 和下载后均核验内嵌 Hermes 字节码、不依赖 Metro，APK 签名校验通过；包约 56 MiB，Android 7+。内部测试签名与正式发布签名分开。
- Swift 编译、5 项 XCTest、release appbundle 与本机签名通过；离线登录页截图已检查，原生“读取登录配置”已实连公网 API 并启用安全登录。正式分发签名/公证尚需用户 Apple 开发者配置。
- 真实云端 OIDC S256 授权、callback state、Token 交换、JWT 签名/audience、产品会话与注销撤销通过；临时 Keycloak 测试用户已删除。已修复 Keycloak 26 client 默认 scope 缺 basic 导致无 sub 的配置问题。
- 使用本机已连接的 Recall 账号验证产品绑定与直接读取既有内容通过；临时产品绑定已按 version 删除，未修改既有记忆内容。PAT 未输出、未进入公开仓库。
- 真实 CSI/Chrome 已验证 BrowserActor 快照、JPEG 帧/视口尺寸和接管 CDP 点击；测试仅操作新建公开示例页，未读取用户其他标签页。
- **真实 Codex 推理与工具路径已验证**：本机既有系统代理下 28.476 秒完成 1 次受限只读工具、`item/tool/call` 回执与固定结果，输出 9 Token。此前直连的流中断及最终成功证据都保留在 `spikes/`，不把失败探测写成成功。
- 节点自动继承本机代理（显式 env > 本机配置 > 系统），Node 24.14+ 原生 fetch 覆盖 Grok 路径；后台 PATH、已有 CSI 幂等启动、无正文 DELETE、附件传输边界均测试。当前开发机没有安装永久 Worker 自启动。
- 公网 TEST 服务完成真实 OIDC → Ed25519 配对 → NodeAgent/SQLite/FakeRuntime → 实际 Recall 只读检索 → checkpoint/费用 → 重启去重及真实报告重放。四阶段全部通过，临时绑定/设备/会话/Keycloak 用户/本机身份均已清理。

## 云资源

| 资源 | 状态 |
| --- | --- |
| `super_agent_test` / `super_agent_prod` | 已创建，每环境独立 owner/service；service 非 superuser、非 BYPASSRLS |
| PostgreSQL TLS | 从已认证 SSH 获取证书并固定信任；连接验证通过，未关闭全局 TLS 校验 |
| test 迁移与隔离测试 | 已真实执行；prod 不做破坏性测试 |
| `super-agent-test` / `super-agent-prod` S3 | 已创建/验证，Put/Get/Delete smoke test 通过 |
| Recall | 每用户独立加密绑定、既有记录读取、候选审核发布与搜索适配已实现；真实账号绑定/列表与隔离测试已通过 |
| OIDC | 云端 Keycloak、test/prod realms、native PKCE client、公网 HTTPS 与真实 Token/产品会话交换已验证 |
| GitHub | [代码 61639c3 的完整检查](https://github.com/ximing/super-agent/actions/runs/44344213897)全绿；[同版本服务镜像](https://github.com/ximing/super-agent/actions/runs/44344248181)已由云 CI 发布 GHCR |
| 安装包 | [v0.1.0-preview.1](https://github.com/ximing/super-agent/releases/tag/v0.1.0-preview.1)已公开发布：Mac arm64 ZIP 与独立 Android APK |
| API | `https://super-agent.aimo.plus` 已切换 `super_agent_prod` / prod S3 / prod OIDC，容器 healthy；生产角色非 superuser/非 BYPASSRLS，任务 FORCE RLS，未授权401、开发登录404 |
| 本地 Docker | 用户确认全清后执行；当前 Colima 的容器/镜像/卷均为 0，默认 context 未发现第二个可用引擎 |

现有 PostgreSQL 没有安装 vector 系统扩展。记忆已改为复用 agent-recall，不为此修改既有数据库服务或另建向量基础设施。

## 仍需验收

- 正式执行 Mac 安装配对、目标 Android 真机操作；当前 Mac 生产账号已完成用户首次改密和登录，工作台现场已核对。
- 真实节点连接云端 API 后的完整任务、跨电脑切换、浏览器画面与人工接管。
- Grok 实际账号调用、业务网站样本、厂商推送和签名配置。

## 与完整产品目标的实现差距

2026-11-19 按实际源码复核。此前的“仍需验收”并未列全实现缺口；当前版本是基础预览版，不能将独立任务并行、提示词和接口占位等同于完整助理团队。

| 能力 | 已有基础 | 尚未实现或尚未闭环 |
| --- | --- | --- |
| 多 Agent 团队 | 主助理提案、确认后创建多个独立 Task，多电脑可并行 | 父子 Agent/Run 树、依赖 DAG、拓扑执行、失败传播、子树取消、Worker 完成事件驱动的自动汇总与再规划；Codex 原生 multi_agent 当前关闭 |
| 交付验收 | 完整结果、云附件、未知业务结果的人工核对 | 独立核对 deliverables 和业务完成标准；目前模型返回后上报成功，未实现自动质量验收 |
| 主动性 | 固定间隔提醒，准备方案后等待确认 | 网站/系统事件观察、条件触发、静默时段、时区规则、个性化建议和持续偏好学习 |
| 记忆学习与治理 | 本人 Recall 绑定、搜索/读写/版本、候选人工审核发布 | 自动复盘、结构化事实/推断与证据验证、冲突/过期处理、活跃 Run 知识失效广播、节点有界缓存与离线 stale；任务级记忆范围也未完整强制过滤 |
| 成本预算 | Token/费用记录、去重、未知费用显示、月额度准入和 Run 预留 | 逐轮 budget grant、单任务实际累计限制、未知金额的 Token 替代约束、主助理/主动任务独立预算、价格表估算和外部记忆/工具费用归集 |
| 图片与画面 | 人可以看网页截图，模型用 DOM/文本工具操作 | 截图/图片的模型视觉输入链路；完整桌面、其他 App、视频、完整远程键鼠仍为后续范围 |
| 跨机恢复 | 新 Run、检查点与同任务云附件可交接 | 完整环境预检、文件清单自动恢复、无人故障接任、可靠的原生会话恢复；重启后未知执行仍需核对 |
| 进度展示 | 状态、Run 摘要、提问、画面和结果 | 工具步骤时间线、SubAgent 树及面向业务的阶段进度 |
| 安装与管理 | CLI 安装、配对码、能力显示、手动 LaunchAgent | 图形化安装配置向导、后台服务管理、自动更新；客户端设备撤销和会话管理入口尚未接 API |
| 关闭 App 后通知 | APNs/Expo 注册适配、运行中的轮询提醒 | 服务端通知生产/投递 outbox、重试和 APNs/FCM 发送闭环，不能归为只差厂商密钥 |

另行区分：Grok 真实账号、公司网站、真实多 Mac 接续、Android 真机及长时间弱网运行是尚未完成的验收；正式签名/公证是发布配置工作。它们不等于上述未实现功能。

登录复测：本机 `ASWebAuthenticationSession` 请求已启动但未弹窗，系统交接根因尚未确认。Mac 新增显式“改用浏览器登录”，复用 PKCE 并严格校验、一次性消费回调；用户已沿此路径完成首次改密和生产登录，现场核对已进入真实工作台。新增阶段提示、取消与超时，8 项 Swift 测试通过。身份配置接口另曾出现 5 秒后返回不完整配置的间歇降级，仍需补可靠性处理；不将备用路径成功等同于原系统窗口问题已解决。

首版定时关注支持创建/启停/删除，触发后提醒并准备待确认目标，确认后执行。应用前台用持久 REST 增量轮询；尚未实现 WSS 和服务端厂商推送，不声称应用关闭后已能收到远程通知。

所有本机模型 Key、数据库连接串、设备私钥和 OIDC 管理密码均不在仓库或本文件中。真实配置由被忽略的环境文件和云服务器配置持有。

生产上线前已备份并由 owner 首迁；生产环境只进行健康、配置、角色与 RLS 的只读验证，没有将生产库用作集成测试。开发电脑未安装长期 Worker；用户将在当前验证后安装到独立 Mac。正式安装说明见 [开始使用](getting-started.md)。
