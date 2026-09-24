import Foundation

/// Store-wide skill switches, shared with packages/cli/src/skill/state.ts.
/// Keys address the source scope: a global switch affects all projects;
/// a project's switch affects only skills authored in that project.
public struct SkillPreferences: Decodable, Equatable, Sendable {
    public static let path = ".config/skill-preferences.json"
    public let schemaVersion: Int
    public let enabledSkills: [String: Bool]
    public static let empty = SkillPreferences(schemaVersion: 1, enabledSkills: [:])

    public static func key(scope: String, name: String) -> String {
        let stem = name.replacingOccurrences(of: #"\.md$"#, with: "", options: [.regularExpression, .caseInsensitive])
        return "\(scope):\(stem.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())"
    }

    public func explicitSetting(scope: String, name: String) -> Bool? {
        enabledSkills[Self.key(scope: scope, name: name)]
    }

    public static func parse(_ content: String?) throws -> SkillPreferences {
        guard let content else { return .empty }
        let value = try JSONDecoder().decode(Self.self, from: Data(content.utf8))
        guard value.schemaVersion == 1 else {
            throw PhrenKitError.validation("Update phren to read this store's skill settings.")
        }
        return value
    }

    /// Edit one key against fresh remote content, retaining all unknown fields
    /// and other scopes. Conflicts on this key preserve the queued choice.
    public static func setting(_ content: String?, scope: String, name: String,
                               enabled: Bool, expected: Bool?) throws -> String {
        guard LocalStore.isSkillPath("\(scope)/skills/\(name).md") else {
            throw PhrenKitError.validation("Invalid skill scope or name.")
        }
        let current = try parse(content)
        let existing = current.explicitSetting(scope: scope, name: name)
        guard existing == expected || existing == enabled else {
            throw PhrenKitError.validation("This skill's setting changed on another device. Refresh and choose again.")
        }
        var document: [String: Any] = [:]
        if let content { document = try JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any] ?? [:] }
        var settings = current.enabledSkills
        settings[key(scope: scope, name: name)] = enabled
        document["schemaVersion"] = 1
        document["enabledSkills"] = settings
        let data = try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        return String(decoding: data, as: UTF8.self) + "\n"
    }
}
