import Foundation
import XCTest
@testable import PhrenKit

final class AgentChildTreeRowsTests: XCTestCase {
    func testRunningRowsExcludeCompletedAgentsAndPromoteTheirRunningDescendants() throws {
        let data = Data(#"""
        [
          {
            "id": "completed-root",
            "provider": "codex",
            "path": "/home/sam/project/root",
            "callId": "root",
            "state": "completed",
            "children": [
              {
                "id": "running-child",
                "provider": "claude",
                "path": "/home/sam/project/child",
                "callId": "child",
                "state": "running",
                "children": []
              },
              {
                "id": "completed-middle",
                "provider": "codex",
                "path": "/home/sam/project/middle",
                "callId": "middle",
                "state": "completed",
                "children": [
                  {
                    "id": "running-descendant",
                    "provider": "codex",
                    "path": "/home/sam/project/descendant",
                    "callId": "descendant",
                    "state": "running",
                    "children": []
                  }
                ]
              }
            ]
          },
          {
            "id": "running-parent",
            "provider": "codex",
            "path": "/home/sam/project/parent",
            "callId": "parent",
            "state": "running",
            "children": [
              {
                "id": "completed-child",
                "provider": "codex",
                "path": "/home/sam/project/completed-child",
                "callId": "completed-child",
                "state": "completed",
                "children": [
                  {
                    "id": "running-grandchild",
                    "provider": "codex",
                    "path": "/home/sam/project/grandchild",
                    "callId": "grandchild",
                    "state": "running",
                    "children": []
                  }
                ]
              }
            ]
          }
        ]
        """#.utf8)
        let agents = try JSONDecoder().decode([AgentChild].self, from: data)

        let rows = AgentChild.runningRows(agents)

        XCTAssertEqual(rows.map(\.agent.id), ["running-child", "running-descendant", "running-parent", "running-grandchild"])
        XCTAssertEqual(rows.map(\.depth), [0, 0, 0, 1])
    }
}
