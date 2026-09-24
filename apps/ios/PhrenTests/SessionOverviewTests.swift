import XCTest
import PhrenKit
import PhrenLive
@testable import Phren

@MainActor
final class SessionOverviewTests: XCTestCase {
    func testEmptyHostsCompleteTheSharedDrawerLoad() async throws {
        let model = SessionOverviewMonitor()
        model.ensureRunning(hosts: [])
        await eventually { model.ready }
        XCTAssertTrue(model.screen.groups.isEmpty)
        XCTAssertTrue(model.screen.computers.isEmpty)
        model.stopRunning()
    }

    func testTimeoutRevealStaysLatchedAcrossRestartWithUnansweredHost() async throws {
        let computer = try host("Offline")
        let model = SessionOverviewMonitor(initialWait: .milliseconds(30)) {
            LiveHostMonitor { _, _ in try await Task.sleep(for: .seconds(30)); throw LiveConnectionError.disconnected }
        }
        let run = Task { await model.run(hosts: [computer]) }
        await eventually { model.ready }
        let shown = model.screen
        run.cancel(); await run.value
        let again = Task { await model.run(hosts: [computer]) }
        await eventually { model.computers.first?.monitor.polling == true }
        XCTAssertTrue(model.ready)
        XCTAssertEqual(model.screen, shown)
        again.cancel(); await again.value
    }

    func testScreenRevealsResolvedProjectsPinsAndComputersTogetherAndSkipsUnchangedPolls() async throws {
        let computer = try host("Mac"), work = try snapshot("working")
        let model = SessionOverviewMonitor {
            LiveHostMonitor(pollInterval: .milliseconds(250)) { _, _ in work }
        }
        model.configure(.init(metadataReady: false))
        let run = Task { await model.run(hosts: [computer]) }
        await eventually { model.computers.first?.monitor.snapshot != nil }
        XCTAssertFalse(model.ready, "Wait for the first local project metadata as well as the computers")
        XCTAssertTrue(model.screen.computers.isEmpty)
        let session = work.sessions(on: computer)[0]
        var data = try LiveSessionPreferences.saving(computer, in: Data())
        data = try LiveSessionPreferences.setPinned(true, for: session.id, in: data)
        data = try LiveSessionPreferences.assigning(hostID: computer.id, directory: "/work/phone",
                                                   storeID: "work/brain", project: "phone", in: data)
        model.configure(.init(preferences: try LiveSessionPreferences.read(data),
                              projects: [.init(storeID: "work/brain", name: "phone")]))
        XCTAssertTrue(model.ready)
        XCTAssertEqual(model.screen.computers.map(\.id), [computer.id])
        XCTAssertEqual(model.screen.groups.map(\.id), ["pinned"])
        XCTAssertEqual(model.screen.pinned, [session.id])
        XCTAssertEqual(model.screen.projects[session.id], "phone")
        try await Task.sleep(for: .milliseconds(650))
        XCTAssertEqual(model.listRelayoutsAfterReady, 0, "Unchanged host polls must not publish a new layout")
        run.cancel(); await run.value
    }

    func testInitialRefreshAppearsTogetherWithoutWaitingForeverForAnOfflineComputer() async throws {
        let fast = try host("Fast"), slow = try host("Slow")
        let snapshot = try snapshot("working")
        let model = SessionOverviewMonitor(initialWait: .milliseconds(150)) {
            LiveHostMonitor { host, _ in
                if host.id == slow.id { try await Task.sleep(for: .seconds(30)) }
                return snapshot
            }
        }
        let run = Task { await model.run(hosts: [slow, fast]) }
        await eventually { model.computers.first { $0.id == fast.id }?.monitor.snapshot != nil }
        XCTAssertFalse(model.ready)
        XCTAssertTrue(groups(model).isEmpty, "No partial sections while the first refresh is pending")
        XCTAssertEqual(model.connectedCount(at: .now), 0)
        await eventually { model.ready }
        XCTAssertEqual(model.connectedCount(at: .now), 1)
        XCTAssertEqual(groups(model).flatMap(\.sessions).map(\.host.id), [fast.id])
        run.cancel(); await run.value
        XCTAssertEqual(model.connectedCount(at: .now), 1, "Backgrounding preserves a recent successful snapshot")
        XCTAssertEqual(groups(model).map(\.title), ["Working"])
    }

