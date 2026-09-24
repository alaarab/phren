import Crypto
import Foundation
import Network
import NIOCore
import NIOPosix
import NIOSSH
import PhrenKit

public enum WebPreviewError: LocalizedError, Equatable {
    case unavailable
    case updateRequired
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "The app stopped or the preview connection closed. Refresh the server list."
        case .updateRequired: return "Update Phren on this computer, then run phren bridge install to enable secure web previews and update this phone's SSH authorization."
        }
    }
}

/// An authenticated, destination-bound CONNECT proxy over pinned SSH. After
/// authorization, bytes pass unchanged, including WebSockets, uploads, and TLS. The
/// browser owns its lifetime; no remote process or public listener is created.
public final class WebPreviewTunnel: @unchecked Sendable {
    public let url: URL
    public let proxyConfiguration: ProxyConfiguration
    let proxyPort: Int
    private let state: PreviewTunnelState
    private init(url: URL, proxyPort: Int, state: PreviewTunnelState) {
        self.url = url; self.proxyPort = proxyPort; self.state = state
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(proxyPort))!))
        proxy.applyCredential(username: "phren", password: state.secret)
        proxy.allowFailover = false
        proxy.matchDomains = ["phren-preview.localhost", "127.0.0.1", "localhost", "::1"]
        proxyConfiguration = proxy
    }

    public static func open(host: LiveHost, privateKey: Data, server: WebServer) async throws -> WebPreviewTunnel {
        try host.validate()
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: privateKey)
        let health = try await PhrenConnection.fetchData(host: host, key: key, request: GatewayRequest(path: "/v1/health"))
        guard let info = try JSONSerialization.jsonObject(with: health) as? [String: Any],
              info["product"] as? String == "phren-hook", info["protocol"] as? Int == 1,
              (info["capabilities"] as? [String: Any])?["webPreview"] as? String == "ssh-exec" else {
            throw WebPreviewError.updateRequired
        }
        let loop = MultiThreadedEventLoopGroup.singleton.next()
        let state = PreviewTunnelState(loop: loop, destination: server.loopbackHost, port: server.port)
        let ready = Exchange(result: loop.makePromise(of: Data.self))
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                let deadline = loop.scheduleTask(in: .seconds(20)) { ready.finish(.failure(LiveConnectionError.timeout)) }
                ready.result.futureResult.whenComplete { _ in deadline.cancel() }
                let bootstrap = ClientBootstrap(group: loop).connectTimeout(.seconds(10)).channelInitializer { channel in
                    state.parent = channel
                    guard !state.closed else { return channel.close() }
                    return channel.eventLoop.makeCompletedFuture {
                        let ssh = NIOSSHHandler(role: .client(.init(
                            userAuthDelegate: DeviceAuthentication(username: host.username, key: key, exchange: ready),
                            serverAuthDelegate: PinnedHost(fingerprint: host.fingerprint))),
                            allocator: channel.allocator, inboundChildChannelInitializer: { child, _ in
                                child.eventLoop.makeFailedFuture(LiveConnectionError.disconnected)
                            })
                        try channel.pipeline.syncOperations.addHandlers(ssh, PreviewSSHEvents(state: state, ready: ready))
                    }
                }
                bootstrap.connect(host: host.address, port: host.port).whenFailure { ready.finish(.failure($0)) }
                _ = try await ready.result.futureResult.get()
                try Task.checkCancellation()
                // Check the dispatcher's SSH exec channel before presenting the browser.
                let probe = try await loop.flatSubmit { state.openChannel() }.get()
                try await probe.close()
                let listener = ServerBootstrap(group: loop)
                    .childChannelOption(ChannelOptions.autoRead, value: false)
                    .childChannelInitializer { local in state.attach(local) }
                let channel = try await listener.bind(host: "127.0.0.1", port: 0).get()
                try await loop.submit {
                    state.listener = channel
                    if state.closed { channel.close(promise: nil) }
                }.get()
                try Task.checkCancellation()
                guard channel.isActive, let port = channel.localAddress?.port else { throw LiveConnectionError.disconnected }
                return WebPreviewTunnel(url: URL(string: "\(server.scheme)://phren-preview.localhost:\(server.port)/")!, proxyPort: port, state: state)
            } catch {
                await state.loop.submit { state.close(); ready.finish(.failure(error)) }.getIgnoringFailure()
                throw error
            }
        } onCancel: {
            loop.execute { state.close(); ready.finish(.failure(CancellationError())) }
        }
    }

    public func close() { state.loop.execute { self.state.close() } }
    public func waitUntilClosed() async { _ = try? await state.ended.futureResult.get() }
    deinit { let state = state; state.loop.execute { state.close() } }
}

