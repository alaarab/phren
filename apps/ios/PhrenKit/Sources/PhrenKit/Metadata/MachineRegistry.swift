import Foundation

/// What the store says about computers: `machines.yaml` maps a hostname to
/// a profile, `profiles/<name>.yaml` lists that profile's projects, and a
/// project's `phren.project.yaml` remembers the folder it was added from.
/// Together they answer "which of my computers has this project, and where"
/// before the phone asks any of them.
public struct MachineRegistry: Equatable, Sendable {
    /// hostname → profile name.
    public var machines: [String: String] = [:]
    /// profile name → project names.
    public var profiles: [String: [String]] = [:]
    /// project name → the `sourcePath` recorded in its `phren.project.yaml`.
    public var sourcePaths: [String: String] = [:]

    public init(machines: [String: String] = [:], profiles: [String: [String]] = [:], sourcePaths: [String: String] = [:]) {
        self.machines = machines; self.profiles = profiles; self.sourcePaths = sourcePaths
    }

    public static let empty = MachineRegistry()

    public static let machinesFile = "machines.yaml"
    public static let projectFile = "phren.project.yaml"
    /// `profiles/<name>.yaml` — one level, a plain name.
    public static func isProfilePath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return parts.count == 2 && parts[0] == "profiles" && parts[1].hasSuffix(".yaml")
            && JSRegex(#"^[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$"#).test(String(parts[1]))
    }

    /// Hostnames whose profile lists the project.
    public func hosts(for project: String) -> [String] {
        machines.filter { profiles[$0.value]?.contains(project) == true }.keys.sorted()
    }

    /// Whether a computer, as it names itself, is known to carry the project.
    /// Herdr and the Hook report `os.hostname()`; `machines.yaml` is written
    /// from the same call, but a `.local` suffix comes and goes with the
    /// network, so the comparison ignores it.
    public func hosts(_ hostname: String, project: String) -> Bool {
        let wanted = Self.canonical(hostname)
        return machines.contains { Self.canonical($0.key) == wanted && profiles[$0.value]?.contains(project) == true }
    }

    static func canonical(_ hostname: String) -> String {
        var name = hostname.lowercased()
        if name.hasSuffix(".local") { name.removeLast(".local".count) }
        return name
    }

    // MARK: - Parsing (the three files are flat YAML)

    /// `# comment` lines, then `Hostname: profile`.
    public static func parseMachines(_ content: String) -> [String: String] {
        var result: [String: String] = [:]
        for raw in content.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), let colon = line.firstIndex(of: ":") else { continue }
            let host = unquote(String(line[..<colon])), profile = unquote(String(line[line.index(after: colon)...]))
            if !host.isEmpty, !profile.isEmpty { result[host] = profile }
        }
        return result
    }

    /// `name: x` and a `projects:` list of `- project` entries.
    public static func parseProfile(_ content: String) -> (name: String?, projects: [String]) {
        var name: String?, projects: [String] = [], inProjects = false
        for raw in content.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("- ") {
                if inProjects { projects.append(unquote(String(line.dropFirst(2)))) }
                continue
            }
            inProjects = false
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces)
            let value = unquote(String(line[line.index(after: colon)...]))
            if key == "name" { name = value }
            else if key == "projects" { inProjects = true; if value.hasPrefix("[") { projects = value.dropFirst().dropLast().split(separator: ",").map { unquote(String($0)) } } }
        }
        return (name, projects.filter { !$0.isEmpty })
    }

    /// The `sourcePath:` of a `phren.project.yaml`, if any.
    public static func parseSourcePath(_ content: String) -> String? {
        for raw in content.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("sourcePath:") else { continue }
            let value = unquote(String(line.dropFirst("sourcePath:".count)))
            return value.hasPrefix("/") ? value : nil
        }
        return nil
    }

    private static func unquote(_ value: String) -> String {
        var text = value.trimmingCharacters(in: .whitespaces)
        if let hash = text.range(of: " #") { text = String(text[..<hash.lowerBound]).trimmingCharacters(in: .whitespaces) }
        if text.count >= 2, let first = text.first, let last = text.last, first == last, first == "\"" || first == "'" {
            text = String(text.dropFirst().dropLast())
        }
        return text
    }
}
