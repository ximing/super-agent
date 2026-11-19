# 实施状态

更新：2026-11-19。此文件区分代码、测试与部署，不将单元测试通过等同于生产就绪。**此前团队 DAG、独立交付验收、证据快照、工具时间线及通知 outbox 已实现并通过云 TEST，并部署生产镜像 32eb39d8。本轮记忆治理、业务观察证据和运行中预算限制已完成代码与本地单元测试，未部署，也未做云 TEST 或真实验收。**

## 当前已验证

- 公共协议包可构建，状态迁移与金额/未知费用 4 项测试通过。
- Mac 节点及两个 Runtime、ToolBroker 均可构建；已验证文件路径与符号链接越界、浏览器独占、Codex JSON-RPC、Grok 本地工具循环、取消、SQLite 去重与重启不重放。
- 真实本机 Codex 0.170.0 只读探测通过：初始化、模型列表、只读 thread 创建/归档和 dynamicTools 定义接受；未因此启动付费模型回合。
- 控制服务 typecheck/build 通过；首帧续期修复后服务端 **41/41、0 fail、0 skip**（28.18秒），显式加载专用云 TEST 配置，使用非 owner 应用角色/独立 owner 迁移及私有测试 S3。覆盖隔离、签名重放、目标确认、费用去重、撤销、Recall 隔离、接管、迁移 ledger/锁、DAG/独立验收/取消传播、不同 envelope 的取消复活与证据替换拒绝、真实对象冻结、通知 outbox/过时抑制/HTTP/API/慢 provider 不阻塞派发。数据库连接故障返回可重试503。
- 跨组件云CI已完整 **7/7通过、0skip**（此前协调者完整6/6加新增usage传输503定向1/1也均通过），使用真实 NodeAgent/SQLite/Fastify 与云 PG；模型使用明确 FakeRuntime，CSI 使用明确 mock。覆盖聊天确认/重启去重/澄清、暂停接管与自然像素换算，以及团队执行、独立 reviewer 和事件恢复路径；不将 FakeRuntime 写成真实 Grok 或业务验收。
- Android 最新 typecheck 与 **12/12 客户端测试**通过，覆盖设备撤销、步骤隐私、任务关系及交付证据；先前基础运行的5项 API/安全配置测试和763 modules Hermes JS 导出为历史证据。独立 release APK 已由最新 GHA 构建通过，CI 和下载后均核验内嵌 Hermes 字节码、不依赖 Metro，APK 签名校验通过；包约 56 MiB，Android 7+。内部测试签名与正式发布签名分开。
- Mac启动恢复补丁的Swift编译与 **22/22测试**、release构建及本机codesign验证通过（此前团队版本17/17），覆盖登录回调、设备撤销、步骤、团队关系和交付核对；先前9项 XCTest、release appbundle 与本机签名为历史已通过证据。旧历史云包曾在本机启动并恢复会话，已撤销设备不会作为执行目标；0.2.0云包实际启动发现钥匙串主线程阻塞；现精确76a9e2e的0.2.1/build5云包已安装并实际看到窗口、等待上限提示及本人工作台，不能沿用历史启动证据或声称自动钥匙串一定恢复。正式分发签名/公证尚需用户 Apple 开发者配置。
- 真实云端 OIDC S256 授权、callback state、Token 交换、JWT 签名/audience、产品会话与注销撤销通过；临时 Keycloak 测试用户已删除。已修复 Keycloak 26 client 默认 scope 缺 basic 导致无 sub 的配置问题。
- 使用本机已连接的 Recall 账号验证产品绑定与直接读取既有内容通过；临时产品绑定已按 version 删除，未修改既有记忆内容。PAT 未输出、未进入公开仓库。
- 真实 CSI/Chrome 已验证 BrowserActor 快照、JPEG 帧/视口尺寸和接管 CDP 点击；测试仅操作新建公开示例页，未读取用户其他标签页。
- **真实 Codex 推理与工具路径已验证**：本机既有系统代理下 28.476 秒完成 1 次受限只读工具、`item/tool/call` 回执与固定结果，输出 9 Token。此前直连的流中断及最终成功证据都保留在 `spikes/`，不把失败探测写成成功。
- 节点自动继承本机代理（显式 env > 本机配置 > 系统），Node 24.14+ 原生 fetch 覆盖 Grok 路径；后台 PATH、已有 CSI 幂等启动、无正文 DELETE、附件传输边界均测试。当前开发机没有安装永久 Worker 自启动。
- 公网 TEST 服务完成真实 OIDC → Ed25519 配对 → NodeAgent/SQLite/FakeRuntime → 实际 Recall 只读检索 → checkpoint/费用 → 重启去重及真实报告重放。四阶段全部通过，临时绑定/设备/会话/Keycloak 用户/本机身份均已清理。
- 用户授权的当前 Mac 临时生产验收已通过：真实原生客户端认领 → 云端派发 → 前台 NodeAgent/SQLite → 本机 Codex `gpt-6.2-sol` 单回合 → 真实 ToolBroker `files_read` 一次 → 正确标记回传 → 客户端已完成与成本页。输入 15,706、缓存输入 15,488、输出 11 Token；订阅金额如实标未知。验收 driver 仅预置自建文件、限制工具/路径/次数，不以固定回答替代模型或 ToolBroker；没有访问业务网站。Run 成功后前台已停止，Mac 通过正常用户 API 撤销临时设备，未安装自启动。此为新增独立验收流程上线前的基础链路证据，不等于业务网站、Grok、浏览器或完整团队调度已通过验收。
- 正式远程 Mac 已由用户批准配对并前台在线；原生工作台已核实保存默认 Grok、默认执行电脑与主助理电脑。用户明确批准将该 Mac 的 Recall 绑定导入本人生产账号，已显示连接；临时导入文件已删除、PAT 未进入仓库/日志。这些是配置与连接证据；后续真实任务的执行、独立审核与人工验收状态见下节。

