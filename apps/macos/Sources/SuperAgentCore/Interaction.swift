import Foundation

public enum InteractionTiming {
    public static let reconnectBannerGrace: TimeInterval = 5
    public static let sseRotationHint: TimeInterval = 25
    public static let progressCheckAfter: TimeInterval = 15
    public static let progressStaleAfter: TimeInterval = 60
}

public struct InteractionCapabilities: Decodable, Sendable, Equatable {
    enum CodingKeys: String, CodingKey { case messageProcessing, actionReceipts, workspaceSnapshot, chatFastPath, taskProgress }
    public var messageProcessing: Bool
    public var actionReceipts: Bool
    public var workspaceSnapshot: Bool
    public var chatFastPath: Bool
    public var taskProgress: Bool
    public static let legacy = InteractionCapabilities(messageProcessing: false, actionReceipts: false, workspaceSnapshot: false, chatFastPath: false, taskProgress: false)
    public init(messageProcessing: Bool, actionReceipts: Bool, workspaceSnapshot: Bool, chatFastPath: Bool, taskProgress: Bool) {
        self.messageProcessing = messageProcessing
        self.actionReceipts = actionReceipts
        self.workspaceSnapshot = workspaceSnapshot
        self.chatFastPath = chatFastPath
        self.taskProgress = taskProgress
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messageProcessing = try container.decodeIfPresent(Bool.self, forKey: .messageProcessing) ?? false
        actionReceipts = try container.decodeIfPresent(Bool.self, forKey: .actionReceipts) ?? false
        workspaceSnapshot = try container.decodeIfPresent(Bool.self, forKey: .workspaceSnapshot) ?? false
        chatFastPath = try container.decodeIfPresent(Bool.self, forKey: .chatFastPath) ?? false
        taskProgress = try container.decodeIfPresent(Bool.self, forKey: .taskProgress) ?? false
    }
}

public struct MessageProcessing: Decodable, Sendable, Equatable {
    enum CodingKeys: String, CodingKey { case id, sourceMessageId, clientMessageId, version, status, phase, reasonCode, historical, taskIds, updatedAt }
    public var id: String
    public var sourceMessageId: String
    public var clientMessageId: String?
    public var version: Int?
    public var status: String?
    public var phase: String?
    public var reasonCode: String?
    public var historical: String?
    public var taskIds: [String]
    public var updatedAt: String?
    public init(id: String, sourceMessageId: String, clientMessageId: String? = nil, version: Int? = nil, status: String? = nil, phase: String? = nil, reasonCode: String? = nil, historical: String? = nil, taskIds: [String] = [], updatedAt: String? = nil) {
        self.id = id
        self.sourceMessageId = sourceMessageId
        self.clientMessageId = clientMessageId
        self.version = version
        self.status = status
        self.phase = phase
        self.reasonCode = reasonCode
        self.historical = historical
        self.taskIds = taskIds
        self.updatedAt = updatedAt
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? ""
        sourceMessageId = try container.decodeIfPresent(String.self, forKey: .sourceMessageId) ?? ""
        clientMessageId = try container.decodeIfPresent(String.self, forKey: .clientMessageId)
        version = try container.decodeIfPresent(Int.self, forKey: .version)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        phase = try container.decodeIfPresent(String.self, forKey: .phase)
        reasonCode = try container.decodeIfPresent(String.self, forKey: .reasonCode)
        historical = try container.decodeIfPresent(String.self, forKey: .historical)
        taskIds = try container.decodeIfPresent([String].self, forKey: .taskIds) ?? []
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

public struct ActionReceipt: Codable, Sendable, Equatable {
    public var actionId: String
    public var taskId: String
    public var action: String
    public var status: String
    public var version: Int?
    public var reasonCode: String?
    public var runId: String?
    public init(actionId: String, taskId: String, action: String, status: String, version: Int? = nil, reasonCode: String? = nil, runId: String? = nil) {
        self.actionId = actionId
        self.taskId = taskId
        self.action = action
        self.status = status
        self.version = version
        self.reasonCode = reasonCode
        self.runId = runId
    }
}

public struct ActionAcceptResponse: Decodable, Sendable, Equatable {
    public var actionId: String
    public var status: String
    public var receipt: ActionReceipt?
}

public struct MessageLookup: Decodable, Sendable {
    public var message: Message
    public var processing: MessageProcessing?
}

public struct WorkspaceSnapshot: Decodable, Sendable {
    enum CodingKeys: String, CodingKey { case asOf, cursor, tasks, messages, processing, actions, questions, devices }
    public var asOf: String?
    public var cursor: String
    public var tasks: [AgentTask]
    public var messages: [Message]
    public var processing: [MessageProcessing]
    public var actions: [ActionReceipt]
    public var questions: [Question]
    public var devices: [Device]
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        asOf = try container.decodeIfPresent(String.self, forKey: .asOf)
        cursor = try container.decodeIfPresent(String.self, forKey: .cursor) ?? "0"
        tasks = try container.decodeIfPresent([AgentTask].self, forKey: .tasks) ?? []
        messages = try container.decodeIfPresent([Message].self, forKey: .messages) ?? []
        processing = try container.decodeIfPresent([MessageProcessing].self, forKey: .processing) ?? []
        actions = try container.decodeIfPresent([ActionReceipt].self, forKey: .actions) ?? []
        questions = try container.decodeIfPresent([Question].self, forKey: .questions) ?? []
        devices = try container.decodeIfPresent([Device].self, forKey: .devices) ?? []
    }
}

public enum InteractionCopy {
    public static func processingLabel(status: String?, reason: String?, historical: String?) -> String {
        if historical == "unknown" || status == nil { return "历史处理状态未知" }
        if reason == "waiting_device_offline" { return "主助理电脑离线，消息已保存" }
        if reason == "waiting_previous_message" || reason == "assistant_lease_held" { return "主助理正在处理上一条消息" }
        if reason == "model_in_progress" { return "模型处理中" }
        if reason == "ambiguous_target" { return "有多个任务符合，请先选择" }
        if reason == "interrupted_unknown" || status == "interrupted" { return "处理结果待核对" }
        if status == "received" || status == "queued" { return "已收到" }
        if status == "processing" { return "正在处理" }
        if status == "waiting_input" { return "需要你处理" }
        if status == "handled" { return "已回复" }
        if status == "failed" { return "处理失败" }
        return "尚未确认处理状态"
    }

