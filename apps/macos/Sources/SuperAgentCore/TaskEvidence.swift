import Foundation

public struct EvidenceReference: Hashable, Sendable {
    public let kind: String
    public let id: String
    public var key: String { "\(kind):\(id)" }
    public init(kind: String, id: String) { self.kind = kind; self.id = id }
}
public struct ReviewEvidenceOption: Identifiable, Sendable {
    public let reference: EvidenceReference
    public let title: String
    public var id: String { reference.key }
}
public struct DeliveryRecord: Decodable, Sendable {
    public let id: String; public let runId: String; public let status: String
    public let deliverables: [String]; public let artifactIds: [String]; public let version: Int
}
public struct EvidenceCheckpoint: Decodable, Sendable { public let id: String; public let createdAt: String }
public struct TaskEvidence: Decodable, Sendable {
    public let task: AgentTask
    public let run: Run?
    public let delivery: DeliveryRecord?
    public let deliverables: [String]
    public let checkpoint: EvidenceCheckpoint?
    public let steps: [ToolStep]
    public let artifacts: [Artifact]
    public var canReview: Bool { guard let delivery, let run else { return false }; return task.status == "awaiting_review" && ["pending", "rejected", "needs_input"].contains(delivery.status) && run.state == "succeeded" && run.id == task.currentRunId && delivery.runId == run.id }
    public var options: [ReviewEvidenceOption] {
        var values: [ReviewEvidenceOption] = []
        if let checkpoint { values.append(ReviewEvidenceOption(reference: EvidenceReference(kind: "checkpoint", id: checkpoint.id), title: "执行结果检查点")) }
        values += steps.filter { $0.runId == run?.id && $0.status == "succeeded" }.map { ReviewEvidenceOption(reference: EvidenceReference(kind: "step", id: $0.id), title: "工具回执：\($0.displayTitle)") }
        values += artifacts.filter { $0.taskId == task.id && $0.runId == run?.id && $0.status == "ready" }.map { ReviewEvidenceOption(reference: EvidenceReference(kind: "artifact", id: $0.id), title: "附件：\($0.name)") }
        return values
    }
    public func reviewBody(verdict: String, summary: String, passed: Set<Int>, selected: [Int: String]) throws -> [String: JSONValue] {
        guard canReview, let run else { throw APIError(status: 409, code: "delivery_changed", message: "交付状态已变化，请刷新证据后重试") }
        let note = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ["accept", "reject", "needs_input"].contains(verdict), !note.isEmpty else { throw APIError(status: 0, code: "review_note", message: "请填写核对依据或需要补充的内容") }
        let available = Dictionary(options.map { ($0.id, $0.reference) }, uniquingKeysWith: { first, _ in first })
        if verdict == "accept" {
            guard !deliverables.isEmpty, deliverables.indices.allSatisfy({ passed.contains($0) && selected[$0].flatMap { available[$0] } != nil }) else { throw APIError(status: 0, code: "review_incomplete", message: "请逐项确认交付标准，并选择实际核对证据") }
        }
        let checks: [JSONValue] = deliverables.indices.map { index in
            let ref = selected[index].flatMap { available[$0] }
            return .object(["deliverable_index": .number(Double(index)), "passed": .bool(passed.contains(index)), "evidence_refs": .array(ref.map { [.object(["kind": .string($0.kind), "id": .string($0.id)])] } ?? [])])
        }
        return ["run_id": .string(run.id), "verdict": .string(verdict), "summary": .string(note), "checks": .array(checks)]
    }
}
