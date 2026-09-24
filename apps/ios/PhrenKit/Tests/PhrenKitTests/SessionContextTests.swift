import XCTest
@testable import PhrenKit

final class SessionContextTests: XCTestCase {
    func testProviderReportedPercentagePreservesZeroAndFractionalUsage() throws {
        for percent in [0.0, 37.5, 100.0] {
            XCTAssertEqual(try tab(contextUsedPercent: percent).contextUsedPercent, percent)
        }
    }

    func testUnavailableAndInvalidPercentagesRemainUnknown() throws {
        XCTAssertNil(try tab().contextUsedPercent)
        for invalid: Any in [NSNull(), -1, 101, "50", true, ["used": 50], [50]] {
            let value = try tab(contextUsedPercent: invalid)
            XCTAssertNil(value.contextUsedPercent)
            XCTAssertEqual(value.activity, .working)
        }
    }

    func testAContextPercentageCannotRepresentMultipleAgents() throws {
        XCTAssertEqual(try tab(contextUsedPercent: 50, agentPaneCount: 1).contextUsedPercent, 50)
        XCTAssertNil(try tab(contextUsedPercent: 50, agentPaneCount: 2).contextUsedPercent)
        XCTAssertNil(try tab(contextUsedPercent: 50, agentPaneCount: 0).contextUsedPercent)
    }

    private func tab(contextUsedPercent: Any? = nil, agentPaneCount: Int? = nil) throws -> LiveWorkspaces.Tab {
        var child: [String: Any] = ["id": "w1:t1", "label": "Build", "agentStatus": "working"]
        child["contextUsedPercent"] = contextUsedPercent
        child["agentPaneCount"] = agentPaneCount
        let payload: [String: Any] = ["kind": "herdr", "groups": [
            ["id": "w1", "label": "Project", "children": [child]],
        ]]
        return try XCTUnwrap(LiveWorkspaces.read(JSONSerialization.data(withJSONObject: payload)).groups.first?.children.first)
    }
}
