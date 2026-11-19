# Android 图标

统一母版和导出资源位于 `../../assets/branding/`。亮色为白底紫色标记，暗色为 `#202027` 底和浅紫标记。

`plugins/with-launcher-icons.js` 在 Expo prebuild 时生成原生资源并设置 Manifest；图标使用独立的 `super_agent` 资源名，避免被 Expo 默认图标生成流程覆盖。无需修改根 lockfile。

- Android 8+ 使用前景、背景分离的 adaptive icon，外形由系统桌面遮罩决定；支持圆角方形、圆形等桌面形状。
- `values-night` 和 `drawable-night-nodpi` 随系统暗色选择背景、标记；旧版桌面使用五档密度的亮/暗 legacy PNG。
- Android 13+ 额外提供 monochrome 图层。用户开启主题图标后，由支持的桌面按壁纸和系统主题着色。
- 桌面可能缓存图标；切换后是否即时刷新由桌面实现决定。图标暗色资源不改变应用现有界面主题。

重新导出母版后可只更新现有原生工程的图标：

```sh
node apps/android/plugins/with-launcher-icons.js
```

`pnpm --filter @super-agent/android native:generate` 也会保留这套规则。

参考：[Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)、[创建应用图标](https://developer.android.com/studio/write/create-app-icons)。
