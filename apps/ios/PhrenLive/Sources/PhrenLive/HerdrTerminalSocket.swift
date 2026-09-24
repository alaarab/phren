import Foundation
import NIOCore
import NIOSSH
import PhrenKit

/// One Herdr client in the configured server, carried by the existing SSH key.
/// Closing this connection detaches the client; it does not kill remote panes.
public final class HerdrTerminalSocket: @unchecked Sendable {
    private let lock = NSLock()
    private var channel: Channel?
    func attach(_ channel: Channel) { lock.lock(); self.channel = channel; lock.unlock() }
    private func current() -> Channel? { lock.lock(); defer { lock.unlock() }; return channel }
    public init() {}

    public func input(_ text: String) async throws {
        guard !text.isEmpty, text.utf8.count <= 65_536 else { return }
        guard let channel = current(), channel.isActive else { throw LiveConnectionError.disconnected }
        try await channel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(string: text)))).get()
    }
    public func resize(columns: Int, rows: Int) async throws {
        guard (10...500).contains(columns), (2...300).contains(rows) else { return }
        guard let channel = current(), channel.isActive else { throw LiveConnectionError.disconnected }
        try await channel.triggerUserOutboundEvent(SSHChannelRequestEvent.WindowChangeRequest(
            terminalCharacterWidth: columns, terminalRowHeight: rows, terminalPixelWidth: 0, terminalPixelHeight: 0)).get()
    }
    public func acknowledge(_ bytes: Int) async throws {
        guard bytes >= 0, bytes <= 8_388_608 else { return }
        guard let channel = current(), channel.isActive else { throw LiveConnectionError.disconnected }
        try await channel.triggerUserOutboundEvent(TerminalAcknowledged(bytes: bytes)).get()
    }
}

/// What the SSH PTY runs on the computer. The dispatcher there accepts exactly
/// these commands; anything else the forced key refuses.
public enum TerminalRoute: Sendable, Hashable {
    /// Attach to a running Herdr server.
    case herdr(server: String)
    /// No Herdr: a login shell, or one agent, started in a project folder.
    /// The folder travels base64url-encoded so paths never touch the command grammar.
    case shell(directory: String, agent: PhrenConnection.LaunchKind?)

    public var command: String {
        switch self {
        case .herdr(let server): return "phren-hook v1 terminal " + server
        case .shell(let directory, let agent):
            let folder = Data(directory.utf8).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            return "phren-hook v1 shell " + folder + (agent.map { " " + $0.rawValue } ?? "")
        }
    }
    public var needsHerdr: Bool { if case .herdr = self { return true } else { return false } }
}

extension PhrenConnection {
    public static func herdrTerminal(host: LiveHost, privateKey: Data, socket: HerdrTerminalSocket,
                                     route: TerminalRoute? = nil, columns: Int = 80, rows: Int = 24) -> HerdrTerminalOutput {
        let buffer = TerminalOutputBuffer()
        let signals = AsyncThrowingStream<Void, Error>(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    let request = GatewayRequest(path: "", streaming: true, terminalSocket: socket,
                                                 terminalRoute: route ?? .herdr(server: host.herdrSession ?? "default"),
                                                 terminalColumns: min(500, max(10, columns)), terminalRows: min(300, max(2, rows)))
                    _ = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request) { data in
                        try buffer.append(data)
                        // Only wakeups coalesce. Terminal bytes are never dropped:
                        // escape sequences and UTF-8 can span SSH packets.
                        continuation.yield(())
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return HerdrTerminalOutput(buffer: buffer, signals: signals)
    }
}

/// Single-consumer, byte-bounded output. The consumer acknowledges only bytes
/// it has rendered, so the SSH receive window applies backpressure.
public struct HerdrTerminalOutput: AsyncSequence, Sendable {
    public typealias Element = Data
    let buffer: TerminalOutputBuffer
    let signals: AsyncThrowingStream<Void, Error>
    public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(buffer: buffer, signals: signals.makeAsyncIterator()) }
    public struct AsyncIterator: AsyncIteratorProtocol {
        let buffer: TerminalOutputBuffer
        var signals: AsyncThrowingStream<Void, Error>.AsyncIterator
        public mutating func next() async throws -> Data? {
            try Task.checkCancellation()
            if let bytes = buffer.take() { return bytes }
            while try await signals.next() != nil {
                try Task.checkCancellation()
                if let bytes = buffer.take() { return bytes }
            }
            return nil
        }
    }
}

final class TerminalOutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var pending = Data()
    private var offset = 0
    static let capacity = 1_048_576
    func append(_ bytes: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard bytes.count <= Self.capacity - (pending.count - offset) else { throw LiveConnectionError.oversized }
        if offset > 0 { pending = pending.subdata(in: offset..<pending.count); offset = 0 }
        pending.append(bytes)
    }
    func take() -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard offset < pending.count else { return nil }
        let end = min(pending.count, offset + 65_536)
        let bytes = pending.subdata(in: offset..<end)
        offset = end
        if offset == pending.count { pending = Data(); offset = 0 }
        return bytes
    }
}