    func testFirstRefreshRevealsAllHostsAtOnceAndCachedReturnDoesNotFlashLoading() async throws {
        let fast = try host("Fast"), slow = try host("Slow")
        let snapshot = try snapshot("working")
        var release = false
        let model = SessionOverviewMonitor {
            LiveHostMonitor { host, _ in
                while host.id == slow.id && !release { try await Task.sleep(for: .milliseconds(10)) }
                return snapshot
            }
        }
        let run = Task { await model.run(hosts: [fast, slow]) }
        await eventually { model.computers.first?.monitor.snapshot != nil }
        XCTAssertFalse(model.ready)
        XCTAssertTrue(groups(model).isEmpty)
        release = true
        await eventually { model.ready }
        XCTAssertEqual(groups(model).flatMap(\.sessions).count, 2)
        run.cancel(); await run.value
        let next = Task { await model.run(hosts: [fast, slow]) }
        await eventually { model.computers.allSatisfy { $0.monitor.polling } }
        XCTAssertTrue(model.ready)
        XCTAssertEqual(groups(model).flatMap(\.sessions).count, 2)
        next.cancel(); await next.value
    }

    func testGroupComputationIsMemoizedAcrossClockTicks() async throws {
        let computer = try host("Mac"), snapshot = try snapshot("working")
        let model = SessionOverviewMonitor { LiveHostMonitor { _, _ in snapshot } }
        let run = Task { await model.run(hosts: [computer]) }
        await eventually { model.ready }
        _ = model.groups(at: .now, preferences: nil, projects: [])
        let firstCount = model.groupComputationCount
        _ = model.groups(at: .now.addingTimeInterval(1), preferences: nil, projects: [])
        XCTAssertEqual(model.groupComputationCount, firstCount, "The one-second freshness clock must reuse snapshot grouping")
        _ = model.groups(at: .now, preferences: nil, projects: [SessionProject(storeID: "work/brain", name: "phone")])
        XCTAssertEqual(model.groupComputationCount, firstCount + 1, "A project change must invalidate grouping")
        run.cancel(); await run.value
    }

    func testCancelledBatchCannotRevealAReplacementBatch() async throws {
        let first = try host("Old"), second = try host("New")
        let model = SessionOverviewMonitor(initialWait: .seconds(1)) {
            LiveHostMonitor { _, _ in
                try await Task.sleep(for: .seconds(30))
                throw LiveConnectionError.disconnected
            }
        }
        let run = Task { await model.run(hosts: [first]) }
        await eventually { !model.computers.isEmpty }
        run.cancel(); await run.value
        let next = Task { await model.run(hosts: [second]) }
        await eventually { model.computers.first?.id == second.id }
        XCTAssertFalse(model.ready)
        XCTAssertTrue(groups(model).isEmpty)
        next.cancel(); await next.value
    }

    func testSameSessionIDsOnTwoComputersStayDistinct() async throws {
        let first = try host("Mac"), second = try host("Linux")
        let working = try snapshot("working"), waiting = try snapshot("waiting")
        let model = SessionOverviewMonitor { LiveHostMonitor { host, _ in host.id == first.id ? working : waiting } }
        let run = Task { await model.run(hosts: [second, first]) }
        await eventually { model.connectedCount(at: .now) == 2 }
        let result = groups(model)
        XCTAssertEqual(result.map(\.title), ["Working", "Needs input"])
        XCTAssertEqual(Set(result.flatMap(\.sessions).map(\.id)).count, 2)
        run.cancel(); await run.value
    }

    func testFocusFilterScopesGroupsToItsComputer() async throws {
        let first = try host("Mac"), second = try host("Work")
        let working = try snapshot("working")
        let model = SessionOverviewMonitor { LiveHostMonitor { _, _ in working } }
        let run = Task { await model.run(hosts: [first, second]) }
        await eventually { model.connectedCount(at: .now) == 2 }
        let filter = AgentFocusFilter(computerID: second.id, storeID: nil, label: "Work")
        let result = model.groups(at: .now, preferences: nil, projects: [], focusFilter: filter)
        XCTAssertEqual(result.flatMap(\.sessions).map(\.host.id), [second.id])
        run.cancel(); await run.value
    }

