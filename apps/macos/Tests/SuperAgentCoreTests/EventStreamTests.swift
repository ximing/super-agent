import XCTest
@testable import SuperAgentCore

final class EventStreamTests: XCTestCase {
    func testCursorSurvivesAMalformedLineAndSkipsTheDuplicateSeq() {
        let fixture = [
            "id: 4",
            "event: task.changed",
            "data: {\"event_id\":\"e4\",\"stream_seq\":\"4\",\"type\":\"task.changed\",\"task_id\":\"task-a\"}",
            "",
            "%%%",
            "",
            "id: 5",
            "event: task.changed",
            "data: {\"event_id\":\"e5\",\"stream_seq\":\"5\",\"type\":\"task.changed\",\"task_id\":\"task-b\"}",
            "",
        ].joined(separator: "\n") + "\n"
        let cut = fixture.range(of: "\"stream_seq\":\"5\"")!.lowerBound
        let offset = fixture.distance(from: fixture.startIndex, to: cut) + 4
        let index = fixture.index(fixture.startIndex, offsetBy: offset)
        let first = EventStreamDecoder.consume(String(fixture[..<index]), cursor: "4")
        XCTAssertEqual(first.cursor, "4")
        XCTAssertTrue(first.applied.isEmpty)
        let second = EventStreamDecoder.consume(String(fixture[index...]), cursor: first.cursor, seen: first.seen, remainder: first.remainder)
        XCTAssertEqual(second.applied.map(\.streamSeq), ["5"])
        XCTAssertEqual(second.cursor, "5")
        XCTAssertEqual(second.applied.first?.eventId, "e5")
        XCTAssertEqual(second.applied.first?.taskId, "task-b")
        let replay = EventStreamDecoder.consume(fixture, cursor: second.cursor, seen: second.seen)
        XCTAssertTrue(replay.applied.isEmpty)
        XCTAssertEqual(replay.cursor, "5")
    }
}
