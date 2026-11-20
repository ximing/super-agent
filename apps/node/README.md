# Mac 执行节点

节点与云端控制服务分开运行。它不启动 Docker、数据库或服务端；连接用户提供的云端 API。SQLite 仅保存执行设备必要的 inbox/outbox、去重、运行绑定和检查点，属于本地执行状态。

## 安装已发布的包

npm 上的包名是 `@aimo-supa-agent/node`。需要 Node.js 24.14 或更新版本。

```sh
npm install -g @aimo-supa-agent/node
super-agent-node --help
```

发版由 GitHub Actions「Publish node package」执行。版本号取自本目录 `package.json`。同一个版本已经在 npm 上时，流水线会跳过，不会覆盖。要发出新包，先改版本号再推到 main，或手动运行该流水线。

## 构建与首次设置

在仓库根目录 `pnpm install && pnpm build`，然后：

```sh
node apps/node/dist/cli.js init --server https://your-server.example --name "Office Mac"
node apps/node/dist/cli.js pair
```

在 Mac/Android 控制端认领配对码，再执行 `node apps/node/dist/cli.js start`。默认配置为 `~/.super-agent/node.json`，可通过 `--config` 分开运行测试节点。已有配置与设备私钥不会被 init 覆盖。私钥文件及 SQLite 使用本机用户访问权限。

配置中的 Codex 读取本机已有登录，init 尽可能读取公开的 `model` 配置值；`configured-default` 是本机默认模型别名，传给 Codex 时省略 model 参数，由本机 Codex 决定。Grok 配置 `grok.model` 和 `grok.key_env`（默认 XAI_API_KEY）、`grok.keychain_service` 或 `grok.key_file`，Key 仅在本机解析并直连供应商。后台 LaunchAgent 不自动继承交互终端环境，建议使用本机 Keychain 服务项。节点不会创建或覆盖用户已有的模型凭据。

`probe` 只输出脱敏能力、模型与就绪原因。`launchagent` 生成供用户审阅/安装的用户级启动配置，不改 root 服务，也不嵌入模型 Key。只有显式 `init --fake-runtime` 才开启集成测试运行时，能力和结果均标注 FakeRuntime；实际部署不使用这个选项。

### 正式 Mac 的一次性安装与登录自启

当前开发电脑用于临时验收。下面步骤由用户在正式执行 Mac 上按需运行，生成 plist 本身不会注册自启动。

1. 在正式 Mac 安装 Node 24.14+、pnpm 和 Codex CLI，使用运行节点的同一个 macOS 用户完成 Codex 登录。在长期保留的项目目录中构建本仓库，完成 `init`、客户端认领配对及 `probe`。使用 Grok 时配置本机 Keychain 服务或私密 Key 文件；LaunchAgent 不复制终端中的 API Key。
2. 浏览器任务需要一次性安装 CSI。在 **CSI 项目自己的 checkout** 中按其安装说明运行 `bash scripts/install.sh`，再在 Chrome 的 `chrome://extensions` 开启开发者模式，加载安装器提示的已构建扩展目录，确认扩展已启用并显示 connected。这里不会替用户安装 CSI 或修改浏览器扩展。
3. 先以前台 `start` 验证并用 Ctrl+C 退出，再在正式 Mac 上生成并注册用户级 LaunchAgent：

```sh
node "/absolute/path/super-agent/apps/node/dist/cli.js" launchagent --config "$HOME/.super-agent/node.json"
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HOME/.super-agent/launchd/com.superagent.node.plist" "$HOME/Library/LaunchAgents/com.superagent.node.plist"
chmod 600 "$HOME/Library/LaunchAgents/com.superagent.node.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.superagent.node.plist"
launchctl print "gui/$(id -u)/com.superagent.node"
```

生成的 plist 只持久化安全 PATH：当前 Node 可执行文件目录、当前 PATH 中的绝对目录及常规 Homebrew/系统目录；不复制模型 Key、代理凭据或其他环境变量。程序与配置路径支持空格。若升级或移动 Node、Codex 或项目目录，重新生成 plist 并在正式 Mac 上更新注册；也可在本机配置中把 `codex.command` 指向稳定的绝对路径。

