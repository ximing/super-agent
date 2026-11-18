# Mac 执行节点

节点与云端控制服务分开运行。它不启动 Docker、数据库或服务端；连接用户提供的云端 API。SQLite 仅保存执行设备必要的 inbox/outbox、去重、运行绑定和检查点，属于本地执行状态。

## 构建与首次设置

在仓库根目录 `pnpm install && pnpm build`，然后：

```sh
node apps/node/dist/cli.js init --server https://your-server.example --name "Office Mac"
node apps/node/dist/cli.js pair
```

在 Mac/Android 控制端认领配对码，再执行 `node apps/node/dist/cli.js start`。默认配置为 `~/.super-agent/node.json`，可通过 `--config` 分开运行测试节点。已有配置与设备私钥不会被 init 覆盖。私钥文件及 SQLite 使用本机用户访问权限。

配置中的 Codex 读取本机已有登录，init 尽可能读取公开的 `model` 配置值；`configured-default` 是本机默认模型别名，传给 Codex 时省略 model 参数，由本机 Codex 决定。Grok 配置 `grok.model` 和 `grok.key_env`（默认 XAI_API_KEY）、`grok.keychain_service` 或 `grok.key_file`，Key 仅在本机解析并直连供应商。后台 LaunchAgent 不自动继承交互终端环境，建议使用本机 Keychain 服务项。节点不会创建或覆盖用户已有的模型凭据。

`probe` 只输出脱敏能力、模型与就绪原因。`launchagent` 生成供用户审阅/安装的用户级启动配置，不改 root 服务，也不嵌入模型 Key。只有显式 `init --fake-runtime` 才开启集成测试运行时，能力和结果均标注 FakeRuntime；实际部署不使用这个选项。

### 与用户云端测试服务联调

单独使用一个测试配置目录，不能把测试节点配进生产账号：

```sh
node apps/node/dist/cli.js init --server https://YOUR-CLOUD-TEST-API --name "Integration Test Mac" --config /tmp/super-agent-test-node/node.json --fake-runtime
node apps/node/dist/cli.js pair --config /tmp/super-agent-test-node/node.json --no-wait
# 在云端测试控制客户端中认领显示的code，再次运行pair保存设备身份。
node apps/node/dist/cli.js pair --config /tmp/super-agent-test-node/node.json
node apps/node/dist/cli.js start --config /tmp/super-agent-test-node/node.json
```

通过控制端为该设备创建 `fake-test-model` 任务。预期它执行云端记忆检索、创建本地 `test-result.txt`、上报成功状态与“费用不可取得”，结果明确带 `[FakeRuntime 测试完成]`。这一联调不调用模型、不启动任何本地数据库服务；节点 SQLite 是执行日志。生产模型验证另行使用真实本机配置。

不产生推理调用的真实 Codex 检查：`pnpm exec tsx spikes/codex-probe.ts`。它只 initialize、列模型、创建并归档 read-only thread，验证 dynamicTools 定义可接受，不执行 turn/start。

## 已实现机制

- Ed25519 设备配对与服务器 challenge 完整字符串签名、短期设备 token 自动刷新。
- SQLite 持久命令 inbox、payload hash 冲突、producer 序号、报告 outbox 与 ACK 去重；用量修订和 outbox 同一事务。
- 轮询 cloud commands、accept 后才执行、续租、补传、断线恢复保守标记 result_unknown，不盲目重跑提交。
- Codex stdio JSON-RPC、experimental dynamic tools（目标版本需可用）、开始/补充/中断、原生提问转接与 Token 事件。
- Grok Responses API 直连、自定义工具循环、输出/轮次/超时边界、429/5xx 退避、费用字段归因。
- 共享受管工具：CSI 浏览器、云端记忆、任务目录文件、提问；shell 必须本机配置 allow_shell=true 才提供。
- CSI session 按 Run 分组，浏览器操作串行并保持本机唯一 Run 持有者；按需截图与人工输入检查 frame/viewport。
- 所选主助理电脑持租约处理 inbox，预取最近对话、待处理任务与待确认方案；先展示目标、产出、电脑与引擎，收到真实用户后续“确认 计划编号”才创建任务。取消与澄清不会启动执行；结构化任务表单是单独的显式授权。方案与确认回复用 SQLite outbox 保证重试不重复派活；没有在线主助理时消息等待。

## 明确的实现边界

- Codex 默认使用版本化 app-server 的实验 dynamicTools，未启用时应报错，不伪装 MCP 已正常工作；另提供本地 stdio MCP bridge 实现供支持的配置接入。
- 预算/停止对在途原生模型请求与本机全权限绕过无法提供绝对封顶；网站提交结果不明时需要核对。
- GUI 浏览器依赖 macOS 登录会话、CSI daemon 与 Chrome 扩展；系统弹窗、验证码、跨域 iframe 仍可能需要用户介入。
- 实际 Grok 调用需要用户已配置 Key/模型；测试使用本机 mock HTTP，不声称已验证付费云账号。
- 已用真实云端专用 PostgreSQL 与进程内 Fastify inject 验证节点配对、执行、重启去重、方案确认、第二台电脑路由与画面接管。测试运行时、CSI 和 Agent Recall 上游是明确的 mock；真实供应商推理、实际 Chrome 登录态和公网部署仍需要部署环境验证。

## 云端跨组件验证

根目录 `pnpm test:integration` 会读取显式 `TEST_DATABASE_URL`、`TEST_MIGRATION_DATABASE_URL`（或根 `.env.test`），只允许云端专用 `*_test` 数据库，缺少配置时明确跳过。测试迁移并使用真实 PostgreSQL，HTTP 通过 Fastify inject 适配 fetch，不监听本地服务、不启动 Docker。记忆上游、CSI 与 FakeRuntime 均是显式 fixture，不能视作真实模型或浏览器验收。

运行中每2秒默认检查执行续租与停止，可在节点配置中用 `renew_interval_ms` 调整；它与 `poll_interval_ms` 一起影响用户停止与接管响应。主助理租约单独维护，避免长规划回合过期。

协议来源：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Grok function calling](https://docs.x.ai/developers/tools/function-calling)。
