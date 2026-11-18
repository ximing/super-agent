import SwiftUI
import SuperAgentCore

@main struct SuperAgentApplication: App {
    @NSApplicationDelegateAdaptor(NativeNotifications.self) private var notifications
    @StateObject private var model = WorkspaceModel()
    var body: some Scene {
        WindowGroup {
            WorkspaceView().environmentObject(model).tint(Palette.blue)
                .frame(minWidth: 1040, minHeight: 680).task {
                    notifications.model = model; model.notifications = notifications
                    if let index = CommandLine.arguments.firstIndex(of: "--smoke-screenshot"), CommandLine.arguments.indices.contains(index + 1) {
                        let path = CommandLine.arguments[index + 1]
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            if let view = NSApp.windows.first?.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                                view.cacheDisplay(in: view.bounds, to: bitmap)
                                if let data = bitmap.representation(using: .png, properties: [:]) { try? data.write(to: URL(fileURLWithPath: path)) }
                            }
                            NSApp.terminate(nil)
                        }
                    } else { await model.bootstrap() }
                }
        }.defaultSize(width: 1260, height: 840)
        .commands { CommandGroup(after: .newItem) { Button("刷新工作台") { Task { await model.refresh() } }.keyboardShortcut("r") } }
    }
}
enum Palette {
    static let ink = Color(red: 0.09, green: 0.15, blue: 0.23)
    static let blue = Color(red: 0.17, green: 0.40, blue: 0.68)
    static let muted = Color.secondary
    static let canvas = Color(nsColor: .windowBackgroundColor)
}
enum WorkspaceSection: String, CaseIterable, Identifiable {
    case conversation = "助理", tasks = "任务", questions = "待我处理", devices = "电脑", memories = "记忆", schedules = "定时关注", costs = "成本"
    var id: String { rawValue }
    var icon: String { switch self { case .conversation: "bubble.left.and.bubble.right"; case .tasks: "checklist"; case .questions: "hand.raised"; case .devices: "desktopcomputer"; case .memories: "books.vertical"; case .schedules: "clock.arrow.circlepath"; case .costs: "chart.bar.xaxis" } }
}
struct WorkspaceView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var section: WorkspaceSection? = .conversation
    var body: some View {
        Group {
            if model.session == nil { LoginView() }
            else {
                NavigationSplitView {
                    VStack(alignment: .leading, spacing: 18) {
                        VStack(alignment: .leading, spacing: 5) { Text("助理工作台").font(.title2.weight(.semibold)); Text(model.session?.user.name ?? "我的助理").font(.callout).foregroundStyle(.secondary) }.padding(.horizontal, 18).padding(.top, 20)
                        List(WorkspaceSection.allCases, selection: $section) { item in
                            HStack { Label(item.rawValue, systemImage: item.icon); Spacer(); if item == .questions && !model.questions.isEmpty { Text("\(model.questions.count)").font(.caption.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2).background(Palette.blue.opacity(0.12), in: Capsule()) } }.padding(.vertical, 5).tag(item)
                        }.listStyle(.sidebar)
                        VStack(alignment: .leading, spacing: 8) {
                            Label("\(model.devices.filter { $0.status != "offline" }.count) 台电脑在线", systemImage: "network").font(.caption)
                            if let time = model.lastSync { Text("同步于 \(time.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(.secondary) }
                            Button("退出登录") { Task { await model.signOut() } }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                            Button("开启系统提醒") { Task { await model.enableNotifications() } }.buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                            if let status = model.notificationStatus { Text(status).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                        }.padding(18)
                    }.navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
                } detail: {
                    VStack(spacing: 0) {
                        HStack { Text((section ?? .conversation).rawValue).font(.title2.weight(.semibold)); Spacer(); if model.busy { ProgressView().controlSize(.small) }; Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }.help("刷新") }.padding(.horizontal, 26).padding(.vertical, 20)
                        Divider()
                        if let error = model.error { HStack(alignment: .top) { Image(systemName: "exclamationmark.circle"); Text(error).textSelection(.enabled); Spacer(); Button { model.error = nil } label: { Image(systemName: "xmark") }.buttonStyle(.plain) }.font(.callout).foregroundStyle(.orange).padding(14).background(Color.orange.opacity(0.06)) }
                        Group { switch section ?? .conversation { case .conversation: ConversationView(); case .tasks: TasksView(); case .questions: QuestionsView(); case .devices: DevicesView(); case .memories: MemoriesView(); case .schedules: SchedulesView(); case .costs: CostsView() } }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }.background(Palette.canvas)
                }
            }
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
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 64, weight: .light)).foregroundStyle(Palette.blue)
                Text("工作继续，\n你随时掌握。").font(.system(size: 38, weight: .semibold, design: .rounded)).lineSpacing(5)
                Text("连接自己的电脑，交办任务、查看过程，\n让经验在每一次工作中积累。").font(.body).foregroundStyle(.secondary).lineSpacing(5)
            }.frame(width: 360, alignment: .leading)
            VStack(alignment: .leading, spacing: 18) {
                Text("连接你的助理").font(.title2.weight(.semibold))
                if model.authConfig?.mode == "development" {
                    Label("服务器已显式启用本地开发登录", systemImage: "hammer").font(.caption).foregroundStyle(.secondary)
                    TextField("邮箱", text: $email).textFieldStyle(.roundedBorder)
                    TextField("称呼（可选）", text: $name).textFieldStyle(.roundedBorder)
                } else { Text("使用系统浏览器完成安全登录。模型账号始终留在你的执行电脑上。").font(.callout).foregroundStyle(.secondary) }
                TextField("云端服务器，例如 https://agent.example.com", text: $model.server).textFieldStyle(.roundedBorder)
                Button("读取登录配置") { Task { await model.operation { try await model.configure() } } }.disabled(model.server.isEmpty || model.busy)
                Button { Task { await model.signIn(email: email, name: name) } } label: { HStack { if model.busy { ProgressView().controlSize(.small) }; Text(model.authConfig?.mode == "development" ? "登录开发环境" : "打开安全登录").frame(maxWidth: .infinity) } }.buttonStyle(.borderedProminent).controlSize(.large).disabled(model.busy || model.server.isEmpty || model.authConfig == nil || (model.authConfig?.mode == "development" && !email.contains("@")))
                if let error = model.error { Text(error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            }.frame(width: 340).padding(30).background(.background, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(.quaternary))
        }.padding(50).frame(maxWidth: .infinity, maxHeight: .infinity).background(Palette.canvas)
    }
}
struct ExecutionPicker: View {
    @EnvironmentObject var model: WorkspaceModel
    var body: some View {
        HStack(spacing: 14) {
            Picker("引擎", selection: $model.selectedEngine) { ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) } }.frame(width: 160)
            Picker("电脑", selection: $model.selectedDevice) { Text("选择执行电脑").tag(""); ForEach(model.devices) { device in Text("\(device.name)（\(AgentStatus.title(device.status))）").tag(device.id) } }.frame(maxWidth: 330)
            Picker("模型", selection: $model.selectedModelId) { Text("本机默认").tag(""); ForEach(model.devices.first(where: { $0.id == model.selectedDevice })?.capabilities.engines.first(where: { $0.engine == model.selectedEngine })?.models ?? [], id: \.self) { Text($0).tag($0) } }.frame(maxWidth: 230)
            if let device = model.devices.first(where: { $0.id == model.selectedDevice }), !device.supports(model.selectedEngine) { Label("此电脑尚未配置该引擎", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
        }.onChange(of: model.selectedEngine) { _, _ in model.selectedModelId = "" }.onChange(of: model.selectedDevice) { _, _ in model.selectedModelId = "" }
    }
}
struct ConversationView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var text = ""
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if model.messages.isEmpty { EmptyState(icon: "bubble.left.and.bubble.right", title: "从一件具体的工作开始", detail: "告诉助理目标，它会按授权范围自主推进。所有电脑离线时，消息会排队等待。") }
                        ForEach(model.messages) { message in
                            VStack(alignment: .leading, spacing: 7) { HStack { Text(message.role == "user" ? "你" : "助理").font(.callout.weight(.semibold)); Text(formatTime(message.createdAt)).font(.caption).foregroundStyle(.tertiary) }; Text(message.content).font(.body).lineSpacing(5).textSelection(.enabled) }.padding(18).frame(maxWidth: message.role == "user" ? 650 : .infinity, alignment: .leading).background(message.role == "user" ? Palette.blue.opacity(0.07) : Color.clear, in: RoundedRectangle(cornerRadius: 12)).id(message.id)
                        }
                    }.padding(28)
                }.onChange(of: model.messages.count) { _, _ in if let id = model.messages.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } } }
            }
            VStack(alignment: .leading, spacing: 12) {
                ExecutionPicker()
                TextEditor(text: $text).font(.body).frame(height: 80).padding(8).background(.background, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
                HStack { Text("模型请求从所选 Mac 直接发出").font(.caption).foregroundStyle(.secondary); Spacer(); Button("直接派活") { let value = text; Task { await model.createTask(value); if model.error == nil { text = "" } } }.disabled(model.selectedDevice.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy); Button("发送给助理") { let value = text; Task { await model.sendMessage(value); if model.error == nil { text = "" } } }.buttonStyle(.borderedProminent).disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.busy).keyboardShortcut(.return, modifiers: .command) }
            }.padding(22).background(.background)
        }
    }
}
struct EmptyState: View {
    let icon: String; let title: String; let detail: String
    var body: some View { VStack(spacing: 14) { Image(systemName: icon).font(.system(size: 36, weight: .light)).foregroundStyle(Palette.blue); Text(title).font(.title3.weight(.semibold)); Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 430) }.padding(40).frame(maxWidth: .infinity, minHeight: 240) }
}
struct StatusLabel: View {
    let value: String
    var color: Color { ["running", "online", "succeeded", "verified"].contains(value) ? .green : ["failed", "result_unknown"].contains(value) ? .orange : .secondary }
    var body: some View { Label(AgentStatus.title(value), systemImage: value == "running" ? "circle.dotted" : "circle.fill").font(.caption).foregroundStyle(color) }
}
func formatTime(_ value: String) -> String { let parser = ISO8601DateFormatter(); return parser.date(from: value)?.formatted(date: .abbreviated, time: .shortened) ?? String(value.prefix(16)) }
