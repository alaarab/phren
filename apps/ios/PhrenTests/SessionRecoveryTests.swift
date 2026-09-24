import XCTest
@testable import PhrenKit
@testable import Phren

/// Exercises the real app bootstrap with isolated credentials, cached files,
/// pending edits, and a URLSession that never reaches the network.
@MainActor
final class SessionRecoveryTests: XCTestCase {
    private var root: URL!
    private var defaults: UserDefaults!
    private var suite: String!
    private var saved: KeychainStore.StoredToken?
    private var deletes = 0
    private var models: [AppModel] = []
    private let descriptor = StoreDescriptor(owner: "sample", name: "brain", branch: "main", canPush: true)

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        suite = "phren.auth-tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        defaults.set(try JSONEncoder().encode([descriptor]), forKey: "phren.stores")
        saved = try JSONDecoder().decode(KeychainStore.StoredToken.self, from: Data(
            #"{"token":"fixture-token","kind":"pat","user":{"login":"sample","name":"Sample"}}"#.utf8))
        let directory = root.appendingPathComponent(descriptor.id)
        let store = try LocalStore(rootDirectory: directory, owner: "sample", repo: "brain", branch: "main")
        try await store.write("demo/FINDINGS.md", content: "# Findings\n\n- Saved before the elevator\n", blobSha: nil)
        // Enqueued operations have already been applied to the local files.
        try await store.write("demo/tasks.md", content: "# Tasks\n\n## Queue\n- [ ] An unsynced task\n", blobSha: nil)
        var queue = PendingOpsQueue()
        queue.pending = [QueuedOp(op: .addTask(project: "demo", text: "An unsynced task"))]
        try JSONEncoder().encode(queue).write(to: directory.appendingPathComponent("pending-ops.json"))
        SessionURLProtocol.configure(.failure(.notConnectedToInternet))
    }

    override func tearDown() async throws {
        for model in models {
            await model.enterBackground()
            for context in model.storeContexts {
                await context.engine.setOnUpdate({ _ in })
                await context.engine.setAutoFlush(false)
                await context.engine.flushNow()
            }
        }
        models.removeAll()
        SessionURLProtocol.configure(.failure(.cancelled))
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
    }

    private func makeModel() -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionURLProtocol.self]
        let model = AppModel(client: GitHubClient(session: URLSession(configuration: configuration)),
                             credentials: .init(load: { self.saved }, save: { self.saved = $0 },
                                                delete: { self.saved = nil; self.deletes += 1 }),
                             storageDefaults: defaults, storeDirectory: root)
        models.append(model)
        return model
    }

    private func assertCachedSession(_ model: AppModel, file: StaticString = #filePath, line: UInt = #line) async {
        XCTAssertEqual(model.phase, .ready, file: file, line: line)
        XCTAssertEqual(model.mergedProjects.map(\.project.name), ["demo"], file: file, line: line)
        XCTAssertEqual(saved?.token, "fixture-token", file: file, line: line)
        XCTAssertEqual(deletes, 0, file: file, line: line)
        let pending = await model.storeContexts.first?.engine.pendingOps()
        XCTAssertEqual(pending?.map(\.op), [.addTask(project: "demo", text: "An unsynced task")], file: file, line: line)
    }

    func testOfflineRelaunchKeepsCredentialCachedIdentityAndPendingWork() async {
        let first = makeModel()
        await first.bootstrap()
        await assertCachedSession(first)
        XCTAssertEqual(first.user?.login, "sample")
        await first.enterBackground()
        let relaunched = makeModel()
        await relaunched.bootstrap()
        await assertCachedSession(relaunched)
    }

    func testStatusRefreshesKeepSearchIndexAndExternalEditsRefreshIt() async throws {
        let model = makeModel()
        await model.bootstrap()
        await model.enterBackground()
        await model.refresh()
        let revision = model.searchRevision
        async let first: Void = model.refresh()
        async let second: Void = model.refresh()
        _ = await (first, second)
        XCTAssertEqual(revision, model.searchRevision)
        let other = try LocalStore(rootDirectory: root.appendingPathComponent(descriptor.id), owner: "sample", repo: "brain", branch: "main")
        try await other.write("demo/FINDINGS.md", content: "# Findings\n- Freshly searchable pineapple\n", blobSha: nil)
        await model.refresh()
        XCTAssertNotEqual(revision, model.searchRevision)
        XCTAssertEqual(model.searchIndex.search("pineapple").count, 1)
        await model.signOut()
        await model.refresh()
        XCTAssertTrue(model.searchIndex.search("pineapple").isEmpty)
    }

    func testTransientErrorsNeverSignOut() async {
        let failures: [SessionURLProtocol.Response] = [
            .failure(.timedOut), .failure(.networkConnectionLost), .failure(.cannotFindHost),
            .failure(.cancelled), .http(403), .http(429), .http(500), .http(503), .malformed,
        ]
        for failure in failures {
            SessionURLProtocol.configure(failure)
            let model = makeModel()
            await model.bootstrap()
            await assertCachedSession(model)
            await model.enterBackground()
        }
    }

    func testCachedProjectsOpenBeforeAccountRequestFinishes() async {
        let requested = expectation(description: "Account request is stalled")
        SessionURLProtocol.configure(.held, onRequest: { requested.fulfill() })
        let model = makeModel()
        let bootstrap = Task { await model.bootstrap() }
        await fulfillment(of: [requested], timeout: 3)
        await assertCachedSession(model)
        SessionURLProtocol.releaseHeld(with: .failure(.timedOut))
        await bootstrap.value
        await assertCachedSession(model)
    }

    func testLegacyCredentialRecoversIdentityWhenReceptionReturns() async {
        saved = KeychainStore.StoredToken(token: "fixture-token", kind: .pat)
        let model = makeModel()
        await model.bootstrap()
        await assertCachedSession(model)
        XCTAssertNil(model.user)
        SessionURLProtocol.configure(.http(200))
        await model.enterForeground()
        XCTAssertEqual(model.user?.login, "sample")
        XCTAssertEqual(saved?.user?.login, "sample")
        XCTAssertEqual(model.phase, .ready)
    }

    func testRejectedTokenRequestsSignInAndReauthenticationRestoresStores() async throws {
        SessionURLProtocol.configure(.http(401))
        let model = makeModel()
        await model.bootstrap()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(saved)
        XCTAssertEqual(deletes, 1)
        XCTAssertNotNil(model.authenticationMessage)
        XCTAssertEqual(model.storeDescriptors, [descriptor])
        SessionURLProtocol.configure(.http(200))
        try await model.signIn(token: "replacement-token", kind: .pat)
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(model.storeDescriptors, [descriptor])
        XCTAssertNil(model.authenticationMessage)
        let pending = await model.storeContexts.first?.engine.pendingOps()
        XCTAssertEqual(pending?.count, 1)
        XCTAssertEqual(saved?.token, "replacement-token")
    }

    func testLateAccountResponseCannotUndoExplicitSignOut() async {
        let requested = expectation(description: "Account request is stalled")
        SessionURLProtocol.configure(.held, onRequest: { requested.fulfill() })
        let model = makeModel()
        let bootstrap = Task { await model.bootstrap() }
        await fulfillment(of: [requested], timeout: 3)
        await model.signOut()
        SessionURLProtocol.releaseHeld(with: .http(200))
        await bootstrap.value
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertNil(saved)
        XCTAssertNil(model.user)
        XCTAssertTrue(model.storeContexts.isEmpty)
    }

    func testOldRejectionCannotEraseAReplacementSignIn() async throws {
        let requested = expectation(description: "Old account request is stalled")
        SessionURLProtocol.configure(.held, onRequest: { requested.fulfill() })
        let model = makeModel()
        let bootstrap = Task { await model.bootstrap() }
        await fulfillment(of: [requested], timeout: 3)
        SessionURLProtocol.configure(.http(200))
        try await model.signIn(token: "replacement-token", kind: .pat)
        SessionURLProtocol.releaseHeld(with: .http(401))
        await bootstrap.value
        XCTAssertEqual(model.phase, .ready)
        XCTAssertEqual(saved?.token, "replacement-token")
        XCTAssertEqual(deletes, 0)
    }

    func testOfflineRepoPickerDoesNotBecomeSignIn() async {
        defaults.removeObject(forKey: "phren.stores")
        let model = makeModel()
        await model.bootstrap()
        XCTAssertEqual(model.phase, .pickingRepo)
        XCTAssertEqual(saved?.token, "fixture-token")
        XCTAssertEqual(deletes, 0)
    }

    func testNoGitHubCredentialStartsOnAgentsWithoutAccountRequests() async {
        saved = nil
        var requested = false
        SessionURLProtocol.configure(.failure(.notConnectedToInternet), onRequest: { requested = true })
        let model = makeModel()
        await model.bootstrap()
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.selectedTab, .agents)
        XCTAssertFalse(requested)
    }

    func testGitHubSignOutPreservesAgentPreferencesAndCurrentTab() async {
        let connection = Data("saved-agent-connection-fixture".utf8)
        defaults.set(connection, forKey: "sessions.live.preferences.v1")
        let model = makeModel()
        await model.bootstrap()
        model.selectedTab = .agents
        await model.signOut()
        XCTAssertNil(saved)
        XCTAssertEqual(model.phase, .signedOut)
        XCTAssertEqual(model.selectedTab, .agents)
        XCTAssertEqual(defaults.data(forKey: "sessions.live.preferences.v1"), connection)
    }
}

