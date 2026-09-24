import XCTest
@testable import PhrenKit

final class AccountUsageTests: XCTestCase {
    func testPercentagesResetTimesAndStaleness() throws {
        let data = Data(#"{"accounts":[{"source":"claude","updatedAt":"2026-09-12T08:00:00.000Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":23.5,"resetsAt":"2026-09-12T09:00:00Z"}]}]}"#.utf8)
        let account = try XCTUnwrap(AccountUsageSnapshot.read(data).accounts.first)
        XCTAssertEqual(account.windows[0].usedPercent, 23.5)
        XCTAssertEqual(account.windows[0].resetDate?.timeIntervalSince(account.updatedDate!), 3600)
        XCTAssertFalse(account.isStale(at: account.updatedDate!.addingTimeInterval(60)))
        XCTAssertTrue(account.isStale(at: account.updatedDate!.addingTimeInterval(121)))
        XCTAssertTrue(account.isStale(at: account.windows[0].resetDate!))
    }
    func testSameAccountOnTwoComputersKeepsTheNewestReportIntact() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-15T20:30:00Z"))
        let mac = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","windows":[],"message":"Sign in"},{"source":"claude","origin":"status-line","updatedAt":"2026-09-15T20:29:30Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":40},{"id":"seven_day","name":"7-day, all models","usedPercent":16},{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":18,"asOf":"2026-09-14T08:06:00Z"}]}]}"#.utf8))
        let remote = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","updatedAt":"2026-09-15T20:29:40Z","windows":[{"id":"codex:primary","name":"7-day limit","usedPercent":90}]},{"source":"claude","updatedAt":"2026-09-15T20:29:00Z","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":13},{"id":"seven_day","name":"7-day, all models","usedPercent":70},{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":89,"asOf":"2026-09-15T18:00:00Z"}]}]}"#.utf8))
        let merged = MergedAccountUsage.merge([("Desk", mac), ("Desk 2", remote)], at: now)
        XCTAssertEqual(merged.map(\.source), ["codex", "claude"])
        XCTAssertEqual(merged[0].computers, ["Desk", "Desk 2"])
        XCTAssertEqual(merged[0].windows.map(\.usedPercent), [90])
        XCTAssertNil(merged[0].message, "A computer that has the account reporting outranks one that asks to sign in")
        let claude = merged[1]
        XCTAssertEqual(claude.windows.map(\.id), ["five_hour", "seven_day", "seven_day_fable"])
        XCTAssertEqual(claude.windows.map(\.usedPercent), [40, 16, 18], "The newest whole report wins, not the maximum for each window")
        XCTAssertEqual(claude.windows.map(\.name), ["5-hour limit", "7-day, all models", "7-day, Fable"])
        XCTAssertEqual(claude.primaryWindow?.id, "seven_day")
        XCTAssertEqual(claude.origin, "status-line")
        XCTAssertEqual(claude.updatedAt, ISO8601Dates.parse("2026-09-15T20:29:30Z"))
        XCTAssertFalse(claude.stale)
        XCTAssertEqual(MergedAccountUsage.merge([("Desk", nil)], at: now), [])
    }
    func testUnavailableDoesNotInventZeroUsage() throws {
        let value = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","windows":[],"message":"Sign in"}]}"#.utf8))
        XCTAssertTrue(value.accounts[0].windows.isEmpty)
        XCTAssertNil(value.accounts[0].updatedDate)
    }
    /// The header ring draws primaryWindow: Claude's 7-day all-models window
    /// (never the 5-hour or per-model weekly one), and Codex's first window.
    func testRingBindsToClaudesSevenDayAllModelsWindow() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-15T20:30:00Z"))
        let claudeReport = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"claude","origin":"status-line","updatedAt":"2026-09-15T20:29:30Z","windows":[{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":90},{"id":"seven_day","name":"7-day, all models","usedPercent":70},{"id":"five_hour","name":"5-hour limit","usedPercent":5}]}]}"#.utf8))
        let codexReport = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"codex","updatedAt":"2026-09-15T20:29:30Z","windows":[{"id":"codex:primary","name":"5-hour limit","usedPercent":23.5},{"id":"codex:secondary","name":"7-day limit","usedPercent":41.2}]}]}"#.utf8))
        let merged = MergedAccountUsage.merge([("Desk", claudeReport), ("Desk 2", codexReport)], at: now)

        let claude = try XCTUnwrap(merged.first { $0.source == "claude" })
        XCTAssertEqual(claude.displayWindows.map(\.id), ["five_hour", "seven_day_fable", "seven_day"])
        XCTAssertEqual(claude.primaryWindow?.id, "seven_day", "Not the 5-hour or the Fable-only window")
        XCTAssertEqual(claude.primaryWindow?.usedPercent, 70)

        let codex = try XCTUnwrap(merged.first { $0.source == "codex" })
        XCTAssertEqual(codex.displayWindows.map(\.id), ["codex:primary", "codex:secondary"])
        XCTAssertEqual(codex.primaryWindow?.id, "codex:primary", "The 5-hour window the page shows first, not the higher 7-day one")
        XCTAssertEqual(codex.primaryWindow?.usedPercent, 23.5)
    }
    func testOpenCodeCostsSumAndDuplicateOpenRouterKeysCountOnce() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-19T18:30:00Z"))
        let keyA = String(repeating: "a", count: 64), keyB = String(repeating: "b", count: 64)
        let mac = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"opencode","updatedAt":"2026-09-19T18:29:00Z","windows":[],"spend":{"amountUSD":4.39,"period":"rolling_7_days"}},{"source":"openrouter","accountId":"\#(keyA)","updatedAt":"2026-09-19T18:29:00Z","windows":[],"spend":{"amountUSD":5.0,"period":"calendar_week"}}]}"#.utf8))
        let remote = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"opencode","updatedAt":"2026-09-19T18:29:30Z","windows":[],"spend":{"amountUSD":0.61,"period":"rolling_7_days"}},{"source":"openrouter","accountId":"\#(keyA)","updatedAt":"2026-09-19T18:29:30Z","windows":[],"spend":{"amountUSD":5.08,"period":"calendar_week"}}]}"#.utf8))
        let server = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"openrouter","accountId":"\#(keyB)","updatedAt":"2026-09-19T18:29:20Z","windows":[],"spend":{"amountUSD":1.12,"period":"calendar_week"}}]}"#.utf8))
        let merged = MergedAccountUsage.merge([("Desk", mac), ("Desk 2", remote), ("Desk 3", server)], at: now)
        let openCode = try XCTUnwrap(merged.first { $0.source == "opencode" })
        XCTAssertEqual(try XCTUnwrap(openCode.spend).amountUSD, 5.0, accuracy: 0.000_001)
        XCTAssertEqual(openCode.spend?.periodLabel, "Past 7 days")
        let openRouter = try XCTUnwrap(merged.first { $0.source == "openrouter" })
        XCTAssertEqual(try XCTUnwrap(openRouter.spend).amountUSD, 6.2, accuracy: 0.000_001)
        XCTAssertEqual(openRouter.spend?.periodLabel, "This week · UTC")
    }
    func testOpenCodeGoWindowsDecodeDollarUsageWithoutInventingAPercentage() throws {
        let data = Data(#"{"accounts":[{"source":"opencode-go","updatedAt":"2026-09-20T07:41:45.218Z","windows":[{"id":"opencode-go:kimi_k3:5h","name":"opencode-go/kimi-k3 · 5h","usedUSD":1.2},{"id":"opencode-go:kimi_k3:7d","name":"opencode-go/kimi-k3 · 7d","usedUSD":4.8,"limitUSD":5,"usedPercent":96},{"id":"opencode-go:kimi_k3:30d","name":"opencode-go/kimi-k3 · 30d","usedUSD":9.1,"limitUSD":10,"usedPercent":91}],"spend":{"amountUSD":9.1,"period":"rolling_30_days"}}]}"#.utf8)
        let account = try XCTUnwrap(AccountUsageSnapshot.read(data).accounts.first)
        XCTAssertEqual(account.name, "OpenCode Go")
        XCTAssertEqual(account.spend?.periodLabel, "Past 30 days")
        XCTAssertEqual(account.windows.map(\.usedUSD), [1.2, 4.8, 9.1])
        XCTAssertNil(account.windows[0].limitUSD)
        XCTAssertNil(account.windows[0].usedPercent)
        XCTAssertEqual(account.windows[2].limitUSD, 10)
        XCTAssertEqual(account.windows[2].usedPercent, 91)
    }
    func testOpenCodeGoLocalModelAmountsMergeAcrossComputers() throws {
        let first = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"opencode-go","updatedAt":"2026-09-20T07:41:45.218Z","windows":[{"id":"opencode-go:kimi_k3:5h","name":"opencode-go/kimi-k3 · 5h","usedUSD":1.2,"limitUSD":2,"usedPercent":60}],"spend":{"amountUSD":1.2,"period":"rolling_30_days"}}]}"#.utf8))
        let second = try AccountUsageSnapshot.read(Data(#"{"accounts":[{"source":"opencode-go","updatedAt":"2026-09-20T07:42:45.218Z","windows":[{"id":"opencode-go:kimi_k3:5h","name":"opencode-go/kimi-k3 · 5h","usedUSD":0.8}],"spend":{"amountUSD":0.8,"period":"rolling_30_days"}}]}"#.utf8))
        let go = try XCTUnwrap(MergedAccountUsage.merge([("Desk", first), ("Desk 2", second)], at: Date.now).first)

        XCTAssertEqual(go.windows[0].usedUSD, 2)
        XCTAssertEqual(go.windows[0].limitUSD, 2)
        XCTAssertEqual(go.windows[0].usedPercent, 100)
        XCTAssertEqual(go.spend?.amountUSD, 2)
    }
    func testHookPayloadWithAllFourProvidersParses() throws {
        let now = try XCTUnwrap(ISO8601Dates.parse("2026-09-20T07:41:48.502Z"))
        let key = String(repeating: "a", count: 64)
        let data = Data(#"{"accounts":[{"source":"codex","windows":[{"id":"codex:primary","name":"7-day limit","usedPercent":12,"resetsAt":"2026-09-26T13:12:01.000Z"}],"updatedAt":"2026-09-20T07:41:48.502Z"},{"source":"claude","windows":[{"id":"five_hour","name":"5-hour limit","usedPercent":35,"resetsAt":"2026-09-20T09:30:00.000Z"},{"id":"seven_day","name":"7-day, all models","usedPercent":15,"resetsAt":"2026-09-26T20:00:00.000Z"},{"id":"seven_day_fable","name":"7-day, Fable","usedPercent":16,"resetsAt":"2026-09-26T20:00:00.000Z"}],"updatedAt":"2026-09-20T07:41:45.218Z"},{"source":"opencode","windows":[],"spend":{"amountUSD":4.5,"period":"rolling_7_days"},"updatedAt":"2026-09-20T07:41:45.218Z"},{"source":"openrouter","accountId":"\#(key)","windows":[],"spend":{"amountUSD":5.177927645,"period":"calendar_week"},"updatedAt":"2026-09-20T07:41:45.218Z"}]}"#.utf8)
        let value = try AccountUsageSnapshot.read(data)
        XCTAssertEqual(value.accounts.map(\.source), ["codex", "claude", "opencode", "openrouter"])

        let codex = value.accounts[0]
        XCTAssertEqual(codex.windows.map(\.id), ["codex:primary"])
        XCTAssertEqual(codex.windows[0].usedPercent, 12)
        XCTAssertEqual(codex.updatedDate, now)
        XCTAssertEqual(codex.windows[0].resetDate, ISO8601Dates.parse("2026-09-26T13:12:01.000Z"))

        let claude = value.accounts[1]
        XCTAssertEqual(claude.windows.map(\.id), ["five_hour", "seven_day", "seven_day_fable"])
        XCTAssertEqual(claude.windows.map(\.usedPercent), [35, 15, 16])
        XCTAssertEqual(claude.windows.map(\.name), ["5-hour limit", "7-day, all models", "7-day, Fable"])

        let openCode = value.accounts[2]
        XCTAssertTrue(openCode.windows.isEmpty)
        XCTAssertEqual(try XCTUnwrap(openCode.spend).amountUSD, 4.5, accuracy: 0.000_001)
        XCTAssertEqual(openCode.spend?.periodLabel, "Past 7 days")

        let openRouter = value.accounts[3]
        XCTAssertTrue(openRouter.windows.isEmpty)
        XCTAssertEqual(openRouter.accountId, key)
        XCTAssertEqual(try XCTUnwrap(openRouter.spend).amountUSD, 5.177927645, accuracy: 0.000_000_001)
        XCTAssertEqual(openRouter.spend?.periodLabel, "This week · UTC")
    }
    func testHookPayloadWithoutSpendingAccountsParses() throws {
        let data = Data(#"{"accounts":[{"source":"codex","windows":[{"id":"codex:primary","name":"7-day limit","usedPercent":12}],"updatedAt":"2026-09-20T07:41:48.502Z"},{"source":"claude","windows":[],"message":"Usage appears after Claude Code replies on this computer."}]}"#.utf8)
        let value = try AccountUsageSnapshot.read(data)
        XCTAssertEqual(value.accounts.map(\.source), ["codex", "claude"])
        XCTAssertTrue(value.accounts[1].windows.isEmpty)
        XCTAssertNil(value.accounts[0].spend)
        XCTAssertNil(value.accounts[0].accountId)
    }
    func testInvalidProviderPercentDateAndDuplicateWindowsAreRejected() throws {
        let valid = #"{"accounts":[{"source":"codex","windows":[{"id":"primary","name":"5-hour limit","usedPercent":0,"resetsAt":"2026-09-12T09:00:00Z"}]}]}"#
        for invalid in [valid.replacingOccurrences(of: "codex", with: "unknown"),
                        valid.replacingOccurrences(of: ":0,", with: ":101,"),
                        valid.replacingOccurrences(of: "2026-09-12T09:00:00Z", with: "bad date")] {
            XCTAssertThrowsError(try AccountUsageSnapshot.read(Data(invalid.utf8)))
        }
        XCTAssertNoThrow(try AccountUsageSnapshot.read(Data(valid.utf8)))
    }
}
