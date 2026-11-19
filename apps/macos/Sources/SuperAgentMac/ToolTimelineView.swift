import SwiftUI
import SuperAgentCore

struct ToolTimelineView: View {
    @EnvironmentObject var model: WorkspaceModel
    let runId: String
    let state: String
    @State private var steps: [ToolStep] = []
    @State private var failed = false
    @State private var loading = false
    @State private var loadGeneration = UUID()
    private var active: Bool { ["created", "dispatched", "starting", "running", "waiting_input", "stopping"].contains(state) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text("工具步骤").font(.caption.weight(.semibold)); Spacer(); if loading { ProgressView().controlSize(.mini) } }
            if failed { HStack { Text("暂时无法读取步骤").font(.caption).foregroundStyle(.secondary); Button("重试") { Task { await load() } }.controlSize(.small).disabled(loading) } }
            if steps.isEmpty && !failed && !loading { Text("尚未收到工具步骤记录").font(.caption).foregroundStyle(.secondary) }
            ForEach(steps) { step in
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: step.status == "result_unknown" ? "questionmark.circle" : step.status == "succeeded" ? "checkmark.circle" : step.status == "failed" ? "exclamationmark.circle" : "circle.dotted").foregroundStyle(step.status == "result_unknown" || step.status == "failed" ? Color.orange : Palette.blue)
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(step.displayTitle).font(.callout.weight(.medium)); Spacer(); Text(step.statusTitle).font(.caption).foregroundStyle(.secondary) }
                        if let date = step.startDate { Text("开始 \(date.formatted(date: .abbreviated, time: .standard))").font(.caption2).foregroundStyle(.secondary) }
                        if let date = step.completionDate { Text("结束 \(date.formatted(date: .abbreviated, time: .standard))").font(.caption2).foregroundStyle(.secondary) }
                        if let error = step.errorMessage { Text(error).font(.caption).foregroundStyle(.orange) }
                    }
                }.padding(.vertical, 4)
            }
        }.padding(14).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 8))
            .task(id: active) {
                repeat {
                    await load()
                    guard active, !Task.isCancelled else { return }
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                } while !Task.isCancelled
            }
    }
    private func load() async {
        let generation = UUID(); loadGeneration = generation; loading = true
        defer { if loadGeneration == generation { loading = false } }
        do {
            let result: Items<ToolStep> = try await model.api.request("/runs/\(runId)/steps")
            guard !Task.isCancelled, generation == loadGeneration else { return }
            steps = result.items.filter { $0.runId == runId }.sorted { let a = $0.startDate ?? .distantPast, b = $1.startDate ?? .distantPast; return a == b ? $0.id < $1.id : a < b }
            failed = false
        } catch is CancellationError { }
        catch { if !Task.isCancelled && generation == loadGeneration { failed = true } }
    }
}
