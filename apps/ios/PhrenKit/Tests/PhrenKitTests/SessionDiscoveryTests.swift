import XCTest
@testable import PhrenKit

final class SessionDiscoveryTests: XCTestCase {
    private let project = SessionProject(storeID: "personal/brain", name: "phren")

    func testDirectoryRecognitionHandlesSubfoldersAndWorktreesWithoutPrefixMatches() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))
        for path in ["/work/phren", "/work/Phren/apps/ios", "/home/dev/.codex/worktrees/ab12/phren/src"] {
            let match = try XCTUnwrap(preferences.projectMatch(hostID: host.id, cwd: path, projects: [project]))
            XCTAssertEqual(match.project, project)
            XCTAssertTrue(match.automatic)
            XCTAssertFalse(match.directory.hasSuffix("/src"))
        }
        for path in ["/work/phren-other", "/work/phren/../other", "/work/./phren", "phren", "/work/other"] {
            XCTAssertNil(preferences.projectMatch(hostID: host.id, cwd: path, projects: [project]))
        }
        XCTAssertNil(preferences.projectMatch(hostID: UUID(), cwd: "/work/phren", projects: [project]))
    }

    /// A project named after the user (a portfolio site, a dotfiles repo)
    /// must not claim every folder under that user's home.
    func testHomeDirectoryNamedLikeAProjectIsNotAMatch() throws {
        let host = try LiveHost(name: "Desk", address: "desk.example", username: "sam")
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))
        let portfolio = SessionProject(storeID: "personal/brain", name: "sam")
        let hub = SessionProject(storeID: "personal/brain", name: "hub")
        for path in ["/home/sam/Projects/hub", "/Users/sam/hub", "/home/sam", "/home/sam/Downloads"] {
            XCTAssertNil(preferences.projectMatch(hostID: host.id, cwd: path, projects: [portfolio]), path)
        }
        XCTAssertEqual(preferences.projectMatch(hostID: host.id, cwd: "/home/sam/Projects/hub", projects: [portfolio, hub])?.project, hub)
        // The same name below home is still a project.
        XCTAssertEqual(preferences.projectMatch(hostID: host.id, cwd: "/home/sam/Projects/sam/src", projects: [portfolio])?.project, portfolio)
        XCTAssertEqual(preferences.projectMatch(hostID: host.id, cwd: "/root/sam", projects: [portfolio])?.project, portfolio)
        // An explicit choice of the home folder still wins.
        let chosen = try LiveSessionPreferences.assigning(hostID: host.id, directory: "/home/sam", storeID: "personal/brain", project: "sam", in: LiveSessionPreferences.saving(host, in: Data()))
        XCTAssertEqual(try LiveSessionPreferences.read(chosen).projectMatch(hostID: host.id, cwd: "/home/sam/notes", projects: [portfolio])?.automatic, false)
    }

    func testDuplicateStoreNamesNeedAChoiceAndExplicitMappingWins() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let team = SessionProject(storeID: "team/brain", name: "phren")
        var data = try LiveSessionPreferences.saving(host, in: Data())
        XCTAssertNil(try LiveSessionPreferences.read(data).projectMatch(hostID: host.id, cwd: "/work/phren/src", projects: [project, team]))
        data = try LiveSessionPreferences.assigning(hostID: host.id, directory: "/work/phren", storeID: team.storeID, project: team.name, in: data)
        let preferences = try LiveSessionPreferences.read(data)
        let match = try XCTUnwrap(preferences.projectMatch(hostID: host.id, cwd: "/work/phren/src", projects: [project, team]))
        XCTAssertEqual(match.project, team)
        XCTAssertFalse(match.automatic)
        // A removed store's explicit choice must not be reassigned to a different store.
        XCTAssertEqual(preferences.projectMatch(hostID: host.id, cwd: "/work/phren", projects: [project])?.project, team)
    }

    func testDeepestProjectDirectoryWinsButAmbiguityDoesNotFallBackToParent() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))
        let nested = SessionProject(storeID: "personal/brain", name: "app")
        let duplicate = SessionProject(storeID: "team/brain", name: "app")
        XCTAssertEqual(preferences.projectMatch(hostID: host.id, cwd: "/work/phren/app/src", projects: [project, nested])?.project, nested)
        XCTAssertNil(preferences.projectMatch(hostID: host.id, cwd: "/work/phren/app/src", projects: [project, nested, duplicate]))
    }

    func testDestinationsRetainExactHostWorkspaceAndTab() throws {
        let a = try LiveHost(name: "A", address: "a.example", username: "dev")
        let b = try LiveHost(name: "B", address: "b.example", username: "dev")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w1","label":"Work","children":[{"id":"w1:t1","label":"one"},{"id":"w1:t2","label":"two"}]}]}"#.utf8))
        let local = snapshot.sessions(on: a), remote = snapshot.sessions(on: b)
        XCTAssertEqual(local.map(\.workspaceID), ["w1", "w1"])
        XCTAssertEqual(local.map { $0.tab.id }, ["w1:t1", "w1:t2"])
        XCTAssertNotEqual(local[0].id, remote[0].id)
        XCTAssertNotEqual(local[0].id, local[1].id)
    }

    func testWorkspaceSectionsFoldRepeatedProjectLabelsWithoutReplacingDestinationIDs() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"first","label":" Phren ","children":[{"id":"first:tab","label":"one"}]},{"id":"second","label":"phren","children":[{"id":"second:tab","label":"two"}]}]}"#.utf8))

        let sections = LiveAgentWorkspaceGrouping.sections(snapshot.sessions(on: host), preferences: nil, projects: [])

        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].title, "Phren", "The first visible label remains stable")
        XCTAssertEqual(sections[0].sessions.map(\.workspaceID), ["first", "second"])
        XCTAssertEqual(sections[0].sessions.map { $0.tab.id }, ["first:tab", "second:tab"])
    }

    func testWorkspaceSectionsUseResolvedProjectIdentityAndPreserveFirstSeenOrder() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"other","label":"Other","children":[{"id":"other:tab","label":"other","cwd":"/work/other"}]},{"id":"first","label":"Planning","children":[{"id":"first:tab","label":"one","cwd":"/work/phren/apps/ios"}]},{"id":"second","label":"Release","children":[{"id":"second:tab","label":"two","cwd":"/work/phren"}]}]}"#.utf8))
        let preferences = try LiveSessionPreferences.read(LiveSessionPreferences.saving(host, in: Data()))

        let sections = LiveAgentWorkspaceGrouping.sections(snapshot.sessions(on: host), preferences: preferences,
                                                            projects: [project])

        XCTAssertEqual(sections.map(\.title), ["Other", "phren"])
        XCTAssertEqual(sections.map { $0.sessions.count }, [1, 2])
        XCTAssertEqual(sections[1].sessions.map(\.workspaceID), ["first", "second"])
    }

    func testWorkspaceSectionsDoNotMergeUnlabelledRealWorkspaces() throws {
        let host = try LiveHost(name: "Mac", address: "mac.example", username: "dev")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"first","label":"","children":[{"id":"first:tab","label":"one"}]},{"id":"second","label":"","children":[{"id":"second:tab","label":"two"}]}]}"#.utf8))

        let sections = LiveAgentWorkspaceGrouping.sections(snapshot.sessions(on: host), preferences: nil, projects: [])

        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections.flatMap(\.sessions).map(\.workspaceID), ["first", "second"])
    }
}
