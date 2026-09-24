import Crypto
import Foundation
import NIOCore
import NIOPosix
import NIOSSH
import PhrenKit
import XCTest
@testable import PhrenLive

/// Uploads share one SSH connection with every other request to the computer,
/// as on the phone once a chat or terminal is open.
final class SharedConnectionUploadTests: XCTestCase {
    override func tearDown() { GatewayConnections.shared.reset(); super.tearDown() }

    /// A sibling request that fails while an upload's reply is still on its way
    /// must not close the connection under the upload. The Hook has already
    /// stored the file, so the upload has to report the path it returns.
    func testSiblingFailureDoesNotCloseAnUploadInFlight() async throws {
        let server = try await HarnessSSHServer.start { FakeHookSession(hook: $0) }
        addTeardownBlock { try await server.close() }
        let host = try server.host()
        let key = server.deviceKey.rawRepresentation
        let png = Data(repeating: 0x89, count: 355 * 1024)
        let upload = Task { try await PhrenConnection.uploadFile(host: host, privateKey: key, name: "shot.png", data: png) }
        let stored = try await server.hook.stored.futureResult.get()
        XCTAssertEqual(stored, png)

        // A stream or poll on the same connection ends badly.
        do {
            _ = try await PhrenConnection.fetchData(host: host, key: server.deviceKey, request: GatewayRequest(path: "/v1/drop"))
            XCTFail("The dropped request must fail")
        } catch { XCTAssertEqual(error as? LiveConnectionError, .disconnected) }
        let opened = GatewayConnections.shared.opened

        server.hook.reply.succeed(())
        let path = try await upload.value
        XCTAssertEqual(path, "/home/sam/.local/share/phren/bridge/uploads/files/shot.png")
        // The failed connection left the pool: the next request dials again.
        _ = try await PhrenConnection.fetchData(host: host, key: server.deviceKey, request: GatewayRequest(path: "/v1/health"))
        XCTAssertEqual(GatewayConnections.shared.opened, opened + 1)
    }

    /// Opt-in: the real gateway (`nc -U` or the node dispatcher) and a running
    /// Hook behind an in-process sshd stand-in. PHREN_UPLOAD_GATEWAY names a
    /// forced-command script that pipes `phren-hook v1 pipe` to that Hook.
    func testUploadsThroughRealGatewayAndHook() async throws {
        guard let gateway = ProcessInfo.processInfo.environment["PHREN_UPLOAD_GATEWAY"] else {
            throw XCTSkip("Requires PHREN_UPLOAD_GATEWAY")
        }
        let server = try await HarnessSSHServer.start { _ in ForcedCommandSession(command: gateway) }
        addTeardownBlock { try await server.close() }
        let host = try server.host()
        let key = server.deviceKey.rawRepresentation
        for size in [355 * 1024, 2 * 1024 * 1024, 355 * 1024] {
            var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
            png.append(Data((0..<size).map { _ in UInt8.random(in: 0...255) }))
            async let first = PhrenConnection.uploadFile(host: host, privateKey: key, name: "a.png", data: png)
            async let second = PhrenConnection.uploadFile(host: host, privateKey: key, name: "b.png", data: png)
            for path in try await [first, second] { XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), png) }
            let next = try await PhrenConnection.uploadFile(host: host, privateKey: key, name: "c.png", data: png)
            XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: next)), png)
        }
    }
}

/// Promises the fake Hook fulfils, shared by every session on the server.
final class FakeHookState: @unchecked Sendable {
    let stored: EventLoopPromise<Data>
    let reply: EventLoopPromise<Void>
    init(loop: EventLoop) {
        stored = loop.makePromise(); reply = loop.makePromise()
    }
    func fail() {
        stored.fail(CancellationError()); reply.fail(CancellationError())
    }
}

final class HarnessSSHServer: @unchecked Sendable {
    let deviceKey = Curve25519.Signing.PrivateKey()
    let hostKey = Curve25519.Signing.PrivateKey()
    let hook: FakeHookState
    private(set) var channel: Channel!
    private init(hook: FakeHookState) { self.hook = hook }

    static func start(session: @escaping @Sendable (FakeHookState) -> ChannelHandler) async throws -> HarnessSSHServer {
        let loop = MultiThreadedEventLoopGroup.singleton.next()
        let server = HarnessSSHServer(hook: FakeHookState(loop: loop))
        let auth = HarnessAuth(key: server.deviceKey)
        var configuration = SSHServerConfiguration(hostKeys: [.init(ed25519Key: server.hostKey)], userAuthDelegate: auth)
        // OpenSSH's session channel: 2 MiB window, 32 KiB packets.
        configuration.maximumPacketSize = 32_768
        let hook = server.hook
        server.channel = try await ServerBootstrap(group: loop).childChannelInitializer { channel in
            channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandler(NIOSSHHandler(role: .server(configuration), allocator: channel.allocator,
                    inboundChildChannelInitializer: { child, _ in
                        child.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).flatMap {
                            child.pipeline.addHandler(session(hook))
                        }
                    }))
            }
        }.bind(host: "127.0.0.1", port: 0).get()
        return server
    }
    func host() throws -> LiveHost {
        try LiveHost(name: "Desk", address: "127.0.0.1", port: channel.localAddress!.port!, username: "sam",
            fingerprint: PhrenConnection.fingerprint(publicKey: String(openSSHPublicKey: NIOSSHPrivateKey(ed25519Key: hostKey).publicKey)))
    }
    func close() async throws { hook.fail(); try await channel.close() }
}

