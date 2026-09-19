import Foundation
import NIOCore
import NIOSSH

/// Start HTTP only after SSH accepts the restricted helper command.
final class PhrenExecChannel: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    let exchange: Exchange
    private var ready = false
    init(exchange: Exchange) { self.exchange = exchange }
    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: "phren-hook v1 pipe", wantReply: true), promise: nil)
    }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is ChannelSuccessEvent, !ready { ready = true; context.fireChannelActive() }
        else if event is ChannelFailureEvent { exchange.finish(.failure(LiveConnectionError.disconnected)) }
        else { context.fireUserInboundEventTriggered(event) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        if message.type == .channel { context.fireChannelRead(data) }
    }
}

struct TerminalAcknowledged { let bytes: Int }

/// The SSH PTY is the terminal transport. Receive credit follows rendered bytes,
/// so a busy terminal cannot run ahead of the phone's renderer indefinitely.
final class PhrenTerminalChannel: ChannelDuplexHandler {
    typealias InboundIn = SSHChannelData
    typealias OutboundIn = SSHChannelData
    let exchange: Exchange
    let socket: HerdrTerminalSocket
    let route: TerminalRoute
    let columns: Int
    let rows: Int
    private var stage = 0
    private var outstanding = 0
    init(exchange: Exchange, socket: HerdrTerminalSocket, route: TerminalRoute, columns: Int, rows: Int) {
        self.exchange = exchange; self.socket = socket; self.route = route; self.columns = columns; self.rows = rows
    }
    func handlerAdded(context: ChannelHandlerContext) { socket.attach(context.channel) }
    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.PseudoTerminalRequest(wantReply: true, term: "xterm-256color",
            terminalCharacterWidth: columns, terminalRowHeight: rows, terminalPixelWidth: 0, terminalPixelHeight: 0,
            terminalModes: .init([:])), promise: nil)
    }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is ChannelFailureEvent { exchange.finish(.failure(LiveConnectionError.disconnected)); return }
        if event is ChannelSuccessEvent {
            if stage == 0 {
                stage = 1
                context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: route.command, wantReply: true), promise: nil)
            } else if stage == 1 {
                stage = 2
                context.channel.setOption(ChannelOptions.autoRead, value: false).whenFailure { [exchange] in exchange.finish(.failure($0)) }
                context.read()
            }
        } else { context.fireUserInboundEventTriggered(event) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let value = unwrapInboundIn(data)
        guard value.type == .channel, case .byteBuffer(let buffer) = value.data else { return }
        outstanding += buffer.readableBytes
        guard outstanding <= TerminalOutputBuffer.capacity else { exchange.finish(.failure(LiveConnectionError.oversized)); return }
        exchange.receive(Data(buffer.readableBytesView))
    }
    func channelReadComplete(context: ChannelHandlerContext) {
        if stage == 2 && outstanding < 262_144 { context.read() }
    }
    func triggerUserOutboundEvent(context: ChannelHandlerContext, event: Any, promise: EventLoopPromise<Void>?) {
        if let acknowledgement = event as? TerminalAcknowledged {
            outstanding = max(0, outstanding - acknowledgement.bytes)
            if stage == 2 && outstanding < 262_144 { context.read() }
            promise?.succeed(())
        } else { context.triggerUserOutboundEvent(event, promise: promise) }
    }
    func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
        guard stage == 2 else { promise?.fail(LiveConnectionError.disconnected); return }
        context.write(data, promise: promise)
    }
    func errorCaught(context: ChannelHandlerContext, error: Error) { exchange.finish(.failure(error)) }
    func channelInactive(context: ChannelHandlerContext) { exchange.finish(.failure(LiveConnectionError.disconnected)) }
}
