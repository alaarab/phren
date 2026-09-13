import XCTest
@testable import PhrenKit

final class MachineRegistryTests: XCTestCase {
    func testParsesTheThreeFlatFiles() {
        let machines = MachineRegistry.parseMachines("# machine-name: profile-name\nMac.attlocal.net: mac-mini\nSquids-Mac-mini.local: mac-mini\nomarchy: personal\n\"QL-PF5A48WS\": 'ql-laptop'\n")
        XCTAssertEqual(machines, ["Mac.attlocal.net": "mac-mini", "Squids-Mac-mini.local": "mac-mini", "omarchy": "personal", "QL-PF5A48WS": "ql-laptop"])
        let profile = MachineRegistry.parseProfile("name: mac-mini\nprojects:\n  - alphalens\n  - phren # the app\n  - \"objectstudio\"\nother: 1\n")
        XCTAssertEqual(profile.name, "mac-mini")
        XCTAssertEqual(profile.projects, ["alphalens", "phren", "objectstudio"])
        XCTAssertEqual(MachineRegistry.parseProfile("name: inline\nprojects: [a, b]\n").projects, ["a", "b"])
        XCTAssertEqual(MachineRegistry.parseSourcePath("ownership: repo-managed\nsourcePath: /home/alaarab/Projects/phren\n"), "/home/alaarab/Projects/phren")
        XCTAssertNil(MachineRegistry.parseSourcePath("ownership: detached\n"))
        XCTAssertNil(MachineRegistry.parseSourcePath("sourcePath: relative/path\n"))
    }

    func testHostLookupIgnoresTheLocalSuffixAndCase() {
        let registry = MachineRegistry(machines: ["Squids-Mac-mini.local": "mac-mini", "omarchy": "personal"],
                                       profiles: ["mac-mini": ["phren", "alphalens"], "personal": ["phren"]])
        XCTAssertEqual(registry.hosts(for: "phren"), ["Squids-Mac-mini.local", "omarchy"])
        XCTAssertEqual(registry.hosts(for: "alphalens"), ["Squids-Mac-mini.local"])
        XCTAssertTrue(registry.hosts("squids-mac-mini", project: "phren"))
        XCTAssertTrue(registry.hosts("Squids-Mac-mini.local", project: "alphalens"))
        XCTAssertFalse(registry.hosts("omarchy", project: "alphalens"))
        XCTAssertFalse(registry.hosts("laptop", project: "phren"))
    }

    func testSyncedPathsAdmitTheRegistryFilesReadOnly() {
        for path in ["machines.yaml", "profiles/mac-mini.yaml", "phren/phren.project.yaml"] {
            XCTAssertTrue(LocalStore.isSyncedPath(path), path)
            XCTAssertFalse(LocalStore.isWritablePath(path), path)
        }
        XCTAssertFalse(LocalStore.isSyncedPath("profiles/nested/x.yaml"))
        XCTAssertFalse(LocalStore.isSyncedPath("profiles/../x.yaml"))
    }

    func testSnapshotCarriesTheRegistry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("machines-\(UUID())")
        let store = try LocalStore(rootDirectory: root, owner: "o", repo: "r", branch: "main")
        try await store.write("machines.yaml", content: "mini.local: home\n", blobSha: "1")
        try await store.write("profiles/home.yaml", content: "name: home\nprojects:\n  - phren\n", blobSha: "2")
        try await store.write("phren/phren.project.yaml", content: "sourcePath: /Users/me/phren\n", blobSha: "3")
        try await store.write("phren/FINDINGS.md", content: "# Findings\n", blobSha: "4")
        let snapshot = await store.snapshot()
        XCTAssertEqual(snapshot.machines.hosts(for: "phren"), ["mini.local"])
        XCTAssertEqual(snapshot.machines.sourcePaths["phren"], "/Users/me/phren")
        XCTAssertEqual(snapshot.projects.map(\.name), ["phren"])
        try? FileManager.default.removeItem(at: root)
    }
}