    public static func actionLabel(action: String, status: String) -> String {
        if status == "accepted" { return "请求已收到" }
        if status == "delivered" || status == "applying" {
            if action == "pause" || action == "cancel" { return "正在暂停" }
            return "等待电脑处理"
        }
        if status == "result_unknown" { return "结果待核对" }
        if status == "failed" { return "操作失败" }
        if status == "superseded" { return "操作已被新的执行替代" }
        if action == "pause" { return "已暂停" }
        if action == "cancel" { return "已取消" }
        if action == "resume" || action == "retry" { return "已开始新的执行" }
        if action == "switch" { return "已切换" }
        return "已完成"
    }
}

public enum ActionDisplay {
    /// Missing receipt, or receipts disabled, stays at "请求已收到". Never treat accepted as paused.
    public static func label(action: String, receiptStatus: String?, receiptsEnabled: Bool) -> String {
        guard receiptsEnabled, let receiptStatus else { return "请求已收到" }
        return InteractionCopy.actionLabel(action: action, status: receiptStatus)
    }
}

public enum EntityMerge {
    public static func accept(incoming: Int?, current: Int?) -> Bool {
        guard let current else { return true }
        guard let incoming else { return false }
        return incoming >= current
    }

    public static func choose<T>(_ incoming: T, current: T?, incomingVersion: Int?, currentVersion: Int?) -> T {
        if let current, !accept(incoming: incomingVersion, current: currentVersion) { return current }
        return incoming
    }
}

public struct DirtyProjection: Codable, Equatable, Sendable {
    public var seq: String
    public var type: String
    public var taskId: String?
    public var eventId: String?
    public init(seq: String, type: String, taskId: String? = nil, eventId: String? = nil) {
        self.seq = seq
        self.type = type
        self.taskId = taskId
        self.eventId = eventId
    }
}

public struct ProjectionJournal: Codable, Equatable, Sendable {
    public var projectedCursor: String
    public var receivedCursor: String
    public var dirty: [DirtyProjection]
    public init(projectedCursor: String = "0", receivedCursor: String = "0", dirty: [DirtyProjection] = []) {
        self.projectedCursor = projectedCursor
        self.receivedCursor = receivedCursor
        self.dirty = dirty
    }

