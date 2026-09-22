import Foundation
import PhrenKit

/// The six read routes over the `code` module's local symbol index. They are
/// store-scoped, not pane-scoped: the phone names a project and the computer
/// answers from `<store>/.runtime/code/<project>.sqlite`. A project with no
/// index is a 404 the caller shows as "not indexed".
extension PhrenConnection {
    public static func codeStatus(host: LiveHost, privateKey: Data, project: String) async throws -> CodeStatus {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/status", project: project, fields: [:])
        return try CodeStatus.read(data)
    }

    public static func codeSearch(host: LiveHost, privateKey: Data, project: String, query: String, kind: String? = nil, limit: Int? = nil) async throws -> [CodeSymbol] {
        guard query.utf8.count <= 500 else { throw PhrenKitError.validation("That search is too long.") }
        var fields = ["q": query]
        if let kind, !kind.isEmpty { fields["kind"] = try codeKind(kind) }
        if let limit { fields["limit"] = String(min(max(limit, 1), 100)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/search", project: project, fields: fields)
        return try CodeSearchResults.read(data)
    }

    public static func codeOutline(host: LiveHost, privateKey: Data, project: String, path: String) async throws -> [CodeOutlineEntry] {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/outline", project: project, fields: ["path": try codePath(path)])
        return try CodeOutlineResults.read(data)
    }

    public static func codeDefinition(host: LiveHost, privateKey: Data, project: String, symbol: String) async throws -> CodeDefinition {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/definition", project: project, fields: ["symbol": try codeSymbol(symbol)])
        return try CodeDefinitionResults.read(data)
    }

    public static func codeReferences(host: LiveHost, privateKey: Data, project: String, symbol: String, limit: Int? = nil) async throws -> CodeReferences {
        var fields = ["symbol": try codeSymbol(symbol)]
        if let limit { fields["limit"] = String(min(max(limit, 1), 500)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/references", project: project, fields: fields)
        return try CodeReferencesResults.read(data)
    }

    public static func codeUsage(host: LiveHost, privateKey: Data, project: String, top: Int? = nil) async throws -> CodeUsage {
        var fields: [String: String] = [:]
        if let top { fields["top"] = String(min(max(top, 1), 100)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/usage", project: project, fields: fields)
        return try CodeUsageResults.read(data)
    }

    public static func codeNote(host: LiveHost, privateKey: Data, note: CodeNoteRequest) async throws -> CodeNoteResult {
        try host.validate()
        var request = GatewayRequest(path: "/v1/code/note", body: try JSONEncoder().encode(note))
        request.method = "POST"
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try JSONDecoder().decode(CodeNoteResult.self, from: data)
    }

    private static func codeGet(host: LiveHost, privateKey: Data, path: String, project: String, fields: [String: String]) async throws -> Data {
        try host.validate()
        var query = ["project": try codeProject(project)]
        query.merge(fields) { _, new in new }
        return try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: GatewayRequest(path: GatewayRequest.path(path, query)))
    }

    private static func codeProject(_ project: String) throws -> String {
        guard project.range(of: #"^[a-z0-9][a-z0-9_-]{0,99}$"#, options: .regularExpression) != nil else {
            throw PhrenKitError.validation("That project name is invalid.")
        }
        return project
    }

    private static func codeSymbol(_ symbol: String) throws -> String {
        let trimmed = symbol.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 500, !trimmed.contains("\0") else {
            throw PhrenKitError.validation("That symbol name is invalid.")
        }
        return trimmed
    }

    private static func codePath(_ path: String) throws -> String {
        guard !path.isEmpty, path.utf8.count <= 4_096, !path.contains("\0"), !path.split(separator: "/").contains("..") else {
            throw PhrenKitError.validation("That file path is invalid.")
        }
        return path
    }

    private static func codeKind(_ kind: String) throws -> String {
        let allowed = ["function", "method", "class", "struct", "enum", "interface", "type", "variable"]
        guard allowed.contains(kind) else { throw PhrenKitError.validation("That symbol kind is invalid.") }
        return kind
    }
}
