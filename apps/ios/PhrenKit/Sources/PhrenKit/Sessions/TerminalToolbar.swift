import Foundation

public enum TerminalToolbarItem: String, Codable, CaseIterable, Identifiable, Sendable {
    case control, escape, tab, arrows, shortcuts, paste, keyboard
    case enter, interrupt, backspace, clearLine, up, down, left, right, home, end
    case attachments, workspaces, chat, agents, webServers
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .control: return "Control"
        case .escape: return "Escape"
        case .tab: return "Tab"
        case .arrows: return "Arrow keys"
        case .shortcuts: return "Terminal shortcuts"
        case .paste: return "Paste into terminal"
        case .keyboard: return "Toggle terminal keyboard"
        case .enter: return "Enter"
        case .interrupt: return "Interrupt (Ctrl-C)"
        case .backspace: return "Backspace"
        case .clearLine: return "Clear line"
        case .up: return "Up"
        case .down: return "Down"
        case .left: return "Left"
        case .right: return "Right"
        case .home: return "Line start"
        case .end: return "Line end"
        case .attachments: return "Attach image"
        case .workspaces: return "Workspaces & panes"
        case .chat: return "Chat"
        case .agents: return "Agents"
        case .webServers: return "Web servers"
        }
    }
    public var keyLabel: String? {
        switch self { case .control: return "Ctrl"; case .escape: return "Esc"; case .tab: return "Tab"; case .interrupt: return "^C"; default: return nil }
    }
    public var symbol: String {
        switch self {
        case .control: return "control"
        case .escape: return "escape"
        case .tab: return "arrow.right.to.line"
        case .arrows: return "dpad"
        case .shortcuts: return "command"
        case .paste: return "document.on.clipboard"
        case .keyboard: return "keyboard"
        case .enter: return "return"
        case .interrupt: return "stop"
        case .backspace: return "delete.left"
        case .clearLine: return "eraser"
        case .up: return "chevron.up"
        case .down: return "chevron.down"
        case .left: return "chevron.left"
        case .right: return "chevron.right"
        case .home: return "arrow.left.to.line"
        case .end: return "arrow.right.to.line"
        case .attachments: return "paperclip"
        case .workspaces: return "rectangle.split.3x1"
        case .chat: return "bubble.left"
        case .agents: return "person.2"
        case .webServers: return "globe"
        }
    }
    public var sequence: String? {
        switch self {
        case .escape: return "\u{1B}"
        case .tab: return "\t"
        case .enter: return "\r"
        case .interrupt: return "\u{03}"
        case .backspace: return "\u{7F}"
        case .clearLine: return "\u{05}\u{15}"
        case .up: return "\u{1B}[A"
        case .down: return "\u{1B}[B"
        case .left: return "\u{1B}[D"
        case .right: return "\u{1B}[C"
        case .home: return "\u{01}"
        case .end: return "\u{05}"
        default: return nil
        }
    }
}

public struct TerminalToolbarPreferences: Codable, Equatable, Sendable {
    public static let storageKey = "terminal.toolbar.v1"
    /// Nine since Chat joined: every earlier default kept its place.
    public static let maximumItems = 9
    public static let defaults = Self(items: [.control, .escape, .tab, .arrows, .shortcuts, .paste, .chat, .agents, .keyboard])
    /// 1: the original layout. 2: has been offered the Agents control. 3: has
    /// been offered the Chat control. A layout without an offered control is
    /// a choice and stays that way.
    public let version: Int
    public var items: [TerminalToolbarItem]
    public init(items: [TerminalToolbarItem]) { version = 3; self.items = items }
    private var valid: Bool {
        (1...3).contains(version) && items.count <= Self.maximumItems && items.contains(.keyboard) && Set(items).count == items.count
    }
    /// A layout saved before a control existed gains it once, where the
    /// defaults keep it — Agents second to last, Chat just before Agents —
    /// when there is room for it.
    private var migrated: Self {
        guard version < 3 else { return self }
        var items = items
        if version < 2, !items.contains(.agents), items.count < Self.maximumItems {
            items.insert(.agents, at: max(0, items.count - 1))
        }
        if !items.contains(.chat), items.count < Self.maximumItems {
            items.insert(.chat, at: items.firstIndex(of: .agents) ?? max(0, items.count - 1))
        }
        return Self(items: items)
    }
    private static let memo = DecodeMemo<Self>()
    public static func read(_ data: Data) throws -> Self {
        try memo.value(for: data, decode: decode)
    }
    private static func decode(_ data: Data) throws -> Self {
        if data.isEmpty { return defaults }
        guard data.count <= 8_192 else { throw PhrenKitError.validation("Saved terminal controls could not be read.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.valid else { throw PhrenKitError.validation("Saved terminal controls could not be read.") }
        return value.migrated
    }
    public func encoded() throws -> Data {
        guard valid else { throw PhrenKitError.validation("Choose up to nine different controls, including Keyboard.") }
        return try JSONEncoder().encode(self)
    }
}