本机 `browser.enabled=false` 时不启动 CSI、不列出浏览器工具。启用浏览器时，能力探测只读 CSI `/status`，必须扩展连接才广告 browser；文件/记忆任务不依赖它。真实模式每次 `start` 会检查已有 `~/.csi/bin/csi` 的可执行权限并调用官方幂等 `start`。不会自动 install、stop 或 restart。CSI 缺失或启动失败时只输出固定诊断，节点仍可处理非浏览器任务；FakeRuntime 完全跳过此步骤。CSI 安装器不注册登录自启，节点启动检查负责补上重启后的启动；扩展和已登录的 Chrome 仍需可用。

保持正式 Mac 的用户会话登录、Chrome 扩展运行、网络与所需系统代理可用，并按需要配置系统电源设置避免任务期间休眠。LaunchAgent 属于用户登录会话，不能替代登录界面中的桌面会话。日志位于 `~/.super-agent/launchd/node.log` 和 `node-error.log`。控制请求超时会丢掉卡住的代理连接再试；连续 3 次心跳失败则进程退出，已安装的 KeepAlive 会拉起新进程。这样进程不会一直活着却让电脑显示离线。

若用户要停止并取消该 Mac 的自动启动，可自行执行：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.superagent.node.plist"
rm "$HOME/Library/LaunchAgents/com.superagent.node.plist"
```

停止节点不会自动关闭用户的 CSI 服务或浏览器会话。

### 本机网络与代理

启动、配对及 `probe` 会按“显式 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 环境变量 → 本机 `node.json` 的 `proxy_url` → macOS 系统 HTTP/HTTPS 代理”的顺序设置当前进程。小写环境变量优先；只指定一种 HTTP(S) 代理时用于两种请求协议。配置不会写入系统或 Codex 全局设置，也不会上传代理 URL 或凭据。`probe` 只输出来源及是否启用。

Codex 子进程继承相同代理环境；Grok 使用的 Node 原生 `fetch` 通过 `http.setGlobalProxyFromEnv()` 启用代理。已有 `NO_PROXY` 排除项保留，并加入 `localhost`、`127.0.0.1`、`::1`，确保 CSI 和本机工具桥保持本地连接。`proxy_url` 可设置 HTTP(S) 代理；仅有 SOCKS/PAC 时会明确要求 HTTP(S) 端点。

官方 API 从 **Node 24.14.0** 起可用。检测到代理但缺少该 API 时节点明确要求升级，不会让 Grok 静默直连；没有代理时旧版 Node 24 仍可运行。云端控制服务不需要此配置。参见 [Node 24 HTTP 文档](https://nodejs.org/docs/latest-v24.x/api/http.html#httpsetglobalproxyfromenvproxyenv)。

已验证：此 Mac 通过已有系统代理完成一次真实 Codex 文件读取工具回合，28.476 秒，1 次工具调用、输出 9 Token。先前未继承代理时的失败和成功记录分别保存在 `spikes/codex-live-tool-result.json`、`spikes/codex-live-tool-proxy-result.json`。

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
- Codex Worker 默认使用已验证的受管启动参数：关闭原生 shell、apps/plugins、浏览器/桌面、多 Agent、hooks、图像及网页搜索旁路；从本机配置只提取外部 MCP section 名称并按进程禁用，统一使用提供的 dynamicTools 或显式 `super_agent` 桥。启动前核对 CLI feature 列表；不支持时明确报兼容错误，不改用户全局设置。inline/profile MCP 配置无法安全隔离时会明确拒绝启动，需改为具名 MCP section。
- Grok Responses API 直连、自定义工具循环、输出/轮次/超时边界、429/5xx 退避、费用字段归因。
- 共享受管工具：CSI 浏览器、云端记忆、任务目录文件、提问与云端附件。`artifacts_list` 只列当前任务；`artifacts_download` 可读取用户上传及同任务较早 Run 的文件；`artifacts_upload` 将工作目录文件上传并 finalize 为本 Run 产物。签名对象存储传输限定 HTTPS、禁止重定向且不携带产品 Bearer，下载原子写入并检查 50 MiB 上限、目录与符号链接边界。shell 必须本机配置 allow_shell=true 才提供。
- CSI session 按 Run 分组，浏览器操作串行并保持本机唯一 Run 持有者；按需截图与人工输入检查 frame/viewport。
- 所选主助理电脑持租约处理 inbox，预取最近对话、待处理任务与待确认方案；先展示目标、产出、电脑与引擎，收到真实用户后续“确认 计划编号”才创建任务。取消与澄清不会启动执行；结构化任务表单是单独的显式授权。方案与确认回复用 SQLite outbox 保证重试不重复派活；没有在线主助理时消息等待。

## 明确的实现边界

- Codex 默认使用版本化 app-server 的实验 dynamicTools，未启用时应报错，不伪装 MCP 已正常工作；另提供本地 stdio MCP bridge 实现供支持的配置接入。
- 预算/停止对在途原生模型请求与本机全权限绕过无法提供绝对封顶；网站提交结果不明时需要核对。
- GUI 浏览器依赖 macOS 登录会话、CSI daemon 与 Chrome 扩展；系统弹窗、验证码、跨域 iframe 仍可能需要用户介入。
- Grok 支持两种本机模式：原有 Responses API Key/模型，以及官方原生 Grok Build CLI 1.0.89 既有登录。原生 CLI 已通过独立单文件受限真实回合；正式产品 Task、浏览器业务与云端记忆绑定仍需分别验收。
- 已用真实云端专用 PostgreSQL 与进程内 Fastify inject 验证节点配对、执行、重启去重、方案确认、第二台电脑路由与画面接管。测试运行时、CSI 和 Agent Recall 上游是明确的 mock；真实供应商推理、实际 Chrome 登录态和公网部署仍需要部署环境验证。

## 云端跨组件验证

根目录 `pnpm test:integration` 会读取显式 `TEST_DATABASE_URL`、`TEST_MIGRATION_DATABASE_URL`（或根 `.env.test`），只允许云端专用 `*_test` 数据库，缺少配置时明确跳过。测试迁移并使用真实 PostgreSQL，HTTP 通过 Fastify inject 适配 fetch，不监听本地服务、不启动 Docker。记忆上游、CSI 与 FakeRuntime 均是显式 fixture，不能视作真实模型或浏览器验收。

运行中每2秒默认检查执行续租与停止，可在节点配置中用 `renew_interval_ms` 调整；它与 `poll_interval_ms` 一起影响用户停止与接管响应。主助理租约单独维护，避免长规划回合过期。

协议来源：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[Grok function calling](https://docs.x.ai/developers/tools/function-calling)。

## 官方 Grok CLI 与可移植 Worker 包

复用正式 Mac 已登录的官方 Grok Build 1.0.89 时，在本机配置中设置 `grok.mode="cli"`、`grok.command` 为稳定绝对路径、`grok.model=""` 使用默认模型，并用 `assistant_engine="grok"` 选择本机主助理默认引擎。API 模式仍可使用上述本机 Key 来源；CLI 模式完全不读取 Key 配置，不向服务端传模型认证。默认模型在控制端显示为 `configured-default`。原有 Grok MCP 与全局配置保持原样，任务使用隔离工具配置和原认证文件路径；详见 [Grok runtime](../../packages/runtime-grok/README.md)。

构建稳定后，可只打包 Worker 所需的 5 个 workspace（不包含服务端、数据库、用户配置或任何认证文件）：

```sh
node apps/node/scripts/bundle.mjs /absolute/new/super-agent-worker-release
```

将新目录完整复制到正式 Mac 的长期 release 目录即可，不需要目标机器安装 pnpm。使用目标机 Node 24.14+ 运行包里的 `apps/node/dist/cli.js`。每个 release 保持独立，本机 `--config`/data_dir 放在 release 之外；更新时无需复制或覆盖 Grok/Codex 登录文件。正式配对先 `init`、`pair`，由用户在产品中认领后再 `start`，首次以前台验证，按需另行注册用户 LaunchAgent。
