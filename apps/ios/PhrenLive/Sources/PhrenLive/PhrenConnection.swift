import Crypto
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import NIOSSH
import PhrenKit

public enum LiveConnectionError: LocalizedError, Equatable {
    case untrustedHost(String)
    case changedHost
    case authentication
    case timeout
    case disconnected
    case response(Int)
    case gatewayRejection(status: Int, reason: String)
    case oversized
    case deliveryUnconfirmed

    public var errorDescription: String? {
        switch self {
        case .untrustedHost: return "Verify this computer's SSH fingerprint before connecting."
        case .changedHost: return "This computer's SSH host key has changed. The connection was stopped. Verify the computer before removing and adding this connection again."
        case .authentication: return "SSH did not accept this device's key. Add the public key to the selected user's authorized_keys file and enable Remote Login or SSH."
        case .timeout: return "The connection timed out. Check Tailscale and SSH, then run phren bridge doctor on the computer."
        case .disconnected: return "The connection to the computer closed."
        case .response(let status): return "The computer returned HTTP \(status)."
        case .gatewayRejection(let status, let reason): return "\(reason) (HTTP \(status))"
        case .deliveryUnconfirmed: return "The computer did not confirm message delivery."
        case .oversized: return "The Phren Hook response exceeded this request's size limit."
        }
    }
}

