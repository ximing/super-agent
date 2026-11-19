import SwiftUI
import SuperAgentCore
struct TaskRelationsView: View {
    @EnvironmentObject var model: WorkspaceModel
    let task: AgentTask
    let onSelect: (String) -> Void
    private var links: TaskRelationships { TaskGraph.relationships(for: task, loaded: model.tasks) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("已加载任务关系").font(.headline)
            Text("这里只显示当前已加载的任务，不代表完整方案或整体完成率。").font(.caption).foregroundStyle(.secondary)
            if !links.ancestors.isEmpty { Text("上级任务").font(.caption.weight(.semibold)); ForEach(links.ancestors) { related in row(related) } }
            if links.incompleteAncestors { Text("部分上级未加载或层级关系待核对。").font(.caption).foregroundStyle(.secondary) }
            if !links.children.isEmpty { Text("直属子任务").font(.caption.weight(.semibold)); ForEach(links.children) { related in row(related) } }
            if !links.dependencies.isEmpty {
                Text("执行前置条件").font(.caption.weight(.semibold))
                ForEach(links.dependencies) { dependency in if let related = dependency.task { row(related) } else { Text("未加载的前置任务 · \(dependency.id.prefix(8))").font(.caption).foregroundStyle(.secondary) } }
            }
            if links.ancestors.isEmpty && links.children.isEmpty && links.dependencies.isEmpty && !links.incompleteAncestors { Text("当前列表未显示其他相关任务。").font(.caption).foregroundStyle(.secondary) }
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 12))
    }
    private func row(_ related: AgentTask) -> some View {
        HStack { Button(related.title) { onSelect(related.id) }.buttonStyle(.plain).foregroundStyle(Palette.blue); Spacer(); StatusLabel(value: related.status) }
    }
}
