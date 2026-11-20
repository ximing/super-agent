import XCTest
@testable import SuperAgentCore

final class ConversationOrderTests: XCTestCase {
    func testOlderPlanStaysAboveALaterQuestion() {
        let slots = assistantThreadSlots(
            messages: [
                (id: "review", createdAt: "2026-11-20T03:16:00Z"),
                (id: "question", createdAt: "2026-11-20T03:21:00Z"),
            ],
            plan: (id: "task", createdAt: "2026-11-20T03:10:00Z")
        )
        XCTAssertEqual(slots.map(\.id), ["task", "review", "question"])
        XCTAssertEqual(slots.map(\.kind), [.plan, .message, .message])
    }

    func testPlanFollowsTheMessageThatCreatedIt() {
        let slots = assistantThreadSlots(
            messages: [(id: "question", createdAt: "2026-11-20T03:21:00Z")],
            plan: (id: "task", createdAt: "2026-11-20T03:21:05Z")
        )
        XCTAssertEqual(slots.map(\.id), ["question", "task"])
    }
}
