import Crypto
import Foundation
import NIOCore
import NIOHTTP1
import NIOWebSocket
import PhrenKit

extension PhrenConnection {
    public static func chatUpdates(host: LiveHost, privateKey: Data, target: AgentChatTarget) -> AsyncThrowingStream<AgentChatTranscript, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingOldest(8)) { continuation in
            let worker = Task {
                do {
                    guard target.hostID == host.id && target.muxID == host.muxID else { throw PhrenKitError.validation("The chat belongs to another computer.") }
                    let request = GatewayRequest.transcript(target, streaming: true)
                    _ = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request) { data in
                        let frame = try AgentChatTranscript.read(data, source: target.source)
                        if case .dropped = continuation.yield(frame) { throw LiveConnectionError.oversized }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in worker.cancel() }
        }
    }

    public static func chatHistory(host: LiveHost, privateKey: Data, target: AgentChatTarget, beforeLine: Int) async throws -> AgentChatTranscript {
        guard target.hostID == host.id && target.muxID == host.muxID, beforeLine > 0 else { throw PhrenKitError.validation("This history has no earlier destination.") }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        let data: Data
        do {
            // A history page should not download a fresh backlog or wait for
            // a WebSocket polling cycle before asking for the requested range.
            data = try await fetchData(host: host, key: key, request: .history(target, beforeLine: beforeLine))
        } catch let error as LiveConnectionError {
            switch error {
            case .response(404), .gatewayRejection(status: 404, reason: _):
                // Existing computers remain usable until their Hook is updated.
                data = try await fetchData(host: host, key: key, request: .transcript(target, beforeLine: beforeLine))
            default: throw error
            }
        }
        let result = try AgentChatTranscript.read(data, source: target.source)
        guard result.kind == .older, result.messages.allSatisfy({ $0.line < beforeLine }),
              !result.hasMore || result.startLine.map({ $0 >= 0 && $0 < beforeLine }) == true else {
            throw PhrenKitError.validation("The computer returned a different history range.")
        }
        return result
    }

    public static func uploadChatAttachment(host: LiveHost, privateKey: Data, target: AgentChatTarget, attachment: AgentAttachment) async throws -> String {
        guard target.hostID == host.id && target.muxID == host.muxID else { throw PhrenKitError.validation("The chat belongs to another computer.") }
        _ = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target, sending: true)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .upload(attachment, target: target))
        return try AgentAttachment.uploadedPath(from: data)
    }

    /// Only Escape is exposed. The caller cannot supply terminal key sequences.
    public static func stopChatTurn(host: LiveHost, privateKey: Data, target: AgentChatTarget) async throws {
        guard target.hostID == host.id && target.muxID == host.muxID else { throw PhrenKitError.validation("The chat belongs to another computer.") }
        let pane = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID).validate(target, sending: true)
        guard pane.agentStatus == "working" else { throw PhrenKitError.validation("This agent is no longer working.") }
        let request = try GatewayRequest.stop(target)
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        guard (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else {
            throw PhrenKitError.validation("The stop request was not confirmed. Check the terminal.")
        }
    }
    public static func chatPanes(host: LiveHost, privateKey: Data, workspaceID: String, tabID: String) async throws -> AgentChatPanes {
        guard AgentChatTarget.validID(workspaceID), AgentChatTarget.validID(tabID) else {
            throw PhrenKitError.validation("This workspace has no usable chat destination.")
        }
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: .panes(workspaceID, tabID))
        return try AgentChatPanes.read(data, workspaceID: workspaceID, tabID: tabID)
    }

    /// A bounded recent-history snapshot from the hook's WebSocket, then close.
    /// One-shot callers can use this without subscribing to live updates.
    public static func chatTranscript(host: LiveHost, privateKey: Data, target: AgentChatTarget) async throws -> AgentChatTranscript {
        guard target.hostID == host.id && target.muxID == host.muxID else { throw PhrenKitError.validation("The chat belongs to another computer.") }
        var request = GatewayRequest.transcript(target)
        request.streaming = false
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try AgentChatTranscript.read(data, source: target.source)
    }

    public static func sendChat(host: LiveHost, privateKey: Data, target: AgentChatTarget, text: String) async throws {
        guard target.hostID == host.id && target.muxID == host.muxID else { throw PhrenKitError.validation("The chat belongs to another computer.") }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 32_768,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" }) else {
            throw PhrenKitError.validation("Enter a message up to 32 KB without terminal control characters.")
        }
        let panes = try await chatPanes(host: host, privateKey: privateKey, workspaceID: target.workspaceID, tabID: target.tabID)
        _ = try panes.validate(target, sending: true)
        try Task.checkCancellation()
        let request = try GatewayRequest.prompt(target, text: text)
        // Exactly one attempt. An interrupted reply must not replay terminal input.
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["ok"] as? Bool == true else {
            throw PhrenKitError.validation("Delivery was not confirmed. Check the conversation before sending again.")
        }
    }
}

