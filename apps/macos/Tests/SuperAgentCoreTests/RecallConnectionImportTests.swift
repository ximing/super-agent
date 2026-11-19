import Foundation
import XCTest
@testable import SuperAgentCore
final class RecallConnectionImportTests: XCTestCase {
    func testLocalJSONImportHasNoNetworkOrAutomaticBinding() throws {
        let value = try RecallConnectionImport.decode(Data("{\"url\":\"https://recall.example\",\"token\":\"fixture-token\"}".utf8))
        XCTAssertEqual(value.url, "https://recall.example"); XCTAssertEqual(value.token, "fixture-token")
    }
    func testInvalidURLFormatAndOversizedInputUseFixedErrorsWithoutEchoingContent() {
        let invalid = ["not-json", "{\"url\":\"https://recall.example\"}", "{\"url\":\"http://recall.example\",\"token\":\"private-fixture\"}", "{\"url\":\"https://user:password@recall.example\",\"token\":\"private-fixture\"}", "{\"url\":\"https://recall.example?token=private-fixture\",\"token\":\"private-fixture\"}", "{\"url\":\"https://recall.example\",\"token\":\"line\\nprivate-fixture\"}"]
        for input in invalid {
            XCTAssertThrowsError(try RecallConnectionImport.decode(Data(input.utf8))) { error in XCTAssertFalse(error.localizedDescription.contains("private-fixture")); XCTAssertFalse(error.localizedDescription.contains("password@")) }
        }
        XCTAssertThrowsError(try RecallConnectionImport.decode(Data(repeating: 0, count: RecallConnectionImport.maximumBytes + 1))) { error in XCTAssertEqual((error as? APIError)?.code, "recall_import_size") }
    }
}
