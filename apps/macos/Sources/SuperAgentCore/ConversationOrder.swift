import Foundation

public struct AssistantThreadSlot: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case message, plan }
    public let kind: Kind
    public let id: String
    public init(kind: Kind, id: String) { self.kind = kind; self.id = id }
}

/// Oldest first. A selected plan sits at the task's creation time, not after later messages.
public func assistantThreadSlots(messages: [(id: String, createdAt: String)], plan: (id: String, createdAt: String)? = nil) -> [AssistantThreadSlot] {
    let sorted = messages.sorted { chatInstant($0.createdAt) < chatInstant($1.createdAt) }
    guard let plan else { return sorted.map { AssistantThreadSlot(kind: .message, id: $0.id) } }
    let planTime = chatInstant(plan.createdAt)
    var slots: [AssistantThreadSlot] = []
    var placed = false
    for message in sorted {
        if !placed, chatInstant(message.createdAt) > planTime {
            slots.append(AssistantThreadSlot(kind: .plan, id: plan.id))
            placed = true
        }
        slots.append(AssistantThreadSlot(kind: .message, id: message.id))
    }
    if !placed { slots.append(AssistantThreadSlot(kind: .plan, id: plan.id)) }
    return slots
}

private func chatInstant(_ value: String) -> Date {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    if let date = ISO8601DateFormatter().date(from: value) { return date }
    return .distantPast
}
