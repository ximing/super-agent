import Foundation

public struct TaskTreeEntry: Identifiable, Sendable {
    public let task: AgentTask; public let depth: Int; public let parentUnavailable: Bool; public let relationUncertain: Bool
    public var id: String { task.id }
}
public struct TaskTreeGroup: Identifiable, Sendable { public let id: String; public let title: String; public let entries: [TaskTreeEntry] }
public struct TaskDependency: Identifiable, Sendable { public let id: String; public let task: AgentTask? }
public struct TaskRelationships: Sendable {
    public let ancestors: [AgentTask]; public let children: [AgentTask]; public let dependencies: [TaskDependency]; public let incompleteAncestors: Bool
}
/// All results describe only the supplied snapshot. Execution dependencies never become parent links.
public enum TaskGraph {
    public static func groups(_ loaded: [AgentTask]) -> [TaskTreeGroup] {
        var keys: [String] = []; var grouped: [String:[AgentTask]] = [:]
        for task in loaded { let key = task.planId ?? "unassigned"; if grouped[key] == nil { keys.append(key) }; grouped[key, default: []].append(task) }
        return keys.map { key in TaskTreeGroup(id: key, title: key == "unassigned" ? "未分组任务" : "方案 \(key.prefix(8))", entries: entries(grouped[key] ?? [])) }
    }
    public static func entries(_ loaded: [AgentTask]) -> [TaskTreeEntry] {
        let index = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { a, b in a.version >= b.version ? a : b })
        var seen: Set<String> = []; var rows: [TaskTreeEntry] = []
        func visit(_ task: AgentTask, depth: Int, uncertain: Bool) {
            guard seen.insert(task.id).inserted else { return }
            rows.append(TaskTreeEntry(task: index[task.id] ?? task, depth: min(depth, 3), parentUnavailable: task.parentTaskId.map { index[$0] == nil } ?? false, relationUncertain: uncertain || depth > 3))
            for child in loaded where child.parentTaskId == task.id { visit(child, depth: depth + 1, uncertain: false) }
        }
        for task in loaded where task.parentTaskId == nil || index[task.parentTaskId ?? ""] == nil { visit(task, depth: 0, uncertain: false) }
        for task in loaded where !seen.contains(task.id) { visit(task, depth: 0, uncertain: true) }
        return rows
    }
    public static func relationships(for task: AgentTask, loaded: [AgentTask]) -> TaskRelationships {
        let index = Dictionary(loaded.map { ($0.id, $0) }, uniquingKeysWith: { a, b in a.version >= b.version ? a : b })
        var ancestors: [AgentTask] = []; var seen: Set<String> = [task.id]; var current = task.parentTaskId; var incomplete = false
        while let id = current {
            guard seen.insert(id).inserted, let parent = index[id] else { incomplete = true; break }
            ancestors.append(parent); current = parent.parentTaskId
        }
        var dependencies: [TaskDependency] = []; var depSeen: Set<String> = []
        for id in task.dependsOnTaskIds ?? [] where depSeen.insert(id).inserted { dependencies.append(TaskDependency(id: id, task: index[id])) }
        return TaskRelationships(ancestors: ancestors.reversed(), children: loaded.filter { $0.parentTaskId == task.id }, dependencies: dependencies, incompleteAncestors: incomplete)
    }
}