/// Bounded, cancellable requests through a pinned SSH connection. Only the
/// workspace, pane, transcript, and exact-session prompt routes are exposed.
public enum PhrenConnection {
    public static func computerIdentity(host: LiveHost, privateKey: Data) async throws -> LiveWorkspaces.Computer? {
        try host.validate()
        let data = try await fetchData(host: host, key: Curve25519.Signing.PrivateKey(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/health"))
        guard data.count <= 65_536, let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["product"] as? String == "phren-hook",
              let computer = response["computer"] as? [String: Any],
              let rawID = computer["id"] as? String, let id = UUID(uuidString: rawID),
              let name = computer["name"] as? String, !name.isEmpty, name.utf8.count <= 253,
              name.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return LiveWorkspaces.Computer(id: id, name: name)
    }

    /// The name the computer gives itself (`os.hostname()`), as the Hook's
    /// health reports it — the key the store's `machines.yaml` uses.
    public static func computerName(host: LiveHost, privateKey: Data) async throws -> String? {
        try host.validate()
        let data = try await fetchData(host: host, key: Curve25519.Signing.PrivateKey(rawRepresentation: privateKey), request: GatewayRequest(path: "/v1/health"))
        guard data.count <= 65_536, let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              response["product"] as? String == "phren-hook",
              let name = (response["computer"] as? [String: Any])?["name"] as? String,
              !name.isEmpty, name.utf8.count <= 253,
              name.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        return name
    }

    public static func fetch(host: LiveHost, privateKey: Data) async throws -> LiveWorkspaces {
        try host.validate()
        let data = try await fetchData(host: host, key: Curve25519.Signing.PrivateKey(rawRepresentation: privateKey))
        try Task.checkCancellation()
        guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let helper = response["phren"] as? [String: Any], helper["product"] as? String == "phren-hook",
              helper["protocol"] as? Int == 1 else {
            throw PhrenKitError.validation("Install Phren Hook on this computer with phren bridge install.")
        }
        return try LiveWorkspaces.read(data)
    }

    static func fetchData(host: LiveHost, key: Curve25519.Signing.PrivateKey, request: GatewayRequest = .workspaces,
                          receive: (@Sendable (Data) throws -> Void)? = nil) async throws -> Data {
        try host.validate()
        let request = request.scoped(to: host)
        GatewayTiming.mark("request \(request.path) start")
        // The connection is shared; this request is one session channel on it.
        // Nothing has been sent before the channel opens, so a connection that
        // died in the pool is simply replaced.
        let connection = try await GatewayConnections.shared.connection(for: host, key: key)
        let loop = connection.loop
        let result = loop.makePromise(of: Data.self)
        let exchange = Exchange(result: result)
        exchange.onFrame = receive
        // All Exchange access is confined to this event loop, including cancel.
        let deadline = loop.scheduleTask(in: .seconds(Int64(request.timeoutSeconds ?? (request.body == nil ? 20 : 60)))) { exchange.finish(.failure(LiveConnectionError.timeout)) }
        if receive != nil { exchange.onFirstFrame = { deadline.cancel() } }
        result.futureResult.whenComplete { outcome in
            deadline.cancel()
            exchange.child?.close(promise: nil)
            // A transport failure means the shared connection may be gone
            // (the phone changed networks, the computer slept): drop it so
            // the next request reconnects instead of timing out again.
            let healthy: Bool
            switch outcome {
            case .success: healthy = true
            case .failure(let error):
                switch error {
                case LiveConnectionError.timeout, LiveConnectionError.disconnected: healthy = false
                case is LiveConnectionError, is CancellationError, is PhrenKitError: healthy = true
                default: healthy = false
                }
            }
            GatewayConnections.shared.release(connection, healthy: healthy)
        }
        return try await withTaskCancellationHandler {
            guard !Task.isCancelled else { loop.execute { exchange.finish(.failure(CancellationError())) }; throw CancellationError() }
            loop.execute { openGatewayChannel(on: connection, exchange: exchange, request: request) }
            let data = try await result.futureResult.get()
            GatewayTiming.mark("request \(request.path) done \(data.count) bytes")
            return data
        } onCancel: {
            loop.execute { exchange.finish(.failure(CancellationError())) }
        }
    }

    public static func fingerprint(publicKey: String) -> String? {
        let fields = publicKey.split(separator: " ")
        guard fields.count >= 2, let data = Data(base64Encoded: String(fields[1])) else { return nil }
        return "SHA256:" + Data(SHA256.hash(data: data)).base64EncodedString().replacingOccurrences(of: "=", with: "")
    }
}

// NIO callbacks and cancellations are serialized onto the owning event loop.
final class Exchange: @unchecked Sendable {
    let result: EventLoopPromise<Data>
    var child: Channel?
    var onFrame: (@Sendable (Data) throws -> Void)?
    var onFirstFrame: (() -> Void)?
    private(set) var finished = false
    init(result: EventLoopPromise<Data>) { self.result = result }
    func receive(_ data: Data) {
        guard !finished else { return }
        if let onFrame {
            do { try onFrame(data); onFirstFrame?(); onFirstFrame = nil }
            catch { finish(.failure(error)) }
        } else { finish(.success(data)) }
    }
    func finish(_ value: Result<Data, Error>) {
        guard !finished else { return }
        finished = true
        result.completeWith(value)
    }
}

final class PinnedHost: NIOSSHClientServerAuthenticationDelegate {
    let fingerprint: String?
    init(fingerprint: String?) { self.fingerprint = fingerprint }
    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        guard let received = PhrenConnection.fingerprint(publicKey: String(openSSHPublicKey: hostKey)) else {
            validationCompletePromise.fail(LiveConnectionError.changedHost)
            return
        }
        guard let fingerprint else {
            validationCompletePromise.fail(LiveConnectionError.untrustedHost(received))
            return
        }
        if fingerprint == received { validationCompletePromise.succeed(()) }
        else { validationCompletePromise.fail(LiveConnectionError.changedHost) }
    }
}

final class DeviceAuthentication: NIOSSHClientUserAuthenticationDelegate {
    let username: String
    let key: Curve25519.Signing.PrivateKey
    let exchange: Exchange
    var offered = false
    init(username: String, key: Curve25519.Signing.PrivateKey, exchange: Exchange) {
        self.username = username; self.key = key; self.exchange = exchange
    }
    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods,
                                nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !offered, availableMethods.contains(.publicKey) else {
            nextChallengePromise.succeed(nil)
            exchange.finish(.failure(LiveConnectionError.authentication))
            return
        }
        offered = true
        nextChallengePromise.succeed(.init(username: username, serviceName: "ssh-connection",
            offer: .privateKey(.init(privateKey: .init(ed25519Key: key)))))
    }
}

