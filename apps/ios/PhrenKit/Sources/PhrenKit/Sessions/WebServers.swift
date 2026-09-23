import Foundation

/// The gateway's /events snapshot. Scan IDs are temporary; use origin + port
/// within a computer, and never interpret a reported URL as an SSH destination.
public struct WebServer: Equatable, Sendable, Identifiable {
    public let name: String
    public let port: Int
    public let scheme: String
    public let loopbackHost: String
    public let process: String?
    public let pid: Int?
    public let directory: String?
    /// For one session's list: "started" (its own process tree) or
    /// "mentioned" (a live port its transcript names); nil machine-wide.
    public let source: String?
    public var mentionedHere: Bool { source == "mentioned" }
    public var id: String { "\(scheme):\(loopbackHost):\(port)" }
    public var displayName: String { name.isEmpty || name == "Error response" ? "Web server on port \(port)" : name }
    public var detail: String { [process, "Port \(port)"].compactMap { $0 }.joined(separator: " · ") }

    /// A loopback link an agent printed (http://localhost:5173/admin), as the
    /// server it names on that agent's computer; nil for any other URL.
    public static func loopback(_ url: URL) -> Self? {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host?.lowercased(), ["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"].contains(host),
              url.user == nil, url.password == nil else { return nil }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        guard (1...65535).contains(port) else { return nil }
        return Self(name: "", port: port, scheme: scheme, loopbackHost: host.contains(":") ? "::1" : "127.0.0.1",
                    process: nil, pid: nil, directory: nil, source: nil)
    }

    public static func readSnapshot(_ data: Data) throws -> [Self] {
        guard data.count <= 1_048_576 else { throw PhrenKitError.validation("The server list is too large.") }
        struct Snapshot: Decodable { var servers: [Entry] }
        struct Entry: Decodable {
            var name: String?
            var port: Int
            var origin: String
            var process: String?
            var pid: Int?
            var cwd: String?
            var source: String?
        }
        let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
        var seen = Set<String>()
        return snapshot.servers.compactMap { entry in
            guard (1...65535).contains(entry.port),
                  let url = URLComponents(string: entry.origin),
                  let scheme = url.scheme, ["http", "https"].contains(scheme),
                  let host = url.host, ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "::", "[::]"].contains(host),
                  url.user == nil, url.password == nil,
                  (url.port ?? (scheme == "https" ? 443 : 80)) == entry.port else { return nil }
            let server = Self(name: String((entry.name ?? "").prefix(300)), port: entry.port, scheme: scheme,
                              loopbackHost: host.contains(":") ? "::1" : "127.0.0.1",
                              process: entry.process.map { String($0.prefix(100)) }, pid: entry.pid, directory: entry.cwd,
                              source: entry.source.flatMap { ["started", "mentioned"].contains($0) ? $0 : nil })
            return seen.insert(server.id).inserted ? server : nil
        }.sorted { $0.port < $1.port }
    }
}
