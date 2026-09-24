import CryptoKit
import Foundation

/// Device-local unsent work. Files never enter the Phren store or sync queue.
public final class AgentDraftStore {
    public struct Draft: Sendable {
        public var text: String
        public var attachments: [AgentAttachment]
        public init(text: String = "", attachments: [AgentAttachment] = []) {
            self.text = text; self.attachments = attachments
        }
    }
    private struct Document: VersionedDocument {
        static let currentSchemaVersion = 1
        var schemaVersion = 1
        let target: String
        let text: String
        let files: [File]
        struct File: Codable {
            let id: UUID
            let name: String
            let image: Bool
            let digest: String
        }
        enum CodingKeys: String, CodingKey { case schemaVersion, target, text, files }
        init(target: String, draft: Draft) {
            self.target = target; text = draft.text
            files = draft.attachments.map { File(id: $0.id, name: $0.name, image: $0.isImage, digest: $0.contentDigest) }
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
            target = try c.decode(String.self, forKey: .target)
            text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
            files = try c.decodeIfPresent([File].self, forKey: .files) ?? []
        }
    }
    public let root: URL
    private var unreadable: Set<String> = []
    private var checked: Set<String> = []
    private var writtenDigests: [URL: String] = [:]
    private var writtenFiles: [String: Set<String>] = [:]
    public init(root: URL) { self.root = root }
    private static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func directory(_ target: String) -> URL { root.appendingPathComponent(Self.digest(Data(target.utf8)), isDirectory: true) }

    public func load(target: String) throws -> Draft {
        do { let draft = try read(target: target); checked.insert(target); return draft }
        catch { unreadable.insert(target); throw error }
    }
    private func read(target: String) throws -> Draft {
        let directory = directory(target), file = directory.appendingPathComponent("draft.json")
        if !FileManager.default.fileExists(atPath: file.path),
           let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil),
           files.contains(where: { $0.pathExtension == "json" }) {
            throw PhrenKitError.validation("An unreadable agent draft has been preserved. Restore it before replacing this draft.")
        }
        if FileManager.default.fileExists(atPath: file.path), (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) > 262_144 {
            throw PhrenKitError.validation("This draft is too large to read. Its file has been kept.")
        }
        let result = PersistedState.load(Document.self, from: file, document: "agent drafts")
        if let issue = result.issue { throw PhrenKitError.validation(issue.userMessage) }
        guard let value = result.value else { return Draft() }
        guard value.target == target, value.text.utf8.count <= 131_072, value.files.count <= 4,
              Set(value.files.map(\.id)).count == value.files.count else {
            throw PhrenKitError.validation("This agent draft couldn't be read. Its saved files have been kept.")
        }
        let attachments = try value.files.map { entry in
            let url = directory.appendingPathComponent(entry.id.uuidString + ".bin")
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= AgentAttachment.maximumBytes else {
                throw PhrenKitError.validation("A saved attachment is too large. Its file has been kept.")
            }
            let data = try Data(contentsOf: url)
            guard Self.digest(data) == entry.digest else { throw PhrenKitError.validation("A saved attachment couldn't be verified. Its file has been kept.") }
            writtenDigests[url] = entry.digest
            return try AgentAttachment(id: entry.id, name: entry.name, data: data, isImage: entry.image)
        }
        return Draft(text: value.text, attachments: attachments)
    }

    public func save(_ draft: Draft, target: String) throws {
        if !checked.contains(target) { _ = try load(target: target) }
        guard !unreadable.contains(target) else { throw PhrenKitError.validation("The previous draft couldn't be read and has been preserved. This new draft is only in memory.") }
        guard draft.text.utf8.count <= 131_072, draft.attachments.count <= 4, Set(draft.attachments.map(\.id)).count == draft.attachments.count else {
            throw PhrenKitError.validation("This draft is too large to save on the phone.")
        }
        let manager = FileManager.default, directory = directory(target)
        if draft.text.isEmpty && draft.attachments.isEmpty {
            if manager.fileExists(atPath: directory.path) { try manager.removeItem(at: directory) }
            writtenDigests = writtenDigests.filter { $0.key.deletingLastPathComponent() != directory }
            writtenFiles[target] = nil
            return
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var local = root; try local.setResourceValues(excluded)
        let filenames = Set(draft.attachments.map { $0.id.uuidString + ".bin" })
        let changed = draft.attachments.filter { writtenDigests[directory.appendingPathComponent($0.id.uuidString + ".bin")] != $0.contentDigest }
        var total = 0
        if !changed.isEmpty, let contents = manager.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) {
            for case let file as URL in contents {
                let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                if values.isRegularFile == true { total += values.fileSize ?? 0 }
            }
        }
        for attachment in changed {
            let file = directory.appendingPathComponent(attachment.id.uuidString + ".bin")
            let previousBytes = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                guard previousBytes == 0 else { throw PhrenKitError.validation("This attachment changed after it was saved. Remove it and attach the new file again.") }
                guard total - previousBytes + attachment.data.count <= 256 * 1_024 * 1_024 else {
                    throw PhrenKitError.validation("Agent drafts have reached 256 MB. Send or remove some attachments before saving more.")
                }
                try attachment.data.write(to: file, options: .atomic)
                #if os(iOS)
                try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
                #endif
                total += attachment.data.count - previousBytes
                writtenDigests[file] = attachment.contentDigest
        }
        let file = directory.appendingPathComponent("draft.json")
        if let issue = PersistedState.save(Document(target: target, draft: draft), to: file, document: "agent drafts") {
            throw PhrenKitError.validation(issue.userMessage)
        }
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
        #endif
        // Only collect orphaned blobs after the manifest is safely replaced.
        if writtenFiles[target] != filenames {
          for file in try manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            if file.pathExtension == "bin", UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil,
               !filenames.contains(file.lastPathComponent) { try manager.removeItem(at: file); writtenDigests[file] = nil }
          }
          writtenFiles[target] = filenames
        }
    }
}

/// One serialized owner for filesystem work. Revisions reject delayed saves
/// from a dismissed editor or an earlier debounce after a newer save/clear.
public actor AgentDraftRepository {
    private let store: AgentDraftStore
    private var revisions: [String: UInt64] = [:]
    public init(root: URL) { store = AgentDraftStore(root: root) }
    public func load(target: String) throws -> AgentDraftStore.Draft { try store.load(target: target) }
    public func save(_ draft: AgentDraftStore.Draft, target: String, revision: UInt64) throws {
        guard revision > (revisions[target] ?? 0) else { return }
        revisions[target] = revision
        try store.save(draft, target: target)
    }
}
