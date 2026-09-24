import Foundation

/// The model arguments this phone recently gave each harness, newest first.
/// Stored as JSON so an id carrying punctuation (`Hook` Codex ids are only
/// length-capped) can never split into two recents or eat another harness's
/// entry. At most `perSourceLimit` ids per source; a remembered id the next
/// catalogue no longer lists still leads that list as its own row.
public struct AgentModelRecents: Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public var source: String
        public var ids: [String]
        public init(source: String, ids: [String]) { self.source = source; self.ids = ids }
    }

    public static let perSourceLimit = 5
    public private(set) var entries: [Entry]

    public init(entries: [Entry] = []) { self.entries = entries }

    /// Decodes stored JSON; anything unparseable is no recents at all.
    public init(raw: String) {
        guard let data = raw.data(using: .utf8),
              let decoded = try? JSONDecoder().decode([Entry].self, from: data) else {
            entries = []
            return
        }
        entries = []
        for entry in decoded.prefix(16).reversed() where !entry.source.isEmpty {
            for id in entry.ids.prefix(Self.perSourceLimit).reversed() { remember(id, source: entry.source) }
        }
    }

    public var raw: String {
        guard let data = try? JSONEncoder().encode(entries), let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    public func ids(source: String) -> [String] {
        entries.first(where: { $0.source == source })?.ids ?? []
    }

    /// Puts `id` first for `source`, deduplicated and capped; the other
    /// sources' entries survive unchanged.
    public mutating func remember(_ id: String, source: String) {
        guard !id.isEmpty else { return }
        let ids = Array(([id] + ids(source: source).filter { $0 != id }).prefix(Self.perSourceLimit))
        entries.removeAll { $0.source == source }
        entries.insert(Entry(source: source, ids: ids), at: 0)
    }

    /// Recent ids lead, newest first: each is its catalogue row when the
    /// catalogue still lists it, otherwise its own "Used recently" row. The
    /// catalogue's tail keeps its order, the default first as sent.
    public static func ordered(_ list: [AgentModelChoice], recent: [String]) -> [AgentModelChoice] {
        var seen = Set<String>()
        let unique = recent.filter { seen.insert($0).inserted }
        let lead = unique.map { id in
            list.first(where: { $0.argument == id }) ?? AgentModelChoice(name: id, argument: id, description: "Used recently")
        }
        return lead + list.filter { choice in !seen.contains(choice.argument) }
    }
}