    /// Nil means the cursor must stay. A failed fetch advances only together with a dirty mark.
    public static func reduce(journal: ProjectionJournal, seq: String, fetchSucceeded: Bool, dirty: DirtyProjection?) -> ProjectionJournal? {
        if EventStreamDecoder.compareStreamSeq(seq, journal.projectedCursor) <= 0 { return journal }
        if !fetchSucceeded && dirty == nil { return nil }
        var next = journal
        next.dirty.removeAll { $0.seq == seq }
        if let dirty, !fetchSucceeded { next.dirty.append(dirty) }
        let events = [(seq: seq, fetchSucceeded: fetchSucceeded, dirtySaved: dirty != nil && !fetchSucceeded)]
        next.projectedCursor = CursorProjection.nextCursor(current: journal.projectedCursor, events: events)
        next.receivedCursor = EventStreamDecoder.compareStreamSeq(seq, journal.receivedCursor) >= 0 ? seq : journal.receivedCursor
        return next
    }
}

public enum CursorProjection {
    public static func nextCursor(current: String, events: [(seq: String, fetchSucceeded: Bool, dirtySaved: Bool)]) -> String {
        var cursor = current
        for event in events {
            if EventStreamDecoder.compareStreamSeq(event.seq, cursor) <= 0 { continue }
            if event.fetchSucceeded || event.dirtySaved { cursor = event.seq }
            else { break }
        }
        return cursor
    }
}

public enum OutboundPhase: String, Codable, Equatable, Sendable {
    case held
    case inFlight
    case pendingConfirmation
    case conflict
    case failed
    case confirmed
}

public struct OutboundMessage: Codable, Equatable, Sendable, Identifiable {
    public var id: String { clientMessageId }
    public var clientMessageId: String
    public var idempotencyKey: String
    public var text: String
    public var createdAt: String
    public var phase: OutboundPhase
    public var serverMessageId: String?
    public var body: [String: JSONValue]
    public init(clientMessageId: String, idempotencyKey: String, text: String, createdAt: String, phase: OutboundPhase, serverMessageId: String? = nil, body: [String: JSONValue]) {
        self.clientMessageId = clientMessageId
        self.idempotencyKey = idempotencyKey
        self.text = text
        self.createdAt = createdAt
        self.phase = phase
        self.serverMessageId = serverMessageId
        self.body = body
    }
}

public enum OutboundQueue {
    public static func prepare(text: String, clientMessageId: String, createdAt: String, memoryScope: JSONValue, taskId: String?, executionPreference: [String: JSONValue]?) -> OutboundMessage {
        var body: [String: JSONValue] = [
            "client_message_id": .string(clientMessageId),
            "text": .string(text),
            "memory_scope": memoryScope,
        ]
        if let taskId { body["task_id"] = .string(taskId) }
        if let executionPreference { body["execution_preference"] = .object(executionPreference) }
        return OutboundMessage(clientMessageId: clientMessageId, idempotencyKey: clientMessageId, text: text, createdAt: createdAt, phase: .held, body: body)
    }

    public static func canDeleteLocally(_ message: OutboundMessage) -> Bool { message.phase == .held }

    /// Unknown results are not a recall. Only an unsent hold may be deleted, and it is not labeled 撤回.
    public static func removalLabel(_ message: OutboundMessage) -> String? {
        message.phase == .held ? "删除" : nil
    }

    public static func statusText(_ phase: OutboundPhase) -> String? {
        switch phase {
        case .held, .inFlight: return "发送中"
        case .pendingConfirmation: return "发送结果待确认"
        case .conflict: return "提交冲突，没有覆盖已有消息"
        case .failed: return "发送失败"
        case .confirmed: return nil
        }
    }

