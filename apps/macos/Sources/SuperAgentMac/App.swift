import SwiftUI
import SuperAgentCore

@main struct SuperAgentApplication: App {
    @NSApplicationDelegateAdaptor(NativeNotifications.self) private var notifications
    @StateObject private var model = WorkspaceModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WorkspaceView(initialSection: DemoLaunch.current.section)
                .environmentObject(model)
                .tint(Palette.accent)
                .onOpenURL { model.handleLoginCallback($0) }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { model.enterForeground() }
                }
                .frame(minWidth: 1040, minHeight: 680)
                .task {
                    notifications.model = model
                    model.notifications = notifications
                    if let index = CommandLine.arguments.firstIndex(of: "--smoke-screenshot"), CommandLine.arguments.indices.contains(index + 1) {
                        DemoScreenshot.captureAfterDelay(path: CommandLine.arguments[index + 1], demo: false)
                    } else if DemoLaunch.current.isEnabled {
                        NSApp.setActivationPolicy(.regular)
                        model.installDemoWorkspace()
                        if DemoLaunch.current.screenshotPath != nil {
                            DemoScreenshot.captureAfterDelay(path: DemoLaunch.current.screenshotPath, demo: true)
                        } else {
                            NSApp.appearance = NSAppearance(named: .aqua)
                        }
                    } else {
                        await model.bootstrap()
                    }
                }
        }
        .defaultSize(width: 1260, height: 840)
        .windowToolbarStyle(.unified(showsTitle: false))
        .commands {
            CommandGroup(after: .newItem) {
                Button("新建任务") { NotificationCenter.default.post(name: .newTaskRequested, object: nil) }
                    .keyboardShortcut("n")
                    .disabled(model.session == nil)
                Button("刷新工作台") { Task { await model.refresh() } }
                    .keyboardShortcut("r")
                    .disabled(model.session == nil)
            }
            CommandGroup(after: .toolbar) {
                Button("搜索当前工作区") { NotificationCenter.default.post(name: .searchRequested, object: nil) }
                    .keyboardShortcut("k")
                    .disabled(model.session == nil)
                Button("显示或隐藏检查器") { NotificationCenter.default.post(name: .inspectorRequested, object: nil) }
                    .keyboardShortcut("0", modifiers: [.command, .option])
                    .disabled(model.session == nil)
            }
        }
    }
}

enum Palette {
    static let accent = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedRed: 0.72, green: 0.68, blue: 0.96, alpha: 1)
            : NSColor(calibratedRed: 0.384, green: 0.341, blue: 0.776, alpha: 1)
    })
    static let blue = accent // Existing secondary pages share the native-workbench accent.
    static let ink = Color(nsColor: .labelColor)
    static let muted = Color.secondary
    static let canvas = Color(nsColor: .windowBackgroundColor)
}

enum WorkspaceSection: String, CaseIterable, Identifiable {
    case conversation = "助理", tasks = "任务", questions = "待我处理", devices = "电脑", memories = "记忆", schedules = "定时关注", costs = "成本"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .conversation: "bubble.left.and.bubble.right"
        case .tasks: "checklist"
        case .questions: "hand.raised"
        case .devices: "desktopcomputer"
        case .memories: "books.vertical"
        case .schedules: "clock.arrow.circlepath"
        case .costs: "chart.bar.xaxis"
        }
    }
}