struct GatewayRequest: Sendable {
    var path: String
    var body: Data? = nil
    var maximumResponseBytes = 1_048_576
    var webSocket = false
    var streaming = false
    var beforeLine: Int?
    var initialMessages: [Data] = []
    var terminalSocket: HerdrTerminalSocket?
    var terminalServer: String?
    var terminalColumns = 80
    var terminalRows = 24
    var timeoutSeconds: Int?
    static let workspaces = Self(path: "/v1/workspaces?watchApprovals=1")
    static func panes(_ workspace: String, _ tab: String) -> Self {
        Self(path: path("/v1/workspaces/panes", ["groupId": workspace, "childId": tab]))
    }
    static func targetQuery(_ target: AgentChatTarget) -> [String: String] {
        ["server": String(target.muxID.dropFirst("herdr:".count)), "workspace": target.workspaceID,
         "tab": target.tabID, "pane": target.paneID, "source": target.source, "session": target.sessionID]
    }
    static func transcript(_ target: AgentChatTarget, streaming: Bool = false, beforeLine: Int? = nil) -> Self {
        Self(path: path("/v1/transcripts", targetQuery(target)), webSocket: true, streaming: streaming, beforeLine: beforeLine)
    }
    static func history(_ target: AgentChatTarget, beforeLine: Int) -> Self {
        var query = targetQuery(target); query["beforeLine"] = String(beforeLine)
        return Self(path: path("/v1/transcripts/history", query), maximumResponseBytes: 8_388_608)
    }
    static func targetBody(_ target: AgentChatTarget, fields: [String: Any] = [:]) throws -> Data {
        var body = fields; body["target"] = targetQuery(target)
        return try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
    static func upload(_ attachment: AgentAttachment, target: AgentChatTarget) throws -> Self {
        Self(path: "/v1/upload", body: try targetBody(target, fields: ["name": attachment.uploadName, "data": attachment.data.base64EncodedString()]))
    }
    static func stop(_ target: AgentChatTarget) throws -> Self {
        Self(path: "/v1/keys", body: try targetBody(target, fields: ["keys": ["Escape"]]))
    }
    static func prompt(_ target: AgentChatTarget, text: String) throws -> Self {
        Self(path: "/v1/prompt", body: try targetBody(target, fields: ["text": text]))
    }
    func scoped(to host: LiveHost) -> Self {
        guard path.hasPrefix("/v1/workspaces") else { return self }
        var copy = self
        var parts = URLComponents(string: path)!
        var items = parts.queryItems ?? []; items.removeAll { $0.name == "mux" }
        items.append(URLQueryItem(name: "mux", value: host.muxID)); parts.queryItems = items
        copy.path = parts.string!
        return copy
    }
    static func path(_ path: String, _ query: [String: String]) -> String {
        var parts = URLComponents()
        parts.path = path
        parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.string!
    }
}

func installTranscriptHandlers(channel: Channel, exchange: Exchange, request: GatewayRequest) -> EventLoopFuture<Void> {
    let handshake = TranscriptHandshake(exchange: exchange, path: request.path)
    let upgrader = NIOWebSocketClientUpgrader(maxFrameSize: 8_388_608, upgradePipelineHandler: { channel, _ in
        channel.pipeline.addHandler(TranscriptFrames(exchange: exchange, streaming: request.streaming, beforeLine: request.beforeLine,
                                                    initialMessages: request.initialMessages, terminalSocket: request.terminalSocket))
    })
    let config: NIOHTTPClientUpgradeConfiguration = (upgraders: [upgrader], completionHandler: { context in
        context.pipeline.removeHandler(handshake, promise: nil)
    })
    return channel.pipeline.addHandler(SSHHTTPBytes()).flatMap {
        channel.pipeline.addHTTPClientHandlers(withClientUpgrade: config)
    }.flatMap { channel.pipeline.addHandler(handshake) }
}

// Handler state is confined to the channel's event loop.
private final class TranscriptHandshake: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
    typealias InboundIn = HTTPClientResponsePart
    typealias OutboundOut = HTTPClientRequestPart
    let exchange: Exchange
    let path: String
    init(exchange: Exchange, path: String) { self.exchange = exchange; self.path = path }
    func channelActive(context: ChannelHandlerContext) {
        let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: path,
                                   headers: HTTPHeaders([("Host", "phren.local")]))
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil))).whenFailure { [exchange] in exchange.finish(.failure($0)) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        if case .head(let head) = unwrapInboundIn(data) { exchange.finish(.failure(LiveConnectionError.response(Int(head.status.code)))) }
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { exchange.finish(.failure(error)) }
    func channelInactive(context: ChannelHandlerContext) { exchange.finish(.failure(LiveConnectionError.disconnected)) }
}

