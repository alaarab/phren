import Foundation
import PhrenKit
import XCTest
@testable import PhrenLive

final class AgentDestinationResolverTests: XCTestCase {
    override func tearDown() {
        GatewayConnections.shared.reset()
        super.tearDown()
    }

    func testLegacyLocalChildKeepsParentConnectionAndTarget() throws {
        let host = try LiveHost(name: "Desk", address: "desk.example", username: "sam",
                                fingerprint: pin("A"))
        let parent = try target(host: host)
        let childID = String(repeating: "d", count: 32)
        let data = #"{"id":"\#(childID)","provider":"claude","path":"Local checks","callId":"agent:checks","state":"running","children":[]}"#
        let child = try JSONDecoder().decode(AgentChild.self, from: Data(data.utf8))

        let result = try AgentDestinationResolver.resolve(agent: child, parentHost: host,
                                                          parentTarget: parent, hosts: [host])
        let destination = try XCTUnwrap(result.destination)
        XCTAssertFalse(destination.isRemote)
        XCTAssertEqual(destination.host, host)
        XCTAssertEqual(destination.target, parent)
        XCTAssertEqual(destination.child, childID)
    }

    func testImmutableComputerIDWinsOverDuplicateAliasesAndScopesServer() throws {
        let deskID = UUID(uuidString: "c1000000-0000-0000-0000-000000000001")!
        let linuxID = UUID(uuidString: "c1000000-0000-0000-0000-000000000002")!
        let desk = try LiveHost(id: UUID(uuidString: "a1000000-0000-0000-0000-000000000001")!,
                                name: "Desk", address: "desk.example", username: "sam",
                                hookComputerID: deskID, fingerprint: pin("A"))
        let linux = try LiveHost(id: UUID(uuidString: "a1000000-0000-0000-0000-000000000002")!,
                                 name: "Desk", address: "linuxbox.example", username: "sam",
                                 hookComputerID: linuxID, fingerprint: pin("B"))
        let parent = try target(host: desk)
        let child = try remoteChild(computerID: linuxID, computerName: "Desk", nested: true)

        let result = try AgentDestinationResolver.resolve(agent: child, parentHost: desk,
                                                          parentTarget: parent, hosts: [desk, linux])
        let destination = try XCTUnwrap(result.destination)
        XCTAssertEqual(destination.host.id, linux.id)
        XCTAssertEqual(destination.host.address, "linuxbox.example")
        XCTAssertEqual(destination.host.fingerprint, pin("B"))
        XCTAssertEqual(destination.host.muxID, "herdr:work")
        XCTAssertEqual(destination.target.hostID, linux.id)
        XCTAssertNotEqual(destination.target.hostID, linuxID, "The target uses the phone-local keychain identity")
        XCTAssertEqual(destination.target.muxID, "herdr:work")
        XCTAssertEqual(destination.child, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    }

    func testUnknownAndOfflineComputersKeepTheirRows() throws {
        let deskID = UUID(uuidString: "c1000000-0000-0000-0000-000000000001")!
        let linuxID = UUID(uuidString: "c1000000-0000-0000-0000-000000000002")!
        let desk = try LiveHost(name: "Desk", address: "desk.example", username: "sam",
                                hookComputerID: deskID, fingerprint: pin("A"))
        let linux = try LiveHost(name: "Linuxbox", address: "linuxbox.example", username: "sam",
                                 hookComputerID: linuxID, fingerprint: pin("B"))
        let child = try remoteChild(computerID: linuxID, computerName: "Linuxbox", nested: false)

        let unknown = try AgentDestinationResolver.resolve(agent: child, parentHost: desk,
                                                           parentTarget: target(host: desk), hosts: [desk])
        guard case .unknown(let computer) = unknown else { return XCTFail("Expected unknown computer") }
        XCTAssertEqual(computer.id, linuxID)

        let offline = try AgentDestinationResolver.resolve(agent: child, parentHost: desk,
                                                           parentTarget: target(host: desk), hosts: [desk, linux],
                                                           offlineHostIDs: [linux.id])
        guard case .offline(let destination) = offline else { return XCTFail("Expected offline computer") }
        XCTAssertNil(destination.child, "A remote lead opens its ordinary chat")
    }

    func testStartingLeadWaitsOnlyAfterItsComputerIsKnown() throws {
        let computerID = UUID(uuidString: "c1000000-0000-0000-0000-000000000002")!
        let desk = try LiveHost(name: "Desk", address: "desk.example", username: "sam",
                                fingerprint: pin("A"))
        let linux = try LiveHost(name: "Linuxbox", address: "linuxbox.example", username: "sam",
                                 hookComputerID: computerID, fingerprint: pin("B"))
        let data = #"{"id":"remote","provider":"codex","path":"Starting checks","callId":"dispatch:checks","state":"running","computer":{"id":"\#(computerID.uuidString)","name":"Linuxbox"},"children":[]}"#
        let child = try JSONDecoder().decode(AgentChild.self, from: Data(data.utf8))

        let unknown = try AgentDestinationResolver.resolve(agent: child, parentHost: desk,
                                                           parentTarget: target(host: desk), hosts: [desk])
        guard case .unknown = unknown else { return XCTFail("Expected enrollment before waiting") }
        let starting = try AgentDestinationResolver.resolve(agent: child, parentHost: desk,
                                                            parentTarget: target(host: desk), hosts: [desk, linux])
        guard case .starting = starting else { return XCTFail("Expected the verified target to remain pending") }
    }

    func testTwoComputerRelayUsesRemoteKeyPinTargetHistoryAndDiff() async throws {
        let localComputerID = UUID(uuidString: "c1000000-0000-0000-0000-000000000001")!
        let remoteComputerID = UUID(uuidString: "c1000000-0000-0000-0000-000000000002")!
        let localFixture = ChatRelayHookFixture(computerID: localComputerID, computerName: "Desk")
        let remoteFixture = ChatRelayHookFixture(computerID: remoteComputerID, computerName: "Linuxbox")
        let localRelay = try await ChatRelaySSH.start(hookFixture: localFixture)
        let remoteRelay = try await ChatRelaySSH.start(hookFixture: remoteFixture)
        addTeardownBlock {
            GatewayConnections.shared.reset()
            try await localRelay.close(); try await remoteRelay.close()
        }
        var local = try localRelay.host(), remote = try remoteRelay.host()
        let fetchedLocalIdentity = try await PhrenConnection.computerIdentity(
            host: local, privateKey: localRelay.deviceKey.rawRepresentation
        )
        let fetchedRemoteIdentity = try await PhrenConnection.computerIdentity(
            host: remote, privateKey: remoteRelay.deviceKey.rawRepresentation
        )
        let localIdentity = try XCTUnwrap(fetchedLocalIdentity)
        let remoteIdentity = try XCTUnwrap(fetchedRemoteIdentity)
        local.hookComputerID = localIdentity.id; remote.hookComputerID = remoteIdentity.id
        XCTAssertEqual(localIdentity.name, "Desk"); XCTAssertEqual(remoteIdentity.name, "Linuxbox")
        let descriptor = try remoteChild(computerID: remoteComputerID, computerName: remoteIdentity.name, nested: true)
        let resolved = try AgentDestinationResolver.resolve(agent: descriptor, parentHost: local,
                                                            parentTarget: target(host: local), hosts: [local, remote])
        let destination = try XCTUnwrap(resolved.destination)
        let child = try XCTUnwrap(destination.child)

        _ = try await PhrenConnection.childAgentTranscript(host: destination.host,
            privateKey: remoteRelay.deviceKey.rawRepresentation, target: destination.target,
            child: child, provider: descriptor.provider)
        _ = try await PhrenConnection.childAgentHistory(host: destination.host,
            privateKey: remoteRelay.deviceKey.rawRepresentation, target: destination.target,
            child: child, provider: descriptor.provider, beforeLine: 1)
        _ = try await PhrenConnection.repositoryDiff(host: destination.host,
            privateKey: remoteRelay.deviceKey.rawRepresentation, target: destination.target,
            child: child)

        let requests = remoteFixture.requests.joined(separator: "\n")
        XCTAssertTrue(requests.contains("GET /v1/subagents/transcript?"))
        XCTAssertTrue(requests.contains("GET /v1/transcripts/history?"))
        XCTAssertTrue(requests.contains("POST /v1/diff"))
        XCTAssertTrue(requests.contains("server=work")); XCTAssertTrue(requests.contains("workspace=w9"))
        XCTAssertTrue(requests.contains("\"child\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""))
        XCTAssertFalse(localFixture.requests.contains(where: { $0.contains("/v1/subagents/transcript") }),
                       "The conductor computer must not receive the remote child ID")

        do {
            _ = try await PhrenConnection.childAgentTranscript(host: destination.host,
                privateKey: localRelay.deviceKey.rawRepresentation, target: destination.target,
                child: child, provider: descriptor.provider)
            XCTFail("The remote computer must reject the other computer's device key")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .authentication) }

        var changedPin = destination.host
        changedPin.fingerprint = local.fingerprint
        do {
            _ = try await PhrenConnection.childAgentTranscript(host: changedPin,
                privateKey: remoteRelay.deviceKey.rawRepresentation, target: destination.target,
                child: child, provider: descriptor.provider)
            XCTFail("A changed pin must stop before the remote request")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .changedHost) }
    }

    private func pin(_ character: Character) -> String {
        "SHA256:" + String(repeating: character, count: 43)
    }

    private func target(host: LiveHost) throws -> AgentChatTarget {
        try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                            source: "codex", sessionID: "00000000-0000-0000-0000-000000000001",
                            muxID: host.muxID)
    }

    private func remoteChild(computerID: UUID, computerName: String, nested: Bool) throws -> AgentChild {
        let child = nested ? #", "child":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa""# : ""
        let json = #"{"id":"remote","provider":"codex","path":"Parser checks","callId":"dispatch:checks","state":"running","computer":{"id":"\#(computerID.uuidString)","name":"\#(computerName)"},"remote":{"target":{"server":"work","workspace":"w9","tab":"w9:t1","pane":"w9:p1","source":"codex","session":"00000000-0000-0000-0000-000000000042"}\#(child)},"children":[]}"#
        return try JSONDecoder().decode(AgentChild.self, from: Data(json.utf8))
    }
}
