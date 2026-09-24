import Foundation

/// How the code browser decides a file is source it can show, and how it
/// splits that source into lines.
public enum CodeSourceText {
    /// The Hook's `/v1/projects/files` limit, applied to the viewer too.
    public static let maximumBytes = 2_097_152

    /// Kinds the code viewer opens. `.file` has no known extension, so its
    /// first bytes decide. Pictures, media, PDF and CSV keep the file viewer.
    public static func opensAsSource(_ kind: FilePreviewKind) -> Bool {
        [.code, .text, .json, .markdown, .file].contains(kind)
    }

    /// UTF-8 text without NUL bytes, or nil for binary content.
    public static func decode(_ data: Data) -> String? {
        guard !data.contains(0) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Lines as an editor numbers them; CRLF and a final newline do not add rows.
    public static func lines(_ text: String) -> [String] {
        var lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        if lines.count > 1, lines.last == "" { lines.removeLast() }
        return lines
    }
}
