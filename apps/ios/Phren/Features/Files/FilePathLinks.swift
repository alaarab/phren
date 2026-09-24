import PhrenKit
import PhrenLive
import SwiftUI

struct FileLinkContext {
    let host: LiveHost
    let target: AgentChatTarget
}
private struct FileLinkContextKey: EnvironmentKey {
    static let defaultValue: FileLinkContext? = nil
}
extension EnvironmentValues {
    var fileLinkContext: FileLinkContext? {
        get { self[FileLinkContextKey.self] }
        set { self[FileLinkContextKey.self] = newValue }
    }
}

enum FilePathLinks {
    struct Candidate {
        let path: String
        let range: Range<AttributedString.Index>
    }
    static func localPath(_ url: URL) -> String? {
        guard url.scheme == nil || url.isFileURL else { return nil }
        let path = url.isFileURL ? url.path : url.relativeString.removingPercentEncoding ?? url.relativeString
        return path.split(separator: "#", maxSplits: 1).first.map(String.init)
    }
    static func candidates(_ input: AttributedString) -> [Candidate] {
        var result: [Candidate] = []
        for run in input.runs {
            if let link = run.link, let path = localPath(link) { result.append(Candidate(path: path, range: run.range)) }
            else if run.inlinePresentationIntent?.contains(.code) == true {
                let path = String(input[run.range].characters)
                    .replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
                if path.range(of: #"^[\p{L}\p{N}_./ -]+$"#, options: .regularExpression) != nil,
                   !path.contains(" ") || path.contains("/") || path.contains(".") {
                    result.append(Candidate(path: path, range: run.range))
                }
            }
        }
        let text = String(input.characters)
        let pattern = #"(?<![A-Za-z0-9_:/@])(?:/(?:[^\s`<>\[\]()\"',;:]+/)*[^\s`<>\[\]()\"',;:]+|(?:\./)?[\p{L}\p{N}_.-]+/(?:[\p{L}\p{N}_.-]+/)*[\p{L}\p{N}_.-]+|(?:[\p{L}\p{N}_.-]+/)*[\p{L}\p{N}_.-]+\.[A-Za-z][A-Za-z0-9]{0,15})(?::\d+(?::\d+)?)?"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return result }
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).prefix(64) {
            guard let stringRange = Range(match.range, in: text), let range = Range(stringRange, in: input),
                  !input[range].runs.contains(where: { $0.link != nil }),
                  !result.contains(where: { $0.range.overlaps(range) }) else { continue }
            let path = String(text[stringRange]).replacingOccurrences(of: #":\d+(?::\d+)?$"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"[.!?:]+$"#, with: "", options: .regularExpression)
            if !path.isEmpty { result.append(Candidate(path: path, range: range)) }
        }
        return result
    }
    static func linked(_ input: AttributedString, existing: Set<String>) -> AttributedString {
        var output = input
        // An explicit Markdown file link is also inert until the Hook validates it.
        for run in input.runs where run.link.map({ localPath($0) != nil }) == true { output[run.range].link = nil }
        for candidate in candidates(input) where existing.contains(candidate.path) {
            var parts = URLComponents(); parts.scheme = "phren-file"; parts.host = "open"
            parts.queryItems = [URLQueryItem(name: "path", value: candidate.path)]
            output[candidate.range].link = parts.url
        }
        return output
    }
}

/// Coalesce repeated paths across paragraphs and replies. Missing paths expire
/// quickly, so a file an agent is still rendering can become a link later.
@MainActor enum FileLinkChecks {
    private struct Entry { let at: Date; let exists: Bool }
    private static var cache: [String: Entry] = [:]
    private static var inFlight: [String: Task<Bool, Never>] = [:]
    static func file(_ path: String, context: FileLinkContext) -> RemoteFile {
        RemoteFile(path: path, target: context.target, uploads: path.contains("/bridge/uploads/"))
    }
    static func exists(_ path: String, context: FileLinkContext) async -> Bool {
        let key = context.target.id + "\n" + path
        if let cached = cache[key], Date().timeIntervalSince(cached.at) < 15 { return cached.exists }
        if let task = inFlight[key] { return await task.value }
        let task = Task { () -> Bool in
            #if DEBUG && targetEnvironment(simulator)
            if FileViewerFixture.enabled { return FileViewerFixture.names.contains((path as NSString).lastPathComponent) }
            #endif
            guard let privateKey = try? DeviceSSHKey.load(context.host.id) else { return false }
            return (try? await PhrenConnection.fileRange(host: context.host, privateKey: privateKey,
                file: file(path, context: context), length: 0)) != nil
        }
        inFlight[key] = task
        let exists = await task.value
        inFlight[key] = nil
        if cache.count >= 256 { cache = cache.filter { Date().timeIntervalSince($0.value.at) < 15 }; if cache.count >= 256 { cache.removeAll() } }
        cache[key] = Entry(at: Date(), exists: exists)
        return exists
    }
}

/// Kept on individual prose blocks so link updates do not rebuild the timeline.
struct FileLinkedText: View {
    let attributed: AttributedString
    @Environment(\.fileLinkContext) private var context
    @State private var existing: Set<String> = []
    @State private var opened: FileViewerItem?
    /// The surrounding link policy, such as the chat's website confirmation.
    @Environment(\.openURL) private var inherited
    var body: some View {
        Text(ChatInlineCode.tinted(FilePathLinks.linked(attributed, existing: existing)))
            .environment(\.openURL, OpenURLAction { url in
                // Only file links are ours. Every other link goes through the
                // screen's own policy; `.systemAction` would skip the chat's
                // "Open website?" confirmation and its scheme filter.
                guard url.scheme == "phren-file" else { inherited(url); return .handled }
                guard let context, let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value,
                      existing.contains(path) else { return .discarded }
                opened = FileViewerItem(host: context.host, file: FileLinkChecks.file(path, context: context))
                return .handled
            })
            .fullScreenCover(item: $opened) { FileViewer(item: $0) }
            .task(id: (context?.target.id ?? "") + String(attributed.characters)) {
                existing = []
                guard let context else { return }
                let paths = Array(Set(FilePathLinks.candidates(attributed).map(\.path))).sorted().prefix(24)
                for path in paths {
                    if await FileLinkChecks.exists(path, context: context), !Task.isCancelled { existing.insert(path) }
                    if Task.isCancelled { return }
                }
            }
    }
}
