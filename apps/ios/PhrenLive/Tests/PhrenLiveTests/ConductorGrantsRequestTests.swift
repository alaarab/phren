import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class ConductorGrantsRequestTests: XCTestCase {
    func testListRequestIsGetWithoutABody() throws {
        let request = PhrenConnection.conductorGrantsListRequest()
        XCTAssertEqual(request.path, "/v1/conductor/grants")
        XCTAssertEqual(request.method, "GET")
        XCTAssertNil(request.body)
    }

    func testAddRequestIsPostWithTheGrantBody() throws {
        let grant = try ConductorGrant(scope: "project:phone", actions: [.dispatch, .handOff],
                                       computers: ["Desk"], until: "2026-12-01T09:30:00Z")
        let request = try PhrenConnection.conductorGrantAddRequest(grant: grant)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/conductor/grants")
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(body["scope"] as? String, "project:phone")
        XCTAssertEqual(body["actions"] as? [String], ["dispatch", "hand_off"])
        XCTAssertEqual(body["computers"] as? [String], ["Desk"])
        XCTAssertEqual(body["until"] as? String, "2026-12-01T09:30:00Z")
    }

    func testAddRequestOmitsEmptyOptionals() throws {
        let grant = try ConductorGrant(scope: "global", actions: [.dispatch])
        let request = try PhrenConnection.conductorGrantAddRequest(grant: grant)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(body["scope"] as? String, "global")
        XCTAssertEqual(body["actions"] as? [String], ["dispatch"])
        XCTAssertNil(body["computers"])
        XCTAssertNil(body["until"])
    }

    func testRemoveRequestIsDeleteWithAnIndex() throws {
        let request = try PhrenConnection.conductorGrantRemoveRequest(index: 3)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(request.path, "/v1/conductor/grants")
        XCTAssertEqual(request.method, "DELETE")
        XCTAssertEqual(body["index"] as? Int, 3)
    }

    func testRemoveRequestRejectsIndexesOutsideTheHooksList() {
        XCTAssertThrowsError(try PhrenConnection.conductorGrantRemoveRequest(index: -1))
        XCTAssertThrowsError(try PhrenConnection.conductorGrantRemoveRequest(index: 64))
    }

}