    public static func keepingIdentity(_ message: OutboundMessage, phase: OutboundPhase) -> OutboundMessage {
        var copy = message
        copy.phase = phase
        return copy
    }
}

public enum SubmitOutcome: Equatable, Sendable {
    case found(messageId: String)
    case notFound
    case timeout
    case conflict
    case unauthorized
    case rejected
    case transport
    case accepted(messageId: String)
}

public enum RecoveryStep: Equatable, Sendable {
    case merge
    case retransmitOriginal
    case pendingConfirmation
    case conflict
    case failed
    case needsLogin
}

public enum OutboundRecovery {
    public static func step(for outcome: SubmitOutcome) -> RecoveryStep {
        switch outcome {
        case .found, .accepted: return .merge
        case .notFound: return .retransmitOriginal
        case .timeout, .transport: return .pendingConfirmation
        case .conflict: return .conflict
        case .unauthorized: return .needsLogin
        case .rejected: return .failed
        }
    }

    public static func phase(for outcome: SubmitOutcome, current: OutboundPhase) -> OutboundPhase {
        switch step(for: outcome) {
        case .merge: return .confirmed
        case .retransmitOriginal: return current == .held ? .held : .inFlight
        case .pendingConfirmation: return .pendingConfirmation
        case .conflict: return .conflict
        case .failed: return .failed
        case .needsLogin: return current
        }
    }
}

public struct TranscriptItem: Identifiable, Equatable, Sendable {
    public var id: String
    public var role: String
    public var content: String
    public var createdAt: String
    public var taskId: String?
    public var clientMessageId: String?
    public var statusText: String?
    public var localPhase: OutboundPhase?
    public var canDeleteLocally: Bool
    public var canReconcile: Bool
    public var canEditAsNew: Bool
    public init(id: String, role: String, content: String, createdAt: String, taskId: String?, clientMessageId: String?, statusText: String?, localPhase: OutboundPhase?, canDeleteLocally: Bool, canReconcile: Bool, canEditAsNew: Bool) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
        self.taskId = taskId
        self.clientMessageId = clientMessageId
        self.statusText = statusText
        self.localPhase = localPhase
        self.canDeleteLocally = canDeleteLocally
        self.canReconcile = canReconcile
        self.canEditAsNew = canEditAsNew
    }
}

public enum TranscriptMerge {
    public static func merge(messages: [Message], outbound: [OutboundMessage], processing: [MessageProcessing], processingEnabled: Bool) -> [TranscriptItem] {
        let bySource = Dictionary(processing.map { ($0.sourceMessageId, $0) }, uniquingKeysWith: { EntityMerge.choose($1, current: $0, incomingVersion: $1.version, currentVersion: $0.version) })
        let serverClientIds = Set(messages.compactMap(\.clientMessageId))
        let serverIds = Set(messages.map(\.id))
        var items: [TranscriptItem] = messages.map { message in
            let record = bySource[message.id]
            let status = statusText(message: message, processing: record, processingEnabled: processingEnabled)
            return TranscriptItem(id: message.clientMessageId ?? message.id, role: message.role, content: message.content, createdAt: message.createdAt, taskId: message.taskId, clientMessageId: message.clientMessageId, statusText: status, localPhase: nil, canDeleteLocally: false, canReconcile: false, canEditAsNew: false)
        }
        for pending in outbound where pending.phase != .confirmed {
            if serverClientIds.contains(pending.clientMessageId) || serverIds.contains(pending.clientMessageId) { continue }
            if let serverId = pending.serverMessageId, serverIds.contains(serverId) { continue }
            let recoverable = pending.phase == .pendingConfirmation || pending.phase == .failed || pending.phase == .conflict || pending.phase == .inFlight
            items.append(TranscriptItem(id: pending.clientMessageId, role: "user", content: pending.text, createdAt: pending.createdAt, taskId: nil, clientMessageId: pending.clientMessageId, statusText: OutboundQueue.statusText(pending.phase), localPhase: pending.phase, canDeleteLocally: OutboundQueue.canDeleteLocally(pending), canReconcile: recoverable && pending.phase != .inFlight, canEditAsNew: pending.phase == .failed || pending.phase == .pendingConfirmation || pending.phase == .conflict))
        }
        return items.sorted { chatSort($0.createdAt) < chatSort($1.createdAt) }
    }