主助理规划恢复新增保守边界：模型调用前先在本机journal持久记录running，usage回执实时落盘；失败保存通用回复并回执消费，不自动再次发起同一模型工作。重启发现未决running时要求用户明确重发，不因inbox重放或传输重试重复调用；空模型配置按configured-default记账。该路径已包含在协调者完整6项回归中；随后新增提案成功但usage传输503时先持久化再补传的定向回归1/1通过，最新云CI再完整运行7/7通过。

## 云资源

| 资源 | 状态 |
| --- | --- |
| `super_agent_test` / `super_agent_prod` | 已创建，每环境独立 owner/service；service 非 superuser、非 BYPASSRLS |
| PostgreSQL TLS | 从已认证 SSH 获取证书并固定信任；连接验证通过，未关闭全局 TLS 校验 |
| 迁移与隔离 | TEST 001/002/003 已冻结、首帧修复后41项服务端测试通过；生产先备份并核对可恢复目录，再由独立 owner 应用002/003成功，未在prod运行集成测试 |
| `super-agent-test` / `super-agent-prod` S3 | 已创建/验证，Put/Get/Delete smoke test 通过 |
| Recall | 每用户独立加密绑定、既有记录读取、候选审核发布与搜索适配已实现；真实账号绑定/列表与隔离测试已通过 |
| OIDC | 云端 Keycloak、test/prod realms、native PKCE client、公网 HTTPS 与真实 Token/产品会话交换已验证 |
| GitHub | Mac恢复补丁提交76a9e2ea62294eba554a3c9864f319337155a155；[Cloud checks](https://github.com/ximing/super-agent/actions/runs/44464095640)四job全部成功，Swift22/22。CI服务端41项为40pass/1skip（未配置专用测试S3，真实对象case显式跳过），跨组件完整7/7、0skip；本机显式云TEST+私有S3为41/41，二者不混同 |
| 生产镜像 | [云端镜像构建/发布](https://github.com/ximing/super-agent/actions/runs/44460986472)成功，32eb39d8镜像已在云端加载并部署healthy，无本地镜像构建/拉取 |
| 安装包 | [v0.2.1-preview.1](https://github.com/ximing/super-agent/releases/tag/v0.2.1-preview.1)已公开发布，tag target为76a9e2e，含Mac、Android、便携Worker与校验和四份资产。Mac arm64为0.2.1 build5；Android同CI构建仍为0.2.0 code2，已验v2内部debug签名、CRC与内嵌Hermes；Worker r3实现未变。精确云Mac已安装、实际运行并进入本人工作台，替代有旧钥匙串升级风险的v0.2.0 Mac包；仍不是正式Developer ID/公证或商店发布签名 |
| 本批次团队/通知/内容冻结 | 代码/TEST回归与生产部署完成；应用角色仍非superuser/非BYPASSRLS，Task/review/push FORCE RLS已核对。厂商推送凭据与实际设备送达未验收 |
| API | `https://super-agent.aimo.plus` 已切换 `super_agent_prod` / prod S3 / prod OIDC，32eb39d8容器healthy；/ready为200，任务与通知设置无凭证为401、开发登录404；生产角色非superuser/非BYPASSRLS，Task/review/push FORCE RLS |
| 本地 Docker | 用户确认全清后执行；当前 Colima 的容器/镜像/卷均为 0，默认 context 未发现第二个可用引擎 |

现有 PostgreSQL 没有安装 vector 系统扩展。记忆已改为复用 agent-recall，不为此修改既有数据库服务或另建向量基础设施。

## 首帧等待回归（生产0211b3a9之后）

真实工作台验收发现：查看先于浏览器启动时，首次GET画面404导致同事务中的查看续期回滚，原30秒后订阅关闭。代码现将续期提交与缺帧404分开，并把S3下载移出事务；云TEST用可控时钟验证+20秒404续期、+35秒首帧仍接受，同时拒绝外租户续期及关闭会话重启。定向及完整回归均通过，完整服务端41/41、0skip，typecheck/build通过。该修复已随32eb39d8部署生产；先前0211b3a9不含该修复。

## 真实 Grok 只读样例与最终代理复核

正式远程Mac上的真实Grok样例已Run succeeded，回传12条工具步骤，其中2条失败为截图调用及越界文件读取被拒；失败如实保留。已生成2个ready、server_snapshot冻结Markdown产物，example-com-check为1048字节及另一份result产物；协调者实际下载文件并看见实时浏览器画面，逐项比对中文首段一致。

fresh reviewer先给出needs_input：缺少原始网页/记忆内容的独立证据，未将Worker报告直接当作验收通过。随后协调者作为控制端代理，在可用原生onboarding包中逐条核对标准，绑定选定冻结产物和checkpoint，并明确记录实时画面中文首段一致、日期精度、定向Recall查询limit20及占位引用的核对范围，保留2条失败步骤后提交accept。生产只读确认Task succeeded、delivery accepted，review历史为[needs_input,accept]，仍有12条步骤与2个产物。这是有依据的控制端代理复核，不宣称用户本人亲自验收，也不宣称无人自动验证全部业务。正式Worker成本面板现显示4个请求（含新增plan.settled汇总），金额未知，不能计为0。正式Worker已安装用户级gui/501/com.superagent.node LaunchAgent并running；优雅重启后进程正常接任，launchctl运行计数为2；SQLite journal的1个Run、12条步骤、Worker usage revision1和assistant replied2均未变化，无Task/模型重放。节点使用远端r3代码，shell禁用、Grok主助理及browser可用；当前接电配置sleep0，仅只读核对，未运行caffeinate或修改pmset。云端心跳只读核对2026-11-19T05:12:25.292Z、当时约6.8秒，设备在线；此为当次观测，不承诺永不休眠或持续在线。

## 仍需验收

v0.2.1-preview.1已公开发布，但发布/验签不等同安装后的全部真机业务验收。上述真实Grok样例已执行完成，并在自动审核needs_input后由控制端代理核对接受；公司业务、无人自动验收和长时运行仍另行验收。Mac0.2.0云包升级风险见下节，精确0.2.1云包构建、安装及实际工作台验收通过，补丁已公开发布。

- 正式执行 Mac 已完成配对和默认 Grok/电脑选择，已完成真实Grok只读样例及控制端代理复核接受，用户级后台服务已安装并验证优雅重启无重放，尚需长时间弱网/休眠恢复及目标Android真机验收；当前 Mac 生产账号已完成首次改密和登录。
- 长期安装节点的真实业务任务、跨电脑切换、浏览器画面与人工接管；当前临时 Mac 的单回合受限读文件链路已通过。
- 公司业务网站样本、厂商推送、Mac升级后不同钥匙串/账号环境的恢复回归和正式分发签名配置。

## Mac 0.2.0升级阻塞与0.2.1恢复补丁

精确32eb39d8的Mac0.2.0/build4云包验签与版本检查通过，但启动时旧钥匙串ACL触发主线程SecItemCopyMatching阻塞，表现为无窗口。已恢复本机旧本地构建维持工作台可用；不能把旧包曾启动写成新云包已真实启动。0.2.1/build5源码补丁已冻结，采用异步、非交互会话恢复和显式恢复入口；22/22Swift测试、release构建和本机签名核验通过。真实CUA中较早0.2.1 staging窗口立即出现，跳过自动恢复后通过浏览器SSO进入本人工作台。最终带等待上限的0.2.1/build5 staging也已实际出现窗口，并约4秒后固定显示“安全存储响应较慢已停止自动等待”，不再无限停在checking。操作系统Keychain调用本身仍可能阻塞，因此不保证自动会话恢复；用户可明确跳过或使用登录入口。此后精确76a9e2ea的云Mac0.2.1/build5包已安装到用户应用目录，真实CUA看到窗口、约4秒的固定超时提示及随后本人工作台，正式Grok Worker在线；未确定之后进入工作台的具体恢复/SSO路径，不能据此宣称自动Keychain读取成功或总能恢复。0.2.1-preview.1已公开发布；协调者确认当前运行进程来自用户应用目录中的精确云包，并已实际看到本人工作台及1个正式Worker在线。v0.2.0 release notes已提醒Mac升级风险，Android、服务器和Worker不受此问题影响。

## 与完整产品目标的实现差距

2026-11-19 按本批次源码与云 TEST 复核。下表“已实现”指当前代码，本批次服务端已随32eb39d8上线；客户端真机业务验收和厂商配置另列。

| 能力 | 已有基础 | 尚未实现或尚未闭环 |
| --- | --- | --- |
| 多 Agent 团队 | 计划归属、父子 Task、依赖 DAG/拓扑放行、失败阻塞/取消传播、持久 Coordinator 事件与汇总/待确认再规划，云 TEST 已验证 | 真实多 Mac 业务验收；Codex 原生 multi_agent 当前关闭，产品层 Task 图不冒充原生 Agent/Run 树 |
| 交付验收 | Run 完成→awaiting_review，独立只读 reviewer/人工逐条标准核对，固定 checkpoint 与不可旧 PUT 改写的产物；ToolBroker 另保存网页正文、截图清单和记忆检索引用 | 真实模型审核质量、公司网站业务状态的人工验收；截图像素判断和无法独立核实的结论仍是 needs_input |
| 主动性 | 固定间隔提醒、待确认方案；通知自身的时区/跨午夜/DST 静默时段已实现 | 网站/系统事件观察、条件触发、复杂日历/时区调度规则、个性化建议和持续偏好学习 |
| 记忆学习与治理 | 本人 Recall 绑定；服务端按任务的项目、站点、状态和版本过滤 search 与按 ID read；空站点不是通配；全局偏好要同时有显式 global 范围和 `memory_global_read`；复盘只写本地 candidate；冲突/替代/过期只写产品侧关系；节点缓存有界，离线或失效时标 stale 并去掉正文 | 不改写、删除或批量发布公司 Recall；跨电脑的实时失效广播还没有，其他电脑在缓存 TTL 内可能看到本机旧结果；真实隔离项目的 Recall 写入本轮没有配置，因此跳过 |
| 成本预算 | 原有用量账本和 Run 预留；预留按 operation key 幂等；未知金额不计入 0 美元，配置了月额度时未知金额会拒绝新的美元准入；Worker、主助理、reviewer、主动任务有 Token/次数/时间/工具步限制，超限停止下一次可控调用 | 不是供应商美元硬上限。Codex 内部回合和 Grok CLI 的隐藏推理轮不能在每一步之前拦截；已经发出的请求仍可能产生用量。没有价格表估算，也没有把外部工具费用单独拆账 |
| 图片与画面 | 人可以看网页截图，模型用 DOM/文本工具操作 | 截图/图片的模型视觉输入链路；完整桌面、其他 App、视频、完整远程键鼠仍为后续范围 |
| 跨机恢复 | 新 Run、检查点与同任务云附件可交接 | 完整环境预检、文件清单自动恢复、无人故障接任、可靠的原生会话恢复；重启后未知执行仍需核对 |
| 进度展示 | 状态、摘要、提问、画面/结果、安全工具步骤时间线；团队与验收 DTO 已实现 | 新客户端真机团队展示验收；原生 SubAgent 树及更细业务阶段进度 |
| 安装与管理 | CLI 安装、配对码、能力显示、手动 LaunchAgent；Mac 设备撤销已实测，Android 设备撤销已接API并通过客户端测试 | 图形化安装配置向导、后台服务管理、自动更新；两端会话管理入口及Android真机撤销验收 |
| 关闭 App 后通知 | APNs/Expo 服务端发送、持久 outbox/claim、回执/退避/失效 token、账号转移/注销隔离与过时抑制已实现并通过云 TEST/传输 mock | 真实厂商凭据/签名、Mac/Android 关闭应用与弱网送达；无独立直连 FCM/国内厂商适配，provider 接受不等于设备显示 |

另行区分：Grok只读样例已真实调用并由控制端代理复核接受；公司网站、真实多Mac接续、Android真机及长时间弱网运行仍待验收；正式签名/公证是发布配置工作。它们不等于上述未实现功能。

登录复测：本机 `ASWebAuthenticationSession` 请求已启动但未弹窗，系统交接根因尚未确认。Mac 新增显式“改用浏览器登录”，复用 PKCE 并严格校验、一次性消费回调；用户已沿此路径完成首次改密和生产登录，现场核对已进入真实工作台。新增阶段提示、取消与超时；此前设备撤销9项、团队/验收17项Swift测试通过；最新启动恢复补丁为22/22。身份配置接口另曾出现 5 秒后返回不完整配置的间歇降级，仍需补可靠性处理；不将备用路径成功等同于原系统窗口问题已解决。

首版定时关注支持创建/启停/删除，触发后提醒并准备待确认目标，确认后执行。应用前台用持久 REST 增量轮询；尚未实现 WSS；服务端厂商推送代码、TEST和生产部署已完成，但真实厂商配置及实际设备送达尚未验收，不声称应用关闭后已经可收到通知。

## 本轮 P0：记忆、观察证据、运行预算

状态：代码完成，相关包 typecheck 通过，本地单元测试通过。云 PostgreSQL / 私有 S3 集成本轮环境没有 `TEST_DATABASE_URL`，11 项云测试跳过。没有部署，没有改生产库，没有对公司 Recall 做写入。Mac 界面重构仍是工作区里别人的未提交改动，本轮没有改客户端界面。

- 记忆：`POST /node/memory/search` 和 `POST /node/memory/read` 都带运行或主助理身份。Worker 使用任务 `scope.memory`；没有站点范围时不返回空站点记忆。Planner 没有任务时只在设置 `memory_global_read=true` 时读取 `scope_kind=global` 的偏好。猜到其他范围的 ID 返回 404。任务成功后写一条本地复盘，`status=candidate`，`claim=inference`，相同 `retrospective:<run id>` 不重复写，也不调用 Recall 发布。`POST /memories/:id/relations` 只给登录用户记录冲突、替代或过期，不 PATCH 公司正文。
- 证据：`browser_snapshot`、导航后的页面读取、`browser_screenshot` 和记忆 search/read 在 ToolBroker 里生成证据并走现有 staging/finalize。截图不调用画面订阅接口，没有人看画面也可以保存。网页正文记录捕获时间、去掉账号和查询串的 URL、截断和脱敏。记忆证据只保留查询、范围、版本和来源引用。自动验收在运行里有成功的浏览器或记忆步骤时，必须引用 `provenance=tool_broker` 且 `integrity=server_snapshot` 的观察产物；工具成功、检查点或 Worker 报告不够。无法满足时接口返回 422，reviewer 继续 `needs_input`。
- 预算：不新开账本。预留仍在 `budget_reservations`，用量仍按 request key 和 revision 去重。迟到用量在预留已释放或过期后保留账目并标 `late_usage`。默认限制来自协议里的 worker/assistant/review/proactive。续租发现超限时暂停运行。节点在下一次模型调用和工具步骤前停止。Grok 直连循环可以在每次请求前检查；Codex 只在 `turn/start` 前检查，并在用量通知后 `turn/interrupt`；Grok CLI 只在提交 prompt 前检查。这三处都不能把已发出的内部回合收回。

没有新增数据库迁移。001/002/003 未改。新字段放在既有 JSON 文档里。

所有本机模型 Key、数据库连接串、设备私钥和 OIDC 管理密码均不在仓库或本文件中。真实配置由被忽略的环境文件和云服务器配置持有。

生产上线前已备份并由 owner 首迁；最初仅进行健康、配置、角色与 RLS 的只读验证，随后按用户明确授权进行了上述单个原生客户端真实任务验收，任务与用量保留在本人账号中，临时设备已撤销；没有将生产库用作自动化集成测试。开发电脑未安装长期 Worker；正式远程Mac已完成配对、真实样例代理复核与用户级后台安装/重启无重放验证，长期弱网/休眠恢复仍需验收。正式安装说明见 [开始使用](getting-started.md)。