/// Opens this request's session channel on an authenticated connection.
/// Runs on the connection's event loop.
private func openGatewayChannel(on connection: GatewayConnections.Connection, exchange: Exchange, request: GatewayRequest) {
    guard !exchange.finished else { return }
    guard connection.channel.isActive else { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
    let child = connection.loop.makePromise(of: Channel.self)
    child.futureResult.whenFailure { [exchange] in exchange.finish(.failure($0)) }
    connection.ssh.createChannel(child, channelType: .session) { [exchange, request] channel, type in
        exchange.child = channel
        guard case .session = type else {
            return channel.eventLoop.makeFailedFuture(LiveConnectionError.disconnected)
        }
        if let socket = request.terminalSocket {
            return channel.pipeline.addHandler(PhrenTerminalChannel(exchange: exchange, socket: socket,
                route: request.terminalRoute ?? .herdr(server: "default"), columns: request.terminalColumns, rows: request.terminalRows))
        }
        return channel.pipeline.addHandler(PhrenExecChannel(exchange: exchange)).flatMap {
            if request.webSocket { return installTranscriptHandlers(channel: channel, exchange: exchange, request: request) }
            return channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandlers(
                    SSHHTTPBytes(), HTTPRequestEncoder(),
                    ByteToMessageHandler(HTTPResponseDecoder(leftOverBytesStrategy: .dropBytes)),
                    GatewayResponse(exchange: exchange, request: request))
            }
        }
    }
}

/// HTTPRequestEncoder emits IOData, while the SSH child expects SSHChannelData.
final class SSHHTTPBytes: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = IOData
    typealias OutboundOut = SSHChannelData
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard message.type == .channel, case .byteBuffer(let bytes) = message.data else {
            context.fireErrorCaught(LiveConnectionError.disconnected); return
        }
        context.fireChannelRead(wrapInboundOut(bytes))
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        context.write(wrapOutboundOut(.init(type: .channel, data: unwrapOutboundIn(data))), promise: promise)
    }
}

final class GatewayResponse: ChannelInboundHandler {
    typealias InboundIn = HTTPClientResponsePart
    typealias OutboundOut = HTTPClientRequestPart
    let exchange: Exchange
    let request: GatewayRequest
    private var body = Data()
    private var receivedHead = false
    private var status = 200
    private var responseLimit: Int { status == 200 ? request.maximumResponseBytes : min(request.maximumResponseBytes, 32_768) }
    init(exchange: Exchange, request: GatewayRequest = .workspaces) { self.exchange = exchange; self.request = request }
    func channelActive(context: ChannelHandlerContext) {
        var headers = HTTPHeaders([("Host", "phren.local"), ("Accept", "application/json"), ("Connection", "close")])
        if let body = request.body {
            headers.add(name: "Content-Type", value: "application/json")
            headers.add(name: "Content-Length", value: String(body.count))
        }
        let head = HTTPRequestHead(version: .http1_1, method: request.body == nil ? .GET : .POST, uri: request.path, headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        if let body = request.body {
            context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(bytes: body)))), promise: nil)
        }
        context.writeAndFlush(wrapOutboundOut(.end(nil))).whenFailure { [exchange] in exchange.finish(.failure($0)) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard !exchange.finished else { return }
        switch unwrapInboundIn(data) {
        case .head(let head):
            guard !receivedHead, head.status.code == 200 || (400...599).contains(head.status.code) else {
                exchange.finish(.failure(LiveConnectionError.response(Int(head.status.code)))); return
            }
            receivedHead = true
            status = Int(head.status.code)
            if let length = head.headers.first(name: "content-length"), let size = Int(length), size > responseLimit {
                exchange.finish(.failure(LiveConnectionError.oversized))
            }
        case .body(let bytes):
            guard receivedHead, body.count + bytes.readableBytes <= responseLimit else {
                exchange.finish(.failure(LiveConnectionError.oversized)); return
            }
            body.append(contentsOf: bytes.readableBytesView)
        case .end:
            guard receivedHead else { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
            if status != 200 {
                let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                let reason = (object?["error"] as? String).map {
                    String($0.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) })
                        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
                }.map { String($0.prefix(320)) }
                exchange.finish(.failure(reason?.isEmpty == false
                    ? LiveConnectionError.gatewayRejection(status: status, reason: reason!) : .response(status)))
            } else { exchange.finish(.success(body)) }
        }
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { exchange.finish(.failure(error)) }
    func channelInactive(context: ChannelHandlerContext) { exchange.finish(.failure(LiveConnectionError.disconnected)) }
}
