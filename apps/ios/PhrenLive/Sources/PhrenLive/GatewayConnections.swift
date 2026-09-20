import Crypto
import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import PhrenKit

/// One authenticated SSH connection per computer, shared by every gateway
/// request. A fresh connection costs a TCP handshake, a key exchange and an
/// authentication round trip; each request is then one session channel on
/// the shared connection, which is what makes a chat send feel immediate.
///
/// sshd allows ten sessions per connection, so once eight channels are open
/// (long-lived transcript and terminal streams count) a request gets a
/// dedicated connection instead of an open failure. A connection that closes
/// or goes idle leaves the pool; the next request reconnects.
final class GatewayConnections: @unchecked Sendable {
    static let shared = GatewayConnections()
    static let maximumChildren = 8
    static let idleSeconds: Int64 = 90

    /// Channel bookkeeping is confined to the connection's event loop.
    final class Connection: @unchecked Sendable {
        let loop: EventLoop
        let channel: Channel
        let ssh: NIOSSHHandler
        let pooled: Bool
        fileprivate(set) var children = 0
        fileprivate var idle: Scheduled<Void>?
        init(loop: EventLoop, channel: Channel, ssh: NIOSSHHandler, pooled: Bool) {
            self.loop = loop; self.channel = channel; self.ssh = ssh; self.pooled = pooled
        }
    }

    private let lock = NSLock()
    private var ready: [String: Connection] = [:]
    private var connecting: [String: Task<Connection, Error>] = [:]
    /// How many connections were opened; tests read it to prove reuse.
    private(set) var opened = 0

    static func key(host: LiveHost, key: Curve25519.Signing.PrivateKey) -> String {
        let device = Data(SHA256.hash(data: key.publicKey.rawRepresentation)).base64EncodedString()
        return [host.id.uuidString, host.address, String(host.port), host.username, host.fingerprint ?? "", device].joined(separator: "|")
    }

    /// An open connection with room for one more channel, or a new one. The
    /// caller owns one child slot on the result until it calls `release`.
    func connection(for host: LiveHost, key: Curve25519.Signing.PrivateKey) async throws -> Connection {
        let poolKey = Self.key(host: host, key: key)
        if let existing = pooled(poolKey), try await existing.reserve() { return existing }
        let task: Task<Connection, Error> = lock.withLock {
            if let inFlight = connecting[poolKey] { return inFlight }
            let task = Task { try await self.connect(host: host, key: key, pooled: true) }
            connecting[poolKey] = task
            return task
        }
        do {
            let connection = try await task.value
            lock.withLock { if connecting[poolKey] == task { connecting[poolKey] = nil } }
            if try await connection.reserve() { register(connection, poolKey: poolKey); return connection }
            // The shared connection filled up while it was being opened.
            register(connection, poolKey: poolKey)
        } catch {
            lock.withLock { if connecting[poolKey] == task { connecting[poolKey] = nil } }
            throw error
        }
        let dedicated = try await connect(host: host, key: key, pooled: false)
        _ = try await dedicated.reserve()
        return dedicated
    }

    /// Gives the child slot back. A dedicated connection closes with its
    /// only channel; a pooled one waits idle for the next request.
    func release(_ connection: Connection, healthy: Bool) {
        connection.loop.execute {
            connection.children = max(0, connection.children - 1)
            if !connection.pooled || !healthy {
                connection.channel.close(promise: nil)
                self.remove(connection)
                return
            }
            guard connection.children == 0 else { return }
            connection.idle?.cancel()
            connection.idle = connection.loop.scheduleTask(in: .seconds(Self.idleSeconds)) {
                guard connection.children == 0 else { return }
                connection.channel.close(promise: nil)
                self.remove(connection)
            }
        }
    }

    /// Drops everything: tests use it between servers.
    func reset() {
        let connections = lock.withLock { () -> [Connection] in
            let values = Array(ready.values); ready = [:]; connecting = [:]; return values
        }
        for connection in connections { connection.channel.close(promise: nil) }
    }

