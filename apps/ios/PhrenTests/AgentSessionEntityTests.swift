import XCTest
@testable import Phren
import PhrenKit

final class AgentSessionEntityTests: XCTestCase {
    private func entity(_ workspace: String, _ computer: String, title: String = "Chat", agent: String = "claude") -> AgentSessionEntity {
        let host = try! LiveHost(name: computer, address: "\(computer.lowercased()).local", username: "me")
        let json = #"{"kind":"herdr","capabilities":{"paneList":true},"groups":[{"id":"w-\#(workspace)","label":"\#(workspace)","children":[{"id":"w-\#(workspace):t1","label":"\#(title)","agent":"\#(agent)","agentStatus":"idle"}]}]}"#
        let session = try! LiveWorkspaces.read(Data(json.utf8)).sessions(on: host)[0]
        return AgentSessionEntity(session)
    }

    func testSpokenPhrasesResolveWorkspaceAndComputer() {
        let phrenMini = entity("phren", "Mini"), phrenStudio = entity("phren", "Studio"), mina = entity("mina", "Mini")
        let all = [phrenMini, phrenStudio, mina]
        XCTAssertEqual(AgentSessionEntityQuery.rank("phren workspace on mini", among: all).map(\.id), [phrenMini.id])
        XCTAssertEqual(AgentSessionEntityQuery.rank("the phren session on the studio", among: all).map(\.id), [phrenStudio.id])
        // Without a computer both phren sessions survive, so Siri asks which.
        XCTAssertEqual(Set(AgentSessionEntityQuery.rank("phren", among: all).map(\.id)), [phrenMini.id, phrenStudio.id])
        XCTAssertEqual(AgentSessionEntityQuery.rank("mina", among: all).map(\.id), [mina.id])
        XCTAssertTrue(AgentSessionEntityQuery.rank("nothing here", among: all).isEmpty)
        XCTAssertEqual(AgentSessionEntityQuery.rank("", among: all).count, 3)
    }
}