// State and all relay channels share this single event loop.
private final class PreviewTunnelState: @unchecked Sendable {
    let loop: EventLoop
    let port: Int
    let destination: String
    let secret = UUID().uuidString + UUID().uuidString
    let ended: EventLoopPromise<Void>
    var parent: Channel?
    var listener: Channel?
    var clients: [ObjectIdentifier: Channel] = [:]
    var closed = false
    init(loop: EventLoop, destination: String, port: Int) {
        self.loop = loop; self.destination = destination; self.port = port; ended = loop.makePromise()
    }

    func close() {
        guard !closed else { return }; closed = true
        listener?.close(promise: nil); parent?.close(promise: nil)
        for channel in clients.values { channel.close(promise: nil) }
        clients.removeAll()
        ended.succeed(())
    }

    func openChannel(local: Channel? = nil) -> EventLoopFuture<Channel> {
        guard !closed, let parent, parent.isActive else { return loop.makeFailedFuture(LiveConnectionError.disconnected) }
        let promise = loop.makePromise(of: Channel.self)
        let opened = loop.makePromise(of: Channel.self)
        let deadline = loop.scheduleTask(in: .seconds(10)) { self.close() }
        promise.futureResult.whenComplete { _ in deadline.cancel() }
        do {
            let ssh = try parent.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
            ssh.createChannel(opened, channelType: .session) { remote, _ in
                var handlers: [ChannelHandler] = [PreviewExecChannel(destination: self.destination, port: self.port, ready: promise)]
                if let local { handlers += [SSHHTTPBytes(), PreviewRelay(peer: local)] }
                return remote.pipeline.addHandlers(handlers)
            }
        } catch { opened.fail(error) }
        opened.futureResult.whenFailure { promise.fail($0) }
        return promise.futureResult.flatMapError { _ in self.loop.makeFailedFuture(WebPreviewError.unavailable) }
    }

    func attach(_ local: Channel) -> EventLoopFuture<Void> {
        guard clients.count < 64, !closed else { return local.close() }
        let id = ObjectIdentifier(local)
        clients[id] = local
        local.closeFuture.whenComplete { _ in self.clients.removeValue(forKey: id) }
        return local.pipeline.addHandler(PreviewAuthorization(state: self)).flatMap {
            local.setOption(ChannelOptions.autoRead, value: true)
        }
    }

    func authorize(_ local: Channel) -> EventLoopFuture<Void> {
        return openChannel(local: local).flatMap { remote in
            guard !self.closed else { return remote.close() }
            return local.pipeline.addHandler(PreviewRelay(peer: remote)).flatMap {
                remote.setOption(ChannelOptions.autoRead, value: true)
            }.flatMap { local.setOption(ChannelOptions.autoRead, value: true) }
        }.flatMapError { error in
            local.close(promise: nil)
            return self.loop.makeFailedFuture(error)
        }
    }
}

/// OpenSSH forwarding bypasses forced commands, including for Unix sockets.
/// Previews therefore use an allowlisted exec command on a session channel.
private final class PreviewExecChannel: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    let destination: String
    let port: Int
    let ready: EventLoopPromise<Channel>
    private var completed = false
    init(destination: String, port: Int, ready: EventLoopPromise<Channel>) {
        self.destination = destination; self.port = port; self.ready = ready
    }
    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(
            command: "phren-hook v1 web \(destination) \(port)", wantReply: true), promise: nil)
    }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is ChannelSuccessEvent, !completed {
            completed = true
            context.channel.setOption(ChannelOptions.autoRead, value: false).map {
                // The relay becomes active only after the dispatcher accepts exec.
                context.fireChannelActive()
                return context.channel
            }.cascade(to: ready)
        } else if event is ChannelFailureEvent { fail() }
        else { context.fireUserInboundEventTriggered(event) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        // A dispatcher's stderr is diagnostic text, never browser response bytes.
        if unwrapInboundIn(data).type == .channel { context.fireChannelRead(data) }
    }
    func channelInactive(context: ChannelHandlerContext) { fail(); context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(); context.close(promise: nil) }
    private func fail() {
        guard !completed else { return }
        completed = true; ready.fail(WebPreviewError.unavailable)
    }
}

