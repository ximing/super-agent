import Foundation

public struct AppliedStreamEvent: Equatable, Sendable {
    public let streamSeq: String
    public let eventId: String?
    public let type: String
    public let taskId: String?
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
            guard compareSeq(seq, cursor) > 0 else { return }
            cursor = seq
            let type = (object["type"] as? String) ?? currentEvent ?? ""
            let taskId = (object["task_id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            applied.append(AppliedStreamEvent(streamSeq: seq, eventId: eventId, type: type, taskId: taskId))
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

    static func compareSeq(_ lhs: String, _ rhs: String) -> Int {
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
}
