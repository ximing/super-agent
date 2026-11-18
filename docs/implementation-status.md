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

- 用户首次生产登录（临时密码要求修改）、正式 Mac 安装配对、目标 Android 真机操作。
- 真实节点连接云端 API 后的完整任务、跨电脑切换、浏览器画面与人工接管。
- Grok 实际账号调用、业务网站样本、厂商推送和签名配置。

首版定时关注支持创建/启停/删除，触发后提醒并准备待确认目标，确认后执行。应用前台用持久 REST 增量轮询；尚未实现 WSS 和服务端厂商推送，不声称应用关闭后已能收到远程通知。

所有本机模型 Key、数据库连接串、设备私钥和 OIDC 管理密码均不在仓库或本文件中。真实配置由被忽略的环境文件和云服务器配置持有。

生产上线前已备份并由 owner 首迁；生产环境只进行健康、配置、角色与 RLS 的只读验证，没有将生产库用作集成测试。开发电脑未安装长期 Worker；用户将在当前验证后安装到独立 Mac。正式安装说明见 [开始使用](getting-started.md)。
