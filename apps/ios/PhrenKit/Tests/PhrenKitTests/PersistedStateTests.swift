import XCTest
@testable import PhrenKit

/// Upgrade-safety tests for everything the app writes to the device.
///
/// Every legacy fixture here is a hand-written JSON literal, never a re-encode
/// of the current types. That is the whole point: a fixture generated from the
/// types it is meant to pin drifts with them and stops testing anything. These
/// strings are what builds already on users' phones actually wrote.
final class PersistedStateTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("phren-persistence-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        StorageIssueLog.shared.removeAll()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        StorageIssueLog.shared.removeAll()
        super.tearDown()
    }

    // MARK: - Fixtures

    /// `pending-ops.json` exactly as the shipped build writes it: no
    /// `schemaVersion` key, `queuedAt` as a bare reference-date Double, an op
    /// encoded as Swift's synthesized single-key enum object.
    private static let legacyPendingOpsJSON = """
    {
      "pending": [
        {
          "id": "11111111-2222-3333-4444-555555555555",
          "op": {
            "addNote": {
              "project": "demo",
              "date": "2026-07-30",
              "time": "12:00:00",
              "text": "the note that only exists on this phone"
            }
          },
          "queuedAt": 771692800,
          "attempts": 0,
          "paths": ["demo/notes/2026-07-30.md"]
        },
        {
          "id": "22222222-3333-4444-5555-666666666666",
          "op": { "addTask": { "project": "demo", "text": "ship the fix" } },
          "queuedAt": 771692810,
          "attempts": 1
        }
      ],
      "failed": [
        {
          "id": "33333333-4444-5555-6666-777777777777",
          "op": { "completeTask": { "project": "demo", "match": "old task" } },
          "queuedAt": 771692820,
          "attempts": 3,
          "lastError": "conflict"
        }
      ]
    }
    """

    /// `manifest.json` as the shipped build writes it — no `schemaVersion`.
    private static let legacyManifestJSON = """
    {
      "owner": "octo",
      "repo": "brain",
      "branch": "main",
      "headSha": "head-abc",
      "blobShas": { "demo/FINDINGS.md": "blob-1", "demo/tasks.md": "blob-2" },
      "lastSyncedAt": 771692800
    }
    """

    private func write(_ json: String, to name: String) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try Data(json.utf8).write(to: url)
        return url
    }

    private func quarantineFiles(matching prefix: String) throws -> [URL] {
        try FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("\(prefix).corrupt-") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: - Pending ops: legacy format

    func testLegacyPendingOpsFileWithoutSchemaVersionStillDecodes() throws {
        let url = try write(Self.legacyPendingOpsJSON, to: "pending-ops.json")

        let loaded = PendingOpsQueue.load(from: url)

        XCTAssertNil(loaded.issue, "a file the shipped build wrote is not an issue")
        let decoded = try JSONDecoder().decode(PendingOpsQueue.self, from: Data(Self.legacyPendingOpsJSON.utf8))
        XCTAssertEqual(decoded.schemaVersion, 1, "a missing version key IS version 1")
        XCTAssertEqual(loaded.queue.schemaVersion, PendingOpsQueue.currentSchemaVersion,
                       "loading upgrades legacy queues before the engine can append new operations")
        XCTAssertEqual(loaded.queue.pending.count, 2)
        XCTAssertEqual(loaded.queue.failed.count, 1)
        XCTAssertEqual(
            loaded.queue.pending[0].op,
            .addNote(project: "demo", date: "2026-07-30", time: "12:00:00",
                     text: "the note that only exists on this phone")
        )
        XCTAssertEqual(loaded.queue.pending[0].paths, ["demo/notes/2026-07-30.md"])
        XCTAssertEqual(loaded.queue.pending[1].attempts, 1)
        XCTAssertEqual(loaded.queue.failed[0].lastError, "conflict")
        XCTAssertTrue(try quarantineFiles(matching: "pending-ops").isEmpty,
                      "a readable file must never be moved")
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    }

    func testLegacyPendingOpsFileSurvivesAReSaveAtTheCurrentVersion() throws {
        let url = try write(Self.legacyPendingOpsJSON, to: "pending-ops.json")

        let queue = PendingOpsQueue.load(from: url).queue
        XCTAssertNil(queue.save(to: url))

        let reloaded = PendingOpsQueue.load(from: url)
        XCTAssertNil(reloaded.issue)
        XCTAssertEqual(reloaded.queue.pending.map(\.op), queue.pending.map(\.op))
        XCTAssertEqual(reloaded.queue.failed.map(\.op), queue.failed.map(\.op))
    }

    // MARK: - Pending ops: round trip

    func testPendingOpsRoundTripsWithTheVersionField() throws {
        let url = directory.appendingPathComponent("pending-ops.json")
        var queue = PendingOpsQueue()
        queue.pending = [QueuedOp(op: .addFinding(project: "demo", text: "a finding", type: nil))]

        XCTAssertNil(queue.save(to: url), "a plain write must not report an issue")

        let raw = try XCTUnwrap(String(data: try Data(contentsOf: url), encoding: .utf8))
        XCTAssertTrue(raw.contains("\"schemaVersion\""), "the version has to be written, not assumed")

        let reloaded = PendingOpsQueue.load(from: url)
        XCTAssertNil(reloaded.issue)
        XCTAssertEqual(reloaded.queue.schemaVersion, PendingOpsQueue.currentSchemaVersion)
        XCTAssertEqual(reloaded.queue.pending.map(\.id), queue.pending.map(\.id))
        XCTAssertEqual(reloaded.queue.pending.map(\.op), queue.pending.map(\.op))
    }

    func testMissingPendingOpsFileIsAnEmptyQueueAndNotAnIssue() {
        let loaded = PendingOpsQueue.load(from: directory.appendingPathComponent("pending-ops.json"))

        XCTAssertNil(loaded.issue, "first launch is not a failure")
        XCTAssertTrue(loaded.queue.pending.isEmpty)
        XCTAssertTrue(StorageIssueLog.shared.issues.isEmpty)
    }

    // MARK: - Pending ops: quarantine

    func testCorruptPendingOpsFileIsQuarantinedWithItsBytesIntact() throws {
        // A truncated write — the shape a killed app leaves behind.
        let corrupt = #"{"pending":[{"id":"11111111-2222-3333-4444-5555555"#
        let url = try write(corrupt, to: "pending-ops.json")

        let loaded = PendingOpsQueue.load(from: url)

        XCTAssertTrue(loaded.queue.pending.isEmpty, "the caller starts empty")
        let issue = try XCTUnwrap(loaded.issue)
        XCTAssertEqual(issue.kind, .unreadable)
        XCTAssertEqual(issue.document, "unsynced changes")

        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path),
                       "the unreadable file is moved, so the next save can't land on it")
        let quarantined = try quarantineFiles(matching: "pending-ops")
        XCTAssertEqual(quarantined.count, 1)
        XCTAssertEqual(quarantined[0].pathExtension, "json")
        XCTAssertEqual(try String(data: Data(contentsOf: quarantined[0]), encoding: .utf8), corrupt,
                       "quarantine preserves the bytes exactly — a migration has to be able to read them")
        // Resolved on both sides: the temporary directory is reached through a
        // symlink, so the reported path and the enumerated one differ by
        // /var vs /private/var.
        let reported = URL(fileURLWithPath: try XCTUnwrap(issue.quarantineLocation))
        XCTAssertEqual(reported.resolvingSymlinksInPath().path,
                       quarantined[0].resolvingSymlinksInPath().path)
    }

    /// The upgrade case the whole file exists for: a build that added an enum
    /// case writes ops this build has never heard of.
    func testUnknownPendingOpCaseIsQuarantinedNotDiscarded() throws {
        let fromTheFuture = """
        {
          "pending": [
            {
              "id": "44444444-5555-6666-7777-888888888888",
              "op": { "archiveProject": { "project": "demo" } },
              "queuedAt": 771692800,
              "attempts": 0
            }
          ],
          "failed": []
        }
        """
        let url = try write(fromTheFuture, to: "pending-ops.json")

        let loaded = PendingOpsQueue.load(from: url)

        XCTAssertEqual(loaded.issue?.kind, .unreadable)
        XCTAssertTrue(loaded.queue.pending.isEmpty)
        let quarantined = try quarantineFiles(matching: "pending-ops")
        XCTAssertEqual(try String(data: Data(contentsOf: XCTUnwrap(quarantined.first)), encoding: .utf8),
                       fromTheFuture)
    }

    func testNewerPendingOpsSchemaVersionIsQuarantinedNotDestroyed() throws {
        let fromTheFuture = """
        {
          "schemaVersion": 99,
          "pending": [
            {
              "id": "55555555-6666-7777-8888-999999999999",
              "op": { "addTask": { "project": "demo", "text": "written by a newer build" } },
              "queuedAt": 771692800,
              "attempts": 0
            }
          ],
          "failed": []
        }
        """
        let url = try write(fromTheFuture, to: "pending-ops.json")

        let loaded = PendingOpsQueue.load(from: url)

        let issue = try XCTUnwrap(loaded.issue)
        XCTAssertEqual(issue.kind, .futureSchema)
        XCTAssertEqual(issue.foundSchemaVersion, 99)
        XCTAssertEqual(issue.expectedSchemaVersion, PendingOpsQueue.currentSchemaVersion)
        XCTAssertTrue(loaded.queue.pending.isEmpty)
        XCTAssertTrue(issue.userMessage.contains("newer version"))

        let quarantined = try quarantineFiles(matching: "pending-ops")
        XCTAssertEqual(quarantined.count, 1, "an older build must not eat a newer build's queue")
        XCTAssertEqual(try String(data: Data(contentsOf: quarantined[0]), encoding: .utf8), fromTheFuture)
    }

    func testQuarantiningTwiceInTheSameSecondKeepsBothCopies() throws {
        let first = #"{"pending": "not an array"}"#
        let second = #"{"failed": 12}"#

        _ = PendingOpsQueue.load(from: try write(first, to: "pending-ops.json"))
        _ = PendingOpsQueue.load(from: try write(second, to: "pending-ops.json"))

        let quarantined = try quarantineFiles(matching: "pending-ops")
        XCTAssertEqual(quarantined.count, 2, "the second quarantine must not clobber the first")
        let contents = Set(try quarantined.map { try String(data: Data(contentsOf: $0), encoding: .utf8) })
        XCTAssertEqual(contents, [first, second])
    }

    // MARK: - Write failures

    func testPendingOpsWriteFailureIsReportedRatherThanSwallowed() throws {
        // A regular file where a directory would have to be: the write fails
        // with ENOTDIR, which is as close as a test gets to a full disk.
        let blocker = directory.appendingPathComponent("blocker")
        try Data("x".utf8).write(to: blocker)

        var queue = PendingOpsQueue()
        queue.pending = [QueuedOp(op: .addTask(project: "demo", text: "offline work"))]

        let issue = try XCTUnwrap(queue.save(to: blocker.appendingPathComponent("pending-ops.json")))
        XCTAssertEqual(issue.kind, .unwritable)
        XCTAssertEqual(issue.document, "unsynced changes")
        XCTAssertNotNil(issue.detail)
        XCTAssertTrue(issue.userMessage.contains("couldn't save"))
        XCTAssertEqual(StorageIssueLog.shared.issues.map(\.id), [issue.id])
    }

    func testAFailedQuarantineKeepsItsReasonInTheIssue() throws {
        // A read-only folder refuses both the move and the fallback copy.
        let locked = directory.appendingPathComponent("locked")
        try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
        try Data(#"{"pending": ["#.utf8).write(to: locked.appendingPathComponent("pending-ops.json"))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: locked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }

        let issue = try XCTUnwrap(PendingOpsQueue.load(from: locked.appendingPathComponent("pending-ops.json")).issue)
        XCTAssertEqual(issue.kind, .unreadable)
        XCTAssertNil(issue.quarantineLocation)
        XCTAssertTrue(issue.detail?.contains("move failed:") == true, issue.detail ?? "no detail")
        XCTAssertTrue(issue.detail?.contains("copy failed:") == true, issue.detail ?? "no detail")
        XCTAssertTrue(issue.userMessage.contains("couldn't set them aside"))
    }

    func testCacheWriteFailuresReachTheIssueLog() {
        let issue = PersistedState.reportUnwritable(document: "local edits", location: "demo/tasks.md",
                                                     error: CocoaError(.fileWriteNoPermission))
        XCTAssertEqual(issue.kind, .unwritable)
        XCTAssertNotNil(issue.detail)
        XCTAssertEqual(StorageIssueLog.shared.issues.map(\.id), [issue.id])
        XCTAssertEqual(issue.userMessage, "Phren couldn't save your local edits on this device, so they may not survive closing the app.")
    }

    func testAWipeThatCannotDeleteTheCopySaysSo() async throws {
        let parent = directory.appendingPathComponent("parent")
        let store = try LocalStore(rootDirectory: parent.appendingPathComponent("store"), owner: "octo", repo: "brain", branch: "main")
        try await store.write("demo/tasks.md", content: "# tasks\n", blobSha: nil)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: parent.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path) }

        do {
            try await store.wipe()
            XCTFail("a wipe that left the folder behind must throw")
        } catch {
            XCTAssertFalse(error is CancellationError)
        }
        // The in-memory state is reset either way.
        let manifest = await store.currentManifest
        XCTAssertTrue(manifest.blobShas.isEmpty)
    }

    // MARK: - SyncEngine plumbing

    func testSyncEngineStartsEmptyAndReportsAQuarantinedQueue() async throws {
        _ = try write(#"{"pending": ["#, to: "pending-ops.json")
        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")
        let engine = SyncEngine(client: FakeGitHubClient(), store: store, stateDirectory: directory)

        let issues = await engine.storageIssues
        let status = await engine.currentStatus()
        XCTAssertEqual(issues.count, 1)
        XCTAssertEqual(issues.first?.kind, .unreadable)
        XCTAssertEqual(status.pendingCount, 0)
        XCTAssertEqual(try quarantineFiles(matching: "pending-ops").count, 1)

        // And the engine keeps working from there — a quarantine is a fresh
        // start, not a broken store.
        await engine.setAutoFlush(false)
        try await engine.enqueue(.addTask(project: "demo", text: "after the quarantine"))
        let pending = await engine.pendingOps()
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(PendingOpsQueue.load(from: directory.appendingPathComponent("pending-ops.json"))
            .queue.pending.count, 1)
    }

    func testSyncEngineLoadsAnIntactQueueUnchanged() async throws {
        _ = try write(Self.legacyPendingOpsJSON, to: "pending-ops.json")
        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")
        let engine = SyncEngine(client: FakeGitHubClient(), store: store, stateDirectory: directory)

        let issues = await engine.storageIssues
        let status = await engine.currentStatus()
        XCTAssertTrue(issues.isEmpty)
        XCTAssertEqual(status.pendingCount, 2)
        XCTAssertEqual(status.failedCount, 1)
        XCTAssertTrue(StorageIssueLog.shared.issues.isEmpty)
    }

    // MARK: - Manifest

    func testLegacyManifestWithoutSchemaVersionStillDecodes() async throws {
        _ = try write(Self.legacyManifestJSON, to: "manifest.json")

        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")

        let issues = await store.storageIssues
        let manifest = await store.currentManifest
        let taskSha = await store.blobSha(for: "demo/tasks.md")
        XCTAssertTrue(issues.isEmpty)
        XCTAssertEqual(manifest.schemaVersion, 1)
        XCTAssertEqual(manifest.headSha, "head-abc")
        XCTAssertEqual(manifest.blobShas["demo/FINDINGS.md"], "blob-1")
        XCTAssertEqual(taskSha, "blob-2")
        XCTAssertNotNil(manifest.lastSyncedAt)
        XCTAssertTrue(try quarantineFiles(matching: "manifest").isEmpty)
    }

    func testManifestRoundTripsWithTheVersionField() async throws {
        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")
        try await store.updateManifest { $0.headSha = "head-1" }

        let raw = try XCTUnwrap(String(
            data: try Data(contentsOf: directory.appendingPathComponent("manifest.json")),
            encoding: .utf8
        ))
        XCTAssertTrue(raw.contains("\"schemaVersion\""))

        let reopened = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")
        let manifest = await reopened.currentManifest
        let issues = await reopened.storageIssues
        XCTAssertEqual(manifest.headSha, "head-1")
        XCTAssertTrue(issues.isEmpty)
    }

    func testCorruptManifestIsQuarantinedAndTheStoreStartsClean() async throws {
        let corrupt = #"{"owner":"octo","repo":"brain","blobShas":"not a dictionary"}"#
        _ = try write(corrupt, to: "manifest.json")

        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")

        let issues = await store.storageIssues
        let manifest = await store.currentManifest
        XCTAssertEqual(issues.count, 1)
        XCTAssertEqual(issues.first?.kind, .unreadable)
        XCTAssertEqual(issues.first?.document, "offline cache records")
        XCTAssertEqual(manifest.owner, "octo")
        XCTAssertTrue(manifest.blobShas.isEmpty)

        let quarantined = try quarantineFiles(matching: "manifest")
        XCTAssertEqual(quarantined.count, 1)
        XCTAssertEqual(try String(data: Data(contentsOf: quarantined[0]), encoding: .utf8), corrupt)
    }

    func testNewerManifestSchemaVersionIsQuarantinedNotDestroyed() async throws {
        let fromTheFuture = """
        {"schemaVersion":42,"owner":"octo","repo":"brain","branch":"main","blobShas":{}}
        """
        _ = try write(fromTheFuture, to: "manifest.json")

        let store = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")

        let issues = await store.storageIssues
        let issue = try XCTUnwrap(issues.first)
        XCTAssertEqual(issue.kind, .futureSchema)
        XCTAssertEqual(issue.foundSchemaVersion, 42)
        XCTAssertEqual(try String(
            data: Data(contentsOf: XCTUnwrap(try quarantineFiles(matching: "manifest").first)),
            encoding: .utf8
        ), fromTheFuture)
    }

    /// A manifest for a different repo in the same directory is a reused
    /// folder, not corruption — reset, don't quarantine, and don't complain.
    func testManifestForAnotherRepoResetsWithoutAnIssue() async throws {
        _ = try write(Self.legacyManifestJSON, to: "manifest.json")

        let store = try LocalStore(rootDirectory: directory, owner: "other", repo: "repo", branch: "main")

        let issues = await store.storageIssues
        let manifest = await store.currentManifest
        XCTAssertTrue(issues.isEmpty)
        XCTAssertEqual(manifest.owner, "other")
        XCTAssertTrue(try quarantineFiles(matching: "manifest").isEmpty)
    }

    // MARK: - Versioned lists (the capture log and the store registry)

    func testLegacyBareArrayDecodesAsVersionOne() throws {
        // What the shipped build wrote for `phren.stores`: a bare array, and
        // for the oldest installs, entries with no `canPush` either.
        let legacy = """
        [
          { "owner": "octo", "name": "brain", "branch": "main" },
          { "owner": "octo", "name": "work", "branch": "trunk", "canPush": false }
        ]
        """
        let url = try write(legacy, to: "stores.json")

        let loaded = PersistedState.load(VersionedList<StoreDescriptor>.self, from: url,
                                         document: "store settings")

        XCTAssertNil(loaded.issue)
        let list = try XCTUnwrap(loaded.value)
        XCTAssertEqual(list.schemaVersion, 1)
        XCTAssertEqual(list.items.map(\.id), ["octo/brain", "octo/work"])
        XCTAssertTrue(list.items[0].canPush, "a missing canPush still defaults to writable")
        XCTAssertFalse(list.items[1].canPush)
        XCTAssertEqual(list.items[0].schemaVersion, 1)
    }

    func testVersionedListRoundTripsThroughTheEnvelope() throws {
        let url = directory.appendingPathComponent("stores.json")
        let list = VersionedList(items: [StoreDescriptor(owner: "octo", name: "brain", branch: "main")])

        XCTAssertNil(PersistedState.save(list, to: url, document: "store settings"))

        let raw = try XCTUnwrap(String(data: try Data(contentsOf: url), encoding: .utf8))
        XCTAssertTrue(raw.contains("\"items\""))
        XCTAssertTrue(raw.contains("\"schemaVersion\""))

        let loaded = PersistedState.load(VersionedList<StoreDescriptor>.self, from: url,
                                         document: "store settings")
        XCTAssertNil(loaded.issue)
        XCTAssertEqual(loaded.value?.items, list.items)
    }

    func testNewerVersionedListIsQuarantinedNotDestroyed() throws {
        let fromTheFuture = """
        {"schemaVersion":7,"items":[{"owner":"octo","name":"brain","branch":"main"}]}
        """
        let url = try write(fromTheFuture, to: "stores.json")

        let loaded = PersistedState.load(VersionedList<StoreDescriptor>.self, from: url,
                                         document: "store settings")

        XCTAssertNil(loaded.value)
        XCTAssertEqual(loaded.issue?.kind, .futureSchema)
        XCTAssertEqual(loaded.issue?.foundSchemaVersion, 7)
        XCTAssertEqual(try quarantineFiles(matching: "stores").count, 1)
    }

    func testUnreadableVersionedListIsQuarantinedWithItsBytesIntact() throws {
        let corrupt = #"{"items":[{"owner":"octo"}]}"#  // `name` is required
        let url = try write(corrupt, to: "stores.json")

        let loaded = PersistedState.load(VersionedList<StoreDescriptor>.self, from: url,
                                         document: "store settings")

        XCTAssertNil(loaded.value)
        XCTAssertEqual(loaded.issue?.kind, .unreadable)
        let quarantined = try quarantineFiles(matching: "stores")
        XCTAssertEqual(try String(data: Data(contentsOf: XCTUnwrap(quarantined.first)), encoding: .utf8),
                       corrupt)
    }

    // MARK: - UserDefaults-backed state

    func testUnreadableDefaultsValueIsCopiedAsideBeforeTheKeyIsCleared() throws {
        let suite = "phren-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let corrupt = Data(#"{"items": "not an array"}"#.utf8)
        defaults.set(corrupt, forKey: "phren.capture.log")

        let loaded = PersistedState.load(VersionedList<StoreDescriptor>.self, fromDefaults: defaults,
                                         key: "phren.capture.log", document: "recent captures")

        XCTAssertNil(loaded.value)
        let issue = try XCTUnwrap(loaded.issue)
        XCTAssertEqual(issue.kind, .unreadable)
        XCTAssertNil(defaults.data(forKey: "phren.capture.log"),
                     "the unreadable value is cleared so the next save can't overwrite it")

        let quarantineKey = try XCTUnwrap(
            defaults.dictionaryRepresentation().keys
                .first { $0.hasPrefix("phren.capture.log.corrupt-") }
        )
        XCTAssertEqual(defaults.data(forKey: quarantineKey), corrupt)
        XCTAssertEqual(issue.quarantineLocation, "UserDefaults:\(quarantineKey)")
    }

    func testDefaultsRoundTripAndMissingKeyAreBothQuiet() throws {
        let suite = "phren-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let missing = PersistedState.load(VersionedList<StoreDescriptor>.self, fromDefaults: defaults,
                                          key: "phren.stores", document: "store settings")
        XCTAssertNil(missing.value)
        XCTAssertNil(missing.issue, "an unset key is every first launch, not a failure")

        let list = VersionedList(items: [StoreDescriptor(owner: "octo", name: "brain", branch: "main")])
        XCTAssertNil(PersistedState.save(list, toDefaults: defaults, key: "phren.stores",
                                         document: "store settings"))

        let reloaded = PersistedState.load(VersionedList<StoreDescriptor>.self, fromDefaults: defaults,
                                           key: "phren.stores", document: "store settings")
        XCTAssertNil(reloaded.issue)
        XCTAssertEqual(reloaded.value?.items, list.items)
        XCTAssertTrue(StorageIssueLog.shared.issues.isEmpty)
    }

    // MARK: - The shared log the app reads

    /// `AppModel` reads this one log rather than unioning the per-owner
    /// arrays, so everything quarantined anywhere has to land in it.
    func testEveryIssueReachesTheSharedLogTheAppSurfaces() throws {
        _ = PendingOpsQueue.load(from: try write("nonsense", to: "pending-ops.json"))
        _ = try LocalStore(rootDirectory: directory, owner: "octo", repo: "brain", branch: "main")
        _ = PersistedState.load(VersionedList<StoreDescriptor>.self,
                                from: try write("{", to: "stores.json"),
                                document: "store settings")

        let issues = StorageIssueLog.shared.issues
        XCTAssertEqual(issues.count, 2, "an intact store contributes nothing")
        XCTAssertEqual(Set(issues.map(\.document)), ["unsynced changes", "store settings"])
        XCTAssertTrue(issues.allSatisfy { $0.userMessage.contains("set aside") })
    }
}
