import Crypto
import Foundation
import NIOCore
import NIOEmbedded
import NIOPosix
import NIOSSH
import NIOWebSocket
import PhrenKit
import XCTest
@testable import PhrenLive

final class AgentChatConnectionTests: XCTestCase {


    func testNamedServerIsolationBeforeTransportAndWorkspaceQueryScoping() async throws {
        var host = try LiveHost(name: "Fixture", address: "fixture.invalid", username: "fixture")
        host.herdrSession = "work"
        let target = try AgentChatTarget(hostID: host.id, workspaceID: "w1", tabID: "w1:t1", paneID: "w1:p1", source: "codex", sessionID: "fixture")
        do { _ = try await PhrenConnection.transcriptImage(host: host, privateKey: Data(), target: target, line: 0, block: 0); XCTFail("Must reject a different Herdr server") }
        catch { XCTAssertTrue(error.localizedDescription.contains("another computer or Herdr server")) }
        let scoped = GatewayRequest.panes("w1", "w1:t1").scoped(to: host)
        XCTAssertEqual(URLComponents(string: scoped.path)?.queryItems?.first { $0.name == "mux" }?.value, "herdr:work")
    }


    func testDifferentComputerRejectsBeforeConnectingOrUsingItsKey() async throws {
        let host = try LiveHost(name: "Other computer", address: "fixture.invalid", username: "fixture")
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w7", tabID: "w7:t1", paneID: "w7:p1", source: "codex", sessionID: "fixture")
        do {
            try await PhrenConnection.sendChat(host: host, privateKey: Data(), target: target, text: "Must not send")
            XCTFail("A different computer must reject delivery")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
        do {
            _ = try await PhrenConnection.chatTranscript(host: host, privateKey: Data(), target: target)
            XCTFail("A different computer must reject the transcript")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
        do {
            let image = try AgentAttachment(name: "image.png", data: Data([1]), isImage: true)
            _ = try await PhrenConnection.uploadChatAttachment(host: host, privateKey: Data(), target: target, attachment: image)
            XCTFail("A different computer must reject an upload")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
        do {
            try await PhrenConnection.stopChatTurn(host: host, privateKey: Data(), target: target)
            XCTFail("A different computer must reject stopping")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
        do {
            for try await _ in PhrenConnection.chatUpdates(host: host, privateKey: Data(), target: target) { XCTFail("Must not subscribe") }
            XCTFail("A different computer must reject streaming")
        } catch { XCTAssertTrue(error.localizedDescription.contains("another computer")) }
    }

    func testPromptEncodingKeepsTextOutOfTerminalCommands() throws {
        let target = try AgentChatTarget(hostID: UUID(), workspaceID: "w7", tabID: "w7:t1", paneID: "w7:p2", source: "claude", sessionID: "fixture")
        let text = "Review `file.swift`\n$(not-a-command) \"quoted\""
        let request = try GatewayRequest.prompt(target, text: text)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.body)) as? [String: Any])
        XCTAssertEqual(URLComponents(string: request.path)?.path, "/v1/prompt")
        XCTAssertNil(URLComponents(string: request.path)?.queryItems)
        XCTAssertEqual(body["target"] as? [String: String], GatewayRequest.targetQuery(target))
        XCTAssertEqual(body["text"] as? String, text)
    }

    func testFragmentedTranscriptAndPingFramesReassembleOneBoundedSnapshot() throws {
        let loop = EmbeddedEventLoop()
        let promise = loop.makePromise(of: Data.self)
        let exchange = Exchange(result: promise)
        let channel = EmbeddedChannel(handler: TranscriptFrames(exchange: exchange), loop: loop)
        try channel.writeInbound(WebSocketFrame(fin: false, opcode: .text, data: ByteBuffer(string: "{\"type\":")))
        try channel.writeInbound(WebSocketFrame(fin: true, opcode: .ping, data: ByteBuffer(string: "alive")))
        let pong = try XCTUnwrap(channel.readOutbound(as: WebSocketFrame.self))
        XCTAssertEqual(pong.opcode, .pong)
        XCTAssertNotNil(pong.maskKey)
        try channel.writeInbound(WebSocketFrame(fin: true, opcode: .continuation, data: ByteBuffer(string: "\"backlog\"}")))
        XCTAssertEqual(try promise.futureResult.wait(), Data(#"{"type":"backlog"}"#.utf8))
        _ = try channel.finish()
    }

    func testInvalidFrameSequenceAndOversizedTranscriptFailClosed() throws {
        for oversized in [false, true] {
            let loop = EmbeddedEventLoop()
            let promise = loop.makePromise(of: Data.self)
            let exchange = Exchange(result: promise)
            let channel = EmbeddedChannel(handler: TranscriptFrames(exchange: exchange), loop: loop)
            if oversized {
                try channel.writeInbound(WebSocketFrame(fin: false, opcode: .text, data: ByteBuffer(bytes: repeatElement(UInt8(65), count: 8_388_608))))
                try channel.writeInbound(WebSocketFrame(fin: true, opcode: .continuation, data: ByteBuffer(string: "x")))
            } else {
                try channel.writeInbound(WebSocketFrame(fin: true, opcode: .continuation, data: ByteBuffer(string: "x")))
            }
            XCTAssertThrowsError(try promise.futureResult.wait())
            _ = try channel.finish()
        }
    }

}

final class ChatRelaySSH: @unchecked Sendable {
    let deviceKey: Curve25519.Signing.PrivateKey
    let hostKey: Curve25519.Signing.PrivateKey
    let listener: Channel
    init(deviceKey: Curve25519.Signing.PrivateKey, hostKey: Curve25519.Signing.PrivateKey, listener: Channel) {
        self.deviceKey = deviceKey; self.hostKey = hostKey; self.listener = listener
    }
    func host() throws -> LiveHost {
        try LiveHost(name: "Chat fixture", address: "127.0.0.1", port: listener.localAddress!.port!, username: "fixture",
                     fingerprint: PhrenConnection.fingerprint(publicKey: String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: hostKey).publicKey)))
    }
    static func start(forwardPorts: [Int: Int] = [:], webPreviewHealth: String? = nil) async throws -> ChatRelaySSH {
        let loop = MultiThreadedEventLoopGroup.singleton.next()
        let device = Curve25519.Signing.PrivateKey(), host = Curve25519.Signing.PrivateKey()
        let listener = try await ServerBootstrap(group: loop).childChannelInitializer { parent in
            parent.eventLoop.makeCompletedFuture {
                try parent.pipeline.syncOperations.addHandler(NIOSSHHandler(role: .server(.init(hostKeys: [.init(ed25519Key: host)], userAuthDelegate: ChatRelayAuth(key: device))),
                allocator: parent.allocator, inboundChildChannelInitializer: { child, type in
                    if case .session = type {
                        return child.pipeline.addHandler(ChatRelayExec(ports: forwardPorts, webPreviewHealth: webPreviewHealth))
                    }
                    // Match restrict keys: SSH forwarding never reaches private sockets or TCP.
                    return child.eventLoop.makeFailedFuture(LiveConnectionError.disconnected)
                }))
            }
        }.bind(host: "127.0.0.1", port: 0).get()
        return ChatRelaySSH(deviceKey: device, hostKey: host, listener: listener)
    }
    func close() async throws { if listener.isActive { try await listener.close() } }
}
private final class ChatRelayAuth: NIOSSHServerUserAuthenticationDelegate, @unchecked Sendable {
    let key: NIOSSHPublicKey
    var supportedAuthenticationMethods: NIOSSHAvailableUserAuthenticationMethods { .publicKey }
    init(key: Curve25519.Signing.PrivateKey) { self.key = NIOSSHPrivateKey(ed25519Key: key).publicKey }
    func requestReceived(request: NIOSSHUserAuthenticationRequest, responsePromise: EventLoopPromise<NIOSSHUserAuthenticationOutcome>) {
        if request.username == "fixture", case .publicKey(let offered) = request.request, offered.publicKey == key { responsePromise.succeed(.success) }
        else { responsePromise.succeed(.failure) }
    }
}
private final class ChatRelayTCP: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    let peer: Channel
    init(peer: Channel) { self.peer = peer }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        peer.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(unwrapInboundIn(data))), promise: nil)
    }
    func channelInactive(context: ChannelHandlerContext) { peer.close(promise: nil) }
}
private final class ChatRelayChild: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    let peer: Channel
    init(peer: Channel) { self.peer = peer }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        if case .byteBuffer(let buffer) = unwrapInboundIn(data).data { peer.writeAndFlush(buffer, promise: nil) }
    }
}

