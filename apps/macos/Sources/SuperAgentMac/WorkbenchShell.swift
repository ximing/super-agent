import SwiftUI
import SuperAgentCore

extension Notification.Name {
    static let newTaskRequested = Notification.Name("SuperAgent.newTaskRequested")
    static let searchRequested = Notification.Name("SuperAgent.searchRequested")
    static let inspectorRequested = Notification.Name("SuperAgent.inspectorRequested")
}

struct WorkspaceView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var section: WorkspaceSection?
    @State private var selectedTaskID: String?
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var showInspector = true
    @State private var newTask = false
    @State private var newMemory = false
    @State private var searchText = ""
    @FocusState private var searchFocused: Bool

    init(initialSection: WorkspaceSection = .conversation) {
        _section = State(initialValue: initialSection)
        _showInspector = State(initialValue: initialSection == .conversation)
    }

    private var currentSection: WorkspaceSection { section ?? .conversation }
    private var supportsInspector: Bool { currentSection == .conversation }
    private var supportsSearch: Bool { currentSection == .conversation || currentSection == .tasks }

    var body: some View {
        Group {
            if model.session == nil {
                LoginView()
            } else {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    WorkbenchSidebar(section: $section, selectedTaskID: $selectedTaskID)
                        .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 270)
                } detail: {
                    detail
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Palette.canvas)
                        .toolbar { workbenchToolbar }
                }
                .sheet(isPresented: $newTask) {
                    NewTaskSheet()
                }
                .sheet(isPresented: $newMemory) {
                    MemoryEditor(memory: nil)
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .newTaskRequested)) { _ in
            guard model.session != nil else { return }
            if currentSection == .memories { newMemory = model.memorySettings?.configured == true }
            else { newTask = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .searchRequested)) { _ in
            if supportsSearch {
                searchFocused = true
            } else if currentSection != .memories {
                section = .tasks
                DispatchQueue.main.async { searchFocused = true }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .inspectorRequested)) { _ in
            guard supportsInspector else { return }
            showInspector.toggle()
        }
        .onChange(of: currentSection) { _, newValue in
            searchText = ""
            searchFocused = false
            showInspector = newValue == .conversation
        }
        .onChange(of: model.tasks.map(\.id)) { _, _ in ensureTaskSelection() }
        .onAppear { ensureTaskSelection() }
    }

    @ViewBuilder private var detail: some View {
        VStack(spacing: 0) {
            if let error = model.error {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button { model.error = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.plain)
                        .accessibilityLabel("关闭错误提示")
                }
                .font(.callout)
                .foregroundStyle(.orange)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.orange.opacity(0.06))
                Divider()
            }

            if supportsInspector {
                HSplitView {
                    currentPage
                        .frame(minWidth: 390, idealWidth: 740, maxWidth: .infinity, maxHeight: .infinity)
                    if showInspector {
                        TaskContextInspector(selectedTaskID: $selectedTaskID) {
                            section = .tasks
                        }
                        .frame(minWidth: 250, idealWidth: 282, maxWidth: 310, maxHeight: .infinity)
                    }
                }
            } else {
                currentPage
            }
        }
    }

    @ViewBuilder private var currentPage: some View {
        switch currentSection {
        case .conversation:
            AssistantWorkspaceView(searchText: searchText, selectedTaskID: $selectedTaskID)
        case .tasks:
            TasksView(selectedTaskID: $selectedTaskID, searchText: searchText, initialReviewTaskID: DemoLaunch.current.reviewTaskID)
        case .questions:
            QuestionsView()
        case .devices:
            DevicesView()
        case .memories:
            MemoriesView()
        case .schedules:
            SchedulesView()
        case .costs:
            CostsView()
        }
    }

    @ToolbarContentBuilder private var workbenchToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            VStack(alignment: .leading, spacing: 1) {
                Text(currentSection.rawValue).font(.headline)
                Text(toolbarContext).font(.caption2).foregroundStyle(.secondary)
            }
            .padding(.leading, 2)
        }
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                if currentSection == .memories { newMemory = true }
                else { newTask = true }
            } label: { Image(systemName: "plus") }
                .help(currentSection == .memories ? "添加记忆（⌘N）" : "新建任务（⌘N）")
                .accessibilityLabel(currentSection == .memories ? "添加记忆" : "新建任务")
                .disabled(currentSection == .memories && model.memorySettings?.configured != true)
            Button { Task { await model.refresh() } } label: {
                if model.busy { ProgressView().controlSize(.small) } else { Image(systemName: "arrow.clockwise") }
            }
            .help("刷新工作台（⌘R）")
            .accessibilityLabel("刷新工作台")
            .disabled(model.busy)
            if supportsSearch {
                TextField("搜索", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 180)
                    .focused($searchFocused)
                    .accessibilityLabel("搜索当前工作区")
            }
            if supportsInspector {
                Button { showInspector.toggle() } label: { Image(systemName: "sidebar.trailing") }
                    .help("显示或隐藏检查器（⌘⌥0）")
                    .accessibilityLabel("显示或隐藏检查器")
                    .foregroundStyle(showInspector ? Palette.accent : .secondary)
            }
        }
    }

    private var toolbarContext: String {
        switch currentSection {
        case .conversation:
            if let id = model.settings?.assistantDeviceId, let device = model.devices.first(where: { $0.id == id }) {
                return "\(device.name) 上的主助理"
            }
            return "主助理对话"
        case .tasks: return "\(model.tasks.count) 项已加载工作"
        case .questions:
            let count = model.questions.count + model.tasks.filter { $0.status == "awaiting_review" }.count
            return count == 0 ? "没有待处理事项" : "\(count) 项待处理"
        case .devices: return "\(model.devices.filter { $0.status != "offline" && $0.revoked != true }.count) 台电脑在线"
        case .memories:
            if model.memorySettings?.configured != true { return "尚未连接记忆库" }
            let candidates = model.memories.filter { ($0.governance?.verification ?? $0.status) == "candidate" }.count
            return "已加载 \(model.memories.count) 条，\(candidates) 条待审核"
        case .schedules: return "提醒并准备目标，确认后执行"
        case .costs: return "用量与费用来源"
        }
    }

    private func ensureTaskSelection() {
        guard !model.tasks.isEmpty else { selectedTaskID = nil; return }
        if let selectedTaskID, model.tasks.contains(where: { $0.id == selectedTaskID }) { return }
        if model.isDemo {
            selectedTaskID = model.tasks.first(where: { $0.status == "running" })?.id ?? model.tasks[0].id
        } else {
            selectedTaskID = model.tasks.first(where: { $0.status == "awaiting_review" })?.id ?? model.tasks[0].id
        }
    }
}

