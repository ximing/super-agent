import Foundation
import XCTest
@testable import SuperAgentCore

final class OIDCCallbackTests: XCTestCase {
    private let redirect = URL(string: "superagent://oauth/callback")!
    func testValidCodeAndExplicitDenial() throws {
        XCTAssertEqual(try OIDCCallbackParser.parse(URL(string: "superagent://oauth/callback?state=expected&code=fixture")!, redirect: redirect, state: "expected"), .authorizationCode("fixture"))
        XCTAssertEqual(try OIDCCallbackParser.parse(URL(string: "superagent://oauth/callback?state=expected&error=access_denied")!, redirect: redirect, state: "expected"), .denied)
    }
    func testRejectsWrongStateRedirectFragmentsAndAmbiguousParameters() {
        let invalid = [
            "superagent://oauth/callback?state=old&code=fixture",
            "other://oauth/callback?state=expected&code=fixture",
            "superagent://other/callback?state=expected&code=fixture",
            "superagent://oauth/other?state=expected&code=fixture",
            "superagent://oauth:88/callback?state=expected&code=fixture",
            "superagent://oauth/callback?state=expected&code=fixture#fragment",
            "superagent://oauth/callback?state=expected&state=expected&code=fixture",
            "superagent://oauth/callback?state=expected&code=fixture&code=another",
            "superagent://oauth/callback?state=expected&code=fixture&error=access_denied",
            "superagent://oauth/callback?state=expected&code=",
            "superagent://oauth/callback?code=fixture",
            "superagent://user@oauth/callback?state=expected&code=fixture"
        ]
        for value in invalid { XCTAssertThrowsError(try OIDCCallbackParser.parse(URL(string: value)!, redirect: redirect, state: "expected")) }
    }
    func testUnsolicitedAndConsumedCallbacksNeverCompleteAnotherLogin() throws {
        let current = URL(string: "superagent://oauth/callback?state=expected&code=fixture")!
        var absent = OIDCPendingCallback()
        XCTAssertNil(try absent.accept(current))
        var pending = OIDCPendingCallback(redirect: redirect, state: "expected")
        XCTAssertThrowsError(try pending.accept(URL(string: "superagent://oauth/callback?state=old&code=fixture")!))
        XCTAssertEqual(try pending.accept(current), .authorizationCode("fixture"))
        XCTAssertNil(try pending.accept(current))
    }
}
