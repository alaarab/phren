import Foundation
import NIOCore
import NIOWebSocket
import PhrenKit

/// The microphone's side of `/v1/speech/transcribe`: 16 kHz mono PCM goes up
/// as binary frames, and `commit()` tells the computer the person stopped.
public final class SpeechStreamSocket: @unchecked Sendable {
    private let lock = NSLock()
    private var channel: Channel?
    func attach(_ channel: Channel) { lock.lock(); self.channel = channel; lock.unlock() }
    private func current() -> Channel? { lock.lock(); defer { lock.unlock() }; return channel }
    public init() {}

    public var isOpen: Bool { current()?.isActive == true }

    public func send(_ pcm: Data) async throws {
        guard !pcm.isEmpty, pcm.count <= 32_768 else { return }
        guard let channel = current(), channel.isActive else { throw LiveConnectionError.disconnected }
        try await channel.writeAndFlush(WebSocketFrame(fin: true, opcode: .binary, maskKey: .random(), data: ByteBuffer(bytes: pcm))).get()
    }

    public func commit() async {
        guard let channel = current(), channel.isActive else { return }
        try? await channel.writeAndFlush(WebSocketFrame(fin: true, opcode: .text, maskKey: .random(), data: ByteBuffer(string: #"{"type":"commit"}"#))).get()
    }

    public func close() {
        guard let channel = current() else { return }
        channel.close(promise: nil)
    }
}

/// What the computer hears, as it hears it.
public enum SpeechTranscriptEvent: Equatable, Sendable {
    case partial(String)
    case committed(String)
    case failed(code: String, message: String)
}

extension PhrenConnection {
    /// Opens Scribe dictation through the computer's Hook. The stream ends
    /// when the socket closes; `failed` carries the Hook's fixed message.
    public static func speechTranscription(host: LiveHost, privateKey: Data, socket: SpeechStreamSocket,
                                           language: String?, keyterms: [String]) -> AsyncThrowingStream<SpeechTranscriptEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = speechTranscriptionRequest(language: language, keyterms: keyterms, socket: socket)
                    _ = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request) { data in
                        if let event = speechTranscriptEvent(data) { continuation.yield(event) }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel(); socket.close() }
        }
    }

    static func speechTranscriptionRequest(language: String?, keyterms: [String], socket: SpeechStreamSocket) -> GatewayRequest {
        var items = [URLQueryItem]()
        if let language, !language.isEmpty { items.append(.init(name: "language", value: language)) }
        items += keyterms.prefix(50).map { URLQueryItem(name: "keyterm", value: $0) }
        var parts = URLComponents(); parts.path = "/v1/speech/transcribe"; parts.queryItems = items.isEmpty ? nil : items
        var request = GatewayRequest(path: parts.string ?? "/v1/speech/transcribe", webSocket: true, streaming: true)
        request.speechSocket = socket
        return request
    }

    static func speechTranscriptEvent(_ data: Data) -> SpeechTranscriptEvent? {
        guard let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let text = frame["text"] as? String ?? ""
        switch frame["type"] as? String {
        case "partial": return .partial(text)
        case "committed": return .committed(text)
        case "error": return .failed(code: frame["code"] as? String ?? "transcribe-failed",
                                     message: frame["error"] as? String ?? "Transcription failed.")
        default: return nil
        }
    }
}
