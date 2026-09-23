import Foundation
import PhrenKit

/// Read routes over the `code` module's local symbol index. They are
/// store-scoped, not pane-scoped: the phone names a project and the computer
/// answers from `<store>/.runtime/code/<project>.sqlite`. A project with no
/// index is a 404 the caller shows as "not indexed".
extension PhrenConnection {
    public static func codeStatus(host: LiveHost, privateKey: Data, project: String, storeID: String? = nil) async throws -> CodeStatus {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/status", project: project, storeID: storeID, fields: [:])
        return try CodeStatus.read(data)
    }

    public static func codeSearch(host: LiveHost, privateKey: Data, project: String, query: String, kind: String? = nil, limit: Int? = nil, directory: String? = nil, storeID: String? = nil) async throws -> [CodeSymbol] {
        guard query.utf8.count <= 500 else { throw PhrenKitError.validation("That search is too long.") }
        var fields = ["q": query]
        if let directory, !directory.isEmpty { fields["directory"] = try codePath(directory) }
        if let kind, !kind.isEmpty { fields["kind"] = try codeKind(kind) }
        if let limit { fields["limit"] = String(min(max(limit, 1), 100)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/search", project: project, storeID: storeID, fields: fields)
        return try CodeSearchResults.read(data)
    }

    public static func codeOutline(host: LiveHost, privateKey: Data, project: String, path: String, storeID: String? = nil) async throws -> [CodeOutlineEntry] {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/outline", project: project, storeID: storeID, fields: ["path": try codePath(path)])
        return try CodeOutlineResults.read(data)
    }

    public static func codeOutlineSummary(host: LiveHost, privateKey: Data, project: String, paths: [String], storeID: String? = nil) async throws -> [CodeOutlineSummary] {
        guard (1...200).contains(paths.count) else { throw PhrenKitError.validation("Choose between 1 and 200 paths.") }
        let validated = try paths.map { try codePath($0) }
        let encoded = String(decoding: try JSONEncoder().encode(validated), as: UTF8.self)
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/outline-summary", project: project, storeID: storeID, fields: ["paths": encoded])
        return try CodeOutlineSummaryResults.read(data)
    }

    /// Resolved uses made from one file, for tappable identifiers in the code viewer.
    public static func codeFileReferences(host: LiveHost, privateKey: Data, project: String, path: String, storeID: String? = nil) async throws -> [CodeFileReference] {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/file-references", project: project, storeID: storeID, fields: ["path": try codePath(path)])
        return try CodeFileReferenceResults.read(data)
    }

    public static func codeDefinition(host: LiveHost, privateKey: Data, project: String, symbol: String, storeID: String? = nil) async throws -> CodeDefinition {
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/definition", project: project, storeID: storeID, fields: ["symbol": try codeSymbol(symbol)])
        return try CodeDefinitionResults.read(data)
    }

    public static func codeReferences(host: LiveHost, privateKey: Data, project: String, symbol: String, limit: Int? = nil, storeID: String? = nil) async throws -> CodeReferences {
        var fields = ["symbol": try codeSymbol(symbol)]
        if let limit { fields["limit"] = String(min(max(limit, 1), 500)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/references", project: project, storeID: storeID, fields: fields)
        return try CodeReferencesResults.read(data)
    }

    public static func codeUsage(host: LiveHost, privateKey: Data, project: String, top: Int? = nil, storeID: String? = nil) async throws -> CodeUsage {
        var fields: [String: String] = [:]
        if let top { fields["top"] = String(min(max(top, 1), 100)) }
        let data = try await codeGet(host: host, privateKey: privateKey, path: "/v1/code/usage", project: project, storeID: storeID, fields: fields)
        return try CodeUsageResults.read(data)
    }

    public static func codeTree(host: LiveHost, privateKey: Data, project: String, directory: String = "", storeID: String? = nil) async throws -> [CodeTreeEntry] {
        let fields = directory.isEmpty ? [:] : ["directory": try codePath(directory)]
        return try CodeTreeResults.read(await codeGet(host: host, privateKey: privateKey, path: "/v1/code/tree", project: project, storeID: storeID, fields: fields))
    }

    public static func codeUsagePage(host: LiveHost, privateKey: Data, project: String, kind: String = "", file: String = "", directory: String = "",
                                     offset: Int = 0, end: Bool = false, storeID: String? = nil) async throws -> CodeUsagePage {
        var fields = ["offset": String(max(0, offset)), "limit": "50", "end": end ? "1" : "0"]
        if !kind.isEmpty { fields["kind"] = try codeKind(kind) }
        if !file.isEmpty { fields["file"] = try codePath(file) }
        if !directory.isEmpty { fields["directory"] = try codePath(directory) }
        return try CodeUsagePage.read(await codeGet(host: host, privateKey: privateKey, path: "/v1/code/usage-page", project: project, storeID: storeID, fields: fields))
    }

    public static func codeRecent(host: LiveHost, privateKey: Data, project: String, directory: String = "", storeID: String? = nil) async throws -> [CodeRecentSymbol] {
        let fields = directory.isEmpty ? [:] : ["directory": try codePath(directory)]
        return try CodeRecentResults.read(await codeGet(host: host, privateKey: privateKey, path: "/v1/code/recent", project: project, storeID: storeID, fields: fields))
    }

    public static func codeReindex(host: LiveHost, privateKey: Data, project: String, storeID: String? = nil) async throws -> CodeStatus {
        try host.validate()
        var fields = ["project": try codeProject(project)]
        if let storeID { fields["store"] = storeID }
        var request = GatewayRequest(path: "/v1/code/reindex", body: try JSONEncoder().encode(fields))
        request.method = "POST"
        return try CodeStatus.read(await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request))
    }

    public static func codeNote(host: LiveHost, privateKey: Data, note: CodeNoteRequest) async throws -> CodeNoteResult {
        try host.validate()
        var request = GatewayRequest(path: "/v1/code/note", body: try JSONEncoder().encode(note))
        request.method = "POST"
        let data = try await fetchData(host: host, key: .init(rawRepresentation: privateKey), request: request)
        return try JSONDecoder().decode(CodeNoteResult.self, from: data)
    }

    private static func codeGet(host: LiveHost, privateKey: Data, path: String, project: String, storeID: String?, fields: [String: String]) async throws -> Data {
        try host.validate()
        var query = ["project": try codeProject(project)]
        if let storeID { query["store"] = storeID }
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
        guard !trimmed.isEmpty, trimmed.utf8.count <= 4600, !trimmed.contains("\0") else {
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
        let allowed = ["function", "method", "class", "struct", "enum", "interface", "type", "variable", "types"]
        guard allowed.contains(kind) else { throw PhrenKitError.validation("That symbol kind is invalid.") }
        return kind
    }
}
