# 实施状态

更新：2026-11-19。此文件区分代码、测试与部署，不将单元测试通过等同于生产就绪。**本批次团队 DAG、独立交付验收、证据快照、工具时间线及通知 outbox 已实现并通过云 TEST；尚未部署生产，当前生产仍为 61639c3 基线。**

## 当前已验证

- 公共协议包可构建，状态迁移与金额/未知费用 4 项测试通过。
- Mac 节点及两个 Runtime、ToolBroker 均可构建；已验证文件路径与符号链接越界、浏览器独占、Codex JSON-RPC、Grok 本地工具循环、取消、SQLite 去重与重启不重放。
- 真实本机 Codex 0.170.0 只读探测通过：初始化、模型列表、只读 thread 创建/归档和 dynamicTools 定义接受；未因此启动付费模型回合。
- 控制服务 typecheck/build 通过；最终服务端 **40/40、0 fail、0 skip**（25.35秒），显式加载专用云 TEST 配置，使用非 owner 应用角色/独立 owner 迁移及私有测试 S3。覆盖隔离、签名重放、目标确认、费用去重、撤销、Recall 隔离、接管、迁移 ledger/锁、DAG/独立验收/取消传播、不同 envelope 的取消复活与证据替换拒绝、真实对象冻结、通知 outbox/过时抑制/HTTP/API/慢 provider 不阻塞派发。数据库连接故障返回可重试503。
- 最终跨组件云测试由协调者运行 **5/5 通过**，使用真实 NodeAgent/SQLite/Fastify 与云 PG；模型使用明确 FakeRuntime，CSI 使用明确 mock。覆盖聊天确认/重启去重/澄清、暂停接管与自然像素换算，以及团队执行、独立 reviewer 和事件恢复路径；不将 FakeRuntime 写成真实 Grok 或业务验收。
- Android 最新 typecheck 与 **12/12 客户端测试**通过，覆盖设备撤销、步骤隐私、任务关系及交付证据；先前基础运行的5项 API/安全配置测试和763 modules Hermes JS 导出为历史证据。独立 release APK 已由最新 GHA 构建通过，CI 和下载后均核验内嵌 Hermes 字节码、不依赖 Metro，APK 签名校验通过；包约 56 MiB，Android 7+。内部测试签名与正式发布签名分开。
- Swift 最新编译与 **17/17 测试**通过，覆盖登录回调、设备撤销、步骤、团队关系和交付核对；先前9项 XCTest、release appbundle 与本机签名为历史已通过证据。云 CI 最终安装包已在本机启动并保留产品登录会话，已撤销设备不会作为执行目标。正式分发签名/公证尚需用户 Apple 开发者配置。
- 真实云端 OIDC S256 授权、callback state、Token 交换、JWT 签名/audience、产品会话与注销撤销通过；临时 Keycloak 测试用户已删除。已修复 Keycloak 26 client 默认 scope 缺 basic 导致无 sub 的配置问题。
- 使用本机已连接的 Recall 账号验证产品绑定与直接读取既有内容通过；临时产品绑定已按 version 删除，未修改既有记忆内容。PAT 未输出、未进入公开仓库。
- 真实 CSI/Chrome 已验证 BrowserActor 快照、JPEG 帧/视口尺寸和接管 CDP 点击；测试仅操作新建公开示例页，未读取用户其他标签页。
- **真实 Codex 推理与工具路径已验证**：本机既有系统代理下 28.476 秒完成 1 次受限只读工具、`item/tool/call` 回执与固定结果，输出 9 Token。此前直连的流中断及最终成功证据都保留在 `spikes/`，不把失败探测写成成功。
- 节点自动继承本机代理（显式 env > 本机配置 > 系统），Node 24.14+ 原生 fetch 覆盖 Grok 路径；后台 PATH、已有 CSI 幂等启动、无正文 DELETE、附件传输边界均测试。当前开发机没有安装永久 Worker 自启动。
- 公网 TEST 服务完成真实 OIDC → Ed25519 配对 → NodeAgent/SQLite/FakeRuntime → 实际 Recall 只读检索 → checkpoint/费用 → 重启去重及真实报告重放。四阶段全部通过，临时绑定/设备/会话/Keycloak 用户/本机身份均已清理。
- 用户授权的当前 Mac 临时生产验收已通过：真实原生客户端认领 → 云端派发 → 前台 NodeAgent/SQLite → 本机 Codex `gpt-6.2-sol` 单回合 → 真实 ToolBroker `files_read` 一次 → 正确标记回传 → 客户端已完成与成本页。输入 15,706、缓存输入 15,488、输出 11 Token；订阅金额如实标未知。验收 driver 仅预置自建文件、限制工具/路径/次数，不以固定回答替代模型或 ToolBroker；没有访问业务网站。Run 成功后前台已停止，Mac 通过正常用户 API 撤销临时设备，未安装自启动。此为新增独立验收流程上线前的基础链路证据，不等于业务网站、Grok、浏览器或完整团队调度已通过验收。
- 正式远程 Mac 已由用户批准配对并前台在线；原生工作台已核实保存默认 Grok、默认执行电脑与主助理电脑。用户明确批准将该 Mac 的 Recall 绑定导入本人生产账号，已显示连接；临时导入文件已删除、PAT 未进入仓库/日志。这些是配置与连接证据，真实 Grok 任务及新团队验收仍待上线后验证。

