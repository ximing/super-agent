import SwiftUI
import SuperAgentCore

struct DeliveryReviewView: View {
    @EnvironmentObject var model: WorkspaceModel
    let taskId: String
    @State private var evidence: TaskEvidence?
    @State private var passed: Set<Int> = []
    @State private var selected: [Int: String] = [:]
    @State private var summary = ""
    @State private var loading = false
    @State private var submitting = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Label("交付验收", systemImage: "checkmark.seal").font(.headline); Spacer(); Button("刷新证据") { Task { await load() } }.disabled(loading || submitting) }
            Text("执行结束后还需要核对目标与交付标准。勾选表示你已检查对应证据，验收通过后才标记目标完成。").font(.callout).foregroundStyle(.secondary)
            if loading { ProgressView("读取交付证据") }
            if let evidence {
                if let delivery = evidence.delivery { Text(["pending":"当前交付待核对", "rejected":"已退回，等待后续处理", "needs_input":"已请求补充说明", "accepted":"交付已通过验收"][delivery.status] ?? "交付状态待确认").font(.caption).foregroundStyle(.secondary) }
                if !evidence.canReview { Text("交付状态已变化或证据尚未准备好，请刷新任务与证据。").font(.callout).foregroundStyle(.orange) }
                ForEach(Array(evidence.deliverables.enumerated()), id: \.offset) { index, criterion in
                    VStack(alignment: .leading, spacing: 9) {
                        Toggle(isOn: Binding(get: { passed.contains(index) }, set: { if $0 { passed.insert(index) } else { passed.remove(index) } })) { Text(criterion).textSelection(.enabled) }.disabled(submitting || !evidence.canReview)
                        Picker("核对证据", selection: Binding(get: { selected[index] ?? "" }, set: { selected[index] = $0 })) {
                            Text("请选择实际核对的证据").tag("")
                            ForEach(evidence.options) { option in Text(option.title).tag(option.id) }
                        }.disabled(submitting || !evidence.canReview)
                    }.padding(12).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 8))
                }
                if evidence.options.isEmpty { Text("当前没有可引用的交付证据，暂不能验收通过。可记录缺失内容并要求补充。").font(.caption).foregroundStyle(.secondary) }
                TextField("验收说明：记录核对依据或需要补充的内容", text: $summary, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(3...8).disabled(submitting)
                HStack {
                    Button("验收通过") { Task { await submit("accept") } }.buttonStyle(.borderedProminent).disabled(submitting || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (try? evidence.reviewBody(verdict: "accept", summary: summary, passed: passed, selected: selected)) == nil)
                    Button("退回") { Task { await submit("reject") } }.disabled(submitting || !evidence.canReview || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("需要补充说明") { Task { await submit("needs_input") } }.disabled(submitting || !evidence.canReview || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if submitting { ProgressView().controlSize(.small) }
                }
            }
            if let error { Text(error).font(.callout).foregroundStyle(.orange) }
        }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 12)).task { await load() }
    }
    private func load() async {
        guard !loading else { return }; loading = true; defer { loading = false }
        do {
            let latest: TaskEvidence = try await model.api.request("/tasks/\(taskId)/evidence")
            guard latest.task.id == taskId, !Task.isCancelled else { return }
            if evidence?.delivery?.id != latest.delivery?.id || evidence?.delivery?.version != latest.delivery?.version || evidence?.run?.id != latest.run?.id { passed = []; selected = [:] }
            evidence = latest; error = nil
        } catch { if !Task.isCancelled { self.error = "无法读取交付证据，请刷新后重试" } }
    }
    private func submit(_ verdict: String) async {
        guard let evidence, !submitting else { return }; submitting = true; defer { submitting = false }
        do {
            let body = try evidence.reviewBody(verdict: verdict, summary: summary, passed: passed, selected: selected)
            let _: JSONValue = try await model.api.request("/tasks/\(taskId)/reviews", method: "POST", body: body, version: evidence.task.version)
            await model.refresh(); await load()
        } catch let failure as APIError { error = failure.status == 409 || failure.status == 412 ? "交付已被更新，请刷新证据后重新核对" : failure.localizedDescription }
        catch { self.error = "验收提交未完成，请稍后重试" }
    }
}
