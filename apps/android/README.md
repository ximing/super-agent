# React Native Android 控制端

使用 React Native 0.81.5 / Expo SDK 54 的原生 Android 应用。依赖组合经过 `expo install --check`，不是网站或 WebView 代替客户端。

## 构建

依赖由仓库根目录统一 `pnpm install`，不要在并行开发中竞争修改根 lockfile。

```sh
pnpm --filter @super-agent/android typecheck
pnpm --filter @super-agent/android test
pnpm --filter @super-agent/android exec expo export --platform android --output-dir dist
pnpm --filter @super-agent/android native:generate
cd apps/android/android
ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew :app:assembleRelease --no-daemon
python3 - <<'PY_CHECK_APK'
from pathlib import Path
from zipfile import ZipFile
apk = Path("app/build/outputs/apk/release/app-release.apk")
with ZipFile(apk) as archive:
    bundle = archive.read("assets/index.android.bundle")
    assert len(bundle) > 8, "APK 缺少有效 JS bundle"
    assert bundle[:8] == bytes.fromhex("c61fbc03c103191f"), "APK bundle 不是 Hermes 字节码"
print("已验证独立 APK 内含 Hermes bundle:", apk)
PY_CHECK_APK
adb install -r app/build/outputs/apk/release/app-release.apk
```

交付产物是 `android/app/build/outputs/apk/release/app-release.apk`，当前使用公开开发证书签名，仅作内部测试。`assembleRelease` 会通过 Expo `export:embed` 生成并打包 Hermes 字节码；上述 ZIP 检查用于确认 APK 包含 `assets/index.android.bundle`，并核验 Hermes 文件头。它不需要本机 Metro，业务功能仍连接云端 HTTPS API。正式发布前必须在 CI 换为用户自己的签名配置。

`assembleDebug` 仅用于配合 Metro 的开发调试。当前 React Native 插件默认将 `debug`、`debugOptimized` 列为 debuggable variant，跳过 JS/assets 打包；该开发 APK 不能作为脱离开发电脑运行的交付物。独立安装验收应停止 Metro，断开 `adb reverse`，在 Android 上直接打开上述 release APK 并连接云端服务。

`android/` 已生成原生工程，原生构建需要 JDK 17、对应 Android SDK、Gradle 和 Maven 网络。首次 Gradle 8.14.3 分发下载曾遇到读超时，wrapper 网络超时已调整为 60 秒，并固定官方 SHA-256。生成插件保留这些设置；普通 `build` 只导出 bundle，不自动重写原生工程。Hermes bundle 导出通过不等于已生成 APK；具体 APK 结果以 Gradle 命令实际输出为准。

本机已实际运行 `:app:assembleDebug`：官方校验通过的 Gradle 8.14.3 启动后，Maven/plugin 依赖的 TLS 下载持续阻塞，线程栈停留在 `ExternalResourceArtifactResolver.downloadByUrl`，已停止该次单独 daemon。尚无经过验证的 APK；由仓库 CI 在联网环境继续原生构建。提交的 `android/app/debug.keystore` 是 React Native 公共开发模板（公开口令 `android`），只用于开发和明确标注的内部测试安装，不是私人发布证书；正式发布需要 CI 注入用户自己的签名配置。

开发时可以使用 `pnpm --filter @super-agent/android start` 的 Metro；这不是服务端基础设施，不会启动数据库、控制服务或 Docker。生产 API、PostgreSQL、对象存储和 OIDC 由用户云端部署。

## 功能与边界

- 默认云端域名 `https://super-agent.aimo.plus`，首次登录前读取配置；可改为自己的 HTTPS 服务。
- 系统浏览器 OIDC + PKCE / 显式开发登录；SecureStore 用 Android Keystore 支持的存储保存产品会话。
- API 访问刷新串行化，POST 重试保留幂等 ID；更新请求携带 If-Match。切换服务器或退出时不携带上个账户 Token 和页面数据。
- 对话、任务派发和详情、设备/引擎/本机模型选择、任务操作、问题回答、配对认领与默认执行设置。
- 本用户 agent-recall 绑定与记忆读写：HTTPS URL + 掩码访问令牌，令牌提交后清空，不显示已保存令牌。
- 成本总览、时间范围、真实趋势和按电脑/引擎/任务分布；费用来源与不可核算用量分开，支持预算。
- 候选记忆显式审核发布；编辑后带版本提交 `status=verified`，刷新列表兼容 Recall 发布后的新 ID。
- 定时关注规则的创建、启停和删除；周期提醒并准备工作目标，由用户确认后执行。
- 任务附件和交付物：原生文件选择、签名 URL 原始文件上传、完成确认和系统浏览器下载；对象存储请求不附带产品 Token。
- 业务结果人工核对：记录已生效、未生效或仍不确定，必须填写核对说明。
- 浏览器按需画面和人工接管。输入坐标是 **Frame 图片自然像素**，不是 0..1 归一化坐标；节点负责截图像素到 CSS 视口的换算，并核验 frame_id/viewport_version。
- 前台增量事件轮询；AppState 恢复前台时刷新，后台不依赖 JS 保活。

## 远程通知

`src/native.ts` 提供权限、Android notification channel、Expo push token 登记和通知任务跳转适配器。需要发布 CI 提供 `EXPO_PUBLIC_EAS_PROJECT_ID`，并配置对应 Expo/FCM 凭据与云端通知发送服务。未配置时界面明确提示，应用内待处理列表仍可使用。

手机厂商、省电策略和国内网络下的送达需要目标真机验证；目前不声称已验证杀进程后的远程送达。不要把模型 Key 写入任何 `EXPO_PUBLIC_*` 环境变量。

## 已执行的验证

- TypeScript 检查通过。
- 5 项 Node API 客户端测试通过：URL 安全、会话刷新/幂等/版本、跨 origin 隔离、未知金额保留。
- Metro 导出 Android Hermes bundle（763 modules，2.15 MB）通过。
- SDK 包版本兼容性检查通过，原生工程 prebuild 通过。
- APK 与云端真实交互、OIDC/Recall 和后台通知验收仍分别依赖原生构建网络及用户部署配置，不能用上述单元测试代替。

OIDC 登录仅请求 `openid profile email`，默认回调为 `superagent://oauth/callback`。应用保存和刷新产品服务端会话，不申请 OIDC `offline_access` 长期权限。
