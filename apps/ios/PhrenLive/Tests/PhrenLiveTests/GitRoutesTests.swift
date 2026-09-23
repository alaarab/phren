import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class GitRoutesTests: XCTestCase {
    private func target() throws -> AgentChatTarget {
        try AgentChatTarget(hostID: UUID(), workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "claude", sessionID: "fixture")
    }

    func testLogRequestCarriesLimitRefAndChild() throws {
        let child = "a" + String(repeating: "1", count: 31)
        let request = try PhrenConnection.gitLogRequest(target: target(), child: child, limit: 60, ref: "release/1.0")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])

        XCTAssertEqual(request.path, "/v1/git/log")
        XCTAssertEqual(body["limit"] as? Int, 60)
        XCTAssertEqual(body["ref"] as? String, "release/1.0")
        XCTAssertEqual(body["child"] as? String, child)
        XCTAssertNotNil(body["target"])
    }

    func testLogRequestClampsLimitAndRejectsBadChild() throws {
        let low = try PhrenConnection.gitLogRequest(target: target(), child: nil, limit: 0, ref: nil)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: XCTUnwrap(low.body)) as? [String: Any])?["limit"] as? Int, 1)
        let high = try PhrenConnection.gitLogRequest(target: target(), child: nil, limit: 999, ref: nil)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: XCTUnwrap(high.body)) as? [String: Any])?["limit"] as? Int, 200)
        XCTAssertThrowsError(try PhrenConnection.gitLogRequest(target: target(), child: "not-a-child", limit: 60, ref: nil)) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("This child agent is invalid."))
        }
    }

    func testBranchesRequestCarriesChild() throws {
        let child = "b" + String(repeating: "2", count: 31)
        let request = try PhrenConnection.gitBranchesRequest(target: target(), child: child)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])

        XCTAssertEqual(request.path, "/v1/git/branches")
        XCTAssertEqual(body["child"] as? String, child)
        XCTAssertNotNil(body["target"])
    }

    func testWritesCarryEveryPathAndRejectPartialRequests() throws {
        let target = try target()
        for route in ["stage", "unstage", "discard"] {
            let request = try PhrenConnection.gitWriteRequest(target: target, route: route, child: nil, paths: ["a.swift", "b.swift"])
            XCTAssertEqual(request.path, "/v1/git/\(route)")
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
            XCTAssertEqual(body["paths"] as? [String], ["a.swift", "b.swift"])
            for paths in [["a.swift", ""], Array(repeating: "a.swift", count: 65)] {
                XCTAssertThrowsError(try PhrenConnection.gitWriteRequest(target: target, route: route, child: nil, paths: paths))
            }
        }
        XCTAssertThrowsError(try PhrenConnection.gitLogRequest(target: target, child: nil, limit: 60, ref: "--all"))
    }

    func testWorktreeScopesEveryRouteAndIsCheckedForShape() throws {
        let target = try target(), worktree = String(repeating: "c", count: 32)
        func body(_ request: GatewayRequest) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        }
        XCTAssertEqual(try PhrenConnection.gitWorktreesRequest(target: target).path, "/v1/git/worktrees")
        let requests = [
            try PhrenConnection.gitStatusRequest(target: target, child: nil, worktree: worktree),
            try PhrenConnection.gitLogRequest(target: target, child: nil, limit: 60, ref: nil, worktree: worktree),
            try PhrenConnection.gitBranchesRequest(target: target, child: nil, worktree: worktree),
            try PhrenConnection.gitTreeRequest(target: target, path: "", child: nil, worktree: worktree),
            try PhrenConnection.gitWriteRequest(target: target, route: "stage", child: nil, paths: ["a.swift"], worktree: worktree),
            try PhrenConnection.repositoryDiffRequest(target: target, paths: ["ignored.swift"], child: nil, worktree: worktree),
        ]
        for request in requests { XCTAssertEqual(try body(request)["worktree"] as? String, worktree, request.path) }
        XCTAssertNil(try body(requests[5])["paths"], "A worktree diff is the whole checkout")
        XCTAssertThrowsError(try PhrenConnection.gitStatusRequest(target: target, child: nil, worktree: "../repo")) { error in
            XCTAssertEqual(error as? PhrenKitError, .validation("This worktree is invalid."))
        }
    }

    func testTreeRequestAsksForIgnoredOnlyWhenShown() throws {
        let target = try target()
        let hidden = try PhrenConnection.gitTreeRequest(target: target, path: "video", child: nil)
        XCTAssertNil((try JSONSerialization.jsonObject(with: XCTUnwrap(hidden.body)) as? [String: Any])?["ignored"])
        let shown = try PhrenConnection.gitTreeRequest(target: target, path: "video", child: nil, ignored: true)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: XCTUnwrap(shown.body)) as? [String: Any])?["ignored"] as? Bool, true)
    }
}
