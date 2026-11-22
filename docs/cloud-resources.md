# 云端资源清单与部署约束

更新：2026-11-18。用户要求所有服务端基础设施由其部署在云端，不在开发 Mac 运行 Docker、数据库或中间件。Mac 仅运行原生客户端、执行节点、本机模型连接与浏览器；节点 SQLite 是重传/幂等的本地运行日志，不是共享业务数据库。

## 可以先部署的资源

| 资源 | 建议配置 | 需要交付的配置 |
| --- | --- | --- |
| PostgreSQL | 18，TLS，独立生产库 `super_agent_prod` 和专用测试库 `super_agent_test`；版本化 SQL migration | 主机/端口/库名、CA；迁移角色和非 owner/非 BYPASSRLS 的应用角色分别配置 |
| 私有对象存储 | S3 兼容私有 bucket，禁用公开读；支持短期签名读写与生命周期清理 | endpoint、region、bucket、最小权限服务身份或服务器工作负载身份 |
| API 云服务器 | Linux amd64/arm64，起步 4 vCPU/8 GB，HTTPS/WSS，能连接数据库/对象存储/OIDC | API 域名、TLS/反向代理、云端镜像仓库地址与部署方式 |
| OIDC 身份服务 | 可用现有云端 IdP；否则云端部署 Keycloak 等兼容服务；支持原生 public client 的 Authorization Code + PKCE S256 | issuer、API audience、原生客户端 client ID、授权/Token端点、回调白名单 |
| 云端 CI/镜像仓库 | 由 CI 构建 `infra/Dockerfile.server` 并推送到私有云端仓库 | 仓库/registry与CI权限；开发 Mac 不构建/拉取服务镜像 |

原生回调为 `superagent://oauth/callback`，客户端 ID 为 `super-agent-native`，audience 为 `super-agent-api`。Keycloak public client 强制 PKCE S256；不创建需要打包进 App 的 client secret。

