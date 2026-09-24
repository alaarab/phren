import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class RepositoryDiffTests: XCTestCase {
    func testRepositoryDiffRequestCarriesValidatedChildAndOmitsPaths() throws {
        let child = "a" + String(repeating: "1", count: 31)
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                         source: "claude", sessionID: "fixture")
        let request = try PhrenConnection.repositoryDiffRequest(target: target, paths: ["Parent.swift"], child: child)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])

        XCTAssertEqual(request.path, "/v1/diff")
        XCTAssertEqual(body["child"] as? String, child)
        XCTAssertNil(body["paths"])
        XCTAssertThrowsError(try PhrenConnection.repositoryDiffRequest(target: target, paths: [], child: "not-a-child")) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("This child agent is invalid."))
        }
    }
}
