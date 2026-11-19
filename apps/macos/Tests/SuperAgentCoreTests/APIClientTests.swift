import XCTest
import Foundation
@testable import SuperAgentCore

final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do { let (status, data) = try Self.handler!(request); let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!; client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed); client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self) }
        catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
final class APIClientTests: XCTestCase {
    private func makeClient() -> APIClient { let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [StubProtocol.self]; return APIClient(baseURL: URL(string: "https://agent.example")!, transport: URLSession(configuration: config), persistSession: false) }
    private func session(_ token: String = "test-access") -> Session { Session(accessToken: token, refreshToken: "test-refresh", expiresIn: 600, user: User(id: "u", email: "test@example.com", name: "Test", tenantId: "t")) }
    func testServerAddressRejectsCredentialsAndRemoteHTTP() throws {
        for value in ["http://public.example", "https://user:secret@agent.example", "https://agent.example/path", "https://agent.example?token=value", "not a url"] { XCTAssertThrowsError(try APIClient.validatedURL(value)) }
        XCTAssertEqual(try APIClient.validatedURL(" https://agent.example/ ").absoluteString, "https://agent.example")
        XCTAssertEqual(try APIClient.validatedURL("http://127.0.0.1:8787").host, "127.0.0.1")
    }
    func testRequestHasVersionAndStableIdempotencyAcrossRefresh() async throws {
        let client = makeClient(); try await client.setSession(session())
        var calls = 0; var firstKey: String?
        StubProtocol.handler = { request in
            calls += 1
            if request.url!.path == "/v1/auth/refresh" {
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, Data("{\"access_token\":\"renewed\",\"refresh_token\":\"next\",\"expires_in\":600,\"user\":{\"id\":\"u\",\"email\":\"test@example.com\",\"name\":\"Test\",\"tenant_id\":\"t\"}}".utf8))
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "\"7\"")
            let key = request.value(forHTTPHeaderField: "Idempotency-Key")
            XCTAssertNotNil(key)
            if calls == 1 { firstKey = key; return (401, Data("{\"error\":{\"code\":\"expired\",\"message\":\"expired\"}}".utf8)) }
            XCTAssertEqual(key, firstKey); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer renewed")
            return (200, Data("{\"ok\":true}".utf8))
        }
        let _: JSONValue = try await client.request("/tasks/id/actions", method: "POST", body: ["action": .string("pause")], version: 7)
        XCTAssertEqual(calls, 3)
    }
    func testConfigurationDoesNotCarryTokenToAnotherOrigin() async throws {
        let client = makeClient(); try await client.setSession(session()); await client.configure(URL(string: "https://other.example")!)
        let stored = await client.currentSession(); XCTAssertNil(stored)
    }
    func testUnknownSubscriptionCostRemainsUnknown() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let summary = try decoder.decode(CostSummary.self, from: Data("{\"totals\":[],\"input_tokens\":200,\"output_tokens\":10,\"unknown_count\":1,\"request_count\":1,\"coverage\":0,\"as_of\":\"2026-11-18T00:00:00Z\"}".utf8))
        XCTAssertTrue(summary.totals.isEmpty); XCTAssertEqual(summary.unknownCount, 1)
    }
    func testBodylessDeletePreservesAuthorizationAndVersionWithoutJSONContentType() async throws {
        let client = makeClient(); try await client.setSession(session())
        var called = false
        StubProtocol.handler = { request in
            called = true
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertNil(request.httpBody)
            XCTAssertNil(request.httpBodyStream)
            XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-access")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "\"12\"")
            return (204, Data())
        }
        let _: EmptyResponse = try await client.request("/memories/test-memory", method: "DELETE", version: 12)
        XCTAssertTrue(called)
    }

    func testDeviceRevocationFetchesFreshVersionAndRejectsConflictingUpdate() async throws {
        let client = makeClient(); try await client.setSession(session())
        var calls = 0
        StubProtocol.handler = { request in
            calls += 1
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-access")
            if request.httpMethod == "GET" {
                XCTAssertEqual(request.url?.path, "/v1/devices")
                return (200, Data("{\"items\":[{\"id\":\"test-device\",\"name\":\"Fixture\",\"status\":\"online\",\"last_seen_at\":null,\"capabilities\":{\"generation\":1,\"engines\":[],\"tools\":[],\"slots\":{\"browser\":1,\"worker\":1}},\"version\":42}]}".utf8))
            }
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/v1/devices/test-device")
            XCTAssertEqual(request.value(forHTTPHeaderField: "If-Match"), "\"42\"")
            XCTAssertNil(request.value(forHTTPHeaderField: "Content-Type"))
            XCTAssertNil(request.httpBody)
            return (409, Data("{\"error\":{\"code\":\"version_conflict\",\"message\":\"Refresh required\"}}".utf8))
        }
        do { try await client.revokeDevice(id: "test-device"); XCTFail("Conflicting revocation must fail rather than silently retry") }
        catch let error as APIError { XCTAssertEqual(error.status, 409); XCTAssertEqual(error.code, "version_conflict") }
        XCTAssertEqual(calls, 2)
    }

}