主助理规划恢复新增保守边界：模型调用前先在本机journal持久记录running，usage回执实时落盘；失败保存通用回复并回执消费，不自动再次发起同一模型工作。重启发现未决running时要求用户明确重发，不因inbox重放或传输重试重复调用；空模型配置按configured-default记账。该路径的新增跨组件回归结果待协调者最终确认，不预先计入通过数。

## 云资源

| 资源 | 状态 |
| --- | --- |
| `super_agent_test` / `super_agent_prod` | 已创建，每环境独立 owner/service；service 非 superuser、非 BYPASSRLS |
| PostgreSQL TLS | 从已认证 SSH 获取证书并固定信任；连接验证通过，未关闭全局 TLS 校验 |
| test 迁移与隔离测试 | 001/002/003 已由独立 owner 应用并冻结，40项服务端测试全通过；prod 不做自动化集成测试 |
| `super-agent-test` / `super-agent-prod` S3 | 已创建/验证，Put/Get/Delete smoke test 通过 |
| Recall | 每用户独立加密绑定、既有记录读取、候选审核发布与搜索适配已实现；真实账号绑定/列表与隔离测试已通过 |
| OIDC | 云端 Keycloak、test/prod realms、native PKCE client、公网 HTTPS 与真实 Token/产品会话交换已验证 |
| GitHub | [代码 ba2dcc0 的完整检查](https://github.com/ximing/super-agent/actions/runs/44446095351)全绿；服务代码未变，[61639c3 服务镜像](https://github.com/ximing/super-agent/actions/runs/44344248181)仍为当前生产版本 |
| 安装包 | [v0.1.1-preview.2 Mac 登录与设备管理包](https://github.com/ximing/super-agent/releases/tag/v0.1.1-preview.2)已由云 CI 构建并公开发布，本机实测会话恢复；Android 沿用 [v0.1.0-preview.1 APK](https://github.com/ximing/super-agent/releases/tag/v0.1.0-preview.1) |
| 本批次团队/通知/内容冻结 | 代码、TEST schema 和回归完成；尚未部署生产，厂商推送凭据与真实设备送达未验收 |
| API | `https://super-agent.aimo.plus` 已切换 `super_agent_prod` / prod S3 / prod OIDC，容器 healthy；生产角色非 superuser/非 BYPASSRLS，任务 FORCE RLS，未授权401、开发登录404 |
| 本地 Docker | 用户确认全清后执行；当前 Colima 的容器/镜像/卷均为 0，默认 context 未发现第二个可用引擎 |

现有 PostgreSQL 没有安装 vector 系统扩展。记忆已改为复用 agent-recall，不为此修改既有数据库服务或另建向量基础设施。

## 仍需验收

- 正式执行 Mac 已完成配对和默认 Grok/电脑选择，尚需真实任务、长期后台运行与目标 Android 真机验收；当前 Mac 生产账号已完成首次改密和登录。
- 长期安装节点的真实业务任务、跨电脑切换、浏览器画面与人工接管；当前临时 Mac 的单回合受限读文件链路已通过。
- Grok 实际账号调用、业务网站样本、厂商推送和签名配置。

## 与完整产品目标的实现差距

2026-11-19 按本批次源码与云 TEST 复核。下表“已实现”指当前代码，不表示旧生产镜像已包含；真实业务验收、部署和发布配置另列。

| 能力 | 已有基础 | 尚未实现或尚未闭环 |
| --- | --- | --- |
| 多 Agent 团队 | 计划归属、父子 Task、依赖 DAG/拓扑放行、失败阻塞/取消传播、持久 Coordinator 事件与汇总/待确认再规划，云 TEST 已验证 | 生产部署及真实多 Mac 业务验收；Codex 原生 multi_agent 当前关闭，产品层 Task 图不冒充原生 Agent/Run 树 |
| 交付验收 | Run 完成→awaiting_review，独立只读 reviewer/人工逐条标准核对，固定 checkpoint 与不可旧 PUT 改写的产物，legacy 明确未验证 | 真实模型审核质量、公司网站业务状态的独立证据与人工验收；不能核实转 needs_input，不自动重做副作用 |
| 主动性 | 固定间隔提醒、待确认方案；通知自身的时区/跨午夜/DST 静默时段已实现 | 网站/系统事件观察、条件触发、复杂日历/时区调度规则、个性化建议和持续偏好学习 |
| 记忆学习与治理 | 本人 Recall 绑定、搜索/读写/版本、候选人工审核发布 | 自动复盘、结构化事实/推断与证据验证、冲突/过期处理、活跃 Run 知识失效广播、节点有界缓存与离线 stale；任务级记忆范围也未完整强制过滤 |
| 成本预算 | Token/费用记录、去重、未知费用显示、月额度准入和 Run 预留 | 逐轮 budget grant、单任务实际累计限制、未知金额的 Token 替代约束、主助理/主动任务独立预算、价格表估算和外部记忆/工具费用归集 |
| 图片与画面 | 人可以看网页截图，模型用 DOM/文本工具操作 | 截图/图片的模型视觉输入链路；完整桌面、其他 App、视频、完整远程键鼠仍为后续范围 |
| 跨机恢复 | 新 Run、检查点与同任务云附件可交接 | 完整环境预检、文件清单自动恢复、无人故障接任、可靠的原生会话恢复；重启后未知执行仍需核对 |
| 进度展示 | 状态、摘要、提问、画面/结果、安全工具步骤时间线；团队与验收 DTO 已实现 | 新客户端安装包及真实团队展示验收；原生 SubAgent 树及更细业务阶段进度 |
| 安装与管理 | CLI 安装、配对码、能力显示、手动 LaunchAgent；Mac 设备撤销已实测，Android 设备撤销已接API并通过客户端测试 | 图形化安装配置向导、后台服务管理、自动更新；两端会话管理入口及Android真机撤销验收 |
| 关闭 App 后通知 | APNs/Expo 服务端发送、持久 outbox/claim、回执/退避/失效 token、账号转移/注销隔离与过时抑制已实现并通过云 TEST/传输 mock | 生产部署、真实厂商凭据/签名、Mac/Android 关闭应用与弱网送达；无独立直连 FCM/国内厂商适配，provider 接受不等于设备显示 |

另行区分：Grok 真实账号、公司网站、真实多 Mac 接续、Android 真机及长时间弱网运行是尚未完成的验收；正式签名/公证是发布配置工作。它们不等于上述未实现功能。

登录复测：本机 `ASWebAuthenticationSession` 请求已启动但未弹窗，系统交接根因尚未确认。Mac 新增显式“改用浏览器登录”，复用 PKCE 并严格校验、一次性消费回调；用户已沿此路径完成首次改密和生产登录，现场核对已进入真实工作台。新增阶段提示、取消与超时；此前连同设备撤销的9项Swift测试通过；本批次新增团队/验收等覆盖后为17/17。身份配置接口另曾出现 5 秒后返回不完整配置的间歇降级，仍需补可靠性处理；不将备用路径成功等同于原系统窗口问题已解决。

首版定时关注支持创建/启停/删除，触发后提醒并准备待确认目标，确认后执行。应用前台用持久 REST 增量轮询；尚未实现 WSS；服务端厂商推送代码和 TEST 已完成，但生产部署及实际设备送达尚未验收，不声称应用关闭后已经可收到通知。

所有本机模型 Key、数据库连接串、设备私钥和 OIDC 管理密码均不在仓库或本文件中。真实配置由被忽略的环境文件和云服务器配置持有。

生产上线前已备份并由 owner 首迁；最初仅进行健康、配置、角色与 RLS 的只读验证，随后按用户明确授权进行了上述单个原生客户端真实任务验收，任务与用量保留在本人账号中，临时设备已撤销；没有将生产库用作自动化集成测试。开发电脑未安装长期 Worker；正式远程 Mac 已完成配对与前台连接，后台长期运行仍需验收。正式安装说明见 [开始使用](getting-started.md)。
