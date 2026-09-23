import Foundation
import XCTest
@testable import PhrenKit

final class HookHealthTests: XCTestCase {
    /// The shape `GET /v1/health/details` returns (packages/cli/src/bridge/health.ts).
    static let json = """
    {"product":"phren-hook","computer":{"name":"Desk","id":"5b7c1a2e-0000-4000-8000-000000000001"},"checkedAt":"2026-09-22T10:00:00.000Z",
     "versions":[{"tool":"hook","status":"ok","version":"0.2.14"},{"tool":"herdr","status":"ok","version":"0.9.0"},
      {"tool":"claude","status":"ok","version":"2.1.280"},{"tool":"codex","status":"error","detail":"--version did not answer within 3 seconds"},
      {"tool":"copilot","status":"missing"},{"tool":"opencode","status":"ok","version":"1.4.2"}],
     "stores":[{"name":"primary","role":"primary","available":true,"branch":"main","upstream":"origin/main","ahead":2,"behind":1,
       "lastPushStatus":"push-failed","lastPushAt":"2026-09-22T09:00:00.000Z","consecutiveFailures":4,
       "error":"rejected: non-fast-forward","degraded":true},
      {"name":"team","role":"team","available":true,"branch":"main","degraded":false}],
     "schedules":{"running":true,"lastTickAt":"2026-09-22T09:59:40.000Z",
       "lastRun":{"name":"Nightly triage","project":"phren","status":"failed","reason":"Herdr: agent not detected","startedAt":"2026-09-22T03:00:00.000Z"}},
     "peers":{"configured":true,"computers":[
       {"name":"Linuxbox","reachable":true,"ms":412,"version":"0.2.14","listsBack":false},
       {"name":"Laptop","reachable":false,"ms":5003,"error":"No answer within 5 seconds.","listsBack":null},
       {"name":"Studio","reachable":true,"ms":230,"listsBack":true}]},
     "push":{"configured":true,"devices":1},
     "canary":{"version":1,"trigger":"daily","computer":"Desk","startedAt":"2026-09-22T04:00:00.000Z","finishedAt":"2026-09-22T04:00:31.000Z",
       "durationMs":31000,"ok":false,"steps":[{"name":"conductor","status":"ok","durationMs":20000,"detail":"claude started (idle)"},
       {"name":"schedules","status":"ok","durationMs":10},{"name":"transcript","status":"skipped","durationMs":40,"reason":"No idle agent session with a transcript to read."},
       {"name":"sessions","status":"failed","durationMs":5100,"reason":"Unreachable: Laptop (No answer within 5 seconds.)"}]}}
    """

    func testDecodesHealthDetails() throws {
        let health = try HookHealth.decode(Data(Self.json.utf8))
        XCTAssertEqual(health.computer.name, "Desk")
        XCTAssertEqual(health.versions.map(\.title), ["Phren Hook", "Herdr", "Claude Code", "Codex", "Copilot", "OpenCode"])
        XCTAssertEqual(health.versions[4].summary, "Not installed")
        XCTAssertEqual(health.versions[3].summary, "--version did not answer within 3 seconds")
        XCTAssertEqual(health.stores[0].position, "main · 2 ahead, 1 behind")
        XCTAssertEqual(health.stores[1].position, "main · no upstream")
        XCTAssertEqual(health.failingStores.map(\.name), ["primary"])
        XCTAssertEqual(health.schedules.lastRun?.name, "Nightly triage")
        XCTAssertEqual(health.oneWayPeers.map(\.name), ["Linuxbox"])
        XCTAssertNil(health.peers.computers[1].listsBack)
        XCTAssertFalse(health.peers.computers[1].oneWay)
        XCTAssertEqual(health.canary?.steps.map(\.status), ["ok", "ok", "skipped", "failed"])
        XCTAssertTrue(health.needsAttention)
    }

    func testDecodesAQuietComputer() throws {
        let json = """
        {"product":"phren-hook","computer":{"name":"Linuxbox"},"checkedAt":"2026-09-22T10:00:00.000Z","versions":[],
         "stores":[],"schedules":{"running":null,"lastRun":null},"peers":{"configured":false,"computers":[]},
         "push":{"configured":false},"canary":null}
        """
        let health = try HookHealth.decode(Data(json.utf8))
        XCTAssertNil(health.schedules.running)
        XCTAssertNil(health.canary)
        XCTAssertFalse(health.needsAttention)
    }
}
