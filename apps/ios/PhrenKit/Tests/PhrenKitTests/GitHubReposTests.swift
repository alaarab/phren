import XCTest
@testable import PhrenKit

/// Repo discovery for the onboarding picker: paging past the first 100 repos,
/// and telling "not a phren store" apart from "your token can't see it".
final class GitHubReposTests: XCTestCase {
    private func makeClient() -> GitHubClient {
        GitHubClient(session: StubURLProtocol.session(), token: "test-token")
    }

    private func repoJSON(id: Int, name: String) -> String {
        """
        {"id":\(id),"full_name":"octo/\(name)","name":"\(name)","owner":{"login":"octo"},
         "private":true,"default_branch":"main","pushed_at":"2026-07-26T00:00:00Z",
         "permissions":{"push":true}}
        """
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    override func tearDown() {
        StubURLProtocol.reset()
        super.tearDown()
    }

    // MARK: - Pagination

    func testListAllReposFollowsPagesUntilAShortOne() async throws {
        StubURLProtocol.stub("&page=1", status: 200,
                             body: "[\(repoJSON(id: 1, name: "a")),\(repoJSON(id: 2, name: "b"))]")
        StubURLProtocol.stub("&page=2", status: 200,
                             body: "[\(repoJSON(id: 3, name: "c")),\(repoJSON(id: 4, name: "d"))]")
        StubURLProtocol.stub("&page=3", status: 200, body: "[\(repoJSON(id: 5, name: "e"))]")

        let repos = try await makeClient().listAllRepos(maxPages: 5, perPage: 2)
        XCTAssertEqual(repos.map(\.name), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(StubURLProtocol.requests.count, 3, "stops at the short page")
    }

    func testListAllReposStopsAtTheCap() async throws {
        StubURLProtocol.stub("&page=1", status: 200,
                             body: "[\(repoJSON(id: 1, name: "a")),\(repoJSON(id: 2, name: "b"))]")
        StubURLProtocol.stub("&page=2", status: 200,
                             body: "[\(repoJSON(id: 3, name: "c")),\(repoJSON(id: 4, name: "d"))]")
        StubURLProtocol.stub("&page=3", status: 200,
                             body: "[\(repoJSON(id: 5, name: "e")),\(repoJSON(id: 6, name: "f"))]")

        let repos = try await makeClient().listAllRepos(maxPages: 2, perPage: 2)
        XCTAssertEqual(repos.count, 4)
        XCTAssertEqual(StubURLProtocol.requests.count, 2)
    }

    // MARK: - Store probe

    func testProbeStoreDetectsAStore() async {
        StubURLProtocol.stub("contents/phren.root.yaml", status: 200, body: #"{"sha":"abc"}"#)
        let probe = await makeClient().probeStore(owner: "octo", name: "phren-store")
        XCTAssertEqual(probe, .isStore)
    }

    func testProbeStoreSeparatesNotAStoreFromNoAccess() async {
        StubURLProtocol.stub("contents/phren.root.yaml", status: 404,
                             body: #"{"message":"Not Found"}"#)
        StubURLProtocol.stub("repos/octo/plain-repo", status: 200,
                             body: repoJSON(id: 9, name: "plain-repo"))
        let visible = await makeClient().probeStore(owner: "octo", name: "plain-repo")
        XCTAssertEqual(visible, .notStore, "a readable repo without the manifest is simply not a store")

        StubURLProtocol.reset()
        StubURLProtocol.stub("contents/phren.root.yaml", status: 404,
                             body: #"{"message":"Not Found"}"#)
        StubURLProtocol.stub("repos/octo/private-store", status: 404,
                             body: #"{"message":"Not Found"}"#)
        let hidden = await makeClient().probeStore(owner: "octo", name: "private-store")
        XCTAssertEqual(hidden, .noAccess, "404 on the repo itself means the token can't read it")
    }

    func testProbeStoreReportsBadCredentialsAsNoAccess() async {
        StubURLProtocol.stub("contents/phren.root.yaml", status: 401,
                             body: #"{"message":"Bad credentials"}"#)
        let probe = await makeClient().probeStore(owner: "octo", name: "phren-store")
        XCTAssertEqual(probe, .noAccess)
    }

    func testKnownVisibleRepoProbeCostsOneRequest() async {
        StubURLProtocol.stub("contents/phren.root.yaml", status: 404,
                             body: #"{"message":"Not Found"}"#)
        let repo = GitHubRepo(id: 1, fullName: "octo/plain", name: "plain",
                              owner: .init(login: "octo"), isPrivate: true,
                              defaultBranch: "main", pushedAt: nil, permissions: nil)
        let probe = await makeClient().probeStore(repo)
        XCTAssertEqual(probe, .notStore)
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
    }
}
