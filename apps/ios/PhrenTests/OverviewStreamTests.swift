import XCTest
import PhrenKit
import PhrenLive
@testable import Phren

/// The pushed overview: a Hook that offers it is polled once, then followed
/// over its stream; polls return only while the stream is down.
@MainActor
final class OverviewStreamTests: XCTestCase {
    private final class Link {
        var opened = 0
        var continuation: AsyncThrowingStream<LiveOverviewFrame, Error>.Continuation?
        func open() -> AsyncThrowingStream<LiveOverviewFrame, Error> {
            opened += 1
            return AsyncThrowingStream { self.continuation = $0 }
        }
    }

    func testStreamingHookIsPolledOnceThenFollowed() async throws {
        let computer = try host("Desk"), link = Link()
        var fetches = 0
        let first = try snapshot("working", streams: true), second = try snapshot("idle", streams: true)
        let monitor = LiveHostMonitor(pollInterval: .milliseconds(20), fetch: { _, _ in fetches += 1; return first },
                                      stream: { _ in link.open() })
        let run = Task { await monitor.run(host: computer) }
        await eventually { link.continuation != nil }
        XCTAssertEqual(fetches, 1, "One poll learns that the Hook pushes")
        XCTAssertTrue(monitor.streaming)
        XCTAssertEqual(monitor.snapshot, first)

        link.continuation?.yield(.overview(second))
        await eventually { monitor.snapshot == second }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(fetches, 1, "No polls while the stream is open")

        // A heartbeat keeps the held overview current without a poll.
        let before = try XCTUnwrap(monitor.lastUpdated)
        try await Task.sleep(for: .milliseconds(20))
        link.continuation?.yield(.heartbeat(nil))
        await eventually { (monitor.lastUpdated ?? before) > before }
        XCTAssertTrue(monitor.fresh)

        // An explicit refresh still reads once beside the stream.
        monitor.refreshNow()
        await eventually { fetches == 2 }
        XCTAssertTrue(monitor.streaming)
        run.cancel(); await run.value
    }

    func testDroppedStreamFallsBackToPolling() async throws {
        let computer = try host("Linuxbox"), link = Link()
        var fetches = 0
        let value = try snapshot("working", streams: true)
        let monitor = LiveHostMonitor(pollInterval: .milliseconds(20), fetch: { _, _ in fetches += 1; return value },
                                      stream: { _ in link.open() })
        let run = Task { await monitor.run(host: computer) }
        await eventually { link.continuation != nil }
        link.continuation?.finish(throwing: LiveConnectionError.disconnected)
        // A stream that failed at once is retried later; polls carry on.
        await eventually { fetches >= 4 }
        XCTAssertFalse(monitor.streaming)
        XCTAssertEqual(link.opened, 1)
        XCTAssertNil(monitor.message, "A dropped stream is not an unreachable computer")
        run.cancel(); await run.value
    }

    func testOlderHookIsPolled() async throws {
        let computer = try host("Desk"), link = Link()
        var fetches = 0
        let value = try snapshot("working", streams: false)
        let monitor = LiveHostMonitor(pollInterval: .milliseconds(20), fetch: { _, _ in fetches += 1; return value },
                                      stream: { _ in link.open() })
        let run = Task { await monitor.run(host: computer) }
        await eventually { fetches >= 3 }
        XCTAssertEqual(link.opened, 0)
        run.cancel(); await run.value
    }

    func testOverviewFramesDecode() throws {
        let heartbeat = try LiveOverviewFrame.read(Data(#"{"type":"heartbeat","phren":{"load":{"average":1.5,"cpus":8}}}"#.utf8))
        guard case .heartbeat(let info) = heartbeat else { return XCTFail("A heartbeat") }
        XCTAssertEqual(info?.load, HookLoad(average: 1.5, cpus: 8))
        let overview = try LiveOverviewFrame.read(Data(#"""
        {"type":"overview","kind":"herdr","groups":[],"phren":{"product":"phren-hook","protocol":1,"capabilities":{"overviewStream":true}}}
        """#.utf8))
        guard case .overview(let workspaces) = overview else { return XCTFail("An overview") }
        XCTAssertEqual(workspaces.capabilities?.overviewStream, true)
        XCTAssertThrowsError(try LiveOverviewFrame.read(Data(#"{"type":"surprise"}"#.utf8)))
        // An overview frame is held to the same Hook envelope as a poll.
        XCTAssertThrowsError(try LiveOverviewFrame.read(Data(#"{"type":"overview","kind":"herdr","groups":[]}"#.utf8)))
    }

    func testSharedRefreshRunsOneJobPerKey() async throws {
        let refresh = LiveRefresh()
        var runs = 0
        let first = Task { await refresh.every(.milliseconds(50), key: "test:shared") { runs += 1 } }
        let second = Task { await refresh.every(.milliseconds(50), key: "test:shared") { runs += 100 } }
        try await Task.sleep(for: .milliseconds(180))
        XCTAssertGreaterThanOrEqual(runs, 2, "The job runs at its interval")
        XCTAssertLessThan(runs, 100, "Callers of one key share the first caller's run")
        first.cancel(); second.cancel()
        await first.value; await second.value
        let stopped = runs
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(runs, stopped, "No caller left, no runs")
    }

    private func host(_ name: String) throws -> LiveHost { try LiveHost(name: name, address: name.lowercased() + ".invalid", username: "sam") }
    private func snapshot(_ status: String, streams: Bool) throws -> LiveWorkspaces {
        try LiveWorkspaces.read(Data("""
        {"kind":"herdr","groups":[{"id":"w1","label":"Project","children":[{"id":"w1:t1","label":"Build","agent":"codex","agentStatus":"\(status)","cwd":"/work/phone"}]}],
         "phren":{"product":"phren-hook","protocol":1,"capabilities":{"overviewStream":\(streams)}}}
        """.utf8))
    }
    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), file: file, line: line)
    }
}
