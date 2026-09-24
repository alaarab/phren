import Foundation
import XCTest
@testable import PhrenLive

final class ConductorActivityTests: XCTestCase {
    func testTheNewestDispatchOrReturnWins() throws {
        let json = #"{"dispatches":[ {"id":"1","label":"Phone layout","computer":"Linuxbox","state":"accepted","createdAt":"2026-09-24T01:00:00Z","updatedAt":"2026-09-24T01:00:05Z", "returned":{"state":"done","at":"2026-09-24T01:30:00Z","read":false}}, {"id":"2","label":"Soak test","computer":"Desk","state":"accepted","createdAt":"2026-09-24T01:10:00Z","updatedAt":"2026-09-24T01:10:02Z"} ]}"#
        XCTAssertEqual(PhrenConnection.conductorActivity(from: Data(json.utf8))?.line, "Returned: Phone layout finished")
        let dispatched = #"{"dispatches":[{"id":"2","label":"Soak test","computer":"Desk","state":"accepted","createdAt":"2026-09-24T01:10:00Z","updatedAt":"2026-09-24T01:10:02Z"}]}"#
        XCTAssertEqual(PhrenConnection.conductorActivity(from: Data(dispatched.utf8))?.line, "Dispatched Soak test to Desk")
        let asking = #"{"dispatches":[{"id":"3","label":"Migration","state":"accepted","createdAt":"2026-09-24T01:10:00Z","updatedAt":"2026-09-24T01:10:02Z","returned":{"state":"needs-you","at":"2026-09-24T01:20:00Z","question":"Which schema?","read":false}}]}"#
        XCTAssertEqual(PhrenConnection.conductorActivity(from: Data(asking.utf8))?.line, "Needs you: Migration, Which schema?")
        XCTAssertNil(PhrenConnection.conductorActivity(from: Data(#"{"dispatches":[]}"#.utf8)))
    }
}
