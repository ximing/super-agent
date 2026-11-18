# 实施状态

更新：2026-11-18，开发进行中。此文件区分代码、测试与部署，不将单元测试通过等同于生产就绪。

## 当前已验证

- 公共协议包可构建，状态迁移与金额/未知费用 4 项测试通过。
- Mac 节点及两个 Runtime、ToolBroker 均可构建；已验证文件路径与符号链接越界、浏览器独占、Codex JSON-RPC、Grok 本地工具循环、取消、SQLite 去重与重启不重放。
- 真实本机 Codex 0.170.0 只读探测通过：初始化、模型列表、只读 thread 创建/归档和 dynamicTools 定义接受；未因此启动付费模型回合。
- 控制服务与节点构建通过；服务端 15 项 + 跨组件 4 项测试共 19/19 通过，使用真实专用云 test 数据库和私有 S3，覆盖双用户隔离、签名重放拒绝、派发/计费幂等、未知费用、会话撤销、记忆绑定与文件权限。
- 跨组件测试使用真实 NodeAgent/SQLite/Fastify 与云 PG；模型使用明确 FakeRuntime，CSI 使用明确 mock。验证聊天确认前无 Task、确认后仅一个 Task 到指定第二台电脑/Grok、重启去重、澄清上下文、暂停接管与 Retina 坐标换算。
- Android typecheck、4 项 API/安全配置测试和 762 modules Hermes JS 导出通过。原生 Gradle 已启动，但依赖仓库 TLS 下载超时，尚无确认 APK；已配置 GHA 原生 APK 构建与产物上传。
- Swift 编译、4 项 XCTest、release appbundle 与本机签名通过；离线登录页截图已检查。正式分发签名/公证尚需用户 Apple 开发者配置。
- 真实云端 OIDC S256 授权、callback state、Token 交换、JWT 签名/audience、产品会话与注销撤销通过；临时 Keycloak 测试用户已删除。已修复 Keycloak 26 client 默认 scope 缺 basic 导致无 sub 的配置问题。
- 使用本机已连接的 Recall 账号验证产品绑定与直接读取既有内容通过；临时产品绑定已按 version 删除，未修改既有记忆。PAT 未输出、未进入公开仓库。

## 云资源

| 资源 | 状态 |
| --- | --- |
| `super_agent_test` / `super_agent_prod` | 已创建，每环境独立 owner/service；service 非 superuser、非 BYPASSRLS |
| PostgreSQL TLS | 从已认证 SSH 获取证书并固定信任；连接验证通过，未关闭全局 TLS 校验 |
| test 迁移与隔离测试 | 已真实执行；prod 不做破坏性测试 |
| `super-agent-test` / `super-agent-prod` S3 | 已创建/验证，Put/Get/Delete smoke test 通过 |
| Recall | 每用户独立加密绑定、既有记录读取、候选审核发布与搜索适配已实现；真实账号绑定/列表与隔离测试已通过 |
| OIDC | 云端 Keycloak、test/prod realms、native PKCE client、公网 HTTPS 与真实 Token/产品会话交换已验证 |
| GitHub | 已创建公开 [ximing/super-agent](https://github.com/ximing/super-agent)，test 数据库与 CA 已配置 Actions secrets；首次 CI 待运行 |
| API | 云端构建/运行配置已准备；待首个 CI 镜像发布后部署，尚未宣称公网可用 |
| 本地 Docker | 用户确认全清后执行；当前 Colima 的容器/镜像/卷均为 0，默认 context 未发现第二个可用引擎 |

现有 PostgreSQL 没有安装 vector 系统扩展。记忆已改为复用 agent-recall，不为此修改既有数据库服务或另建向量基础设施。

## 仍需验收

- 原生客户端登录后的界面与真实云端业务交互；Android APK。
- GitHub Actions 在真实仓库运行、云端镜像、API/OIDC HTTPS 入口与 PKCE 登录。
- 真实节点连接云端 API 后的完整任务、跨电脑切换、浏览器画面与人工接管。
- Grok 实际账号调用、业务网站样本、厂商推送和签名配置。

首版定时关注支持创建/启停/删除，触发后提醒并准备待确认目标，确认后执行。应用前台用持久 REST 增量轮询；尚未实现 WSS 和服务端厂商推送，不声称应用关闭后已能收到远程通知。

所有本机模型 Key、数据库连接串、设备私钥和 OIDC 管理密码均不在仓库或本文件中。真实配置由被忽略的环境文件和云服务器配置持有。
