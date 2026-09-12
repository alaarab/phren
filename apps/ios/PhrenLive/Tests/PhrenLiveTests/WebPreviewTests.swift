import Foundation
import Network
import NIOCore
import NIOHTTP1
import NIOPosix
import NIOWebSocket
import PhrenKit
import XCTest
@testable import PhrenLive

final class WebPreviewTests: XCTestCase {
    func testBrowserRequestsAssetsRedirectUploadsAndWebSocketThroughPinnedSSH() async throws {
        let site = try await startSite("computer-one")
        let relay = try await ChatRelaySSH.start(forwardPorts: [19472: site.localAddress!.port!], webPreviewHealth: "ssh-exec")
        addTeardownBlock { try await relay.close(); try await site.close() }
        let server = try entry(port: 19472)
        let tunnel = try await WebPreviewTunnel.open(host: relay.host(), privateKey: relay.deviceKey.rawRepresentation, server: server)
        defer { tunnel.close() }
        let session = session(tunnel)
        defer { session.invalidateAndCancel() }
        let unauthenticated = URLSession(configuration: .ephemeral)
        defer { unauthenticated.invalidateAndCancel() }
        let (_, denied) = try await unauthenticated.data(from: URL(string: "http://127.0.0.1:\(tunnel.proxyPort)/")!)
        XCTAssertEqual((denied as? HTTPURLResponse)?.statusCode, 407, "Raw local clients cannot reach the remote app")
        for path in ["/", "/asset.js", "/redirect"] {
            let (data, response) = try await session.data(from: tunnel.url.appendingPathComponent(path))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertEqual(String(decoding: data, as: UTF8.self), "computer-one")
        }
        var upload = URLRequest(url: tunnel.url.appendingPathComponent("upload"))
        upload.httpMethod = "POST"
        upload.httpBody = Data(repeating: 65, count: 2_000_000)
        let (echo, _) = try await session.data(for: upload)
        XCTAssertEqual(echo, upload.httpBody)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<12 { group.addTask {
                let (data, _) = try await session.data(from: tunnel.url.appendingPathComponent("asset.js"))
                XCTAssertEqual(String(decoding: data, as: UTF8.self), "computer-one")
            } }
            try await group.waitForAll()
        }
        var components = URLComponents(url: tunnel.url, resolvingAgainstBaseURL: false)!
        components.scheme = "ws"; components.path = "/hmr"
        let socket = session.webSocketTask(with: components.url!)
        socket.resume()
        try await socket.send(.string("live reload"))
        guard case .string(let reply) = try await socket.receive() else { return XCTFail("Expected live reload frame") }
        XCTAssertEqual(reply, "live reload")
        socket.cancel(with: .goingAway, reason: nil)
        var wrongTarget = URLComponents(url: tunnel.url, resolvingAgainstBaseURL: false)!
        wrongTarget.port = 19473
        do {
            let (_, response) = try await session.data(from: wrongTarget.url!)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 403)
        } catch { /* CFNetwork can surface a rejected CONNECT as a connection error. */ }
        tunnel.close(); await tunnel.waitUntilClosed()
        do { _ = try await session.data(from: tunnel.url); XCTFail("Closing preview must close the listener") }
        catch { }
    }

    func testSamePortOnDifferentComputersAndDeniedWebCommand() async throws {
        let first = try await startSite("first"), second = try await startSite("second")
        let a = try await ChatRelaySSH.start(forwardPorts: [19475: first.localAddress!.port!], webPreviewHealth: "ssh-exec")
        let b = try await ChatRelaySSH.start(forwardPorts: [19475: second.localAddress!.port!], webPreviewHealth: "ssh-exec")
        addTeardownBlock { try await a.close(); try await b.close(); try await first.close(); try await second.close() }
        let server = try entry(port: 19475)
        let tunnelA = try await WebPreviewTunnel.open(host: a.host(), privateKey: a.deviceKey.rawRepresentation, server: server)
        let tunnelB = try await WebPreviewTunnel.open(host: b.host(), privateKey: b.deviceKey.rawRepresentation, server: server)
        defer { tunnelA.close(); tunnelB.close() }
        XCTAssertNotEqual(tunnelA.proxyPort, tunnelB.proxyPort)
        let (one, _) = try await session(tunnelA).data(from: tunnelA.url)
        let (two, _) = try await session(tunnelB).data(from: tunnelB.url)
        XCTAssertEqual(String(decoding: one, as: UTF8.self), "first")
        XCTAssertEqual(String(decoding: two, as: UTF8.self), "second")
        do {
            _ = try await WebPreviewTunnel.open(host: a.host(), privateKey: a.deviceKey.rawRepresentation, server: entry(port: 19476))
            XCTFail("Unpermitted app port must fail before opening a browser")
        } catch { XCTAssertEqual(error as? WebPreviewError, .unavailable) }
        var untrusted = try a.host(); untrusted.fingerprint = nil
        do {
            _ = try await WebPreviewTunnel.open(host: untrusted, privateKey: a.deviceKey.rawRepresentation, server: server)
            XCTFail("Untrusted host must never preview")
        } catch { guard case LiveConnectionError.untrustedHost = error else { return XCTFail("Expected fingerprint check") } }
    }

    func testOlderHelperRequiresUpdateBeforeOpeningPreview() async throws {
        let relay = try await ChatRelaySSH.start(webPreviewHealth: "")
        addTeardownBlock { try await relay.close() }
        do {
            _ = try await WebPreviewTunnel.open(host: relay.host(), privateKey: relay.deviceKey.rawRepresentation, server: entry(port: 19475))
            XCTFail("An older helper must not use unrestricted SSH forwarding")
        } catch {
            XCTAssertEqual(error as? WebPreviewError, .updateRequired)
            XCTAssertTrue(error.localizedDescription.contains("phren bridge install"))
        }
    }

    func testInstalledDiscoveryAndAppThroughSSHWhenRequested() async throws {
        guard ProcessInfo.processInfo.environment["PHREN_TEST_WEB_SERVERS"] == "1" else { throw XCTSkip("Optional real helper and app check") }
        let relay = try await ChatRelaySSH.start()
        defer { Task { try? await relay.close() } }
        let servers = try await PhrenConnection.webServers(host: relay.host(), privateKey: relay.deviceKey.rawRepresentation)
        guard let server = servers.first(where: { $0.scheme == "http" }) else { return XCTFail("Expected a local fixture app") }
        let webRelay = try await ChatRelaySSH.start(forwardPorts: [server.port: server.port], webPreviewHealth: "ssh-exec")
        defer { Task { try? await webRelay.close() } }
        let tunnel = try await WebPreviewTunnel.open(host: webRelay.host(), privateKey: webRelay.deviceKey.rawRepresentation, server: server)
        defer { tunnel.close() }
        let (body, response) = try await session(tunnel).data(from: tunnel.url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertGreaterThan(body.count, 100)
    }

    private func session(_ tunnel: WebPreviewTunnel) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.proxyConfigurations = [tunnel.proxyConfiguration]
        config.timeoutIntervalForRequest = 10
        return URLSession(configuration: config)
    }

    private func entry(port: Int) throws -> WebServer {
        try WebServer.readSnapshot(Data("{\"servers\":[{\"name\":\"Fixture\",\"port\":\(port),\"origin\":\"http://127.0.0.1:\(port)\"}]}".utf8))[0]
    }

    private func startSite(_ name: String) async throws -> Channel {
        try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton).childChannelInitializer { channel in
            let http = PreviewSite(name: name)
            let upgrade = NIOWebSocketServerUpgrader(shouldUpgrade: { channel, _ in channel.eventLoop.makeSucceededFuture(HTTPHeaders()) },
                upgradePipelineHandler: { channel, _ in channel.pipeline.addHandler(PreviewEcho()) })
            return channel.pipeline.configureHTTPServerPipeline(withServerUpgrade: (upgraders: [upgrade], completionHandler: { context in
                context.pipeline.removeHandler(http, promise: nil)
            })).flatMap { channel.pipeline.addHandler(http) }
        }.bind(host: "127.0.0.1", port: 0).get()
    }
}