private final class ChatRelayExec: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    let ports: [Int: Int]
    let webPreviewHealth: String?
    init(ports: [Int: Int], webPreviewHealth: String?) { self.ports = ports; self.webPreviewHealth = webPreviewHealth }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        guard let command = event as? SSHChannelRequestEvent.ExecRequest else {
            context.triggerUserOutboundEvent(ChannelFailureEvent(), promise: nil); return
        }
        let child = context.channel
        let port: Int?
        if command.command == "phren-hook v1 pipe" {
            if let webPreviewHealth {
                child.pipeline.addHandler(ChatRelayHealth(capability: webPreviewHealth)).whenSuccess {
                    child.triggerUserOutboundEvent(ChannelSuccessEvent(), promise: nil)
                }
                return
            }
            port = ports[24543]
        } else {
            let parts = command.command.split(separator: " ")
            guard parts.count == 5, parts.prefix(3) == ["phren-hook", "v1", "web"],
                  ["127.0.0.1", "::1"].contains(parts[3]), let requested = Int(parts[4]), let mapped = ports[requested] else {
                context.triggerUserOutboundEvent(ChannelFailureEvent(), promise: nil); return
            }
            port = mapped
        }
        let bootstrap = ClientBootstrap(group: child.eventLoop).channelInitializer { tcp in tcp.pipeline.addHandler(ChatRelayTCP(peer: child)) }
        let root = ProcessInfo.processInfo.environment["PHREN_BRIDGE_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/phren/bridge").path
        let connection = port.map { bootstrap.connect(host: "127.0.0.1", port: $0) } ?? bootstrap.connect(unixDomainSocketPath: root + "/hook.sock")
        connection.flatMap { tcp in
            child.closeFuture.whenComplete { _ in tcp.close(promise: nil) }
            return child.pipeline.addHandler(ChatRelayChild(peer: tcp))
        }.whenComplete { result in
            switch result {
            case .success: child.triggerUserOutboundEvent(ChannelSuccessEvent(), promise: nil)
            case .failure: child.close(promise: nil)
            }
        }
    }
}

private final class ChatRelayHealth: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    let capability: String
    var received = ""
    init(capability: String) { self.capability = capability }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard case .byteBuffer(let bytes) = unwrapInboundIn(data).data else { return }
        received += String(decoding: bytes.readableBytesView, as: UTF8.self)
        guard received.contains("\r\n\r\n") else { return }
        XCTAssertTrue(received.hasPrefix("GET /v1/health"))
        let body = "{\"product\":\"phren-hook\",\"protocol\":1,\"capabilities\":{\"webPreview\":\"\(capability)\"}}"
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n" + body
        context.writeAndFlush(NIOAny(SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(string: response)))), promise: nil)
    }
}