private final class HarnessAuth: NIOSSHServerUserAuthenticationDelegate, @unchecked Sendable {
    let publicKey: NIOSSHPublicKey
    var supportedAuthenticationMethods: NIOSSHAvailableUserAuthenticationMethods { .publicKey }
    init(key: Curve25519.Signing.PrivateKey) { publicKey = NIOSSHPrivateKey(ed25519Key: key).publicKey }
    func requestReceived(request: NIOSSHUserAuthenticationRequest, responsePromise: EventLoopPromise<NIOSSHUserAuthenticationOutcome>) {
        if case .publicKey(let key) = request.request, key.publicKey == publicKey { responsePromise.succeed(.success) }
        else { responsePromise.succeed(.failure) }
    }
}

/// sshd's end of a session whose forced command has exited: the reply bytes,
/// EOF, exit-status, then CLOSE.
private func endSession(_ channel: Channel, reply: String?) {
    if let reply { channel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(string: reply))), promise: nil) }
    channel.close(mode: .output, promise: nil)
    channel.triggerUserOutboundEvent(SSHChannelRequestEvent.ExitStatus(exitStatus: 0)).whenComplete { _ in channel.close(promise: nil) }
}

/// The Hook behind `phren-hook v1 pipe`: `/v1/files` stores the body, then
/// answers when the test allows; `/v1/drop` ends without an answer.
private final class FakeHookSession: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    let hook: FakeHookState
    private var received = Data()
    private var handled = false
    init(hook: FakeHookState) { self.hook = hook }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let exec = event as? SSHChannelRequestEvent.ExecRequest {
            context.triggerUserOutboundEvent(exec.command == "phren-hook v1 pipe" ? ChannelSuccessEvent() : ChannelFailureEvent(), promise: nil)
        }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard case .byteBuffer(let buffer) = unwrapInboundIn(data).data, !handled else { return }
        received.append(contentsOf: buffer.readableBytesView)
        guard let split = received.range(of: Data("\r\n\r\n".utf8)) else { return }
        let head = String(decoding: received[..<split.lowerBound], as: UTF8.self)
        let length = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
        guard received.count - split.upperBound >= length else { return }
        handled = true
        let channel = context.channel
        if head.hasPrefix("POST /v1/files") {
            let body = received[split.upperBound...]
            let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: String]
            hook.stored.succeed(Data(base64Encoded: object?["data"] ?? "") ?? Data())
            hook.reply.futureResult.whenSuccess {
                let json = #"{"ok":true,"path":"/home/sam/.local/share/phren/bridge/uploads/files/shot.png"}"#
                endSession(channel, reply: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: \(json.utf8.count)\r\n\r\n" + json)
            }
        } else if head.hasPrefix("GET /v1/drop") {
            endSession(channel, reply: nil)
        } else {
            let json = #"{"product":"phren-hook"}"#
            endSession(channel, reply: "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: \(json.utf8.count)\r\n\r\n" + json)
        }
    }
}

/// sshd running a forced command: channel data to its stdin, its stdout to
/// channel data, EOF when stdout ends, exit-status then CLOSE when it exits.
private final class ForcedCommandSession: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias OutboundOut = SSHChannelData
    let command: String
    let process = Process()
    let stdin = Pipe(), stdout = Pipe()
    let writer = DispatchQueue(label: "harness.stdin")
    var stdoutEnded = false, exited: Int32?
    init(command: String) { self.command = command }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let exec = event as? SSHChannelRequestEvent.ExecRequest {
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = [command]
            var environment = ProcessInfo.processInfo.environment
            environment["SSH_ORIGINAL_COMMAND"] = exec.command
            process.environment = environment
            process.standardInput = stdin; process.standardOutput = stdout
            let loop = context.eventLoop, channel = context.channel
            stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil }
                loop.execute {
                    guard let self else { return }
                    if data.isEmpty {
                        self.stdoutEnded = true
                        channel.close(mode: .output, promise: nil)
                        self.finishIfDone(channel)
                    } else {
                        channel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(bytes: data))), promise: nil)
                    }
                }
            }
            process.terminationHandler = { [weak self] process in
                loop.execute { self?.exited = process.terminationStatus; self?.finishIfDone(channel) }
            }
            do {
                try process.run()
                context.triggerUserOutboundEvent(ChannelSuccessEvent(), promise: nil)
            } catch {
                context.triggerUserOutboundEvent(ChannelFailureEvent(), promise: nil)
            }
        } else if case ChannelEvent.inputClosed = event {
            let handle = stdin.fileHandleForWriting
            writer.async { try? handle.close() }
        }
    }
    private func finishIfDone(_ channel: Channel) {
        guard stdoutEnded, let status = exited else { return }
        channel.triggerUserOutboundEvent(SSHChannelRequestEvent.ExitStatus(exitStatus: Int(status))).whenComplete { _ in
            channel.close(promise: nil)
        }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard case .byteBuffer(let buffer) = unwrapInboundIn(data).data else { return }
        let bytes = Data(buffer.readableBytesView), handle = stdin.fileHandleForWriting
        writer.async { try? handle.write(contentsOf: bytes) }
    }
    func channelInactive(context: ChannelHandlerContext) {
        if process.isRunning { process.terminate() }
    }
}
