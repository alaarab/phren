import Foundation
import NIOCore
import NIOEmbedded
import NIOHTTP1
import NIOPosix
import PhrenKit
import XCTest
@testable import PhrenLive

final class ChatDeliveryTests: XCTestCase {
    func testHistoryUsesOnePinnedRequestAndAcceptsLargePages() async throws {
        let helper = try await DeliveryHelper.start()
        let ssh = try await ChatRelaySSH.start(forwardPorts: [24543: helper.channel.localAddress!.port!])
        defer { Task { try await ssh.close(); try await helper.channel.close() } }
        var host = try ssh.host(); host.herdrSession = "phone-test"
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                        source: "codex", sessionID: "current-session", muxID: host.muxID)
        let page = try await PhrenConnection.chatHistory(host: host, privateKey: ssh.deviceKey.rawRepresentation, target: target, beforeLine: 200)
        XCTAssertEqual(page.messages.count, 150)
        XCTAssertEqual(page.startLine, 50)
        XCTAssertEqual(page.messages.last?.line, 199)
        XCTAssertEqual(helper.historyCount, 1)
        do {
            _ = try await PhrenConnection.chatHistory(host: host, privateKey: ssh.deviceKey.rawRepresentation, target: target, beforeLine: 1)
            XCTFail("A non-advancing cursor must fail instead of leaving pagination stuck")
        } catch { XCTAssertTrue(error.localizedDescription.contains("history range")) }
    }

    func testLivePaneDeliveryIgnoresRejectedRecordedLocationAndPinsNamedServer() async throws {
        let helper = try await DeliveryHelper.start()
        let ssh = try await ChatRelaySSH.start(forwardPorts: [24543: helper.channel.localAddress!.port!])
        defer { Task { try await ssh.close(); try await helper.channel.close() } }
        var host = try ssh.host(); host.herdrSession = "phone-test"
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                         source: "codex", sessionID: "current-session", muxID: host.muxID)
        let key = ssh.deviceKey
        let openedBefore = GatewayConnections.shared.opened
        // Reproduce the old client selecting the helper's unusable recorded
        // location despite also supplying the live pane.
        let old = try JSONSerialization.data(withJSONObject: ["source": "codex", "sessionId": target.sessionID,
                                                             "pane": target.paneID, "tab": target.tabID, "text": "Old request"])
        do {
            _ = try await PhrenConnection.fetchData(host: host, key: key, request: .init(path: "/v1/prompt", body: old))
            XCTFail("Recorded terminal must reject")
        } catch {
            XCTAssertEqual(error as? LiveConnectionError, .gatewayRejection(status: 422, reason: "prompt target does not support text input"))
        }
        try await PhrenConnection.sendChat(host: host, privateKey: key.rawRepresentation, target: target, text: "Keep it up")
        XCTAssertEqual(helper.messages, ["Keep it up"])
        XCTAssertEqual(helper.promptCount, 2)

        let changed = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                          source: "codex", sessionID: "previous-session", muxID: host.muxID)
        // The Hook is the gate: it checks the pane's conversation with fresh
        // identity right before typing, so the phone sends without asking
        // first and the refusal comes back as the Hook's own rejection.
        do {
            try await PhrenConnection.sendChat(host: host, privateKey: key.rawRepresentation, target: changed, text: "Must not arrive")
            XCTFail("Changed conversation must reject before input")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .gatewayRejection(status: 409, reason: "wrong destination")) }
        XCTAssertEqual(helper.promptCount, 3)
        XCTAssertEqual(helper.messages, ["Keep it up"])

        // A rejected live-pane request is also a single attempt. There is no
        // alternate target or automatic replay on any delivery error.
        do {
            try await PhrenConnection.sendChat(host: host, privateKey: key.rawRepresentation, target: target, text: "Reject this")
            XCTFail("Expected live-pane rejection")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .gatewayRejection(status: 422, reason: "target pane not found")) }
        XCTAssertEqual(helper.promptCount, 4)
        XCTAssertEqual(helper.messages, ["Keep it up"])
        // Every request above rode one SSH connection; a send used to open two.
        XCTAssertEqual(GatewayConnections.shared.opened - openedBefore, 1)
        try await ssh.close(); try await helper.channel.close()
    }

    func testUploadWhileQuestionIsPendingDoesNotSendOrBypassPromptGate() async throws {
        let helper = try await DeliveryHelper.start(agentStatus: "waiting")
        let ssh = try await ChatRelaySSH.start(forwardPorts: [24543: helper.channel.localAddress!.port!])
        defer { Task { try await ssh.close(); try await helper.channel.close() } }
        var host = try ssh.host(); host.herdrSession = "phone-test"
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1",
                                        source: "codex", sessionID: "current-session", muxID: host.muxID)
        let attachment = try AgentAttachment(name: "notes.txt", data: Data("Keep this draft".utf8))
        let path = try await PhrenConnection.uploadChatAttachment(host: host, privateKey: ssh.deviceKey.rawRepresentation,
                                                                target: target, attachment: attachment)
        XCTAssertEqual(path, "/tmp/phren-upload-fixture/notes.txt")
        // The Hook holds the gate: with a question pending it refuses the
        // prompt, and the phone shows that refusal instead of guessing.
        do {
            try await PhrenConnection.sendChat(host: host, privateKey: ssh.deviceKey.rawRepresentation, target: target, text: "New prompt")
            XCTFail("A pending question must still block prompt delivery")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .gatewayRejection(status: 409, reason: "This agent needs input in the terminal first.")) }
        XCTAssertEqual(helper.promptCount, 1)
        XCTAssertTrue(helper.messages.isEmpty)
    }

    func testErrorBodiesAreBoundedAndOnlyPlainJSONReasonsAreDisplayed() throws {
        for (body, expected) in [
            (Data(#"{"error":"target\npane\u0000 not found"}"#.utf8), LiveConnectionError.gatewayRejection(status: 422, reason: "target pane not found")),
            (Data("<html>upstream error</html>".utf8), .response(422)),
            (try JSONSerialization.data(withJSONObject: ["error": String(repeating: "x", count: 400)]), .gatewayRejection(status: 422, reason: String(repeating: "x", count: 320))),
            (Data(repeating: 65, count: 32_769), .oversized),
        ] {
            let loop = EmbeddedEventLoop()
            let promise = loop.makePromise(of: Data.self)
            let exchange = Exchange(result: promise)
            let channel = EmbeddedChannel(handler: GatewayResponse(exchange: exchange), loop: loop)
            try channel.writeInbound(HTTPClientResponsePart.head(.init(version: .http1_1, status: .unprocessableEntity)))
            let half = body.count / 2
            try channel.writeInbound(HTTPClientResponsePart.body(ByteBuffer(bytes: body.prefix(half))))
            try channel.writeInbound(HTTPClientResponsePart.body(ByteBuffer(bytes: body.dropFirst(half))))
            try channel.writeInbound(HTTPClientResponsePart.end(nil))
            XCTAssertThrowsError(try promise.futureResult.wait()) { XCTAssertEqual($0 as? LiveConnectionError, expected) }
            _ = try channel.finish()
        }
    }
}

/// No real agent is involved. The recorded-session route fails like an
/// unusable terminal record; the live route requires the exact named server.
private final class DeliveryHelper: @unchecked Sendable {
    var channel: Channel!
    let agentStatus: String
    init(agentStatus: String) { self.agentStatus = agentStatus }
    private let lock = NSLock()
    private var accepted: [String] = []
    private var count = 0
    private var historyRequests = 0
    var messages: [String] { lock.lock(); defer { lock.unlock() }; return accepted }
    var promptCount: Int { lock.lock(); defer { lock.unlock() }; return count }
    var historyCount: Int { lock.lock(); defer { lock.unlock() }; return historyRequests }
    func response(path: String, body: Data) -> (HTTPResponseStatus, Data) {
        lock.lock(); defer { lock.unlock() }
        let parts = URLComponents(string: path)!
        let query = Dictionary(uniqueKeysWithValues: (parts.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        var status = HTTPResponseStatus.ok
        var value: [String: Any] = [:]
        if parts.path == "/v1/workspaces/panes" && query == ["mux": "herdr:phone-test", "groupId": "w1", "childId": "w1:t1"] {
            value = ["kind": "herdr", "groupId": "w1", "childId": "w1:t1", "panes": [
                ["id": "w1:p1", "label": "codex", "agent": "codex", "agentStatus": agentStatus, "sessionId": "current-session"]]]
        } else if parts.path == "/v1/upload" {
            let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            let target = request["target"] as? [String: String] ?? [:]
            if target == ["server": "phone-test", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1", "source": "codex", "session": "current-session"] {
                value = ["ok": true, "path": "/tmp/phren-upload-fixture/notes.txt"]
            } else { status = .conflict; value = ["error": "wrong destination"] }
        } else if parts.path == "/v1/transcripts/history" {
            historyRequests += 1
            var destination = query; destination.removeValue(forKey: "beforeLine")
            if destination != ["server": "phone-test", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1", "source": "codex", "session": "current-session"] {
                status = .conflict; value = ["error": "wrong destination"]
            } else {
                let before = Int(query["beforeLine"] ?? "") ?? 0
                let entries: [[String: Any]] = before == 200 ? (50..<200).map { line in
                    ["line": line, "raw": ["type": "response_item", "payload": ["type": "message", "role": "assistant", "content": String(repeating: "x", count: 10_000)]]]
                } : []
                value = ["type": "older", "source": "codex", "startLine": before == 200 ? 50 : before, "totalLines": 300, "hasMore": true, "entries": entries]
            }
        } else if parts.path == "/v1/prompt" {
            count += 1
            let request = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
            let target = request["target"] as? [String: String] ?? [:]
            if request["sessionId"] != nil {
                status = .unprocessableEntity; value = ["error": "prompt target does not support text input"]
            } else if agentStatus == "waiting" {
                status = .conflict; value = ["error": "This agent needs input in the terminal first."]
            } else if target != ["server": "phone-test", "workspace": "w1", "tab": "w1:t1", "pane": "w1:p1", "source": "codex", "session": "current-session"] {
                status = .conflict; value = ["error": "wrong destination"]
            } else if request["text"] as? String == "Reject this" {
                status = .unprocessableEntity; value = ["error": "target pane not found"]
            } else {
                accepted.append(request["text"] as? String ?? ""); value = ["ok": true]
            }
        } else { status = .notFound; value = ["error": "unknown route"] }
        return (status, try! JSONSerialization.data(withJSONObject: value))
    }
    static func start(agentStatus: String = "working") async throws -> DeliveryHelper {
        let helper = DeliveryHelper(agentStatus: agentStatus)
        helper.channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton).childChannelInitializer { channel in
            channel.pipeline.configureHTTPServerPipeline().flatMap { channel.pipeline.addHandler(DeliveryHandler(helper: helper)) }
        }.bind(host: "127.0.0.1", port: 0).get()
        return helper
    }
}
private final class DeliveryHandler: ChannelInboundHandler {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart
    let helper: DeliveryHelper
    var path = "", body = Data()
    init(helper: DeliveryHelper) { self.helper = helper }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        switch unwrapInboundIn(data) {
        case .head(let head): path = head.uri
        case .body(let bytes): body.append(contentsOf: bytes.readableBytesView)
        case .end:
            let (status, data) = helper.response(path: path, body: body)
            let head = HTTPResponseHead(version: .http1_1, status: status, headers: HTTPHeaders([
                ("Content-Type", "application/json"), ("Content-Length", String(data.count)), ("Connection", "close")]))
            context.write(wrapOutboundOut(.head(head)), promise: nil)
            context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(bytes: data)))), promise: nil)
            context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
        }
    }
}
