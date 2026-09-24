import XCTest

/// Opt-in phone baselines for the Phase 2 optimization work: opening the heavy
/// chat fixture, swiping through it, and opening Agents over the all-sessions
/// fixture. Skipped unless `PHREN_RUN_PERF=1` (passed to xcodebuild as
/// `TEST_RUNNER_PHREN_RUN_PERF=1`). Each measurement prints `PHREN_PERF` lines
/// with wall-clock seconds per iteration, next to XCTest's own clock and CPU
/// metrics; the `...Work` tests print `PHREN_COUNT` lines, the change in the
/// app's `PerformanceCounters` over an idle window or a gesture.
/// docs/performance.md records the numbers.
final class PerformanceBaselineTests: XCTestCase {
    private let chatRow = "live-chat:w7:w7:t9"
    private let lastMessage = "chat-message:59:0"
    private let mac = "A1000000-0000-0000-0000-000000000001"

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PHREN_RUN_PERF"] == "1",
                          "Set PHREN_RUN_PERF=1 (TEST_RUNNER_PHREN_RUN_PERF=1) to run the performance baselines.")
        continueAfterFailure = false
    }

    /// Time from tapping the heavy chat's row to its last message on screen.
    @MainActor
    func testHeavyChatOpen() {
        let app = launchToComputer(extra: ["--chat-heavy"])
        let row = app.buttons[chatRow], close = app.buttons["chat-close"]
        // The first open, cold: nothing about this transcript is cached yet.
        let cold = Date()
        row.tap()
        XCTAssertTrue(message(app).waitForExistence(timeout: 20))
        report("chat-open-cold", Date().timeIntervalSince(cold))
        close.tap()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        var iteration = 0
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
            iteration += 1
            let started = Date()
            startMeasuring()
            row.tap()
            XCTAssertTrue(message(app).waitForExistence(timeout: 20))
            stopMeasuring()
            report("chat-open-warm", Date().timeIntervalSince(started), iteration)
            close.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
        }
    }

    /// Tap to first transcript row by the app's own clock (`ChatJourney`,
    /// read through the counters probe): the first open, then five reopens,
    /// with each open building its model afresh (`--chat-fresh-models`, the
    /// old behavior) or keeping it, without and with a simulated computer
    /// round trip (`--chat-latency`).
    @MainActor
    func testChatOpenJourney() {
        let configurations = [("fresh", ["--chat-heavy", "--chat-fresh-models"]), ("kept", ["--chat-heavy"]),
                              ("fresh-latency", ["--chat-heavy", "--chat-latency", "--chat-fresh-models"]), ("kept-latency", ["--chat-heavy", "--chat-latency"])]
        for (name, extra) in configurations {
            let app = launchToComputer(extra: extra)
            let row = app.buttons[chatRow], close = app.buttons["chat-close"]
            var before = counters(app)
            row.tap()
            XCTAssertTrue(message(app).waitForExistence(timeout: 20))
            reportJourney(name + "-first", before, counters(app))
            close.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            before = counters(app)
            for _ in 0..<5 {
                row.tap()
                XCTAssertTrue(message(app).waitForExistence(timeout: 20))
                close.tap()
                XCTAssertTrue(row.waitForExistence(timeout: 10))
            }
            reportJourney(name + "-reopen", before, counters(app))
            app.terminate()
        }
    }

    /// The first open of Agents' top session, with and without the
    /// prefetch Agents starts for its first few sessions (`--chat-prefetch`
    /// lets it run against the fixture), over a simulated round trip.
    @MainActor
    func testChatOpenFromAgentsJourney() {
        for (name, extra) in [("agents-cold", [String]()), ("agents-prefetched", ["--chat-prefetch"])] {
            let app = XCUIApplication()
            app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
            app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture",
                                   "--session-pins-reset", "--chat-heavy", "--chat-latency"] + extra
            let card = app.buttons["overview-chat:\(mac):herdr:default:w1:w1:t1"]
            // The first launch after an install can open on the introduction.
            for attempt in 0..<2 {
                app.launch()
                let agents = app.tabBars.buttons["Agents"]
                XCTAssertTrue(agents.waitForExistence(timeout: 10))
                agents.tap()
                if card.waitForExistence(timeout: attempt == 0 ? 12 : 25) { break }
                app.terminate()
            }
            XCTAssertTrue(card.exists)
            // Time for the prefetch's two round trips; the cold run waits the same.
            sleep(3)
            let before = counters(app)
            card.tap()
            XCTAssertTrue(message(app).waitForExistence(timeout: 20))
            reportJourney(name, before, counters(app))
            app.terminate()
        }
    }

    private func reportJourney(_ name: String, _ before: [String: Int], _ after: [String: Int]) {
        let opens = (after["journey.chat-opens"] ?? 0) - (before["journey.chat-opens"] ?? 0)
        let total = (after["journey.chat-first-row-ms"] ?? 0) - (before["journey.chat-first-row-ms"] ?? 0)
        XCTAssertGreaterThan(opens, 0, "Each open records its first row")
        let view = (after["journey.chat-view-ms"] ?? 0) - (before["journey.chat-view-ms"] ?? 0)
        let views = (after["journey.chat-views"] ?? 0) - (before["journey.chat-views"] ?? 0)
        print(String(format: "PHREN_JOURNEY %@ opens=%d screen_ms=%.0f first_row_ms=%.0f", name, opens,
                     Double(view) / Double(max(views, 1)), Double(total) / Double(max(opens, 1))))
    }

    /// Three swipes down into the heavy transcript's history and three back up.
    @MainActor
    func testHeavyChatSwipes() {
        let app = launchToComputer(extra: ["--chat-heavy"])
        app.buttons[chatRow].tap()
        XCTAssertTrue(message(app).waitForExistence(timeout: 20))
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        var iteration = 0
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
            iteration += 1
            let started = Date()
            for _ in 0..<3 { transcript.swipeDown() }
            let down = Date()
            for _ in 0..<3 { transcript.swipeUp() }
            report("chat-swipes-3-down", down.timeIntervalSince(started), iteration)
            report("chat-swipes-3-up", Date().timeIntervalSince(down), iteration)
            report("chat-swipes-6", Date().timeIntervalSince(started), iteration)
        }
    }

    /// Opening Agents over the all-sessions fixture until the first session card shows.
    @MainActor
    func testAgentsTabAllSessions() {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture", "--session-pins-reset"]
        app.launch()
        let agents = app.tabBars.buttons["Agents"], other = app.tabBars.buttons["Projects"]
        XCTAssertTrue(agents.waitForExistence(timeout: 10))
        let card = app.buttons["overview-chat:\(mac):herdr:default:w1:w1:t1"]
        let cold = Date()
        agents.tap()
        XCTAssertTrue(card.waitForExistence(timeout: 20))
        report("agents-open-cold", Date().timeIntervalSince(cold))
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        var iteration = 0
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(application: app)], options: options) {
            iteration += 1
            other.tap()
            XCTAssertTrue(other.waitForExistence(timeout: 5))
            let started = Date()
            startMeasuring()
            agents.tap()
            XCTAssertTrue(card.waitForExistence(timeout: 20))
            stopMeasuring()
            report("agents-open-warm", Date().timeIntervalSince(started), iteration)
        }
    }

    /// Ten idle seconds on Agents over the all-sessions fixture: what the
    /// app does on its own with nothing changing (clock ticks, polls,
    /// preference reads and decodes).
    @MainActor
    func testAgentsIdleWork() {
        agentsIdle("agents", extra: [])
    }

    /// The same, with each fixture computer pushing its overview the way a
    /// current Hook's `/v1/overview` stream does, instead of being polled.
    @MainActor
    func testAgentsIdleWorkStreaming() {
        agentsIdle("agents-stream", extra: ["--overview-stream-fixture"])
    }

    @MainActor
    private func agentsIdle(_ name: String, extra: [String]) {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--all-sessions-fixture", "--native-chat-fixture", "--session-pins-reset"] + extra
        let card = app.buttons["overview-chat:\(mac):herdr:default:w1:w1:t1"]
        // The first launch after an install can open on the introduction;
        // a second launch opens the list.
        for attempt in 0..<2 {
            app.launch()
            let agents = app.tabBars.buttons["Agents"]
            XCTAssertTrue(agents.waitForExistence(timeout: 10))
            agents.tap()
            if card.waitForExistence(timeout: attempt == 0 ? 12 : 25) { break }
            app.terminate()
        }
        XCTAssertTrue(card.exists)
        reportIdle(name, app)
    }

    /// Ten idle seconds on a computer's page, where every card had its own
    /// one-second timeline.
    @MainActor
    func testComputerIdleWork() {
        let app = launchToComputer(extra: [])
        reportIdle("computer", app)
    }

    /// Ten idle seconds in the heavy chat with the fixture stream running.
    @MainActor
    func testHeavyChatIdleWork() {
        let app = launchToComputer(extra: ["--chat-heavy"])
        app.buttons[chatRow].tap()
        XCTAssertTrue(message(app).waitForExistence(timeout: 20))
        reportIdle("chat", app)
    }

    /// The work behind one round of three swipes down and three up.
    @MainActor
    func testHeavyChatSwipeWork() {
        let app = launchToComputer(extra: ["--chat-heavy"])
        app.buttons[chatRow].tap()
        XCTAssertTrue(message(app).waitForExistence(timeout: 20))
        let transcript = app.scrollViews["chat-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        sleep(2)
        let before = counters(app), started = Date()
        for _ in 0..<3 { transcript.swipeDown() }
        for _ in 0..<3 { transcript.swipeUp() }
        let seconds = Date().timeIntervalSince(started)
        report("chat-swipe-work-6", seconds)
        reportDelta("chat-swipes", before, counters(app), seconds: seconds)
    }

    @MainActor
    /// Ten seconds unless `PHREN_PERF_IDLE_SECONDS` (TEST_RUNNER_PHREN_PERF_IDLE_SECONDS)
    /// asks for a longer window, which slow polls need to show up in.
    private func reportIdle(_ name: String, _ app: XCUIApplication,
                            seconds: UInt32 = UInt32(ProcessInfo.processInfo.environment["PHREN_PERF_IDLE_SECONDS"] ?? "") ?? 10) {
        sleep(2)
        let before = counters(app)
        sleep(seconds)
        reportDelta(name + "-idle", before, counters(app), seconds: TimeInterval(seconds))
    }

    @MainActor
    private func counters(_ app: XCUIApplication) -> [String: Int] {
        let probe = app.descendants(matching: .any).matching(identifier: "perf-counters").firstMatch
        XCTAssertTrue(probe.waitForExistence(timeout: 5), "The counters probe needs PHREN_PERFORMANCE_LOG=1 and a debug build")
        var values: [String: Int] = [:]
        for pair in ((probe.value as? String) ?? "").split(separator: " ") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            if parts.count == 2, let value = Int(parts[1]) { values[String(parts[0])] = value }
        }
        return values
    }

    private func reportDelta(_ name: String, _ before: [String: Int], _ after: [String: Int], seconds: TimeInterval) {
        for key in Set(before.keys).union(after.keys).sorted() {
            let delta = (after[key] ?? 0) - (before[key] ?? 0)
            guard delta != 0 else { continue }
            print(String(format: "PHREN_COUNT %@ %@=%d per_second=%.2f", name, key, delta, Double(delta) / seconds))
        }
    }

    @MainActor
    private func message(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: lastMessage).firstMatch
    }

    private func report(_ name: String, _ seconds: TimeInterval, _ iteration: Int = 0) {
        print(String(format: "PHREN_PERF %@ iteration=%d seconds=%.3f", name, iteration, seconds))
    }

    /// The fixture computer's page, where the heavy chat's row is (as AgentChatTests reaches it).
    @MainActor
    private func launchToComputer(extra: [String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["PHREN_PERFORMANCE_LOG"] = "1"
        app.launchArguments = ["--ui-testing", "--automatic-sessions-fixture", "--session-details-fixture", "--native-chat-fixture"] + extra
        let host = app.buttons["live-host:\(mac)"]
        for attempt in 0..<2 {
            app.launch()
            XCTAssertTrue(app.tabBars.buttons["Agents"].waitForExistence(timeout: 8))
            app.tabBars.buttons["Agents"].tap()
            let revealed = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "live-host:")).firstMatch
            if revealed.waitForExistence(timeout: attempt == 0 ? 12 : 25) || app.staticTexts["agents-introduction"].exists == false { break }
            if attempt == 0 { app.terminate() }
        }
        for _ in 0..<14 {
            if host.exists && host.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(host.waitForExistence(timeout: 5), "The fixture computer must appear in Agents")
        host.tap()
        XCTAssertTrue(app.buttons[chatRow].waitForExistence(timeout: 10))
        return app
    }
}
