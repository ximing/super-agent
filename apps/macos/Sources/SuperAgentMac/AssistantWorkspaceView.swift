import SwiftUI
import SuperAgentCore

struct AssistantWorkspaceView: View {
    @EnvironmentObject private var model: WorkspaceModel
    let searchText: String
    @Binding var selectedTaskID: String?
    @State private var sending = false
    @State private var dispatching = false
    @State private var memoryScope = MemoryScopeDraft()

    init(searchText: String, selectedTaskID: Binding<String?>) {
        self.searchText = searchText
        self._selectedTaskID = selectedTaskID
    }

    private var filteredMessages: [Message] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return model.messages }
        return model.messages.filter { $0.content.localizedCaseInsensitiveContains(query) }
    }

    private var selectedTask: AgentTask? {
        model.tasks.first { $0.id == selectedTaskID }
    }

    private var draftIsEmpty: Bool {
        model.assistantDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var submitting: Bool { sending || dispatching }

    private var selectedDevice: Device? {
        model.devices.first { $0.id == model.selectedDevice }
    }

    private var availableEngines: [Engine] {
        Engine.allCases.filter { engine in
            model.devices.contains { $0.revoked != true && $0.supports(engine) }
        }
    }

    private var availableModels: [String] {
        guard let device = selectedDevice, device.supports(model.selectedEngine) else { return [] }
        return device.capabilities.engines.first { $0.engine == model.selectedEngine }?.models ?? []
    }

    private var canDispatchDirectly: Bool {
        guard !draftIsEmpty, !submitting, !model.busy, let device = selectedDevice else { return false }
        return device.revoked != true && device.supports(model.selectedEngine)
    }

    private var executionWarnings: [String] {
        guard !model.selectedDevice.isEmpty else { return [] }
        guard let device = selectedDevice else { return ["所选电脑不在当前已加载列表中，请重新选择。"] }
        var warnings: [String] = []
        if device.revoked == true { warnings.append("此电脑已撤销，请手动选择其他电脑。") }
        else if !device.supports(model.selectedEngine) { warnings.append("此电脑尚未配置或不支持 \(model.selectedEngine.rawValue.capitalized)，请调整引擎或电脑。") }
        if device.status == "offline" { warnings.append("此电脑当前离线；已接受的工作会等待电脑恢复连接。") }
        return warnings
    }

    var body: some View {
        VStack(spacing: 0) {
            conversation
            Divider()
            composer
        }
        .background(.background)
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if filteredMessages.isEmpty {
                        if model.messages.isEmpty {
                            EmptyState(
                                icon: "bubble.left.and.bubble.right",
                                title: "从一件具体的工作开始",
                                detail: "告诉助理目标，它会按授权范围推进。所有电脑离线时，消息会排队等待。"
                            )
                        } else {
                            VStack(spacing: 10) {
                                Image(systemName: "magnifyingglass").font(.title2).foregroundStyle(.secondary)
                                Text("没有匹配的消息").font(.headline)
                                Text("尝试搜索其他对话内容。").font(.callout).foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 48)
                        }
                    }

                    ForEach(filteredMessages) { message in
                        AssistantMessageRow(message: message).id(message.id)
                    }

                    if let task = selectedTask {
                        AssistantPlanOutline(task: task, tasks: model.tasks, selectedTaskID: $selectedTaskID)
                            .padding(.leading, 37)
                    }

                    Color.clear.frame(height: 1).id("assistant-thread-bottom")
                }
                .frame(maxWidth: 760, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.top, 28)
                .padding(.bottom, 20)
                .frame(maxWidth: .infinity)
            }
            .onAppear { proxy.scrollTo("assistant-thread-bottom", anchor: .bottom) }
            .onChange(of: model.messages.count) { _, _ in
                withAnimation { proxy.scrollTo("assistant-thread-bottom", anchor: .bottom) }
            }
            .onChange(of: searchText) { _, _ in
                proxy.scrollTo("assistant-thread-bottom", anchor: .bottom)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 5) {
                engineMenu
                deviceMenu
                modelMenu
                Spacer(minLength: 0)
            }

            if !executionWarnings.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(executionWarnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            DisclosureGroup {
                MemoryScopeEditor(draft: $memoryScope)
            } label: {
                Text("记忆范围")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $model.assistantDraft)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 3)
                    if model.assistantDraft.isEmpty {
                        Text("发送给助理…")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 11)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: 56)

                HStack(spacing: 10) {
                    Menu {
                        Button("直接创建并派发任务") { dispatchDirectly() }
                            .disabled(!canDispatchDirectly)
                    } label: {
                        Label("直接派活", systemImage: "arrow.up.forward")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .controlSize(.small)
                    .fixedSize(horizontal: true, vertical: false)
                    .tint(.secondary)
                    .foregroundStyle(.secondary)
                    .disabled(submitting || model.busy)
                    .help("跳过方案确认，直接创建任务")

                    Spacer()

                    if sending { ProgressView().controlSize(.small) }
                    Button {
                        sendToAssistant()
                    } label: {
                        Label("发送给助理", systemImage: "arrow.up")
                            .labelStyle(.iconOnly)
                            .frame(width: 20, height: 18)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(draftIsEmpty || submitting || model.busy)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityLabel("发送给助理")
                    .help("发送给助理 (⌘Return)")
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 9)
            .padding(.bottom, 7)
            .background(.background, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(.quaternary))

            HStack(spacing: 12) {
                Text("模型请求从所选 Mac 直接发出")
                Spacer()
                Text("Return 换行 · ⌘Return 发送")
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
        .padding(.top, 10)
        .padding(.bottom, 12)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.background)
    }

    private var engineMenu: some View {
        Menu {
            if availableEngines.isEmpty {
                Text("暂无已配置的引擎")
            } else {
                ForEach(availableEngines, id: \.self) { engine in
                    Button {
                        model.selectedEngine = engine
                    } label: {
                        if engine == model.selectedEngine {
                            Label(engine.rawValue.capitalized, systemImage: "checkmark")
                        } else {
                            Text(engine.rawValue.capitalized)
                        }
                    }
                }
            }
        } label: {
            compactMenuLabel(title: model.selectedEngine.rawValue.capitalized, systemImage: "sparkles")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .controlSize(.small)
        .fixedSize(horizontal: true, vertical: false)
        .tint(.secondary)
        .disabled(availableEngines.isEmpty)
        .onChange(of: model.selectedEngine) { _, _ in model.selectedModelId = "" }
    }

    private var deviceMenu: some View {
        Menu {
            if model.devices.filter({ $0.revoked != true }).isEmpty {
                Text("暂无可用电脑")
            } else {
                ForEach(model.devices.filter { $0.revoked != true }) { device in
                    Button {
                        model.selectedDevice = device.id
                    } label: {
                        VStack(alignment: .leading) {
                            Text(device.name)
                            Text("\(AgentStatus.title(device.status)) · \(device.supports(model.selectedEngine) ? "支持此引擎" : "未配置此引擎")")
                                .font(.caption)
                        }
                    }
                }
            }
        } label: {
            compactMenuLabel(title: selectedDevice?.name ?? "选择电脑", systemImage: "desktopcomputer")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .controlSize(.small)
        .fixedSize(horizontal: true, vertical: false)
        .tint(.secondary)
        .onChange(of: model.selectedDevice) { _, _ in model.selectedModelId = "" }
    }

    private var modelMenu: some View {
        Menu {
            Button {
                model.selectedModelId = ""
            } label: {
                if model.selectedModelId.isEmpty {
                    Label("本机默认", systemImage: "checkmark")
                } else {
                    Text("本机默认")
                }
            }
            ForEach(availableModels, id: \.self) { modelId in
                Button {
                    model.selectedModelId = modelId
                } label: {
                    if modelId == model.selectedModelId {
                        Label(modelId, systemImage: "checkmark")
                    } else {
                        Text(modelId)
                    }
                }
            }
        } label: {
            compactMenuLabel(title: model.selectedModelId.isEmpty ? "本机默认" : model.selectedModelId, systemImage: "cpu")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .controlSize(.small)
        .fixedSize(horizontal: true, vertical: false)
        .tint(.secondary)
        .disabled(selectedDevice.map { !$0.supports(model.selectedEngine) } ?? true)
        .help("模型列表来自所选电脑已加载的能力")
    }

    private func compactMenuLabel(title: String, systemImage: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
            Text(title).lineLimit(1).truncationMode(.middle)
            Image(systemName: "chevron.down").font(.caption2)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private func sendToAssistant() {
        guard !draftIsEmpty, !submitting, !model.busy else { return }
        let value = model.assistantDraft
        sending = true
        Task {
            defer { sending = false }
            await model.sendMessage(value, scope: memoryScope)
            if model.error == nil, model.assistantDraft == value { model.assistantDraft = "" }
        }
    }

    private func dispatchDirectly() {
        guard canDispatchDirectly else { return }
        let value = model.assistantDraft
        dispatching = true
        Task {
            defer { dispatching = false }
            await model.createTask(value, scope: memoryScope)
            if model.error == nil, model.assistantDraft == value { model.assistantDraft = "" }
        }
    }
}

private struct AssistantMessageRow: View {
    let message: Message

    private var messageTime: String {
        guard let date = ISO8601DateFormatter().date(from: message.createdAt) else { return formatTime(message.createdAt) }
        return date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 42)
                VStack(alignment: .trailing, spacing: 7) {
                    HStack(spacing: 8) {
                        Text("你").font(.caption.weight(.medium))
                        Text(messageTime).font(.caption2).help(formatTime(message.createdAt))
                    }
                    .foregroundStyle(.secondary)
                    Text(message.content)
                        .font(.body)
                        .lineSpacing(5)
                        .textSelection(.enabled)
                        .padding(.horizontal, 15)
                        .padding(.vertical, 11)
                        .background(Color.secondary.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                }
                .frame(maxWidth: 620, alignment: .trailing)
            }
        } else {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: 25, height: 25)
                    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 8) {
                        Text("助理").font(.caption.weight(.semibold))
                        Text(messageTime).font(.caption2).foregroundStyle(.secondary).help(formatTime(message.createdAt))
                    }
                    Text(message.content)
                        .font(.body)
                        .lineSpacing(5)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct AssistantPlanOutline: View {
    let task: AgentTask
    let tasks: [AgentTask]
    @Binding var selectedTaskID: String?

    private var entries: [TaskTreeEntry] {
        let rootID = task.rootTaskId ?? (task.parentTaskId == nil ? task.id : nil)
        let loaded = tasks.filter { candidate in
            if candidate.id == task.id { return true }
            if let planID = task.planId { return candidate.planId == planID }
            if let rootID { return candidate.id == rootID || candidate.rootTaskId == rootID }
            return false
        }
        return TaskGraph.entries(loaded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                Text(task.title).font(.callout.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 8)
                StatusLabel(value: task.status)
            }
            Text("已加载方案 · 当前显示 \(entries.count) 项任务；不代表完整方案或整体完成率")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.top, 5)
                .padding(.bottom, 7)

            ForEach(entries) { entry in
                Button {
                    selectedTaskID = entry.task.id
                } label: {
                    HStack(alignment: .top, spacing: 9) {
                        Image(systemName: icon(for: entry.task.status))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 15, height: 18)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.task.title)
                                .font(.callout.weight(entry.task.id == task.id ? .semibold : .regular))
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                            if !entry.task.goal.isEmpty, entry.task.goal != entry.task.title {
                                Text(entry.task.goal)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                            }
                            if let scopeLine = TaskGraph.planItemScopeLine(entry.task.memoryScope) {
                                Text(scopeLine)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .multilineTextAlignment(.leading)
                            }
                            if entry.parentUnavailable {
                                Text("上级不在已加载范围内").font(.caption2).foregroundStyle(.secondary)
                            }
                            if entry.relationUncertain {
                                Text("更深层级待核对").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Text(AgentStatus.title(entry.task.status))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.leading, CGFloat(entry.depth * 13))
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider().opacity(0.55)
            }

            HStack(spacing: 6) {
                Image(systemName: "desktopcomputer")
                Text(task.deviceName ?? "等待分配电脑")
                Text("/")
                Text(task.engine.rawValue.capitalized)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.top, 11)
        }
        .padding(.leading, 15)
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.secondary.opacity(0.16)).frame(width: 2)
        }
        .accessibilityElement(children: .contain)
    }

    private func icon(for status: String) -> String {
        switch status {
        case "succeeded": return "checkmark.circle"
        case "running", "starting", "dispatched", "switching": return "circle.dotted"
        case "failed", "cancelled": return "exclamationmark.circle"
        case "waiting_input", "awaiting_approval", "awaiting_review": return "questionmark.circle"
        default: return "clock"
        }
    }
}