struct LoginView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var email = ""
    @State private var name = ""

    var body: some View {
        HStack(spacing: 70) {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 64, weight: .light))
                    .foregroundStyle(Palette.accent)
                Text("工作继续，\n你随时掌握。")
                    .font(.system(size: 38, weight: .semibold))
                    .lineSpacing(5)
                Text("连接自己的电脑，交办任务、查看过程，\n让经验在每一次工作中积累。")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .lineSpacing(5)
            }
            .frame(width: 360, alignment: .leading)

            VStack(alignment: .leading, spacing: 18) {
                Text("连接你的助理").font(.title2.weight(.semibold))
                if let message = model.sessionRestoreMessage {
                    Text(message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if model.sessionRestoring {
                    HStack {
                        ProgressView().controlSize(.small)
                        Button("跳过恢复，重新登录") { Task { await model.skipSessionRestoration() } }
                    }
                } else if !model.loginInProgress {
                    Button("恢复已保存登录") { Task { await model.restoreSavedSession(allowInteraction: true) } }
                        .disabled(model.busy || model.server.isEmpty)
                }
                if model.authConfig?.mode == "development" {
                    Label("服务器已显式启用本地开发登录", systemImage: "hammer").font(.caption).foregroundStyle(.secondary)
                    TextField("邮箱", text: $email).textFieldStyle(.roundedBorder)
                    TextField("称呼（可选）", text: $name).textFieldStyle(.roundedBorder)
                } else {
                    Text("使用系统浏览器完成安全登录。模型账号始终留在你的执行电脑上。")
                        .font(.callout).foregroundStyle(.secondary)
                }
                TextField("云端服务器，例如 https://agent.example.com", text: $model.server).textFieldStyle(.roundedBorder)
                Button("读取登录配置") { Task { await model.operation { try await model.configure() } } }
                    .disabled(model.server.isEmpty || model.busy)
                Button { Task { await model.signIn(email: email, name: name) } } label: {
                    HStack {
                        if model.busy { ProgressView().controlSize(.small) }
                        Text(model.authConfig?.mode == "development" ? "登录开发环境" : "打开安全登录").frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(model.busy || model.server.isEmpty || model.authConfig == nil || (model.authConfig?.mode == "development" && !email.contains("@")))
                if model.authConfig?.mode == "oidc" {
                    Button("改用浏览器登录") { Task { await model.signIn(email: email, name: name, mode: .external) } }
                        .disabled(model.busy || model.server.isEmpty)
                    Text("系统安全登录未弹出时，可在默认浏览器完成同一授权流程；首次改密由你操作。")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let phase = model.loginPhase {
                    Text(phase.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if model.loginInProgress { Button("取消登录") { model.cancelSignIn() } }
                if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            }
            .frame(width: 340)
            .padding(30)
            .background(.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary))
        }
        .padding(50)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.canvas)
    }
}

struct ExecutionPicker: View {
    @EnvironmentObject var model: WorkspaceModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            labeledMenu("引擎") {
                Picker("引擎", selection: $model.selectedEngine) {
                    ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
            }
            labeledMenu("执行电脑") {
                Picker("执行电脑", selection: $model.selectedDevice) {
                    Text("选择执行电脑").tag("")
                    ForEach(model.devices.filter { $0.revoked != true }) { device in
                        Text("\(device.name)（\(AgentStatus.title(device.status))）").tag(device.id)
                    }
                }
            }
            labeledMenu("模型") {
                Picker("模型", selection: $model.selectedModelId) {
                    Text("本机默认").tag("")
                    ForEach(model.devices.first(where: { $0.id == model.selectedDevice && $0.revoked != true })?.capabilities.engines.first(where: { $0.engine == model.selectedEngine })?.models ?? [], id: \.self) { Text($0).tag($0) }
                }
            }
            if let device = model.devices.first(where: { $0.id == model.selectedDevice }), !device.supports(model.selectedEngine) {
                Label(device.revoked == true ? "此电脑已撤销，请手动选择其他电脑" : "此电脑尚未配置该引擎", systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onChange(of: model.selectedEngine) { _, _ in model.selectedModelId = "" }
        .onChange(of: model.selectedDevice) { _, _ in model.selectedModelId = "" }
    }

    private func labeledMenu<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(title)
                .frame(width: 72, alignment: .leading)
            content()
                .labelsHidden()
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 34, weight: .light)).foregroundStyle(Palette.accent)
            Text(title).font(.title3.weight(.semibold))
            Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 430)
        }
        .padding(40)
        .frame(maxWidth: .infinity, minHeight: 240)
    }
}

struct StatusLabel: View {
    let value: String

    var color: Color {
        switch value {
        case "succeeded", "accepted", "online", "verified": .green
        case "running", "starting", "dispatched": Palette.accent
        case "failed": .red
        case "awaiting_review", "pending", "result_unknown", "lost", "waiting_input": .orange
        case "paused", "pausing", "stopping": .orange
        default: .secondary
        }
    }

    var body: some View {
        Label(AgentStatus.title(value), systemImage: value == "running" ? "circle.dotted" : "circle.fill")
            .font(.caption)
            .foregroundStyle(color)
            .labelStyle(.titleAndIcon)
    }
}

func formatTime(_ value: String) -> String {
    let parser = ISO8601DateFormatter()
    return parser.date(from: value)?.formatted(date: .abbreviated, time: .shortened) ?? String(value.prefix(16))
}