Keycloak 26 的 native client 默认 scope 必须包含 `basic`，以生成 access token 的 `sub`；realm 模板已包含，云端两环境已同步。[Keycloak 升级说明](https://www.keycloak.org/docs/26.7.3/upgrading/)记录此行为。真实 PKCE/签名/audience/产品会话交换已用临时测试账号验证，账号随后删除；可重复执行的脚本见 `spikes/oidc-cloud-smoke.ts`。

先准备 PostgreSQL（含隔离测试库）、API 域名和 OIDC 即可推进核心联调；对象存储随后用于文件与截图。embedding 和厂商推送是单独的可配置能力，未配置时明确不可用，不能借用/上传用户本机 Grok Key。

## 密钥与权限

- 数据库、对象存储和 OIDC 服务凭据仅写入云服务器秘密配置。可以给本项目一个被授权、可撤销的专用测试库连接用于联调，不能把生产库当测试库。
- 不要求用户在聊天里粘贴模型 Key。Codex 登录与 Grok Key 始终位于各执行 Mac。
- 云端应用连接不使用 PostgreSQL superuser、表 owner 或 BYPASSRLS；迁移完成后检查 FORCE RLS 和组合外键。
- 生产禁用 `/auth/dev`。开发身份仅用于独立受控测试，不对公网开放。
- 域名、库名等非敏感配置可以发给开发者；秘密通过环境文件或云端密钥管理分发，日志中不输出完整连接串。

## 部署文件

`infra/cloud/compose.yaml` 只用于云服务器，引用云端 CI 已生成镜像，不含本地 build，也不包含本地数据库。也可使用云厂商容器服务/Kubernetes 接同一环境配置。`.env.example` 是变量名模板，不是可直接上线的秘密文件。

配置包含私有 S3、OIDC、记忆绑定加密密钥、只读 CA 挂载与 `/ready` 健康检查。`migrate` profile 使用独立 owner 连接，API 容器只获得 service 连接，不自动以 owner 迁移。

数据库 URL 的 CA 路径在开发 Mac 与云服务器上不同。云端证书放 `certs/postgres-ca.pem`，容器内使用 `/app/certs/postgres-ca.pem`；URL 保留 TLS 验证，不能直接复制开发电脑上的绝对路径。

测试部署的环境名为 `super-agent-test`、建议端口 `13011`、issuer 后缀 `/realms/aimo-plus-test`。生产使用独立目录、Compose project、数据库、bucket、JWT/记忆加密密钥与 `/realms/aimo-plus-prod`。不要让两环境共享可写业务资源。域名 `super-agent.aimo.plus` 最终指向完成验收的环境，API 上线前不代表它已可用。

在**云服务器**内，配置秘密环境文件与证书后执行：

```sh
# 先备份该环境数据库，再使用已由云端 CI 发布的不可变镜像标签。
docker compose --env-file .env --profile migrate run --rm migrate
docker compose --env-file .env up -d api
curl --fail http://127.0.0.1:13011/ready
```

API 与 OIDC 的云容器端口均只绑定 app 的 `127.0.0.1`。独立 nginx 通过受限 SSH 隧道访问源站，不在公网链路明文发送登录、任务或画面数据；OpenResty 网络的宿主网关为已验证的 `192.168.0.1`。配置见 `origin-tunnel.service`、`origin-sshd.conf`、`api.nginx.conf`。隧道目标是 SSH 别名 `super-agent-origin`，地址写在入口机的 ssh 配置里，不进仓库；示例是 `origin-ssh-config.example`。SSH 私钥只留 nginx，目标 host key 固定校验，账户不能执行命令，转发端口有白名单。nginx 修改后先测试配置再 reload，最后验证 HTTPS `/ready`、`/v1/auth/config` 和未授权 API 拒绝访问。

GitHub Actions 使用 secrets `TEST_DATABASE_URL`、`TEST_MIGRATION_DATABASE_URL` 和 `POSTGRES_CA_PEM`。CI 将 CA 写入 runner 临时目录并修正 URL 路径，在后续步骤使用前注册秘密遮罩，不向可见日志输出连接串。未配置时云端集成测试明确 skip，不能因此宣称已完成云端验收。`cloud-ci.yml` 包含 TypeScript、云库集成、Swift、Android APK 与原生 App 产物；`cloud-image.yml` 在云端构建并可手动发布 GHCR 镜像。公开仓库为 `ximing/super-agent`。

已验证 GitHub 托管 US runner 到家中 PostgreSQL 建连出现 `ECONNRESET`。因此单测与原生构建继续在托管 runner，真实云库集成使用 app 业务机的独立 `super-agent-ci` 用户，标签 `super-agent-cloud`。无 sudo/Docker 权限，systemd 限制可写路径、2GB 内存和2核CPU；服务单元见 `infra/cloud/ci-runner.service`。公开 PR 不调度此 runner、不获得云库 secrets，只有本仓库 main push/手动 workflow 可以运行云库 job。该 runner 不在开发 Mac、不启动本地数据库或本机 Docker。

app 到 GitHub Broker/AAD 的长 TLS 连接也实测出现 EOF/超时，而 nginx 线路稳定。云 runner 经现有 SSH 隧道的 loopback 反向端口使用 `ci-egress-proxy`：独立非 root、仅 CONNECT:443 域名白名单、拒绝私网/IP字面量、不解密 TLS、不记录请求数据，无公开代理端口。Node/npm Actions toolcache 从云端已拉取的官方 glibc Node 24 镜像预置，避免首次跨境大文件慢下载；没有在 Mac 拉取或保存服务器镜像。首个完整 Actions 检查已通过。

迁移使用 `super_agent_private.schema_migrations` owner-only 账本，记录 SQL 文件名、SHA-256 和应用时间；再次迁移不重做 DDL，修改已应用 SQL 会明确失败，后续变更新增 SQL 文件。迁移独占 advisory 锁，租户与配对事务取共享锁，避免在线业务与 DDL 反向锁序。首次给旧服务补账本需要停止旧 API、备份、迁移、重启；本轮 test 首迁已按此执行并通过真实互斥/权限测试。生产不参与集成测试。

记忆复用现有 `https://recall.aimo.plus`，没有新增 embedding、Redis、ES 或 pgvector 依赖。用户在原生设置中绑定自己的 Recall PAT；服务端加密保存，执行节点通过当前任务授权按需检索。`MEMORY_ENCRYPTION_KEY` 必须稳定、独立保管；轮换需要显式迁移或重新绑定。

## 本地 Docker 清理

用户明确确认删除这台开发电脑的全部容器、镜像与数据卷后，已完成清理并核验 Colima 库存：容器 0、镜像 0、卷 0。本项目不再在开发电脑启动 Docker、数据库或服务端镜像构建；云服务器上的部署独立管理。