final class TranscriptFrames: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = WebSocketFrame
    typealias OutboundOut = WebSocketFrame
    let exchange: Exchange
    private var body = Data()
    private var receiving = false
    private let streaming: Bool
    private let beforeLine: Int?
    private var requestedOlder = false
    private var heartbeat: RepeatedTask?
    private var lastReceived = NIODeadline.now()
    private let initialMessages: [Data]
    private let terminalSocket: HerdrTerminalSocket?
    init(exchange: Exchange, streaming: Bool = false, beforeLine: Int? = nil,
         initialMessages: [Data] = [], terminalSocket: HerdrTerminalSocket? = nil) {
        self.exchange = exchange; self.streaming = streaming; self.beforeLine = beforeLine
        self.initialMessages = initialMessages; self.terminalSocket = terminalSocket
    }
    func handlerAdded(context: ChannelHandlerContext) {
        terminalSocket?.attach(context.channel)
        for data in initialMessages {
            context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .text, maskKey: .random(), data: ByteBuffer(bytes: data))), promise: nil)
        }
        guard streaming else { return }
        let channel = context.channel
        heartbeat = context.eventLoop.scheduleRepeatedTask(initialDelay: .seconds(20), delay: .seconds(20)) { [weak self] _ in
            guard let self, !self.exchange.finished else { return }
            if NIODeadline.now() - self.lastReceived > .seconds(45) {
                self.exchange.finish(.failure(LiveConnectionError.timeout))
            } else {
                channel.writeAndFlush(WebSocketFrame(fin: true, opcode: .ping, maskKey: .random(), data: ByteBuffer()))
                    .whenFailure { [exchange = self.exchange] in exchange.finish(.failure($0)) }
            }
        }
    }
    func handlerRemoved(context: ChannelHandlerContext) { heartbeat?.cancel(); heartbeat = nil }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let frame = unwrapInboundIn(data)
        guard !exchange.finished else { return }
        lastReceived = .now()
        switch frame.opcode {
        case .ping:
            context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .pong, maskKey: .random(), data: frame.data)), promise: nil)
            return
        case .pong: return
        case .text, .binary:
            guard frame.opcode != .binary || terminalSocket != nil else { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
            guard !receiving else { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
            receiving = true
        case .continuation:
            guard receiving else { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
        default: exchange.finish(.failure(LiveConnectionError.disconnected)); return
        }
        guard body.count + frame.data.readableBytes <= (terminalSocket == nil ? 8_388_608 : 1_048_576) else {
            exchange.finish(.failure(LiveConnectionError.oversized)); return
        }
        body.append(contentsOf: frame.data.readableBytesView)
        if frame.fin {
            let completed = body
            body = Data(); receiving = false
            if let beforeLine {
                if !requestedOlder {
                    requestedOlder = true
                    let request = "{\"type\":\"older\",\"beforeLine\":\(beforeLine),\"limit\":200}"
                    context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .text, maskKey: .random(), data: ByteBuffer(string: request))), promise: nil)
                    return
                }
                guard let value = try? JSONSerialization.jsonObject(with: completed) as? [String: Any], value["type"] as? String == "older" else { return }
            }
            exchange.receive(completed)
        }
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { exchange.finish(.failure(error)) }
    func channelInactive(context: ChannelHandlerContext) { heartbeat?.cancel(); heartbeat = nil; exchange.finish(.failure(LiveConnectionError.disconnected)) }
}
