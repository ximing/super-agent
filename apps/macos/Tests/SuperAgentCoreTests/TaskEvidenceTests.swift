import Foundation
import XCTest
@testable import SuperAgentCore

final class TaskEvidenceTests: XCTestCase {
    private func evidence(status: String = "awaiting_review") throws -> TaskEvidence {
        let source = """
        {"task":{"id":"task-fixture","title":"Review","goal":"Review","status":"\(status)","reason_code":null,"engine":"codex","model_id":"fixture","device_id":"device-fixture","current_run_id":"run-fixture","created_at":"2026-11-19T01:00:00Z","updated_at":"2026-11-19T01:00:01Z","version":6},"run":{"id":"run-fixture","task_id":"task-fixture","state":"succeeded","engine":"codex","device_id":"device-fixture","model_id":"fixture","lease_epoch":"1","summary":"Execution finished","created_at":"2026-11-19T01:00:00Z"},"delivery":{"id":"delivery-fixture","run_id":"run-fixture","status":"pending","deliverables":["Report"],"artifact_ids":[],"version":1},"deliverables":["Report"],"checkpoint":{"id":"checkpoint-fixture","created_at":"2026-11-19T01:00:01Z"},"steps":[],"artifacts":[]}
        """
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(TaskEvidence.self, from: Data(source.utf8))
    }
    func testAcceptanceRequiresHumanCheckAndActualEvidenceReference() throws {
        let value = try evidence()
        XCTAssertThrowsError(try value.reviewBody(verdict: "accept", summary: "Checked report", passed: [], selected: [0:"checkpoint:checkpoint-fixture"]))
        XCTAssertThrowsError(try value.reviewBody(verdict: "accept", summary: "Checked report", passed: [0], selected: [0:"checkpoint:invented"]))
        let body = try value.reviewBody(verdict: "accept", summary: "Checked report", passed: [0], selected: [0:"checkpoint:checkpoint-fixture"])
        let encoded = try JSONEncoder().encode(body)
        let decoded = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        XCTAssertEqual(decoded["run_id"] as? String, "run-fixture")
        let checks = decoded["checks"] as! [[String: Any]]
        XCTAssertEqual(checks.first?["passed"] as? Bool, true)
        XCTAssertEqual((checks.first?["evidence_refs"] as? [[String:String]])?.first?["id"], "checkpoint-fixture")
    }
    func testCompletedTaskAndEmptyReviewNoteCannotBeAcceptedAgain() throws {
        let completed = try evidence(status: "succeeded")
        XCTAssertFalse(completed.canReview)
        XCTAssertThrowsError(try completed.reviewBody(verdict: "accept", summary: "Checked", passed: [0], selected: [0:"checkpoint:checkpoint-fixture"]))
        XCTAssertThrowsError(try evidence().reviewBody(verdict: "reject", summary: " ", passed: [], selected: [:]))
    }
}