    static func statusText(message: Message, processing: MessageProcessing?, processingEnabled: Bool) -> String? {
        if let processing, processingEnabled || processing.status != nil || processing.historical != nil {
            return InteractionCopy.processingLabel(status: processing.status, reason: processing.reasonCode, historical: processing.historical)
        }
        if message.processingStatus != nil || message.reasonCode != nil {
            return InteractionCopy.processingLabel(status: message.processingStatus, reason: message.reasonCode, historical: nil)
        }
        return nil
    }
}

private func chatSort(_ value: String) -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    if let date = ISO8601DateFormatter().date(from: value) { return date }
    return .distantPast
}

public enum FastControl: String, Equatable, Sendable { case pause, resume, cancel, retry }

public enum FastIntent: Equatable, Sendable {
    case none
    case status
    case control(FastControl, taskRef: String?)
    case select(String)
}

public struct FastTaskRef: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var status: String
    public init(id: String, title: String, status: String) {
        self.id = id
        self.title = title
        self.status = status
    }
}

public enum FastBinding: Equatable, Sendable {
    case ignore
    case status([FastTaskRef])
    case act(FastControl, FastTaskRef)
    case choose(FastControl, [FastTaskRef])
    case missing(FastControl)
}

public enum FastPath {
    public static func parse(_ text: String) -> FastIntent {
        var normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let range = normalized.range(of: #"[。！!？?，,\s]+$"#, options: .regularExpression) {
            normalized.removeSubrange(range)
        }
        normalized = normalized.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty || normalized.count > 80 { return .none }
        if normalized.range(of: #"^(进度|进度呢|现在到哪了|现在怎么样|状态|status)$"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .status
        }
        if let match = firstMatch(in: normalized, pattern: #"^(?:选择|就这个)\s+([a-f0-9-]{8,36})$"#), let ref = match.first {
            return .select(ref.lowercased())
        }
        guard let match = firstMatch(in: normalized, pattern: #"^(暂停|暂停一下|pause|继续|恢复|resume|取消|停止|cancel|重试|retry)(?:\s+([a-f0-9-]{8,36}))?$"#) else {
            return .none
        }
        let word = match[0].lowercased()
        let taskRef = match.count > 1 ? match[1].lowercased() : nil
        let action: FastControl
        if word == "暂停" || word == "暂停一下" || word == "pause" { action = .pause }
        else if word == "继续" || word == "恢复" || word == "resume" { action = .resume }
        else if word == "取消" || word == "停止" || word == "cancel" { action = .cancel }
        else { action = .retry }
        return .control(action, taskRef: taskRef)
    }

    public static func bind(_ intent: FastIntent, tasks: [FastTaskRef]) -> FastBinding {
        switch intent {
        case .none: return .ignore
        case .status: return .status(tasks.filter { eligible($0, action: nil, statusQuery: true) })
        case .select(let ref):
            let choices = tasks.filter { eligible($0, action: nil, statusQuery: true) && matches($0, ref: ref) }
            if choices.count == 1 { return .status(choices) }
            return choices.isEmpty ? .missing(.pause) : .choose(.pause, choices)
        case .control(let action, let taskRef):
            let pool = tasks.filter { eligible($0, action: action, statusQuery: false) }
            let choices = taskRef == nil ? pool : pool.filter { matches($0, ref: taskRef!) }
            if choices.count == 1, let only = choices.first { return .act(action, only) }
            if choices.isEmpty { return .missing(action) }
            return .choose(action, choices)
        }
    }

    public enum Gate: Equatable, Sendable {
        case send(String)
        case choose(action: String, choices: [FastTaskRef])
    }

    /// Ambiguous whole-sentence commands with several visible tasks are not sent. Discussion and conditional sentences are.
    public static func gate(text: String, tasks: [FastTaskRef]) -> Gate {
        switch parse(text) {
        case .status:
            let choices = tasks.filter { eligible($0, action: nil, statusQuery: true) }
            if choices.count > 1 { return .choose(action: "status", choices: choices) }
            return .send(text)
        case .control(let action, let taskRef) where taskRef == nil:
            if case .choose(_, let choices) = bind(.control(action, taskRef: nil), tasks: tasks), choices.count > 1 {
                return .choose(action: action.rawValue, choices: choices)
            }
            return .send(text)
        default:
            return .send(text)
        }
    }