    func testFocusFilterUsesTheMappedStoreWhenRequested() throws {
        let computer = try host("Work")
        let snapshot = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[{"id":"w","label":"Workspace","children":[{"id":"t","label":"Agent","agent":"codex","cwd":"/work/phone"}]}]}"#.utf8))
        let session = try XCTUnwrap(snapshot.sessions(on: computer).first)
        var data = try LiveSessionPreferences.saving(computer, in: Data())
        data = try LiveSessionPreferences.assigning(hostID: computer.id, directory: "/work/phone",
                                                     storeID: "work/brain", project: "phone", in: data)
        let preferences = try LiveSessionPreferences.read(data)
        let projects = [SessionProject(storeID: "work/brain", name: "phone")]
        XCTAssertTrue(AgentFocusFilter(computerID: nil, storeID: "work/brain", label: "Work").includes(session, preferences: preferences, projects: projects))
        XCTAssertFalse(AgentFocusFilter(computerID: nil, storeID: "personal/brain", label: "Personal").includes(session, preferences: preferences, projects: projects))
    }

    func testDoneSitsAboveIdleAndNewestChangeComesFirstWithinAGroup() async throws {
        let mac = try host("Mac")
        let workspaces = try LiveWorkspaces.read(Data("""
        {"kind":"herdr","groups":[
          {"id":"w1","label":"alpha","children":[{"id":"w1:t1","label":"1","agent":"codex","agentStatus":"idle","changedSeq":40}]},
          {"id":"w2","label":"beta","children":[{"id":"w2:t1","label":"1","agent":"claude","agentStatus":"done","changedSeq":10}]},
          {"id":"w3","label":"gamma","children":[{"id":"w3:t1","label":"1","agent":"claude","agentStatus":"done","changedSeq":90}]},
          {"id":"w4","label":"delta","children":[{"id":"w4:t1","label":"1","agent":"codex","agentStatus":"working","changedSeq":5}]}
        ]}
        """.utf8))
        let model = SessionOverviewMonitor { LiveHostMonitor { _, _ in workspaces } }
        let run = Task { await model.run(hosts: [mac]) }
        await eventually { model.connectedCount(at: .now) == 1 }
        let result = groups(model)
        XCTAssertEqual(result.map(\.title), ["Working", "Done", "Idle"])
        // The session that finished most recently (highest change counter) leads its group.
        XCTAssertEqual(result[1].sessions.map(\.workspaceName), ["gamma", "beta"])
        run.cancel(); await run.value
    }

    func testPinningMovesOnlyTheSelectedComputersTabAndUnpinningRestoresItsActivityGroup() async throws {
        let first = try host("Mac"), second = try host("Linux")
        let working = try snapshot("working"), waiting = try snapshot("waiting")
        let selected = waiting.sessions(on: second)[0].id
        var data = try LiveSessionPreferences.saving(first, in: Data())
        data = try LiveSessionPreferences.saving(second, in: data)
        data = try LiveSessionPreferences.setPinned(true, for: selected, in: data)
        let preferences = try LiveSessionPreferences.read(data)
        let model = SessionOverviewMonitor { LiveHostMonitor { host, _ in host.id == first.id ? working : waiting } }
        let run = Task { await model.run(hosts: [second, first]) }
        await eventually { model.connectedCount(at: .now) == 2 }

        let pinned = groups(model, preferences: preferences)
        XCTAssertEqual(pinned.map(\.title), ["Pinned", "Working"])
        XCTAssertEqual(pinned.first?.sessions.map(\.id), [selected])
        XCTAssertEqual(pinned.last?.sessions.map(\.host.id), [first.id])
        XCTAssertEqual(pinned.flatMap(\.sessions).count, 2, "A pin must move a session, not duplicate it")

        data = try LiveSessionPreferences.setPinned(false, for: selected, in: data)
        let unpinned = groups(model, preferences: try LiveSessionPreferences.read(data))
        XCTAssertEqual(unpinned.map(\.title), ["Working", "Needs input"])
        XCTAssertEqual(unpinned.last?.sessions.map(\.id), [selected])
        run.cancel(); await run.value
    }

    func testPinnedFreshAndOfflineSessionsKeepTheirOwnFreshnessAndUnpinningRestoresLastSeen() async throws {
        let first = try host("Mac"), second = try host("Linux")
        let working = try snapshot("working")
        let liveSession = working.sessions(on: first)[0], offlineSession = working.sessions(on: second)[0]
        var data = try LiveSessionPreferences.saving(first, in: Data())
        data = try LiveSessionPreferences.saving(second, in: data)
        for session in [liveSession, offlineSession] {
            data = try LiveSessionPreferences.setPinned(true, for: session.id, in: data)
        }
        let preferences = try LiveSessionPreferences.read(data)
        var failSecond = false
        let model = SessionOverviewMonitor {
            LiveHostMonitor(pollInterval: .milliseconds(20)) { host, _ in
                if host.id == second.id && failSecond { throw LiveConnectionError.disconnected }
                return working
            }
        }
        let run = Task { await model.run(hosts: [first, second]) }
        await eventually { model.connectedCount(at: .now) == 2 }
        XCTAssertTrue(groups(model, preferences: preferences).first?.fresh == true)
        failSecond = true
        await eventually { model.computers.first { $0.id == second.id }?.monitor.message != nil }

        model.computers.first { $0.id == second.id }?.monitor.lastUpdated = .now.addingTimeInterval(-91)
        let pinned = groups(model, preferences: preferences)
        XCTAssertEqual(pinned.map(\.title), ["Pinned"])
        XCTAssertEqual(Set(pinned.flatMap(\.sessions).map(\.id)), [liveSession.id, offlineSession.id])
        XCTAssertFalse(pinned[0].fresh)
        XCTAssertTrue(model.isFresh(liveSession, at: .now), "An offline pin must not disable another computer's session")
        XCTAssertFalse(model.isFresh(offlineSession, at: .now), "Pinning must never make stale work appear active")

        data = try LiveSessionPreferences.setPinned(false, for: offlineSession.id, in: data)
        let unpinned = groups(model, preferences: try LiveSessionPreferences.read(data))
        XCTAssertEqual(unpinned.map(\.title), ["Pinned", "Last seen"])
        XCTAssertEqual(unpinned.first?.sessions.map(\.id), [liveSession.id])
        XCTAssertEqual(unpinned.last?.sessions.map(\.id), [offlineSession.id])
        XCTAssertTrue(unpinned[0].fresh); XCTAssertFalse(unpinned[1].fresh)
        run.cancel(); await run.value
    }

    func testFailureRetainsOnlyThatComputersStaleRowsAndClosedSessionsDisappear() async throws {
        let first = try host("Mac"), second = try host("Linux")
        let working = try snapshot("working"), empty = try LiveWorkspaces.read(Data(#"{"kind":"herdr","groups":[]}"#.utf8))
        var failFirst = false, closeSecond = false
        let model = SessionOverviewMonitor {
            LiveHostMonitor(pollInterval: .milliseconds(20)) { host, _ in
                if host.id == first.id && failFirst { throw LiveConnectionError.disconnected }
                return host.id == second.id && closeSecond ? empty : working
            }
        }
        let run = Task { await model.run(hosts: [first, second]) }
        await eventually { model.connectedCount(at: .now) == 2 }
        failFirst = true
        await eventually { model.computers[0].monitor.message != nil }
        XCTAssertEqual(model.connectedCount(at: .now), 2, "A transient failure has a grace period")
        model.computers[0].monitor.lastUpdated = .now.addingTimeInterval(-91)
        XCTAssertEqual(groups(model).map(\.title), ["Working", "Last seen"])
        XCTAssertEqual(groups(model).last?.sessions.first?.host.id, first.id)
        XCTAssertEqual(model.connectedCount(at: .now), 1)
        closeSecond = true
        await eventually { self.groups(model).flatMap(\.sessions).count == 1 }
        XCTAssertEqual(groups(model).map(\.title), ["Last seen"])
        failFirst = false
        await eventually { model.computers[0].monitor.message == nil }
        XCTAssertEqual(groups(model).map(\.title), ["Working"])
        run.cancel(); await run.value
    }

    /// Seen 2026-09-24: a saturated Mac mini answered /v1/health in under a
    /// second while /v1/workspaces outlasted the phone's 20 s wait. The phone
    /// called it offline and disabled every tile, though chat and terminal
    /// would both have worked. A computer whose Hook answers is busy, not gone.
    func testBusyComputerKeepsItsSessionsUsableUntilTheOverviewCatchesUp() async throws {
        let first = try host("Mini")
        let working = try snapshot("working")
        var overloaded = false, healthAnswers = true
        let model = SessionOverviewMonitor {
            LiveHostMonitor(pollInterval: .milliseconds(20), fetch: { _, _ in
                if overloaded { throw LiveConnectionError.timeout }
                return working
            }, stream: nil, probe: { _ in if !healthAnswers { throw LiveConnectionError.disconnected } })
        }
        let run = Task { await model.run(hosts: [first]) }
        await eventually { model.connectedCount(at: .now) == 1 }
        overloaded = true
        let monitor = model.computers[0].monitor
        await eventually { monitor.busy }
        // Long past the answer's freshness: only the Hook's health keeps it live.
        monitor.lastUpdated = .now.addingTimeInterval(-91)
        XCTAssertNil(monitor.message, "a computer whose Hook answers is not offline")
        XCTAssertTrue(monitor.isLive(at: .now), "its last known sessions stay tappable")
        XCTAssertFalse(monitor.isStale(at: .now))
        XCTAssertEqual(groups(model).map(\.title), ["Working"], "its sessions keep their place instead of dropping to Last seen")
        XCTAssertTrue(groups(model).first?.fresh == true)
        await eventually { model.screen.computers.first?.busy == true }
        XCTAssertNil(model.screen.computers.first?.message)
        XCTAssertFalse(model.screen.computers.first?.connecting ?? true, "busy, not connecting")

        // A computer that doesn't answer at all is still offline.
        healthAnswers = false
        await eventually { monitor.message != nil }
        XCTAssertFalse(monitor.busy)
        XCTAssertFalse(monitor.isLive(at: .now))
        XCTAssertEqual(groups(model).map(\.title), ["Last seen"])

        // The overview catches up: live again, details and all.
        overloaded = false; healthAnswers = true
        await eventually { monitor.message == nil && !monitor.busy && monitor.isFresh(at: .now) }
        XCTAssertEqual(groups(model).map(\.title), ["Working"])
        run.cancel(); await run.value
    }

    func testRemovingAndReconfiguringAComputerDropsItsPreviousDestination() async throws {
        let first = try host("Mac"), second = try host("Linux")
        let working = try snapshot("working")
        let model = SessionOverviewMonitor { LiveHostMonitor { _, _ in working } }
        let run = Task { await model.run(hosts: [first, second]) }
        await eventually { model.connectedCount(at: .now) == 2 }
        let previous = model.computers[0].monitor
        run.cancel(); await run.value
        var changed = first; changed.herdrSession = "another-server"
        let next = Task { await model.run(hosts: [changed]) }
        await eventually { model.computers.count == 1 && model.connectedCount(at: .now) == 1 }
        XCTAssertFalse(model.computers[0].monitor === previous)
        XCTAssertEqual(groups(model).flatMap(\.sessions).map(\.id.muxID), ["herdr:another-server"])
        next.cancel(); await next.value
    }

    private func groups(_ model: SessionOverviewMonitor, preferences: LiveSessionPreferences? = nil) -> [SessionOverviewMonitor.Group] {
        model.groups(at: .now, preferences: preferences, projects: [])
    }
    private func host(_ name: String) throws -> LiveHost { try LiveHost(name: name, address: name.lowercased() + ".invalid", username: "fixture") }
    private func snapshot(_ status: String) throws -> LiveWorkspaces {
        try LiveWorkspaces.read(Data("""
        {"kind":"herdr","groups":[{"id":"w1","label":"Project","children":[{"id":"w1:t1","label":"Build","agent":"codex","agentStatus":"\(status)","cwd":"/work/phone"}]}]}
        """.utf8))
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
}
