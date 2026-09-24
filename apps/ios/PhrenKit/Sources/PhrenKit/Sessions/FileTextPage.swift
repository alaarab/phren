import Foundation

/// Cursors keep a large text document on disk. Only one bounded page is decoded
/// at a time, including UTF-8 characters split across a read boundary.
public struct FileTextCursor: Sendable, Equatable {
    public var offset: UInt64 = 0
    public var depth = 0
    public var quoted = false
    public var escaped = false
    public init() {}
}
public struct FileTextPage: Sendable {
    public let text: String
    public let next: FileTextCursor
    public let eof: Bool

    public static func read(url: URL, cursor: FileTextCursor, json: Bool = false, limit: Int = 32_768) throws -> Self {
        guard (4...65_536).contains(limit) else { throw PhrenKitError.validation("Invalid text page size.") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: cursor.offset)
        var data = try handle.read(upToCount: limit) ?? Data()
        let end = try handle.seekToEnd()
        let atEnd = cursor.offset + UInt64(data.count) == end
        // Prefer complete lines/paragraphs; never allow one long line to force
        // the complete file into memory.
        if !atEnd, !json, let newline = data.lastIndex(of: 10), newline > data.count / 2 { data = data.prefix(through: newline) }
        var text: String?
        for trim in 0...(atEnd ? 0 : min(3, data.count - (data.isEmpty ? 0 : 1))) {
            if let decoded = String(data: data.prefix(data.count - trim), encoding: .utf8) {
                data = data.prefix(data.count - trim); text = decoded; break
            }
        }
        guard let text, !text.contains("\0") else { throw PhrenKitError.validation("This file is not UTF-8 text. Save or share it to open it elsewhere.") }
        var next = cursor; next.offset += UInt64(data.count)
        let output = json ? formatJSON(text, cursor: &next) : text
        return Self(text: output, next: next, eof: next.offset == end)
    }
    private static func formatJSON(_ text: String, cursor: inout FileTextCursor) -> String {
        var result = ""
        func newline() { result += "\n" + String(repeating: "  ", count: min(40, cursor.depth)) }
        for char in text {
            if cursor.quoted {
                result.append(char)
                if cursor.escaped { cursor.escaped = false }
                else if char == "\\" { cursor.escaped = true }
                else if char == "\"" { cursor.quoted = false }
            } else {
                switch char {
                case "\"": cursor.quoted = true; result.append(char)
                case "{", "[": result.append(char); cursor.depth += 1; newline()
                case "}", "]": cursor.depth = max(0, cursor.depth - 1); newline(); result.append(char)
                case ",": result.append(char); newline()
                case ":": result += ": "
                default: if !char.isWhitespace { result.append(char) }
                }
            }
        }
        return result
    }
}

/// A CSV page ends at a complete record, respecting quoted newlines and escaped
/// quotes. A single pathological record has a bounded limit and an export path.
public struct FileCSVPage: Sendable {
    public let rows: [[String]]
    public let nextOffset: UInt64
    public let eof: Bool
    public static func read(url: URL, offset: UInt64, maximumBytes: Int = 262_144) throws -> Self {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        let data = try handle.read(upToCount: maximumBytes) ?? Data()
        let atEnd = offset + UInt64(data.count) == (try handle.seekToEnd())
        var rows: [[String]] = [], row: [String] = [], field = Data()
        var quoted = false, i = 0, boundary = 0
        func finishField() throws {
            guard let value = String(data: field, encoding: .utf8) else { throw PhrenKitError.validation("CSV must contain UTF-8 text.") }
            row.append(value); field.removeAll(keepingCapacity: true)
        }
        while i < data.count {
            let byte = data[i]
            if byte == 34 {
                if quoted && i + 1 < data.count && data[i + 1] == 34 { field.append(34); i += 1 }
                else { quoted.toggle() }
            } else if !quoted && byte == 44 { try finishField() }
            else if !quoted && (byte == 10 || byte == 13) {
                try finishField(); rows.append(row); row = []
                if byte == 13 && i + 1 < data.count && data[i + 1] == 10 { i += 1 }
                boundary = i + 1
                if rows.count == 100 { break }
            } else { field.append(byte) }
            i += 1
        }
        if i >= data.count, atEnd {
            guard !quoted else { throw PhrenKitError.validation("This CSV has an unfinished quoted field.") }
            if !field.isEmpty || !row.isEmpty { try finishField(); rows.append(row) }
            boundary = data.count
        }
        guard boundary > 0 || data.isEmpty else { throw PhrenKitError.validation("This CSV record exceeds 256 KiB. Save or share the file to read it elsewhere.") }
        return Self(rows: rows, nextOffset: offset + UInt64(boundary), eof: atEnd && boundary == data.count)
    }
}
