# Super Agent

多用户私人助理工作台。Swift Mac 与 React Native Android 控制端通过云端服务派活，用户自己的 Mac 执行 Codex/Grok、操作浏览器并按需使用云端记忆。

## 运行边界

- 云端：PostgreSQL、私有 S3、OIDC、任务/设备/费用服务、GitHub Actions 构建。
- 用户 Mac：模型账号、执行节点、浏览器、SQLite 执行日志。模型请求从 Mac 直连供应商。
- 每用户可有多台电脑；执行引擎与具体电脑分别选择，用户间数据隔离。
- 记忆复用已部署的 agent-recall，每个用户分别绑定自己的账号。
- 不在开发电脑启动 Docker、数据库或构建服务端镜像。

## 仓库

| 路径 | 内容 |
| --- | --- |
| `apps/control-server` | Fastify 控制服务、PostgreSQL 迁移、云端集成测试 |
| `apps/node` | Mac 执行节点与命令行 |
| `apps/macos` | SwiftUI 原生应用 |
| `apps/android` | React Native / Expo 原生 Android 应用 |
| `packages/protocol` | 公共类型、状态和费用不变量 |
| `packages/runtime-codex` / `runtime-grok` | 本机执行引擎适配 |
| `packages/tool-broker` | 浏览器、记忆、文件、MCP 与工具调度 |
| `infra/cloud` | 只在云服务器运行的部署配置 |
| `.github/workflows` | 云端检查及手动构建/发布服务镜像 |

## 开发与验证

Node.js 24+、pnpm 10；Mac 原生构建需要 Xcode；Android 原生构建需要 JDK 17 与 Android SDK。

```sh
pnpm install --frozen-lockfile
pnpm --filter @super-agent/node... build
pnpm --filter @super-agent/control-server build
pnpm --filter @super-agent/protocol test
pnpm --filter @super-agent/node test
pnpm --filter @super-agent/control-server test
pnpm --filter @super-agent/android typecheck
swift test --package-path apps/macos
```

服务端集成测试只连接显式提供的云端 `TEST_DATABASE_URL`，迁移使用 `TEST_MIGRATION_DATABASE_URL`；没有测试库时明确 skip，不启动本地数据库。开发身份入口需明确启用且禁止用于生产。配置模板见 `.env.example`，真实 `.env.*` 文件已被 Git 忽略。

## 部署

API：`https://super-agent.aimo.plus`；OIDC：`https://super-agent-auth.aimo.plus`；记忆：`https://recall.aimo.plus`。

数据库为独立 `super_agent_test` / `super_agent_prod`，S3 为私有 `super-agent-test` / `super-agent-prod`。应用使用非超级用户、非 BYPASSRLS 账号，迁移身份单独提供。

服务镜像在 GitHub Actions 云端 runner 构建；`cloud-image.yml` 默认只构建，手动勾选 publish 后才推送 GHCR。数据库、S3、OIDC 的服务凭据只配置到云端，执行 Mac 的模型账号不上传。

首次部署和当前验证状态见 [实施状态](docs/implementation-status.md)、[云资源清单](docs/cloud-resources.md)；组件运行方法见各目录 README。完整设计入口：[docs](docs/README.md)。