private struct WorkbenchSidebar: View {
    @EnvironmentObject var model: WorkspaceModel
    @Binding var section: WorkspaceSection?
    @Binding var selectedTaskID: String?
    @State private var showSettings = false

    private var accountName: String { model.session?.user.name ?? "账户" }
    private var accountInitial: String { String(accountName.prefix(1)) }

    private var pendingCount: Int {
        model.questions.count + model.tasks.filter { $0.status == "awaiting_review" }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "sparkles").foregroundStyle(Palette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Super Agent").font(.headline)
                    Text("\(model.session?.user.name ?? "我的")的工作空间").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 16)

            Text("工作空间")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.bottom, 3)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(spacing: 2) {
                ForEach(WorkspaceSection.allCases) { item in
                    Button { section = item } label: {
                        HStack(spacing: 8) {
                            Label(item.rawValue, systemImage: item.icon)
                            Spacer(minLength: 0)
                            if item == .questions && pendingCount > 0 {
                                Text("\(pendingCount)").font(.caption).foregroundStyle(section == item ? Color.white.opacity(0.85) : .secondary)
                            }
                        }
                        .font(.callout)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(section == item ? Color.white : Color.primary)
                        .background(section == item ? Palette.accent : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(item.rawValue)
                }
            }
            .padding(.horizontal, 8)

            Text("最近任务")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 18)
                .padding(.top, 8)
                .padding(.bottom, 3)
                .frame(maxWidth: .infinity, alignment: .leading)

            if model.tasks.isEmpty {
                Text("暂无已加载任务")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(spacing: 2) {
                    ForEach(model.tasks.prefix(5)) { task in
                        let selected = section == .tasks && selectedTaskID == task.id
                        Button {
                            selectedTaskID = task.id
                            section = .tasks
                        } label: {
                            HStack(spacing: 8) {
                                Circle().fill(statusColor(task.status)).frame(width: 5, height: 5)
                                Text(task.title).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .font(.callout)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundStyle(selected ? Color.white : Color.primary)
                            .background(selected ? Palette.accent : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 8)
            }

            Spacer(minLength: 0)
            Divider()
            VStack(spacing: 0) {
                Button { section = .devices } label: {
                    HStack(spacing: 7) {
                        Circle()
                            .fill(model.devices.contains { $0.status != "offline" && $0.revoked != true } ? Color(red: 0.35, green: 0.59, blue: 0.50) : Color.secondary)
                            .frame(width: 6, height: 6)
                        Text("\(model.devices.filter { $0.status != "offline" && $0.revoked != true }.count) 台电脑在线")
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9))
                            .foregroundStyle(.secondary)
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(.primary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.top, 11)
                .padding(.bottom, 12)

                HStack(spacing: 7) {
                    Text(accountInitial)
                        .font(.system(size: 10))
                        .frame(width: 22, height: 22)
                        .background(Color(nsColor: NSColor(name: nil) { appearance in
                            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                                ? NSColor(calibratedRed: 0.30, green: 0.28, blue: 0.34, alpha: 1)
                                : NSColor(calibratedRed: 0.85, green: 0.83, blue: 0.87, alpha: 1)
                        }), in: Circle())
                    Text(accountName).lineLimit(1)
                    Spacer()
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .frame(width: 26, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("设置")
                    .accessibilityLabel("工作台设置")
                }
                .font(.system(size: 11))
                .padding(.horizontal, 16)
                .padding(.bottom, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .sheet(isPresented: $showSettings) { WorkspaceSettingsSheet() }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "succeeded": .green
        case "running", "starting": Palette.accent
        case "awaiting_review", "waiting_input", "result_unknown": .orange
        case "failed": .red
        default: .secondary
        }
    }
}
