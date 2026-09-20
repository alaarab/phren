import Foundation
import XCTest
@testable import PhrenKit

final class GitPullsTests: XCTestCase {
    func testReadsPullsAndTheirStates() throws {
        let data = Data(#"{"available":true,"pulls":[{"number":42,"title":"Changes: pulls","head":"changes/pulls","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/42","draft":false,"state":"OPEN","updated":"2026-09-20T10:00:00Z"},{"number":7,"title":"Merged work","head":"feature","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/7","draft":false,"state":"MERGED","updated":"2026-09-01T10:00:00Z"},{"number":9,"title":"Closed work","head":"old","base":"main","author":"sam","url":"https://github.com/sam/phren/pull/9","draft":false,"state":"CLOSED","updated":"2026-08-01T10:00:00Z"}]}"#.utf8)
        let pulls = try GitPulls.read(data)
        XCTAssertTrue(pulls.available)
        XCTAssertEqual(pulls.pulls.map(\.number), [42, 7, 9])
        XCTAssertEqual(pulls.pulls.map(\.state), [.open, .merged, .closed])
        XCTAssertEqual(pulls.pulls[0].head, "changes/pulls")
        XCTAssertEqual(pulls.pulls[0].base, "main")
        XCTAssertNotNil(pulls.pulls[0].updatedDate)
    }

    func testUnknownStateIsTolerated() throws {
        let data = Data(#"{"available":true,"pulls":[{"number":1,"title":"Future","head":"a","base":"main","author":"sam","url":"https://example.com/1","draft":false,"state":"queued","updated":"2026-09-20T10:00:00Z"}]}"#.utf8)
        XCTAssertEqual(try GitPulls.read(data).pulls[0].state, .unknown)
    }

    func testUnavailableIsAnEmptyList() throws {
        let pulls = try GitPulls.read(Data(#"{"available":false,"pulls":[]}"#.utf8))
        XCTAssertFalse(pulls.available)
        XCTAssertTrue(pulls.pulls.isEmpty)
    }

    func testOversizedPayloadIsRejected() {
        XCTAssertThrowsError(try GitPulls.read(Data(repeating: 32, count: 8_388_609)))
    }
}