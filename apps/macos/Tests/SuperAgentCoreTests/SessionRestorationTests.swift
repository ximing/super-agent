import XCTest
import Security
@testable import SuperAgentCore

private final class StorageProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var reads = 0, writes = 0, removes = 0, mainReads = 0
    private var interactions: [Bool] = []
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    let blocking: Bool
    let needsInteraction: Bool
    let loaded: Session
    init(blocking: Bool = false, needsInteraction: Bool = false) {
        self.blocking = blocking; self.needsInteraction = needsInteraction
        self.loaded = Session(accessToken: "saved-fixture", refreshToken: "saved-refresh", expiresIn: 600, user: User(id: "fixture", email: "fixture@example.com", name: "Fixture", tenantId: "fixture"))
    }
    var counts: (reads: Int, writes: Int, removes: Int, mainReads: Int, interactions: [Bool]) { lock.withLock { (reads, writes, removes, mainReads, interactions) } }
    var storage: SessionStorage { SessionStorage(read: { [self] _, allow in
        lock.withLock { reads += 1; if Thread.isMainThread { mainReads += 1 }; interactions.append(allow) }
        entered.signal()
        if blocking, release.wait(timeout: .now() + 5) != .success { throw APIError(status: 0, code: "fixture_timeout", message: "fixture timeout") }
        if needsInteraction && !allow { throw SecureSessionStore.StoreError(errSecInteractionNotAllowed) }
        return loaded
    }, write: { [self] _, _ in lock.withLock { writes += 1 } }, remove: { [self] _ in lock.withLock { removes += 1 } }) }
    func waitUntilEntered() async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async { continuation.resume(returning: self.entered.wait(timeout: .now() + 3) == .success) }
        }
    }
}

final class SessionRestorationTests: XCTestCase {
    private let origin = URL(string: "https://fixture.example")!
    private func freshSession() -> Session { Session(accessToken: "new-login", refreshToken: "new-refresh", expiresIn: 600, user: User(id: "new", email: "new@example.com", name: "New", tenantId: "new")) }

    func testConstructionAndConfigurationNeverReadStorageAndDisabledPersistenceNeverTouchesIt() async throws {
        let probe = StorageProbe(blocking: true)
        let client = APIClient(baseURL: origin, sessionStorage: probe.storage)
        XCTAssertEqual(probe.counts.reads, 0, "constructing the scene must not touch Keychain")
        await client.configure(URL(string: "https://other.example")!)
        XCTAssertEqual(probe.counts.reads, 0, "server configuration must not trigger hidden authentication UI")
        let disabled = APIClient(baseURL: origin, persistSession: false, sessionStorage: probe.storage)
        let restored = try await disabled.restoreSession(allowInteraction: true); XCTAssertNil(restored)
        try await disabled.setSession(freshSession()); await disabled.clearSession()
        XCTAssertEqual(probe.counts.reads, 0); XCTAssertEqual(probe.counts.writes, 0); XCTAssertEqual(probe.counts.removes, 0)
    }

    func testConcurrentRestorationSharesOneBackgroundReadAndDoesNotBlockTheActor() async throws {
        let probe = StorageProbe(blocking: true)
        let restoring = APIClient(baseURL: origin, sessionStorage: probe.storage)
        let first = Task { try await restoring.restoreSession() }
        let entered = await probe.waitUntilEntered(); XCTAssertTrue(entered)
        let second = Task { try await restoring.restoreSession() }
        let before = await restoring.currentSession(); XCTAssertNil(before)
        XCTAssertEqual(probe.counts.reads, 1); XCTAssertEqual(probe.counts.mainReads, 0)
        probe.release.signal()
        let a = try await first.value, b = try await second.value
        XCTAssertEqual(a?.accessToken, "saved-fixture"); XCTAssertEqual(b?.accessToken, "saved-fixture")
        _ = try await restoring.restoreSession(); XCTAssertEqual(probe.counts.reads, 1)
        XCTAssertEqual(probe.counts.interactions, [false])
    }

    func testLateSavedSessionCannotOverwriteANewerLoginOrCrossAnOriginChange() async throws {
        let probe = StorageProbe(blocking: true), client = APIClient(baseURL: origin, sessionStorage: probe.storage)
        let pending = Task { try await client.restoreSession() }
        let entered = await probe.waitUntilEntered(); XCTAssertTrue(entered)
        try await client.setSession(freshSession())
        probe.release.signal(); let result = try await pending.value
        let current = await client.currentSession()
        XCTAssertEqual(result?.accessToken, "new-login"); XCTAssertEqual(current?.accessToken, "new-login")
        XCTAssertEqual(probe.counts.writes, 1); XCTAssertEqual(probe.counts.removes, 0)

        let other = StorageProbe(blocking: true), changed = APIClient(baseURL: origin, sessionStorage: other.storage)
        let oldRead = Task { try await changed.restoreSession() }
        let otherEntered = await other.waitUntilEntered(); XCTAssertTrue(otherEntered)
        await changed.configure(URL(string: "https://other.example")!)
        other.release.signal(); let oldResult = try await oldRead.value
        let changedSession = await changed.currentSession()
        XCTAssertNil(oldResult); XCTAssertNil(changedSession); XCTAssertEqual(other.counts.removes, 0)
    }

    func testNoninteractiveAccessFailureIsCachedUntilExplicitRestoreWithoutDeletingCredentials() async throws {
        let probe = StorageProbe(needsInteraction: true), client = APIClient(baseURL: origin, sessionStorage: probe.storage)
        for _ in 0..<2 {
            do { _ = try await client.restoreSession(); XCTFail("automatic restore must not request system authentication") }
            catch let error as APIError { XCTAssertEqual(error.code, "session_access_required") }
        }
        XCTAssertEqual(probe.counts.reads, 1); XCTAssertEqual(probe.counts.removes, 0)
        let restored = try await client.restoreSession(allowInteraction: true)
        XCTAssertEqual(restored?.accessToken, "saved-fixture"); XCTAssertEqual(probe.counts.interactions, [false, true])
        XCTAssertEqual(probe.counts.mainReads, 0); XCTAssertEqual(probe.counts.removes, 0)
    }

    func testSkippingAnUncancellableReadNeverStartsASecondReadAndItsLateResultIsDiscarded() async throws {
        let probe = StorageProbe(blocking: true), client = APIClient(baseURL: origin, sessionStorage: probe.storage)
        let pending = Task { try await client.restoreSession() }
        let entered = await probe.waitUntilEntered(); XCTAssertTrue(entered)
        await client.cancelSessionRestoration()
        do { _ = try await client.restoreSession(allowInteraction: true); XCTFail("must not start another blocked Keychain read") }
        catch let error as APIError { XCTAssertEqual(error.code, "session_restore_pending") }
        XCTAssertEqual(probe.counts.reads, 1); XCTAssertEqual(probe.counts.removes, 0)
        probe.release.signal(); let stale = try await pending.value
        XCTAssertNil(stale)
        // The slot is reusable only after the actual original read returns.
        probe.release.signal(); let retried = try await client.restoreSession(allowInteraction: true)
        XCTAssertEqual(retried?.accessToken, "saved-fixture"); XCTAssertEqual(probe.counts.reads, 2)
    }
}
