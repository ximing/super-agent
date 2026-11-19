# 应用图标

共享母版与 PNG 位于 `assets/branding/`。`bash apps/macos/scripts/build-app.sh` 将亮色与暗色 1024 px 图标复制到应用 Resources，并通过 macOS 自带的 `sips`、`iconutil` 生成完整多尺寸 `AppIcon.icns`，写入 `CFBundleIconFile`。

亮色为白底圆角，暗色为深色圆角。启动后 `AppIconController` 观察 AppKit 的 `effectiveAppearance`，自动更新运行中的 Dock 图标；正常运行继承系统外观。不会更改用户的系统设置。直接 `swift run` 的裸可执行文件没有应用资源，图标切换仅在打包后的 `.app` 中启用。

Finder 与尚未启动的应用使用 `.icns` 亮色图标。当前最低部署目标为 macOS 14、Swift Package 构建，未配置新版 Icon Composer 资源，因此不声称 Finder 图标随系统暗色变化。现代系统的图标着色行为仍由系统控制。

依据：[Apple effectiveAppearance](https://developer.apple.com/documentation/appkit/nsapplication/effectiveappearance)、[applicationIconImage](https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage)。
