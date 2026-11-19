import Foundation
import XCTest
@testable import SuperAgentCore
final class TaskGraphTests: XCTestCase {
    private func task(_ id: String, parent: String? = nil, dependencies: [String] = []) throws -> AgentTask {
        var value: [String:Any] = ["id":id,"title":id,"goal":id,"status":"blocked","reason_code":NSNull(),"engine":"codex","model_id":NSNull(),"device_id":NSNull(),"current_run_id":NSNull(),"created_at":"2026-11-19T01:00:00Z","updated_at":"2026-11-19T01:00:00Z","version":1,"depends_on_task_ids":dependencies]
        if let parent { value["parent_task_id"] = parent }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(AgentTask.self, from: JSONSerialization.data(withJSONObject: value))
    }
    func testDependenciesNeverBecomeParentLinksAndMissingParentsStayVisible() throws {
        let a = try task("a"), b = try task("b", parent: "a"), c = try task("c", dependencies: ["a", "not-loaded"]), orphan = try task("orphan", parent: "missing")
        let rows = TaskGraph.entries([c,b,a,orphan])
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows.first(where: { $0.id == "c" })?.depth, 0)
        XCTAssertEqual(rows.first(where: { $0.id == "b" })?.depth, 1)
        XCTAssertEqual(rows.first(where: { $0.id == "orphan" })?.parentUnavailable, true)
        let related = TaskGraph.relationships(for: c, loaded: [a,b,c,orphan])
        XCTAssertTrue(related.ancestors.isEmpty); XCTAssertEqual(related.dependencies.count, 2)
        XCTAssertNil(related.dependencies.first(where: { $0.id == "not-loaded" })?.task)
    }
    func testCyclesAndDeepLoadedTreesRemainFiniteWithoutHidingTasks() throws {
        let a = try task("a", parent: "b"), b = try task("b", parent: "a")
        XCTAssertEqual(TaskGraph.entries([a,b]).count, 2)
        XCTAssertTrue(TaskGraph.relationships(for: a, loaded: [a,b]).incompleteAncestors)
        let chain = try (0..<12).map { index in try task("n\(index)", parent: index == 0 ? nil : "n\(index-1)") }
        let rows = TaskGraph.entries(chain)
        XCTAssertEqual(rows.count, 12); XCTAssertTrue(rows.allSatisfy { $0.depth <= 3 }); XCTAssertTrue(rows.last!.relationUncertain)
    }
}
