import Foundation

public enum ExternalLinkPolicy {
    /// No custom schemes, credentials, or hostless URLs from remote content.
    /// Return the actual host, never the Markdown label, for confirmation.
    public static func host(for url: URL) -> String? {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil,
              let host = url.host, !host.isEmpty else { return nil }
        return host
    }
}
