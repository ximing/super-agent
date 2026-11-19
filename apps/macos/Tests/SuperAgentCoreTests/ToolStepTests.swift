import Foundation
import XCTest
@testable import SuperAgentCore

final class ToolStepTests: XCTestCase {
    func testSafeStepPresentationIgnoresRawPayloadAndPreservesUnknownOutcome() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let json = """
        {"id":"step-fixture","run_id":"run-fixture","tool":"memory_search","title":"private-fixture","status":"result_unknown","started_at":"2026-11-19T01:00:00.123Z","completed_at":"2026-11-19T01:00:01Z","created_at":"2026-11-19T01:00:00Z","error_code":"result_unknown","version":2,"arguments":{"query":"private-fixture"},"result":"private-fixture","error_message":"private-fixture"}
        """
        let step = try decoder.decode(ToolStep.self, from: Data(json.utf8))
        XCTAssertEqual(step.displayTitle, "检索记忆")
        XCTAssertEqual(step.statusTitle, "结果待核对")
        XCTAssertFalse((step.errorMessage ?? "").contains("private-fixture"))
        XCTAssertTrue((step.errorMessage ?? "").contains("核对"))
        XCTAssertNotNil(step.startDate); XCTAssertNotNil(step.completionDate)
        XCTAssertLessThan(step.startDate!, step.completionDate!)
    }
    func testUnrecognizedToolAndErrorNeverRenderArbitraryServerStrings() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let step = try decoder.decode(ToolStep.self, from: Data("{\"id\":\"x\",\"run_id\":\"y\",\"tool\":\"private-fixture\",\"status\":\"private-fixture\",\"started_at\":null,\"completed_at\":null,\"created_at\":\"invalid\",\"error_code\":\"private-fixture\",\"version\":1}".utf8))
        XCTAssertEqual(step.displayTitle, "其他工具")
        XCTAssertEqual(step.statusTitle, "状态待确认")
        XCTAssertFalse((step.errorMessage ?? "").contains("private-fixture"))
        XCTAssertNil(step.startDate)
    }
}