private final class SessionURLProtocol: URLProtocol {
    enum Response { case failure(URLError.Code), http(Int), malformed, held }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var response: Response = .failure(.notConnectedToInternet)
    nonisolated(unsafe) private static var onRequest: (() -> Void)?
    nonisolated(unsafe) private static var held: SessionURLProtocol?

    static func configure(_ value: Response, onRequest: (() -> Void)? = nil) {
        lock.lock(); defer { lock.unlock() }
        response = value
        self.onRequest = onRequest
    }

    static func releaseHeld(with response: Response) {
        lock.lock()
        let pending = held
        held = nil
        lock.unlock()
        pending?.finish(response)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let value = Self.response
        guard request.url?.path == "/user" else {
            Self.lock.unlock()
            if case .failure = value { finish(value) }
            else { finish(.http(503)) }
            return
        }
        let callback = Self.onRequest
        Self.onRequest = nil
        if case .held = value { Self.held = self }
        Self.lock.unlock()
        callback?()
        finish(value)
    }

    private func finish(_ response: Response) {
        switch response {
        case .held: return
        case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .http(let status):
            deliver(status, body: status == 200 ? #"{"login":"sample","name":"Sample"}"# : #"{"message":"Fixture failure"}"#)
        case .malformed: deliver(200, body: "not JSON")
        }
    }

    private func deliver(_ status: Int, body: String) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
