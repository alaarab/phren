import Foundation

/// Child agents hidden from an individual conversation's agent tree.
///
/// Values stay ordered on disk so the oldest dismissal can be discarded when
/// a conversation reaches its bound. Callers receive sets because visibility
/// checks do not otherwise care about that order.
public struct DismissedAgents {
    private static let storageKey = "chat.dismissedAgents.v1"
    private static let maximumIDsPerConversation = 200
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func ids(for conversationKey: String) -> Set<String> {
        Set(values()[conversationKey] ?? [])
    }

    public func dismiss(_ id: String, in key: String) {
        var stored = values()
        var ids = stored[key] ?? []
        guard !ids.contains(id) else { return }
        ids.append(id)
        if ids.count > Self.maximumIDsPerConversation {
            ids.removeFirst(ids.count - Self.maximumIDsPerConversation)
        }
        stored[key] = ids
        save(stored)
    }

    public func restore(_ id: String, in key: String) {
        var stored = values()
        guard var ids = stored[key] else { return }
        ids.removeAll { $0 == id }
        if ids.isEmpty { stored.removeValue(forKey: key) }
        else { stored[key] = ids }
        save(stored)
    }

    public func clearAll(in key: String) {
        var stored = values()
        guard stored.removeValue(forKey: key) != nil else { return }
        save(stored)
    }

    private func values() -> [String: [String]] {
        guard let stored = defaults.dictionary(forKey: Self.storageKey) else { return [:] }
        return stored.reduce(into: [:]) { result, entry in
            if let ids = entry.value as? [String] { result[entry.key] = ids }
        }
    }

    private func save(_ values: [String: [String]]) {
        if values.isEmpty { defaults.removeObject(forKey: Self.storageKey) }
        else { defaults.set(values, forKey: Self.storageKey) }
    }
}