    public static func explicitCommand(action: String, taskId: String) -> String {
        let prefix = String(taskId.lowercased().prefix(8))
        switch action {
        case "pause": return "暂停 \(prefix)"
        case "resume": return "继续 \(prefix)"
        case "cancel": return "取消 \(prefix)"
        case "retry": return "重试 \(prefix)"
        default: return "选择 \(prefix)"
        }
    }

    private static func eligible(_ task: FastTaskRef, action: FastControl?, statusQuery: Bool) -> Bool {
        if statusQuery { return !["succeeded", "cancelled"].contains(task.status) }
        guard let action else { return false }
        let control: Set<String> = ["queued", "blocked", "running", "waiting_input", "waiting_device", "awaiting_approval", "pausing", "paused", "switching", "awaiting_review", "failed"]
        guard control.contains(task.status) else { return false }
        switch action {
        case .pause: return ["queued", "blocked", "running", "waiting_input", "waiting_device", "awaiting_approval", "pausing"].contains(task.status)
        case .resume: return task.status == "paused"
        case .retry: return ["failed", "paused", "awaiting_review"].contains(task.status)
        case .cancel: return !["succeeded", "failed", "cancelled"].contains(task.status)
        }
    }

    private static func matches(_ task: FastTaskRef, ref: String) -> Bool {
        let id = task.id.lowercased()
        return id == ref || id.hasPrefix(ref)
    }

    private static func firstMatch(in text: String, pattern: String) -> [String]? {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = expression.firstMatch(in: text, options: [], range: range) else { return nil }
        var values: [String] = []
        for index in 1..<match.numberOfRanges {
            guard let slice = Range(match.range(at: index), in: text) else { continue }
            values.append(String(text[slice]))
        }
        return values.isEmpty ? nil : values
    }
}

public struct StageFacts: Equatable, Sendable {
    public var runState: String?
    public var progressPhase: String?
    public var progressSummary: String?
    public var completedCount: Int?
    public var totalCount: Int?
    public var waitingReason: String?
    public var taskStatus: String?
    public var hasOpenQuestion: Bool
    public var deliveryStatus: String?
    public var lastProgressAt: Date?
    public var serverConnected: Bool
    public var deviceOnline: Bool?
    public var now: Date
    public var taskProgressEnabled: Bool
    public init(runState: String? = nil, progressPhase: String? = nil, progressSummary: String? = nil, completedCount: Int? = nil, totalCount: Int? = nil, waitingReason: String? = nil, taskStatus: String? = nil, hasOpenQuestion: Bool = false, deliveryStatus: String? = nil, lastProgressAt: Date? = nil, serverConnected: Bool, deviceOnline: Bool? = nil, now: Date, taskProgressEnabled: Bool) {
        self.runState = runState
        self.progressPhase = progressPhase
        self.progressSummary = progressSummary
        self.completedCount = completedCount
        self.totalCount = totalCount
        self.waitingReason = waitingReason
        self.taskStatus = taskStatus
        self.hasOpenQuestion = hasOpenQuestion
        self.deliveryStatus = deliveryStatus
        self.lastProgressAt = lastProgressAt
        self.serverConnected = serverConnected
        self.deviceOnline = deviceOnline
        self.now = now
        self.taskProgressEnabled = taskProgressEnabled
    }
}

public struct StageView: Equatable, Sendable {
    public var title: String
    public var detail: String
    public var showCheck: Bool
    public var emphasize: Bool
    public var countText: String?
}

