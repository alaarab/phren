import XCTest
@testable import PhrenKit

final class MachineRegistryTests: XCTestCase {
    func testParsesTheThreeFlatFiles() {
        let machines = MachineRegistry.parseMachines("# machine-name: profile-name\nMac.home.example: mac-mini\nDesk.local: mac-mini\nlinuxbox: personal\n\"WORK-LAPTOP\": 'ql-laptop'\n")
        XCTAssertEqual(machines, ["Mac.home.example": "mac-mini", "Desk.local": "mac-mini", "linuxbox": "personal", "WORK-LAPTOP": "ql-laptop"])
        let profile = MachineRegistry.parseProfile("name: mac-mini\nprojects:\n  - alphalens\n  - phren # the app\n  - \"objectstudio\"\nother: 1\n")
        XCTAssertEqual(profile.name, "mac-mini")
        XCTAssertEqual(profile.projects, ["alphalens", "phren", "objectstudio"])
        XCTAssertEqual(MachineRegistry.parseProfile("name: inline\nprojects: [a, b]\n").projects, ["a", "b"])
        XCTAssertEqual(MachineRegistry.parseSourcePath("ownership: repo-managed\nsourcePath: /home/sam/Projects/phren\n"), "/home/sam/Projects/phren")
        XCTAssertNil(MachineRegistry.parseSourcePath("ownership: detached\n"))
        XCTAssertNil(MachineRegistry.parseSourcePath("sourcePath: relative/path\n"))
    }

    func testHostLookupIgnoresTheLocalSuffixAndCase() {
        let registry = MachineRegistry(machines: ["Desk.local": "mac-mini", "linuxbox": "personal"],
                                       profiles: ["mac-mini": ["phren", "alphalens"], "personal": ["phren"]])
        XCTAssertEqual(registry.hosts(for: "phren"), ["Desk.local", "linuxbox"])
        XCTAssertEqual(registry.hosts(for: "alphalens"), ["Desk.local"])
        XCTAssertTrue(registry.hosts("desk", project: "phren"))
        XCTAssertTrue(registry.hosts("Desk.local", project: "alphalens"))
        XCTAssertFalse(registry.hosts("linuxbox", project: "alphalens"))
        XCTAssertFalse(registry.hosts("laptop", project: "phren"))
    }

    func testSyncedPathsAdmitTheRegistryFilesReadOnly() {
        for path in ["machines.yaml", "profiles/mac-mini.yaml"] {
            XCTAssertTrue(LocalStore.isSyncedPath(path), path)
            XCTAssertFalse(LocalStore.isWritablePath(path), path)
        }
        // A project's own `phren.project.yaml` is the one registry file the
        // phone may write, and only through `PendingOp.setProjectKnobs`.
        XCTAssertTrue(LocalStore.isSyncedPath("phren/phren.project.yaml"))
        XCTAssertTrue(LocalStore.isWritablePath("phren/phren.project.yaml"))
        XCTAssertTrue(LocalStore.isProjectConfigPath("phren/phren.project.yaml"))
        XCTAssertFalse(LocalStore.isProjectConfigPath("machines.yaml"))
        XCTAssertFalse(LocalStore.isProjectConfigPath("phren/summary.md"))
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