    private func pooled(_ poolKey: String) -> Connection? {
        lock.withLock { ready[poolKey] }
    }

    private func register(_ connection: Connection, poolKey: String) {
        lock.withLock {
            // A connection that died before registration is not kept.
            guard connection.channel.isActive else { return }
            ready[poolKey] = connection
        }
    }

    private func remove(_ connection: Connection) {
        lock.withLock {
            if let key = ready.first(where: { $0.value === connection })?.key { ready[key] = nil }
        }
    }

    private func connect(host: LiveHost, key: Curve25519.Signing.PrivateKey, pooled: Bool) async throws -> Connection {
        try host.validate()
        let loop = MultiThreadedEventLoopGroup.singleton.next()
        let ready = Exchange(result: loop.makePromise(of: Data.self))
        let deadline = loop.scheduleTask(in: .seconds(15)) { ready.finish(.failure(LiveConnectionError.timeout)) }
        ready.result.futureResult.whenComplete { _ in deadline.cancel() }
        let opened = ConnectionParts()
        let bootstrap = ClientBootstrap(group: loop).connectTimeout(.seconds(10)).channelInitializer { channel in
            channel.eventLoop.makeCompletedFuture {
                let ssh = NIOSSHHandler(
                    role: .client(.init(
                        userAuthDelegate: DeviceAuthentication(username: host.username, key: key, exchange: ready),
                        serverAuthDelegate: PinnedHost(fingerprint: host.fingerprint)
                    )), allocator: channel.allocator,
                    inboundChildChannelInitializer: { channel, _ in
                        channel.eventLoop.makeFailedFuture(LiveConnectionError.disconnected)
                    })
                try channel.pipeline.syncOperations.addHandlers(ssh, GatewayConnectionReady(exchange: ready) { [weak self] in
                    guard let self, let connection = opened.connection else { return }
                    self.remove(connection)
                })
                opened.channel = channel; opened.ssh = ssh
            }
        }
        bootstrap.connect(host: host.address, port: host.port).whenFailure { ready.finish(.failure($0)) }
        do {
            _ = try await ready.result.futureResult.get()
        } catch {
            opened.channel?.close(promise: nil)
            throw error
        }
        guard let channel = opened.channel, let ssh = opened.ssh, channel.isActive else { throw LiveConnectionError.disconnected }
        let connection = Connection(loop: loop, channel: channel, ssh: ssh, pooled: pooled)
        opened.connection = connection
        lock.withLock { self.opened += 1 }
        return connection
    }
}

/// Filled on the event loop during connection setup.
private final class ConnectionParts: @unchecked Sendable {
    var channel: Channel?
    var ssh: NIOSSHHandler?
    var connection: GatewayConnections.Connection?
}

extension GatewayConnections.Connection {
    /// Claims a child slot when the connection is alive and has room.
    fileprivate func reserve() async throws -> Bool {
        try await loop.submit {
            guard self.channel.isActive, self.children < GatewayConnections.maximumChildren else { return false }
            self.children += 1
            self.idle?.cancel(); self.idle = nil
            return true
        }.get()
    }
}

/// Reports the parent connection's authentication and closure.
private final class GatewayConnectionReady: ChannelInboundHandler {
    typealias InboundIn = Any
    let exchange: Exchange
    let onClose: () -> Void
    init(exchange: Exchange, onClose: @escaping () -> Void) { self.exchange = exchange; self.onClose = onClose }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is UserAuthSuccessEvent { exchange.finish(.success(Data())) }
        context.fireUserInboundEventTriggered(event)
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) {
        exchange.finish(.failure(error))
        context.close(promise: nil)
    }
    func channelInactive(context: ChannelHandlerContext) {
        exchange.finish(.failure(LiveConnectionError.disconnected))
        onClose()
        context.fireChannelInactive()
    }
}