public enum StageProjection {
    public static func present(_ facts: StageFacts) -> StageView {
        let title = title(for: facts)
        let terminal = ["succeeded", "cancelled", "failed"].contains(facts.taskStatus ?? "") && facts.hasOpenQuestion == false && facts.deliveryStatus != "pending"
        let age = facts.lastProgressAt.map { facts.now.timeIntervalSince($0) }
        let showCheck = !terminal && (age ?? -1) >= InteractionTiming.progressCheckAfter
        let emphasize = !terminal && (age ?? -1) >= InteractionTiming.progressStaleAfter
        var countText: String?
        if let completed = facts.completedCount, let total = facts.totalCount, total > 0 {
            countText = "\(completed)/\(total)"
        }
        var detail = ""
        if emphasize {
            var parts = ["最后已知：\(title)"]
            parts.append(facts.serverConnected ? "与服务端连接正常" : "与服务端连接中断")
            if let online = facts.deviceOnline { parts.append(online ? "执行电脑在线" : "执行电脑离线") }
            else { parts.append("执行电脑状态未知") }
            detail = parts.joined(separator: " · ")
        } else if let summary = facts.progressSummary, !summary.isEmpty {
            detail = "阶段说明：\(summary)"
        } else if let reason = facts.waitingReason, !reason.isEmpty {
            detail = reason
        }
        return StageView(title: title, detail: detail, showCheck: showCheck, emphasize: emphasize, countText: countText)
    }

    static func title(for facts: StageFacts) -> String {
        if facts.hasOpenQuestion { return "需要你处理" }
        if facts.deliveryStatus == "pending" || facts.deliveryStatus == "needs_input" { return "交付待核对" }
        if facts.deliveryStatus == "accepted" || facts.taskStatus == "succeeded" { return "已完成" }
        if facts.runState == "dispatched" || facts.taskStatus == "dispatched" { return "等待电脑接受" }
        if facts.taskProgressEnabled {
            switch facts.progressPhase {
            case "waiting_device": return "等待执行电脑"
            case "planning": return "正在理解目标"
            case "preparing_tasks": return "准备任务"
            case "replying": return "正在回复"
            case "executing": return "执行中"
            case "reviewing": return "交付核对"
            default: break
            }
            if facts.runState == "starting" { return "电脑已接收" }
        } else if facts.runState == "starting" {
            return "正在启动"
        }
        if facts.taskStatus == "waiting_device" { return "等待电脑接受" }
        if facts.runState == "running" || facts.taskStatus == "running" {
            return facts.taskProgressEnabled ? "执行中" : "正在执行"
        }
        if facts.taskStatus == "paused" { return "已暂停" }
        if facts.taskStatus == "pausing" { return "正在暂停" }
        if facts.taskStatus == "awaiting_review" { return "待验收" }
        return "等待最新进展"
    }
}

public struct TaskStageRecord: Equatable, Sendable {
    public var runState: String?
    public var phase: String?
    public var summary: String?
    public var waitingReason: String?
    public var completedCount: Int?
    public var totalCount: Int?
    public var lastProgressAt: Date?
    public var version: Int?
    public init() {}
}

public enum ConnectionPresentation {
    public static func banner(downSince: Date?, now: Date, unauthorized: Bool) -> String? {
        if unauthorized { return "登录已失效，请重新登录" }
        guard let downSince, now.timeIntervalSince(downSince) >= InteractionTiming.reconnectBannerGrace else { return nil }
        return "与服务端的连接已中断，正在重连"
    }
}

public struct PendingControl: Codable, Equatable, Sendable, Identifiable {
    public var id: String { idempotencyKey }
    public var idempotencyKey: String
    public var taskId: String
    public var action: String
    public var version: Int?
    public var body: [String: JSONValue]
    public var phase: String
    public var notice: String
    public init(idempotencyKey: String, taskId: String, action: String, version: Int?, body: [String: JSONValue], phase: String, notice: String) {
        self.idempotencyKey = idempotencyKey
        self.taskId = taskId
        self.action = action
        self.version = version
        self.body = body
        self.phase = phase
        self.notice = notice
    }
}

public struct FastChoice: Identifiable, Equatable, Sendable {
    public var id: String
    public var action: String
    public var choices: [FastTaskRef]
    public var original: String
    public init(action: String, choices: [FastTaskRef], original: String) {
        self.id = UUID().uuidString
        self.action = action
        self.choices = choices
        self.original = original
    }
}

public struct InteractionScope: Equatable, Sendable, Codable {
    public var server: String
    public var userId: String
    public init(server: String, userId: String) {
        self.server = server
        self.userId = userId
    }
    public var storageKey: String {
        let basis = server + "\n" + userId
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in basis.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        let allowed = CharacterSet.alphanumerics
        let prefix = String(server.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }.prefix(32))
        return "\(prefix)_\(String(hash, radix: 16))"
    }
}
