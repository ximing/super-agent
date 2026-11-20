import SwiftUI
import SuperAgentCore

private enum TaskListFilter: String, CaseIterable {
    case all, active, review

    var title: String {
        switch self {
        case .all: "全部"
        case .active: "活跃"
        case .review: "待验收"
        }
    }
}

private struct TaskListGroup: Identifiable {
    let id: String
    let title: String
    let entries: [TaskTreeEntry]
}

struct TasksView: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.controlActiveState) private var controlActiveState
    @FocusState private var taskListFocused: Bool
    @Binding var selectedTaskID: String?
    let searchText: String
    let initialReviewTaskID: String?
    @State private var filter = TaskListFilter.all
    @State private var reviewTaskID: String?
    @State private var didOpenInitialReview = false

    init(selectedTaskID: Binding<String?>, searchText: String, initialReviewTaskID: String? = nil) {
        self._selectedTaskID = selectedTaskID
        self.searchText = searchText
        self.initialReviewTaskID = initialReviewTaskID
    }

    private var groups: [TaskListGroup] {
        TaskGraph.groups(model.tasks).compactMap { group in
            let entries = group.entries.filter { matches($0.task) }
            return entries.isEmpty ? nil : TaskListGroup(id: group.id, title: group.title, entries: entries)
        }
    }

    private var visibleTaskIDs: [String] { groups.flatMap { $0.entries.map { $0.task.id } } }

    var body: some View {
        HSplitView {
            VStack(spacing: 0) {
                VStack(spacing: 10) {
                    Picker("筛选任务", selection: $filter) {
                        ForEach(TaskListFilter.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .accessibilityLabel("筛选任务")
                    HStack {
                        Text("\(visibleTaskIDs.count) 项任务")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            Text("已按搜索过滤")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                Divider()
                List(selection: $selectedTaskID) {
                    ForEach(groups) { group in
                        Section {
                            ForEach(group.entries) { entry in
                                TaskListRow(
                                    entry: entry,
                                    device: model.devices.first { $0.id == entry.task.deviceId },
                                    isSelected: selectedTaskID == entry.task.id && taskListFocused && controlActiveState == .key
                                )
                                .tag(entry.task.id)
                            }
                        } header: {
                            Text(group.title)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.inset)
                .focused($taskListFocused)
                .scrollContentBackground(.hidden)
                .background(Palette.canvas)
                .accessibilityLabel("任务列表")
            }
            .frame(minWidth: 235, idealWidth: 270, maxWidth: 310)

            Group {
                if let task = model.tasks.first(where: { $0.id == selectedTaskID }) {
                    TaskDetailView(
                        task: task,
                        onSelectTask: { selectedTaskID = $0 },
                        onReview: { reviewTaskID = $0 }
                    )
                    .id(task.id)
                } else if model.tasks.isEmpty {
                    EmptyState(icon: "checklist", title: "从一项具体工作开始", detail: "新建任务，明确目标、交付物和执行电脑。")
                } else {
                    EmptyState(icon: "magnifyingglass", title: "没有匹配的任务", detail: "调整筛选条件或搜索文字，查看其他已加载任务。")
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Palette.canvas)
        .sheet(isPresented: Binding(
            get: { reviewTaskID != nil },
            set: { if !$0 { reviewTaskID = nil } }
        )) {
            if let reviewTaskID {
                DeliveryReviewView(taskId: reviewTaskID)
            }
        }
        .onAppear(perform: handleTaskChanges)
        .onChange(of: searchText) { _, _ in reconcileSelection() }
        .onChange(of: filter) { _, _ in reconcileSelection() }
        .onChange(of: model.tasks.map(\.id)) { _, _ in handleTaskChanges() }
    }

    private func matches(_ task: AgentTask) -> Bool {
        switch filter {
        case .all:
            break
        case .active:
            if ["awaiting_review", "succeeded", "failed", "cancelled"].contains(task.status) { return false }
        case .review:
            if task.status != "awaiting_review" { return false }
        }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        let device = task.deviceName ?? model.devices.first(where: { $0.id == task.deviceId })?.name ?? ""
        return [task.title, task.goal, device, task.engine.rawValue]
            .joined(separator: "\n")
            .localizedCaseInsensitiveContains(query)
    }

    private func handleTaskChanges() {
        if !didOpenInitialReview,
           let initialReviewTaskID,
           model.tasks.contains(where: { $0.id == initialReviewTaskID }) {
            selectedTaskID = initialReviewTaskID
            reviewTaskID = initialReviewTaskID
            didOpenInitialReview = true
            return
        }
        reconcileSelection()
    }

    private func reconcileSelection() {
        if let selectedTaskID, visibleTaskIDs.contains(selectedTaskID) { return }
        selectedTaskID = visibleTaskIDs.first
    }
}

private struct TaskListRow: View {
    let entry: TaskTreeEntry
    let device: Device?
    let isSelected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: taskIcon(entry.task))
                .font(.callout)
                .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.task.title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(isSelected ? Color.white : Color.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(entry.task.goal)
                    .font(.caption)
                    .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    TaskStateLabel(task: entry.task, device: device, isSelected: isSelected)
                    Spacer(minLength: 4)
                    Text(compactTaskTime(entry.task.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(isSelected ? Color.white.opacity(0.8) : Color.secondary)
                        .lineLimit(1)
                        .help(formatTime(entry.task.updatedAt))
                }
                if let scopeLine = TaskGraph.planItemScopeLine(entry.task.memoryScope) {
                    Text(scopeLine)
                        .font(.caption2)
                        .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if entry.parentUnavailable {
                    Text("上级不在已加载范围")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                }
                if entry.relationUncertain {
                    Text("更深层级待核对")
                        .font(.caption2)
                        .foregroundStyle(isSelected ? Color.white.opacity(0.85) : Color.secondary)
                }
            }
        }
        .padding(.vertical, 8)
        .padding(.leading, CGFloat(entry.depth * 12))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private func compactTaskTime(_ value: String) -> String {
    let parser = ISO8601DateFormatter()
    let date: Date?
    if let parsed = parser.date(from: value) {
        date = parsed
    } else {
        parser.formatOptions.insert(.withFractionalSeconds)
        date = parser.date(from: value)
    }
    guard let date else { return String(value.prefix(10)) }
    if Calendar.current.isDateInToday(date) {
        return date.formatted(date: .omitted, time: .shortened)
    }
    if Calendar.current.isDateInYesterday(date) { return "昨天" }
    return date.formatted(.dateTime.month().day())
}

private func taskIcon(_ task: AgentTask) -> String {
    switch task.status {
    case "awaiting_review": "checkmark.seal"
    case "succeeded": "checkmark.circle"
    case "failed", "result_unknown": "exclamationmark.circle"
    case "waiting_input": "bubble.left.and.bubble.right"
    case "blocked", "queued", "waiting_device": "clock"
    default: "doc.text"
    }
}

struct TaskStateLabel: View {
    let task: AgentTask
    var device: Device? = nil
    var isSelected = false

    private var key: String {
        if task.reasonCode == "result_unknown" || task.status == "result_unknown" { return "result_unknown" }
        if task.status == "awaiting_review" { return "awaiting_review" }
        if task.status == "succeeded" { return "succeeded" }
        if task.status == "failed" { return "failed" }
        if device?.status == "offline", ["queued", "waiting_device", "dispatched", "starting", "running"].contains(task.status) {
            return "offline"
        }
        return task.status
    }

    private var title: String {
        if key == "succeeded", task.deliveryStatus == "accepted" { return "已验收" }
        if key == "offline" { return "电脑离线" }
        return AgentStatus.title(key)
    }

    private var icon: String {
        switch key {
        case "running": "circle.dotted"
        case "awaiting_review", "succeeded": "checkmark.circle"
        case "result_unknown": "questionmark.circle"
        case "failed": "exclamationmark.circle"
        case "offline": "desktopcomputer"
        case "queued", "waiting_device", "blocked": "clock"
        case "paused": "pause.circle"
        default: "circle.fill"
        }
    }

    private var color: Color {
        switch key {
        case "running", "dispatched", "starting": Palette.blue
        case "awaiting_review", "result_unknown", "offline": .orange
        case "failed": .red
        case "succeeded": .green
        default: .secondary
        }
    }

    var body: some View {
        Label(title, systemImage: icon)
            .font(.caption)
            .foregroundStyle(isSelected ? Color.white : color)
            .accessibilityLabel("任务状态：\(title)")
    }
}

private enum TaskDetailSection: String, CaseIterable {
    case overview, process, delivery

    var title: String {
        switch self {
        case .overview: "概览"
        case .process: "执行过程"
        case .delivery: "交付物"
        }
    }
}

struct TaskDetailView: View {
    @EnvironmentObject var model: WorkspaceModel
    let task: AgentTask
    let onSelectTask: (String) -> Void
    let onReview: (String) -> Void
    @State private var section = TaskDetailSection.overview
    @State private var runs: [Run] = []
    @State private var messages: [Message] = []
    @State private var switching = false
    @State private var targetEngine: Engine = .codex
    @State private var targetDevice = ""
    @State private var reconciling = false
    @State private var outcome = "unknown"
    @State private var reconciliationNote = ""
    @State private var allowance = ""

    private var draft: Binding<String> { model.taskDraftBinding(for: task.id) }
    private var device: Device? { model.devices.first { $0.id == task.deviceId } }
    private var currentRun: Run? { runs.first { $0.id == task.currentRunId } ?? runs.first }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            HStack {
                Picker("任务详情", selection: $section) {
                    ForEach(TaskDetailSection.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 250)
                .accessibilityLabel("任务详情")
                Spacer()
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 11)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    switch section {
                    case .overview: overview
                    case .process: process
                    case .delivery: delivery
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            composer
        }
        .background(.background)
        .task(id: model.lastSync) { await load() }
        .sheet(isPresented: $switching) { switchSheet }
        .sheet(isPresented: $reconciling) { reconciliationSheet }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 16) {
                Text(task.title)
                    .font(.title2.weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                if task.status == "awaiting_review" {
                    Button("核对交付") { onReview(task.id) }
                        .buttonStyle(.borderedProminent)
                } else if task.status == "paused" {
                    Button("继续") { act("resume") }
                        .buttonStyle(.borderedProminent)
                } else if ["running", "waiting_input"].contains(task.status) {
                    Button("暂停") { act("pause") }
                } else if task.reasonCode == "result_unknown" || task.status == "result_unknown" {
                    Button("核对业务结果") { reconciling = true }
                        .buttonStyle(.borderedProminent)
                }
                taskMenu
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) {
                    TaskStateLabel(task: task, device: device)
                    deviceLabel
                    engineLabel
                    if let modelId = task.modelId, !modelId.isEmpty {
                        Text(modelId)
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 14) {
                        TaskStateLabel(task: task, device: device)
                        engineLabel
                    }
                    HStack(spacing: 10) {
                        deviceLabel
                        if let modelId = task.modelId, !modelId.isEmpty {
                            Text(modelId)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .help(modelId)
                        }
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private var deviceLabel: some View {
        let name = device?.name ?? task.deviceName ?? "等待设备"
        return Label(name, systemImage: "desktopcomputer")
            .lineLimit(1)
            .truncationMode(.middle)
            .help(name)
    }

    private var engineLabel: some View {
        Label(task.engine.rawValue.capitalized, systemImage: "sparkles")
            .fixedSize()
    }

    private var taskMenu: some View {
        Menu {
            Button("暂停") { act("pause") }
            Button("继续") { act("resume") }
            Button("切换引擎或电脑") {
                targetEngine = task.engine
                targetDevice = task.deviceId ?? ""
                switching = true
            }
            Button("重试") { act("retry") }
            Button("核对业务结果") { reconciling = true }
            Divider()
            Button("取消任务", role: .destructive) { act("cancel") }
        } label: {
            Label("任务操作", systemImage: "ellipsis.circle")
                .labelStyle(.iconOnly)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help("任务操作")
        .accessibilityLabel("任务操作")
    }

    @ViewBuilder
    private var overview: some View {
        detailSection("工作目标") {
            Text(task.goal)
                .font(.body)
                .lineSpacing(5)
                .textSelection(.enabled)
            if let deliverables = task.deliverables, !deliverables.isEmpty {
                VStack(alignment: .leading, spacing: 7) {
                    Text("交付标准")
                        .font(.callout.weight(.medium))
                    ForEach(deliverables, id: \.self) { criterion in
                        Label(criterion, systemImage: "circle")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .padding(.top, 4)
            }
        }
        detailSection("当前状态") {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: statusExplanationIcon)
                    .foregroundStyle(Palette.blue)
                VStack(alignment: .leading, spacing: 6) {
                    if let notice = model.controlNotices[task.id] {
                        Text(notice)
                            .font(.callout.weight(.medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    let stage = model.stagePresentation(for: task)
                    Text(stage.emphasize ? stage.detail : stage.title)
                        .font(.caption)
                        .foregroundStyle(stage.emphasize ? .primary : .secondary)
                    if let count = stage.countText { Text(count).font(.caption2).foregroundStyle(.secondary) }
                    if stage.showCheck {
                        Button("检查进展") { Task { await model.checkTask(task.id) } }
                            .controlSize(.small)
                    }
                    Text(statusExplanation)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    if let summary = currentRun?.summary, !summary.isEmpty {
                        Text(summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
            if let reason = task.reasonCode {
                Label(reason, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let scope = task.memoryScope {
                Text(memoryScopeLine(scope))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            limitRecovery
            if task.status == "awaiting_review" {
                Button("逐条核对交付") { onReview(task.id) }
                    .buttonStyle(.borderedProminent)
            }
        }
        let questions = model.questions.filter { $0.taskId == task.id }
        if !questions.isEmpty {
            detailSection("需要你处理") {
                ForEach(questions) { QuestionRow(question: $0) }
            }
        }
        TaskRelationsView(task: task, onSelect: onSelectTask)
    }

    @ViewBuilder
    private var process: some View {
        detailSection("运行记录") {
            if runs.isEmpty {
                Text(task.status == "queued" ? "任务正在排队，尚未开始执行。" : "尚未读取到运行记录。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(runs) { run in
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label(run.engine.rawValue.capitalized, systemImage: "circle.dotted")
                            .font(.callout.weight(.medium))
                        StatusLabel(value: run.state)
                        Spacer()
                        Text(formatTime(run.createdAt))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if !run.summary.isEmpty {
                        Text(run.summary)
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                    if let result = run.resultText, !result.isEmpty {
                        Text(result)
                            .font(.callout)
                            .lineSpacing(4)
                            .textSelection(.enabled)
                    }
                    ToolTimelineView(runId: run.id, state: run.state)
                }
                .padding(.vertical, 6)
                if run.id != runs.last?.id { Divider() }
            }
        }
        if task.currentRunId != nil {
            detailSection("浏览器") {
                if let runId = task.currentRunId { BrowserFrameView(runId: runId) }
            }
        }
        detailSection("任务消息") {
            if messages.isEmpty {
                Text("尚无补充要求或任务消息。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(messages) { message in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(message.role == "user" ? "你" : "助理")
                            .font(.caption.weight(.semibold))
                        Text(formatTime(message.createdAt))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(message.content)
                        .font(.callout)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private var delivery: some View {
        if task.status == "awaiting_review" {
            HStack(alignment: .center, spacing: 14) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("执行已结束，等待验收")
                        .font(.callout.weight(.medium))
                    Text("逐条核对标准和证据；通过后任务才会标记为已验收。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("核对交付") { onReview(task.id) }
                    .buttonStyle(.borderedProminent)
            }
            Divider()
        } else if task.status == "succeeded", task.deliveryStatus == "accepted" {
            Label("交付已验收，任务完成。", systemImage: "checkmark.circle.fill")
                .font(.callout)
                .foregroundStyle(.green)
        }
        if let result = currentRun?.resultText, !result.isEmpty {
            detailSection("执行结果") {
                Text(result)
                    .font(.callout)
                    .lineSpacing(5)
                    .textSelection(.enabled)
            }
        }
        TaskArtifactsView(taskId: task.id)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topLeading) {
                TextEditor(text: draft)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 3)
                    .accessibilityLabel("补充此任务的要求")
                if draft.wrappedValue.isEmpty {
                    Text("补充此任务的要求、说明或约束")
                        .font(.body)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 11)
                        .allowsHitTesting(false)
                }
            }
            .frame(height: 112)
            HStack(spacing: 10) {
                Text("Return 换行 · ⌘Return 发送")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("发送") { sendInput() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("发送补充要求")
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 9)
        .padding(.bottom, 7)
        .background(.background, in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.accentColor.opacity(0.45), lineWidth: 1))
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .background(.background)
    }

    private var switchSheet: some View {
        Form {
            Section {
                Text("切换执行方式")
                    .font(.title2.weight(.semibold))
                Text("先停止当前执行并保存检查点，再由新的 Worker 接续。尚未确认结果的提交会先核对。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("新的执行方式") {
                Picker("引擎", selection: $targetEngine) {
                    ForEach(Engine.allCases, id: \.self) { Text($0.rawValue.capitalized).tag($0) }
                }
                Picker("电脑", selection: $targetDevice) {
                    Text("选择电脑").tag("")
                    ForEach(model.devices.filter { $0.revoked != true }) {
                        Text("\($0.name)（\(AgentStatus.title($0.status))）").tag($0.id)
                    }
                }
            }
            Section {
                HStack {
                    Button("取消", role: .cancel) { switching = false }
                        .keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("切换并继续") {
                        switching = false
                        Task { await model.action("switch", task: task, targetEngine: targetEngine, targetDevice: targetDevice) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(targetDevice.isEmpty)
                }
            }
        }
        .formStyle(.grouped)
        .padding(20)
        .frame(width: 520)
    }

    private var reconciliationSheet: some View {
        Form {
            Section {
                Text("核对业务结果")
                    .font(.title2.weight(.semibold))
                Text("先在目标系统核对实际回执。只有明确未生效的操作才适合重试，避免重复提交。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Section("核对结论") {
                Picker("核对结论", selection: $outcome) {
                    Text("仍不确定").tag("unknown")
                    Text("确认已生效").tag("applied")
                    Text("确认未生效").tag("not_applied")
                }
                TextField("记录核对对象、回执或判断依据", text: $reconciliationNote, axis: .vertical)
                    .lineLimit(4...8)
            }
            if let error = model.error {
                Text(error).font(.callout).foregroundStyle(.orange)
            }
            Section {
                HStack {
                    Button("返回", role: .cancel) { reconciling = false }
                        .keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("提交核对") {
                        let note = reconciliationNote
                        let picked = outcome
                        Task {
                            await model.runLane("task:\(task.id):reconcile", action: "reconcile") {
                                do {
                                    let _: JSONValue = try await model.api.request(
                                        "/tasks/\(task.id)/reconciliation",
                                        method: "POST",
                                        body: ["outcome": .string(picked), "note": .string(note)],
                                        version: task.version
                                    )
                                    reconciling = false
                                    Task { await model.refresh() }
                                } catch { model.error = error.localizedDescription }
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(reconciliationNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy("task:\(task.id):reconcile"))
                }
            }
        }
        .formStyle(.grouped)
        .padding(20)
        .frame(width: 560)
    }

    @ViewBuilder
    private var limitRecovery: some View {
        if let reason = task.reasonCode, let spec = BudgetLimitSpec(reasonCode: reason) {
            VStack(alignment: .leading, spacing: 8) {
                Text(spec.recovery)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Text(spec.currentText(task.budget))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextField(spec.placeholder, text: $allowance)
                    .textFieldStyle(.roundedBorder)
                Button("提高上限并重试") {
                    let raw = allowance
                    Task {
                        await model.raiseLimitAndRetry(task: task, reason: reason, raw: raw)
                        if model.error == nil { allowance = "" }
                    }
                }
                .disabled(allowance.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy("task:\(task.id):control"))
            }
            .padding(.top, 4)
        }
    }

    private var statusExplanation: String {
        if currentRun?.state == "dispatched" || model.stagePresentation(for: task).title == "等待电脑接受" {
            return "等待电脑接受，尚未开始执行。"
        }
        if task.reasonCode == "result_unknown" || task.status == "result_unknown" {
            return "执行结果尚未确认。请先核对业务结果，再决定是否重试，避免重复操作。"
        }
        if device?.status == "offline", ["queued", "waiting_device", "dispatched", "starting", "running"].contains(task.status) {
            return "指定电脑当前离线。任务会保留，等待电脑恢复连接或切换执行电脑。"
        }
        switch task.status {
        case "awaiting_review": return "执行已结束，交付等待核对。验收通过前，任务不会标记为完成。"
        case "succeeded" where task.deliveryStatus == "accepted": return "交付已验收，任务完成。"
        case "succeeded": return "执行已成功结束。"
        case "failed": return "本次执行失败。查看运行记录后可重试或调整执行方式。"
        case "queued": return "任务已排队，等待指定电脑开始执行。"
        case "paused": return "任务已暂停，继续后会从保存的检查点接续。"
        case "blocked": return "任务等待前置条件完成；执行依赖不代表父子层级。"
        case "waiting_input": return "助理需要你回答问题后才会继续。"
        default: return currentRun?.summary.isEmpty == false ? "执行正在进行。" : "任务已加载，等待最新进展。"
        }
    }

    private var statusExplanationIcon: String {
        if task.reasonCode == "result_unknown" { return "questionmark.circle" }
        switch task.status {
        case "awaiting_review", "succeeded": return "checkmark.circle"
        case "failed": return "exclamationmark.circle"
        case "paused": return "pause.circle"
        case "queued", "blocked", "waiting_device": return "clock"
        default: return "circle.dotted"
        }
    }

    @ViewBuilder
    private func detailSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func act(_ value: String) {
        Task { await model.action(value, task: task) }
    }

    private func sendInput() {
        let value = draft.wrappedValue
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        Task {
            await model.runLane("task:\(task.id):input", action: "input") {
                do {
                    let _: JSONValue = try await model.api.request("/tasks/\(task.id)/inputs", method: "POST", body: ["text": .string(value)])
                    model.taskDraftBinding(for: task.id).wrappedValue = ""
                    await load()
                } catch { model.error = error.localizedDescription }
            }
        }
    }

    private func load() async {
        if model.isDemo {
            runs = model.demoRuns.filter { $0.taskId == task.id }
            messages = model.demoTaskMessages.filter { $0.taskId == task.id }
            return
        }
        do {
            let result: Items<Run> = try await model.api.request("/tasks/\(task.id)/runs")
            runs = result.items
            let list: Items<Message> = try await model.api.request("/messages?task_id=\(task.id)")
            messages = list.items
        } catch {
            model.error = error.localizedDescription
        }
    }
}

struct NewTaskSheet: View {
    @EnvironmentObject var model: WorkspaceModel
    @Environment(\.dismiss) private var dismiss
    @State private var goal = ""
    @State private var memoryScope = MemoryScopeDraft()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("交办一项工作")
                    .font(.title2.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text("描述目标、交付物和需要注意的事。明确范围内，助理会在所选 Mac 上执行。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 18)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("工作目标")
                        .font(.headline)
                    TextField("例如：整理本周产品动态，产出附有原始来源的周会简报", text: $goal, axis: .vertical)
                        .lineLimit(6...12)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("工作目标")
                    Text("执行方式")
                        .font(.headline)
                    ExecutionPicker()
                    Text("记忆范围")
                        .font(.headline)
                    MemoryScopeEditor(draft: $memoryScope)
                    if let error = model.error {
                        Text(error)
                            .font(.callout)
                            .foregroundStyle(.orange)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(28)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            HStack {
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("创建任务") { create() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.selectedDevice.isEmpty || model.isBusy("task:create"))
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 16)
        }
        .frame(width: 640, height: 520)
    }

    private func create() {
        let value = goal
        Task {
            await model.createTask(value, scope: memoryScope)
            if model.error == nil {
                goal = ""
                dismiss()
            }
        }
    }
}

struct MemoryScopeEditor: View {
    @Binding var draft: MemoryScopeDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("项目（可选）", text: $draft.project)
                .textFieldStyle(.roundedBorder)
            TextField("网站，用逗号或空格分隔", text: $draft.sites)
                .textFieldStyle(.roundedBorder)
            Toggle("读取不限定网站的全局偏好", isOn: $draft.globalPreference)
                .font(.caption)
            TextField("状态，默认 verified", text: $draft.statuses)
                .textFieldStyle(.roundedBorder)
            TextField("最大记忆版本（可选）", text: $draft.maxVersion)
                .textFieldStyle(.roundedBorder)
            Text("网站留空会提交空列表，不是全部记忆。关闭全局偏好会提交 false。默认只使用已验证记忆。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private func memoryScopeLine(_ scope: MemoryScope) -> String {
    let project = scope.project?.isEmpty == false ? scope.project! : "未指定"
    let sites = scope.sites?.isEmpty == false ? scope.sites!.joined(separator: "、") : "无"
    let global = scope.globalPreference == true ? "开" : "关"
    let statuses = scope.statuses?.isEmpty == false ? scope.statuses!.joined(separator: "、") : "verified"
    let maxVersion = scope.maxVersion.map(String.init) ?? "不限"
    return "记忆范围：项目 \(project) · 网站 \(sites) · 全局偏好 \(global) · 状态 \(statuses) · 最大版本 \(maxVersion)"
}

struct QuestionsView: View {
    @EnvironmentObject var model: WorkspaceModel
    @State private var reviewTaskID: String?

    private var awaitingReview: [AgentTask] {
        model.tasks.filter { $0.status == "awaiting_review" }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.questions.isEmpty && awaitingReview.isEmpty {
                    EmptyState(icon: "checkmark.circle", title: "暂时没有需要你处理的事", detail: "需要你的判断或有新交付等待核对时，会在这里提醒你。")
                }
                if !awaitingReview.isEmpty {
                    Label("待验收", systemImage: "checkmark.seal")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text("执行已结束，逐条核对交付通过后才会完成任务。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    VStack(spacing: 0) {
                        ForEach(awaitingReview) { task in
                            HStack(alignment: .center, spacing: 14) {
                                Image(systemName: "doc.text")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(task.title)
                                        .font(.callout.weight(.medium))
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                    TaskStateLabel(task: task)
                                }
                                Spacer(minLength: 12)
                                Button("核对交付") { reviewTaskID = task.id }
                                    .controlSize(.small)
                            }
                            .padding(.vertical, 12)
                            if task.id != awaitingReview.last?.id { Divider() }
                        }
                    }
                    if !model.questions.isEmpty { Divider() }
                }
                ForEach(model.questions) { question in
                    QuestionRow(question: question)
                    if question.id != model.questions.last?.id { Divider() }
                }
            }
            .padding(28)
            .frame(maxWidth: 820, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: Binding(
            get: { reviewTaskID != nil },
            set: { if !$0 { reviewTaskID = nil } }
        )) {
            if let reviewTaskID {
                DeliveryReviewView(taskId: reviewTaskID)
            }
        }
    }
}

struct QuestionRow: View {
    @EnvironmentObject var model: WorkspaceModel
    let question: Question
    @State private var answer = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("需要你的判断", systemImage: "hand.raised")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Palette.blue)
            Text(question.text)
                .font(.body)
                .textSelection(.enabled)
            if !question.options.isEmpty {
                HStack {
                    ForEach(question.options, id: \.self) { option in
                        Button(option) { Task { await model.answer(question, text: option) } }
                            .disabled(model.isBusy("question:\(question.id)"))
                    }
                }
            }
            HStack {
                TextField("补充回答", text: $answer)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("补充回答")
                Button("回答") {
                    let value = answer
                    Task {
                        await model.answer(question, text: value)
                        if model.error == nil { answer = "" }
                    }
                }
                .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy("question:\(question.id)"))
            }
        }
        .padding(.vertical, 8)
    }
}
