import SwiftUI
import SuperAgentCore

struct TaskContextInspector: View {
    @EnvironmentObject private var model: WorkspaceModel
    @Binding var selectedTaskID: String?
    let onOpenTask: () -> Void
    @State private var section: TaskInspectorSection = .information
    @State private var browserExpanded = false

    init(selectedTaskID: Binding<String?>, onOpenTask: @escaping () -> Void) {
        self._selectedTaskID = selectedTaskID
        self.onOpenTask = onOpenTask
    }

    private var task: AgentTask? {
        model.tasks.first { $0.id == selectedTaskID }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("检查器内容", selection: $section) {
                ForEach(TaskInspectorSection.allCases, id: \.self) { item in
                    Text(item.title).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(14)

            Divider()

            if let task {
                ScrollView {
                    Group {
                        switch section {
                        case .information: information(task)
                        case .activity: activity(task)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "sidebar.trailing")
                        .font(.system(size: 27, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(selectedTaskID == nil ? "选择一项任务" : "任务尚未加载")
                        .font(.headline)
                    Text(selectedTaskID == nil ? "在对话方案或任务列表中选择任务，查看它的执行上下文。" : "所选任务不在当前已加载列表中，请重新选择。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.7))
        .background(Palette.canvas)
        .onChange(of: selectedTaskID) { _, _ in browserExpanded = false }
    }

    @ViewBuilder
    private func information(_ task: AgentTask) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(task.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 10)

            TaskInspectorPropertyRow(label: "状态") {
                StatusLabel(value: task.status)
            }
            TaskInspectorPropertyRow(label: "执行电脑", value: deviceName(task))
            TaskInspectorPropertyRow(label: "引擎", value: task.engine.rawValue.capitalized)
            TaskInspectorPropertyRow(label: "模型", value: task.modelId?.isEmpty == false ? task.modelId! : "本机默认")
            TaskInspectorPropertyRow(label: "最近更新", value: compactUpdateTime(task.updatedAt))
                .help(formatTime(task.updatedAt))

            if let reason = task.reasonCode, !reason.isEmpty {
                Label(reason, systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }

            if !task.goal.isEmpty {
                inspectorSection("工作目标") {
                    Text(task.goal)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineSpacing(2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            relationships(task)
            delivery(task)

            if let runID = task.currentRunId {
                inspectorSection("浏览器") {
                    DisclosureGroup(isExpanded: $browserExpanded) {
                        BrowserFrameView(runId: runID)
                            .padding(.top, 8)
                    } label: {
                        Label("查看当前画面", systemImage: "rectangle.on.rectangle")
                            .font(.callout)
                    }
                    Text("展开后，点击“查看画面”开始采集。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                }
            }
        }
    }

    @ViewBuilder
    private func relationships(_ task: AgentTask) -> some View {
        let links = TaskGraph.relationships(for: task, loaded: model.tasks)
        let dependencies = links.dependencies.compactMap(\.task)
        inspectorSection("相关任务") {
            if !links.ancestors.isEmpty || !links.children.isEmpty || !dependencies.isEmpty {
                Text("仅显示已加载的关系。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if !links.ancestors.isEmpty {
                relationshipGroup("父级任务", tasks: links.ancestors)
            }
            if !links.children.isEmpty {
                relationshipGroup("子任务", tasks: links.children)
            }
            if !dependencies.isEmpty {
                relationshipGroup("前置依赖", tasks: dependencies)
            }
            if links.incompleteAncestors {
                Text("部分父级任务未加载或层级关系待核对。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if links.ancestors.isEmpty, links.children.isEmpty, dependencies.isEmpty {
                Text("暂无已加载的关联任务。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func relationshipGroup(_ title: String, tasks: [AgentTask]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 5)
                .padding(.bottom, 2)
            ForEach(tasks) { related in
                Button {
                    selectedTaskID = related.id
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "checklist")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(width: 14, height: 18)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(related.title)
                                .font(.callout)
                                .foregroundStyle(Palette.blue)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(AgentStatus.title(related.status))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private func delivery(_ task: AgentTask) -> some View {
        inspectorSection("交付") {
            TaskInspectorPropertyRow(label: "交付状态", value: deliveryTitle(task.deliveryStatus))
            if let deliverables = task.deliverables, !deliverables.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(deliverables, id: \.self) { item in
                        Label {
                            Text(item)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        } icon: {
                            Image(systemName: "doc.text")
                        }
                        .font(.callout)
                    }
                }
                .padding(.vertical, 5)
            } else {
                Text("尚未列出交付物。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Button(task.status == "awaiting_review" ? "打开任务并核对交付" : "打开任务详情") {
                onOpenTask()
            }
            .buttonStyle(.link)
            .font(.callout)
            .padding(.top, 5)
        }
    }

    @ViewBuilder
    private func activity(_ task: AgentTask) -> some View {
        let items = activityItems(task)
        VStack(alignment: .leading, spacing: 0) {
            Text(task.title)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 12)

            ForEach(items) { item in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: item.icon)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 16, height: 20)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(item.title).font(.callout.weight(.medium))
                            Spacer(minLength: 6)
                        }
                        Text(formatTime(item.timestamp))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        if !item.detail.isEmpty {
                            Text(item.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineSpacing(3)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.vertical, 10)
                Divider().opacity(0.55)
            }

            Text("活动仅来自当前已加载的任务状态与关联消息；详细执行步骤请在任务详情查看。")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
        }
    }

    private func activityItems(_ task: AgentTask) -> [TaskInspectorActivity] {
        var items = [TaskInspectorActivity(
            id: "created-\(task.id)",
            timestamp: task.createdAt,
            title: "任务创建",
            detail: task.goal,
            icon: "plus.circle"
        )]
        if task.updatedAt != task.createdAt {
            var detail = AgentStatus.title(task.status)
            if let reason = task.reasonCode, !reason.isEmpty { detail += " · \(reason)" }
            items.append(TaskInspectorActivity(
                id: "updated-\(task.id)-\(task.updatedAt)",
                timestamp: task.updatedAt,
                title: "任务最近更新",
                detail: detail,
                icon: "arrow.triangle.2.circlepath"
            ))
        }
        items.append(contentsOf: model.messages.filter { $0.taskId == task.id }.map { message in
            TaskInspectorActivity(
                id: "message-\(message.id)",
                timestamp: message.createdAt,
                title: message.role == "user" ? "你的消息" : "助理消息",
                detail: message.content,
                icon: message.role == "user" ? "person" : "sparkles"
            )
        })
        let parser = ISO8601DateFormatter()
        return items.sorted { lhs, rhs in
            let left = parser.date(from: lhs.timestamp) ?? .distantPast
            let right = parser.date(from: rhs.timestamp) ?? .distantPast
            return left > right
        }
    }

    private func deviceName(_ task: AgentTask) -> String {
        task.deviceName ?? model.devices.first(where: { $0.id == task.deviceId })?.name ?? "等待分配"
    }

    private func deliveryTitle(_ status: String?) -> String {
        switch status {
        case nil, "not_submitted": return "尚未提交"
        case "pending": return "等待验收"
        case "accepted": return "已验收"
        case "rejected": return "已退回"
        case "needs_input": return "需要补充"
        case let value?: return value
        }
    }

    @ViewBuilder
    private func inspectorSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.callout.weight(.semibold))
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 17)
        .padding(.bottom, 16)
        .background(alignment: .top) {
            VStack(spacing: 0) {
                Divider()
                Spacer()
            }
        }
    }

    private func compactUpdateTime(_ value: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: value) else { return formatTime(value) }
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

private enum TaskInspectorSection: Hashable, CaseIterable {
    case information
    case activity

    var title: String {
        switch self {
        case .information: return "任务信息"
        case .activity: return "活动"
        }
    }
}

private struct TaskInspectorPropertyRow<Content: View>: View {
    let label: String
    let content: Content

    init(label: String, value: String) where Content == Text {
        self.label = label
        self.content = Text(value)
    }

    init(label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .foregroundStyle(.secondary)
                .fixedSize()
            Spacer(minLength: 4)
            content
                .font(.caption)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption)
        .padding(.vertical, 6)
    }
}

private struct TaskInspectorActivity: Identifiable {
    let id: String
    let timestamp: String
    let title: String
    let detail: String
    let icon: String
}
