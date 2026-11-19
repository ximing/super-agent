# 开始使用

控制端：Mac 原生应用或 Android APK；云端地址 `https://super-agent.aimo.plus`。首次读取登录配置后打开系统浏览器登录。初始账号由 OIDC 管理员创建；模型账号不用于产品登录。正式分发的 Mac Developer ID/公证与 Android 发布签名独立配置，目前提供本机签名 Mac 应用和 Android 开发签名 APK。

Mac 点击“打开安全登录”后若系统窗口未出现，先点“取消登录”，再选择“改用浏览器登录”。两种入口使用相同的 OIDC/PKCE 授权；浏览器完成后返回工作台，首次修改临时密码由用户完成。登录等待有阶段提示、取消入口及超时，不必一直等转圈。

当前公开版本为[v0.2.1-preview.1](https://github.com/ximing/super-agent/releases/tag/v0.2.1-preview.1)，包含Mac/Android安装包、便携Worker与校验和。Mac arm64版本0.2.1 build5，Android版本0.2.0 code2；安装包签名/校验通过不等于正式公证或商店签名。便携Worker使用方法见[节点README](../apps/node/README.md)，下面保留源码安装方式。

Mac0.2.0云包升级旧钥匙串时可能因ACL交互阻塞而无窗口，已发布风险提示；精确76a9e2e的0.2.1/build5异步、非交互恢复云包已通过构建/验签并安装，真实看到窗口和本人工作台，约4秒后安全存储仍未响应会停止自动等待并给出固定提示；OS Keychain本身仍可能阻塞，不保证自动恢复。补丁已公开发布并替代0.2.0的Mac升级风险包，不能把旧版等待无窗口当作正常启动。旧包历史登录成功不等于新包升级验证通过。Android/服务端/Worker不受影响。

## 正式执行 Mac：一次性安装

需要 Node.js **24.14+**、pnpm 10.30.3、本机已登录的Codex CLI或已配置的Grok运行时，以及已安装的 CSI daemon/Chrome 扩展。浏览器自动化依赖当前用户登录 Chrome；不要把浏览器 cookie 或模型认证文件上传到服务器。

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

Grok支持复用本机已登录的官方CLI，具体adapter配置见[Grok说明](../packages/runtime-grok/README.md)。使用API模式时，在已有 `node.json` 的 `grok` 部分配置可用模型及本机 Key 来源：`keychain_service`、`key_file` 或 `key_env`。后台进程不继承交互终端中的 Key，推荐钥匙串。不要替换整个配置而丢失设备身份；不要把 Key 放进 plist、仓库或控制服务器。

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

当前开发电脑仅进行受限验证，没有安装长期Worker自启动。用户授权的独立正式Mac已安装用户级LaunchAgent，验证优雅重启后journal不变且无Task/模型重放；此为当次安装验收，长期弱网与休眠后恢复仍需观察。

## 记忆、文件与主动提醒

在控制端设置中绑定本人 `https://recall.aimo.plus` 账号 PAT。已发布内容与版本来自 Recall；节点按当前任务授权检索，不获得 PAT。新探索先生成候选，控制端审核并发布后供后续任务使用。

任务要读取站点记忆时，创建任务带上 `memory_scope`，例如 `{"project":"isolated-test","sites":["example.com"],"global_preference":false}`。不填写站点时，空站点的公司记忆不会被这个任务读到。全局偏好还要在记忆上标记 `scope_kind=global`，并在执行设置里显式打开 `memory_global_read`。任务结束后的复盘是待审核候选，不会自动变成已验证。

预算页面里的未知金额不是 0。设置了月额度后，只要本期还有未知金额，新任务不会按美元余额放行。运行中还会受到 Token、模型次数、工具步和时间限制；超过后停止后续可控步骤。已经发给模型的当前请求仍可能计费，尤其是 Codex 和 Grok CLI 已经开始的内部回合。

任务附件上传至私有 S3；Worker 可列出/下载本任务附件，并上传工作目录中的产物。跨电脑切换仍可读取该任务旧 Run 的云端文件。每个用户和任务均校验归属。

定时关注首版为“提醒并确认后执行”。控制端前台可看问题、任务变化与浏览器画面；服务端APNs/Expo投递、持久重试与回执链路已上线，关闭应用后实际送达仍需厂商凭据、签名和目标真机验收，不依赖手机后台 JavaScript 保活。
