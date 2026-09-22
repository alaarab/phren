import Foundation

/// One read stays below the SSH gateway's response cap, including base64.
public struct FileChunk: Codable, Sendable, Equatable {
    public static let maximumLength = 4 * 1024 * 1024
    public let offset: Int64
    public let length: Int
    public let total: Int64
    public let contentType: String
    public let version: String
    public let eof: Bool
    public let data: String

    public init(offset: Int64, total: Int64, contentType: String, version: String, bytes: Data) {
        self.offset = offset; length = bytes.count; self.total = total
        self.contentType = contentType; self.version = version
        eof = offset + Int64(bytes.count) == total; data = bytes.base64EncodedString()
    }

    public func bytes() throws -> Data {
        guard offset >= 0, total >= offset, length >= 0, length <= Self.maximumLength,
              Int64(length) <= total - offset, !version.isEmpty, version.utf8.count <= 512,
              data.utf8.count <= (Self.maximumLength + 2) / 3 * 4,
              let bytes = Data(base64Encoded: data), bytes.count == length,
              eof == (offset + Int64(length) == total) else {
            throw PhrenKitError.validation("The computer returned an invalid file chunk.")
        }
        return bytes
    }
}

public enum FilePreviewKind: String, Sendable, CaseIterable {
    case video, audio, pdf, markdown, code, json, csv, image, text, file

    public static func detect(name: String, contentType: String?) -> Self {
        let ext = (name as NSString).pathExtension.lowercased()
        let mime = contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        // Specific MIME types win over a misleading filename. Generic text and
        // octet-stream still permit an extension to select a richer renderer.
        if mime == "application/pdf" { return .pdf }
        if mime == "application/json" || mime.hasSuffix("+json") { return .json }
        if mime == "text/csv" { return .csv }
        if mime == "text/markdown" { return .markdown }
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        if mime.hasPrefix("image/"), mime != "image/svg+xml" { return .image }
        if ["mp4", "m4v", "mov", "webm", "mkv", "avi"].contains(ext) { return .video }
        if ["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "opus"].contains(ext) { return .audio }
        if ext == "pdf" { return .pdf }
        if ext == "json" { return .json }
        if ext == "csv" { return .csv }
        if ["md", "markdown", "mdown"].contains(ext) { return .markdown }
        if ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"].contains(ext) { return .image }
        if ["ts", "tsx", "js", "jsx", "swift", "py", "rs", "go", "rb", "sh", "bash", "zsh", "c", "h", "cpp", "hpp", "cs", "java", "kt", "html", "css", "scss", "sql", "toml", "yaml", "yml", "xml", "svg", "ini"].contains(ext) { return .code }
        if ["txt", "log", "gitignore", "env"].contains(ext) || mime.hasPrefix("text/") { return .text }
        return .file
    }
}

public struct RemoteFile: Hashable, Sendable {
    public var path: String
    public var project: String?
    public var directory: String?
    public var target: AgentChatTarget?
    public var child: String?
    public var uploads: Bool
    public init(path: String, project: String? = nil, directory: String? = nil,
                target: AgentChatTarget? = nil, child: String? = nil, uploads: Bool = false) {
        self.path = path; self.project = project; self.directory = directory
        self.target = target; self.child = child; self.uploads = uploads
    }
    public var cacheIdentity: String {
        [project ?? "", directory ?? "", target?.id ?? "", child ?? "", uploads ? "uploads" : "project", path].joined(separator: "\n")
    }
}

/// Each completed append is durable. Reopening uses the actual file length,
/// including after process termination, and requires the same remote version.
public actor FileChunkAssembly {
    public nonisolated let file: URL
    private let metadata: URL
    private var expected: FileChunk?
    public init(directory: URL, name: String) {
        let last = (name as NSString).lastPathComponent
        file = directory.appendingPathComponent(["", ".", "..", ".download.json"].contains(last) ? "file" : last)
        metadata = directory.appendingPathComponent(".download.json")
    }
    public func prepare(_ info: FileChunk) throws -> Int64 {
        _ = try info.bytes()
        guard info.offset == 0, info.length == 0 else { throw PhrenKitError.validation("Expected file metadata.") }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let saved = (try? Data(contentsOf: metadata)).flatMap { try? JSONDecoder().decode(FileChunk.self, from: $0) }
        let size = ((try? FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
        if saved?.version != info.version || saved?.total != info.total || size > info.total || !FileManager.default.fileExists(atPath: file.path) {
            try Data().write(to: file, options: .atomic)
        }
        try JSONEncoder().encode(info).write(to: metadata, options: .atomic)
        expected = info
        return try received()
    }
    public func received() throws -> Int64 {
        ((try FileManager.default.attributesOfItem(atPath: file.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }
    public func append(_ chunk: FileChunk) throws -> Int64 {
        let bytes = try chunk.bytes()
        guard let expected, chunk.version == expected.version, chunk.total == expected.total,
              chunk.contentType == expected.contentType, chunk.offset == (try received()),
              !bytes.isEmpty else { throw PhrenKitError.validation("The file changed or a download chunk is missing. Open it again.") }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(chunk.offset))
        do { try handle.write(contentsOf: bytes); try handle.synchronize() }
        catch { try? handle.truncate(atOffset: UInt64(chunk.offset)); throw error }
        return chunk.offset + Int64(bytes.count)
    }
}
