import Crypto
import Foundation
import PhrenKit

extension PhrenConnection {
    /// The Hook's pushed overview for this computer: the full overview when
    /// it changes and a heartbeat while it does not. Ends when the socket
    /// closes; the caller falls back to polling `fetch`.
    public static func overviewUpdates(host: LiveHost, privateKey: Data) -> AsyncThrowingStream<LiveOverviewFrame, Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(2)) { continuation in
            let task = Task {
                do {
                    try host.validate()
                    _ = try await fetchData(host: host, key: Curve25519.Signing.PrivateKey(rawRepresentation: privateKey),
                                            request: .overview) { data in
                        continuation.yield(try LiveOverviewFrame.read(data))
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
