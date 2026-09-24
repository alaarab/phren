import XCTest
@testable import PhrenKit

final class ReleaseNotesTests: XCTestCase {
    func testSectionsGroupsBulletsAndWrappedLines() {
        let notes = ReleaseNotes(markdown: """
        # Changelog

        Preamble that is not part of any release.

        ## 0.0.6

        ### New

        - Shell commands show what they changed, right under
          the call.
        - Queue messages while the agent works.

        ### Fixed

        - "Couldn't move skill" for base64.

        ## 0.0.5 (build 40)

        Only a note here.

        ## Earlier

        Builds 1–39 predate this changelog.
        """)
        XCTAssertEqual(notes.releases.map(\.version), ["0.0.6", "0.0.5 (build 40)", "Earlier"])
        let latest = notes.release(for: "0.0.6")!
        XCTAssertEqual(latest.groups.map(\.title), ["New", "Fixed"])
        XCTAssertEqual(latest.groups[0].items, ["Shell commands show what they changed, right under the call.", "Queue messages while the agent works."])
        XCTAssertEqual(latest.groups[1].items, ["\"Couldn't move skill\" for base64."])
        XCTAssertTrue(latest.notes.isEmpty)
        XCTAssertEqual(notes.release(for: "0.0.5")?.notes, ["Only a note here."])
        XCTAssertTrue(notes.release(for: "0.0.5")!.groups.isEmpty)
        XCTAssertNil(notes.release(for: "0.0.7"))
        XCTAssertTrue(ReleaseNotes(markdown: "").releases.isEmpty)
    }
}
