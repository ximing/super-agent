import XCTest
@testable import SuperAgentCore

final class ObservationRuleTests: XCTestCase {
    func testNonEmptyObservationRuleDecodesLastStatusAndSuggestionReason() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let item = #"{"id":"rule-page","title":"页面","enabled":true,"version":3,"last_status":"matched","config_version":1,"suggestions":[{"id":"suggestion-1","status":"pending","reason":"条件成立。实际记忆范围\n项目 不限"}]}"#
        let rule = try decoder.decode(ObservationRuleItem.self, from: Data(item.utf8))
        XCTAssertEqual(rule.id, "rule-page")
        XCTAssertEqual(rule.title, "页面")
        XCTAssertTrue(rule.enabled)
        XCTAssertEqual(rule.version, 3)
        XCTAssertEqual(rule.lastStatus, "matched")
        XCTAssertEqual(rule.suggestions.count, 1)
        XCTAssertEqual(rule.suggestions[0].id, "suggestion-1")
        XCTAssertEqual(rule.suggestions[0].status, "pending")
        XCTAssertEqual(rule.suggestions[0].reason, "条件成立。实际记忆范围\n项目 不限")
        let list = try decoder.decode(Items<ObservationRuleItem>.self, from: Data("{\"items\":[\(item)]}".utf8))
        XCTAssertEqual(list.items.first?.lastStatus, "matched")
        XCTAssertEqual(list.items.first?.suggestions.first?.reason, "条件成立。实际记忆范围\n项目 不限")
    }
}