private final class PreviewSite: ChannelInboundHandler, RemovableChannelHandler {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart
    let name: String
    var path = ""
    var bytes = ByteBuffer()
    init(name: String) { self.name = name }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        switch unwrapInboundIn(data) {
        case .head(let head):
            XCTAssertNil(head.headers.first(name: "Proxy-Authorization"), "Preview credentials must never reach the app")
            path = head.uri; bytes.clear()
        case .body(var body): bytes.writeBuffer(&body)
        case .end:
            let body = path == "/upload" ? bytes : ByteBuffer(string: name)
            var headers = HTTPHeaders([("Content-Length", "\(body.readableBytes)"), ("Content-Type", "text/plain")])
            if path == "/redirect" { headers.add(name: "Location", value: "/asset.js") }
            context.write(wrapOutboundOut(.head(.init(version: .http1_1, status: path == "/redirect" ? .found : .ok, headers: headers))), promise: nil)
            context.write(wrapOutboundOut(.body(.byteBuffer(body))), promise: nil)
            context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
        }
    }
}

private final class PreviewEcho: ChannelInboundHandler {
    typealias InboundIn = WebSocketFrame
    typealias OutboundOut = WebSocketFrame
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let frame = unwrapInboundIn(data)
        var body = frame.data
        if let mask = frame.maskKey { body.webSocketUnmask(mask) }
        context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: frame.opcode, data: body)), promise: nil)
    }
}
