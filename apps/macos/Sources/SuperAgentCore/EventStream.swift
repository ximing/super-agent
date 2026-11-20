import Foundation

public struct StreamPayloadFacts: Equatable, Sendable {
    public var state: String?
    public var phase: String?
    public var summary: String?
    public var waitingReason: String?
    public var status: String?
    public var reasonCode: String?
    public var actionId: String?
    public var sourceMessageId: String?
    public var completedCount: Int?
    public var totalCount: Int?
    public var version: Int?
    public var lastProgressAt: String?
    public init(state: String? = nil, phase: String? = nil, summary: String? = nil, waitingReason: String? = nil, status: String? = nil, reasonCode: String? = nil, actionId: String? = nil, sourceMessageId: String? = nil, completedCount: Int? = nil, totalCount: Int? = nil, version: Int? = nil, lastProgressAt: String? = nil) {
        self.state = state
        self.phase = phase
        self.summary = summary
        self.waitingReason = waitingReason
        self.status = status
        self.reasonCode = reasonCode
        self.actionId = actionId
        self.sourceMessageId = sourceMessageId
        self.completedCount = completedCount
        self.totalCount = totalCount
        self.version = version
        self.lastProgressAt = lastProgressAt
    }
    public static let empty = StreamPayloadFacts()
}

public struct AppliedStreamEvent: Equatable, Sendable {
    public let streamSeq: String
    public let eventId: String?
    public let type: String
    public let taskId: String?
    public let facts: StreamPayloadFacts
    public init(streamSeq: String, eventId: String?, type: String, taskId: String?, facts: StreamPayloadFacts = .empty) {
        self.streamSeq = streamSeq
        self.eventId = eventId
        self.type = type
        self.taskId = taskId
        self.facts = facts
    }
}

public struct EventStreamConsume: Equatable, Sendable {
    public let applied: [AppliedStreamEvent]
    public let cursor: String
    public let seen: Set<String>
    public let remainder: String
}

public enum EventStreamDecoder {
    public static func consume(_ chunk: String, cursor: String, seen: Set<String> = [], remainder: String = "") -> EventStreamConsume {
        let normalized = (remainder + chunk).replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let ended = normalized.hasSuffix("\n")
        var lines = normalized.components(separatedBy: "\n")
        var rest = ""
        if ended { if !lines.isEmpty { lines.removeLast() } }
        else if !lines.isEmpty { rest = lines.removeLast() }
        var seen = seen
        var cursor = cursor
        var applied: [AppliedStreamEvent] = []
        var id: String?
        var eventName: String?
        var data: [String] = []

        func reset() { id = nil; eventName = nil; data = [] }
        func dispatch() {
            let raw = data.joined(separator: "\n")
            let currentId = id
            let currentEvent = eventName
            reset()
            guard !raw.isEmpty || currentId != nil || currentEvent != nil else { return }
            guard let body = raw.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return }
            let seqFromBody = object["stream_seq"] as? String
            let seq = (seqFromBody.flatMap { $0.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil ? $0 : nil })
                ?? (currentId.flatMap { $0.range(of: #"^\d{1,20}$"#, options: .regularExpression) != nil ? $0 : nil })
            guard let seq else { return }
            let eventId = object["event_id"] as? String
            if seen.contains("seq:\(seq)") || (eventId.map { seen.contains("id:\($0)") } ?? false) { return }
            seen.insert("seq:\(seq)")
            if let eventId { seen.insert("id:\(eventId)") }
            guard compareStreamSeq(seq, cursor) > 0 else { return }
            cursor = seq
            let type = (object["type"] as? String) ?? currentEvent ?? ""
            let taskId = (object["task_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            applied.append(AppliedStreamEvent(streamSeq: seq, eventId: eventId, type: type, taskId: taskId, facts: facts(from: object)))
        }

        for line in lines {
            if line.isEmpty { dispatch(); continue }
            if line.hasPrefix(":") { continue }
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { continue }
            let field = String(line[..<colon])
            var value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
            switch field {
            case "id": id = value
            case "event": eventName = value
            case "data": data.append(value)
            default: break
            }
        }
        var pending = ""
        if let id { pending += "id: \(id)\n" }
        if let eventName { pending += "event: \(eventName)\n" }
        for line in data { pending += "data: \(line)\n" }
        return EventStreamConsume(applied: applied, cursor: cursor, seen: seen, remainder: pending + rest)
    }

    /// Numeric length order. "10" is after "9"; dictionary order is not used.
    public static func compareStreamSeq(_ lhs: String, _ rhs: String) -> Int {
        func normalize(_ value: String) -> String {
            let trimmed = value.drop { $0 == "0" }
            return trimmed.isEmpty ? "0" : String(trimmed)
        }
        let left = normalize(lhs)
        let right = normalize(rhs)
        if left.count != right.count { return left.count < right.count ? -1 : 1 }
        if left == right { return 0 }
        return left < right ? -1 : 1
    }

    static func facts(from object: [String: Any]) -> StreamPayloadFacts {
        let payload = object["payload"] as? [String: Any] ?? [:]
        func text(_ key: String, limit: Int = 180) -> String? {
            guard let raw = (payload[key] as? String) ?? (object[key] as? String) else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            return trimmed.count > limit ? String(trimmed.prefix(limit)) : trimmed
        }
        func whole(_ key: String) -> Int? {
            let value = payload[key] ?? object[key]
            if let number = value as? Int { return number }
            if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() { return number.intValue }
            return nil
        }
        var facts = StreamPayloadFacts()
        facts.state = text("state", limit: 40)
        facts.phase = text("phase", limit: 40)
        facts.summary = text("summary")
        facts.waitingReason = text("waiting_reason", limit: 80)
        facts.status = text("status", limit: 40)
        facts.reasonCode = text("reason_code", limit: 80)
        facts.actionId = text("action_id", limit: 80)
        facts.sourceMessageId = text("source_message_id", limit: 80)
        facts.completedCount = whole("completed_count")
        facts.totalCount = whole("total_count")
        facts.version = whole("version") ?? whole("entity_version")
        facts.lastProgressAt = text("last_progress_at", limit: 40)
        return facts
    }
}