/// Authenticate before opening a remote channel. Credentials are consumed here
/// and never reach the development server, URL, page scripts, or logs.
private final class PreviewAuthorization: ChannelInboundHandler, RemovableChannelHandler {
    typealias InboundIn = ByteBuffer
    let state: PreviewTunnelState
    var buffer = ByteBuffer()
    var connecting = false
    var timeout: Scheduled<Void>?
    init(state: PreviewTunnelState) { self.state = state }
    func handlerAdded(context: ChannelHandlerContext) {
        timeout = context.eventLoop.scheduleTask(in: .seconds(10)) { context.close(promise: nil) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var bytes = unwrapInboundIn(data); buffer.writeBuffer(&bytes)
        guard buffer.readableBytes <= 65536 else { context.close(promise: nil); return }
        guard !connecting, let range = buffer.readableBytesView.firstRange(of: [13, 10, 13, 10]) else { return }
        let length = range.upperBound - buffer.readerIndex
        guard let header = buffer.readString(length: length) else { context.close(promise: nil); return }
        let lines = header.components(separatedBy: "\r\n")
        let request = lines[0].split(separator: " ")
        let authorities = ["phren-preview.localhost:\(state.port)", "127.0.0.1:\(state.port)", "localhost:\(state.port)", "[::1]:\(state.port)"]
        let credentials = lines.dropFirst().compactMap { line -> String? in
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, parts[0].lowercased() == "proxy-authorization" else { return nil }
            return parts[1].trimmingCharacters(in: .whitespaces)
        }
        let expected = "Basic " + Data("phren:\(state.secret)".utf8).base64EncodedString()
        guard credentials == [expected] else { reject(context, status: "407 Proxy Authentication Required", extra: "Proxy-Authenticate: Basic realm=\"Phren preview\"\r\n"); return }
        guard request.count == 3, request[0] == "CONNECT", authorities.contains(String(request[1])), request[2] == "HTTP/1.1" else {
            reject(context, status: "403 Forbidden"); return
        }
        connecting = true
        state.authorize(context.channel).whenComplete { result in
            switch result {
            case .success:
                context.writeAndFlush(NIOAny(IOData.byteBuffer(ByteBuffer(string: "HTTP/1.1 200 Connection Established\r\n\r\n"))), promise: nil)
                if self.buffer.readableBytes > 0 { context.fireChannelRead(NIOAny(self.buffer)); context.fireChannelReadComplete() }
                context.pipeline.removeHandler(self, promise: nil)
            case .failure: context.close(promise: nil)
            }
        }
    }
    private func reject(_ context: ChannelHandlerContext, status: String, extra: String = "") {
        connecting = true
        context.writeAndFlush(NIOAny(IOData.byteBuffer(ByteBuffer(string: "HTTP/1.1 \(status)\r\n\(extra)Content-Length: 0\r\nConnection: close\r\n\r\n"))))
            .whenComplete { _ in context.close(promise: nil) }
    }
    func handlerRemoved(context: ChannelHandlerContext) { timeout?.cancel() }
    func channelInactive(context: ChannelHandlerContext) { timeout?.cancel(); context.fireChannelInactive() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { context.close(promise: nil) }
}

private final class PreviewSSHEvents: ChannelInboundHandler {
    typealias InboundIn = ByteBuffer
    let state: PreviewTunnelState
    let ready: Exchange
    init(state: PreviewTunnelState, ready: Exchange) { self.state = state; self.ready = ready }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is UserAuthSuccessEvent { ready.finish(.success(Data())) }
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { ready.finish(.failure(error)); state.close() }
    func channelInactive(context: ChannelHandlerContext) { ready.finish(.failure(LiveConnectionError.disconnected)); state.close() }
}

/// Gate reads on the other channel's writability to bound queued page data.
private final class PreviewRelay: ChannelDuplexHandler {
    typealias InboundIn = ByteBuffer
    typealias OutboundIn = IOData
    var peer: Channel?
    init(peer: Channel) { self.peer = peer }
    func channelActive(context: ChannelHandlerContext) {
        context.fireChannelActive()
        context.read(); peer?.read()
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        peer?.write(IOData.byteBuffer(unwrapInboundIn(data))).whenFailure { _ in context.close(promise: nil) }
    }
    func channelReadComplete(context: ChannelHandlerContext) { peer?.flush() }
    func read(context: ChannelHandlerContext) { if peer?.isWritable == true { context.read() } }
    func channelWritabilityChanged(context: ChannelHandlerContext) { if context.channel.isWritable { peer?.read() } }
    func channelInactive(context: ChannelHandlerContext) { peer?.close(promise: nil) }
    func errorCaught(context: ChannelHandlerContext, error: Error) { context.close(promise: nil); peer?.close(promise: nil) }
    func handlerRemoved(context: ChannelHandlerContext) { peer = nil }
}

private extension EventLoopFuture where Value == Void {
    func getIgnoringFailure() async { _ = try? await get() }
}
