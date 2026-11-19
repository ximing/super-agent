# Super Agent

多用户私人助理工作台。Swift Mac 与 React Native Android 控制端通过云端服务派活，用户自己的 Mac 执行 Codex/Grok、操作浏览器并按需使用云端记忆。

已发布 [v0.2.1-preview.1](https://github.com/ximing/super-agent/releases/tag/v0.2.1-preview.1)，包含Mac、Android、便携Worker与校验和。API 已部署到 `https://super-agent.aimo.plus`。Mac 0.2.0云包升级旧钥匙串时发现无窗口问题，release notes已提示；0.2.1/build5补丁已公开发布，精确云包已安装并实际看到窗口、等待上限提示及工作台，替代有风险的0.2.0 Mac包，Android/服务端/Worker不受影响。

当前新增团队依赖调度、独立交付验收、不可变产物快照、工具步骤和通知队列已实现，服务端云 TEST **41/41**（含首帧续期修复）、跨组件云CI完整 **7/7、0skip** 通过。本批次服务端已部署生产镜像32eb39d8（2026-11-19），预览安装包已发布；真实Grok只读样例在独立审核needs_input后已由控制端代理核对接受，通知真机送达仍待完成；正式Worker用户级后台服务已安装并验证重启无模型重放；详细范围见[实施状态](docs/implementation-status.md)。

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

Node.js 24.14+、pnpm 10；Mac 原生构建需要 Xcode；Android 原生构建需要 JDK 17 与 Android SDK。

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

服务端集成测试只连接显式提供的云端 `TEST_DATABASE_URL`，迁移使用 `TEST_MIGRATION_DATABASE_URL`；没有测试库时明确 skip，不启动本地数据库。已配置忽略文件时，可用 `node --env-file=.env.test node_modules/tsx/dist/cli.mjs --test apps/control-server/test/*.test.ts` 显式运行完整云 TEST 套件，勿输出配置内容。迁移由 owner 私有 checksum ledger 管理，已应用 SQL 不可修改；新增结构使用新迁移，应用角色不做 DDL。开发身份入口需明确启用且禁止用于生产。配置模板见 `.env.example`，真实 `.env.*` 文件已被 Git 忽略。

## 部署

API：`https://super-agent.aimo.plus`；OIDC：`https://super-agent-auth.aimo.plus`；记忆：`https://recall.aimo.plus`。

数据库为独立 `super_agent_test` / `super_agent_prod`，S3 为私有 `super-agent-test` / `super-agent-prod`。应用使用非超级用户、非 BYPASSRLS 账号，迁移身份单独提供。

服务镜像在 GitHub Actions 云端 runner 构建；`cloud-image.yml` 默认只构建，手动勾选 publish 后才推送 GHCR。数据库、S3、OIDC 的服务凭据只配置到云端，执行 Mac 的模型账号不上传。

首次部署和当前验证状态见 [实施状态](docs/implementation-status.md)、[云资源清单](docs/cloud-resources.md)；组件运行方法见各目录 README。完整设计入口：[docs](docs/README.md)。

正式执行 Mac 的安装、配对和后台启动见[开始使用](docs/getting-started.md)。
