import SwiftUI
import SuperAgentCore

struct TaskRelationsView: View {
    @EnvironmentObject var model: WorkspaceModel
    let task: AgentTask
    let onSelect: (String) -> Void
    private var links: TaskRelationships { TaskGraph.relationships(for: task, loaded: model.tasks) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("任务关系")
                .font(.headline)
            Text("仅显示已加载的任务；归属与前置条件分别列出，不代表完整方案或整体完成率。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if !links.ancestors.isEmpty {
                relationHeading("父子层级 · 上级任务")
                ForEach(links.ancestors) { related in row(related) }
            }
            if links.incompleteAncestors {
                Text("部分上级未加载或层级关系待核对。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !links.children.isEmpty {
                relationHeading("父子层级 · 直属子任务")
                ForEach(links.children) { related in row(related) }
            }
            if !links.dependencies.isEmpty {
                relationHeading("执行依赖 · 前置任务")
                ForEach(links.dependencies) { dependency in
                    if let related = dependency.task {
                        row(related)
                    } else {
                        Label("未加载的前置任务 \(dependency.id.prefix(8))", systemImage: "link")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if links.ancestors.isEmpty && links.children.isEmpty && links.dependencies.isEmpty && !links.incompleteAncestors {
                Text("当前已加载范围内没有其他相关任务。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func relationHeading(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 4)
    }

    private func row(_ related: AgentTask) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                onSelect(related.id)
            } label: {
                Label(related.title, systemImage: "arrow.up.right.square")
                    .font(.callout)
                    .foregroundStyle(Palette.blue)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            .buttonStyle(.plain)
            .help(related.title)
            .layoutPriority(1)
            .accessibilityLabel("打开相关任务 \(related.title)")
            Spacer(minLength: 8)
            TaskStateLabel(task: related, device: model.devices.first { $0.id == related.deviceId })
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.vertical, 3)
    }
}
