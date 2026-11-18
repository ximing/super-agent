# 开始使用

控制端：Mac 原生应用或 Android APK；云端地址 `https://super-agent.aimo.plus`。首次读取登录配置后打开系统浏览器登录。初始账号由 OIDC 管理员创建；模型账号不用于产品登录。正式分发的 Mac Developer ID/公证与 Android 发布签名独立配置，目前提供本机签名 Mac 应用和 Android 开发签名 APK。

## 正式执行 Mac：一次性安装

需要 Node.js **24.14+**、pnpm 10.30.3、本机已登录的 Codex CLI，以及已安装的 CSI daemon/Chrome 扩展。浏览器自动化依赖当前用户登录 Chrome；不要把浏览器 cookie 或模型认证文件上传到服务器。

在正式执行电脑上选择固定目录，后续后台服务会引用此代码路径：

```sh
git clone https://github.com/ximing/super-agent.git ~/super-agent
cd ~/super-agent
pnpm install --frozen-lockfile --filter @super-agent/node...
pnpm --filter @super-agent/node... build
node apps/node/dist/cli.js init --server https://super-agent.aimo.plus --name "办公室 Mac"
node apps/node/dist/cli.js pair --no-wait
```

控制端进入“电脑”，认领该配对码；随后在执行 Mac 完成配对并前台验证：

```sh
node apps/node/dist/cli.js pair
node apps/node/dist/cli.js probe
node apps/node/dist/cli.js start
```

配置与设备私钥仅在 `~/.super-agent/`。在控制端选择主助理电脑、默认执行电脑和引擎。普通聊天先提出目标、产出、执行引擎和电脑，明确确认后再执行；任务表单提交本身是明确交办。多计划待确认时使用回复中的编号。

节点使用显式 HTTP(S)_PROXY 环境变量、`node.json` 本机 `proxy_url` 或 macOS 系统 HTTP(S) 代理，按此优先级选择；localhost 工具通信保持直连。PAC/SOCKS-only 配置需提供等效 HTTP 代理端点。代理设置不上传云端。

Grok 在已有 `node.json` 的 `grok` 部分配置可用模型及本机 Key 来源：`keychain_service`、`key_file` 或 `key_env`。后台进程不继承交互终端中的 Key，推荐钥匙串。不要替换整个配置而丢失设备身份；不要把 Key 放进 plist、仓库或控制服务器。

## 后台运行

前台验证通过并停止前台节点后，在正式执行 Mac 手动安装用户级 LaunchAgent：

```sh
cd ~/super-agent
node apps/node/dist/cli.js launchagent
mkdir -p "$HOME/Library/LaunchAgents"
cp "$HOME/.super-agent/launchd/com.superagent.node.plist" "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.superagent.node.plist"
launchctl print "gui/$(id -u)/com.superagent.node"
```

只保存必要 PATH，已有 CSI 会按需幂等启动；不安装系统级/root 服务。保持 Mac 登录、联网和允许后台运行；睡眠、关机、退出图形会话会使浏览器任务等待设备。关闭控制端窗口不停止节点。

停止后台节点：

```sh
launchctl bootout "gui/$(id -u)/com.superagent.node"
```

当前开发电脑仅进行受限验证，没有安装长期 Worker 自启动。

## 记忆、文件与主动提醒

在控制端设置中绑定本人 `https://recall.aimo.plus` 账号 PAT。已发布内容与版本来自 Recall；节点按当前任务授权检索，不获得 PAT。新探索先生成候选，控制端审核并发布后供后续任务使用。

任务附件上传至私有 S3；Worker 可列出/下载本任务附件，并上传工作目录中的产物。跨电脑切换仍可读取该任务旧 Run 的云端文件。每个用户和任务均校验归属。

定时关注首版为“提醒并确认后执行”。控制端前台可看问题、任务变化与浏览器画面；关闭应用后的远程推送尚需 APNs/FCM/厂商通道配置，不依赖手机后台 JavaScript 保活。
