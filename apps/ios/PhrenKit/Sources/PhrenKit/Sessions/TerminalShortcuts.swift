import Foundation

public enum TerminalShortcutPanelID: String, Codable, CaseIterable, Identifiable, Sendable {
    case favorites, uploads, codex, claude, copilot, herdr, keys, ctrl, tmux
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .favorites: return "Favorites"
        case .uploads: return "Uploads"
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .copilot: return "Copilot"
        case .herdr: return "Herdr"
        case .keys: return "Keys"
        case .ctrl: return "Ctrl"
        case .tmux: return "Tmux"
        }
    }
    public var symbol: String {
        switch self {
        case .favorites: return "star"
        case .uploads: return "square.and.arrow.up"
        case .codex, .claude, .copilot: return "sparkles"
        case .herdr, .tmux: return "rectangle.split.3x1"
        case .keys: return "keyboard"
        case .ctrl: return "control"
        }
    }
}

public struct TerminalShortcut: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, CaseIterable, Sendable { case key, text, binding, action }
    public static let symbols = ["", "keyboard", "return", "escape", "arrow.right.to.line", "control", "option", "shift",
                                 "star", "bolt", "terminal", "command", "sparkles", "arrow.up", "arrow.down", "arrow.left", "arrow.right",
                                 "delete.left", "eraser", "doc", "photo.on.rectangle", "camera", "globe", "rectangle.split.3x1"]
    public static let namedKeys = ["Esc", "Tab", "Enter", "BSpace", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown"]
    public static let actions = ["photos", "camera", "files", "workspaces", "webServers"]
    public var id: String
    public var label: String
    public var hint: String
    public var symbol: String
    public var kind: Kind
    public var value: String
    /// Control = 1, Option = 2, Shift = 4.
    public var modifiers: Int
    public var appendEnter: Bool
    public var enabled: Bool
    public init(id: String = UUID().uuidString, label: String = "", hint: String = "", symbol: String = "",
                kind: Kind = .key, value: String = "", modifiers: Int = 0, appendEnter: Bool = false, enabled: Bool = true) {
        self.id = id; self.label = label; self.hint = hint; self.symbol = symbol; self.kind = kind; self.value = value
        self.modifiers = modifiers; self.appendEnter = appendEnter; self.enabled = enabled
    }
    public var bindingLabel: String {
        if kind == .action { return label.isEmpty ? value : label }
        let prefix = (modifiers & 1 != 0 ? "Ctrl+" : "") + (modifiers & 2 != 0 ? "Opt+" : "") + (modifiers & 4 != 0 ? "Shift+" : "")
        return (kind == .binding ? value : prefix + value) + (appendEnter ? " ↵" : "")
    }
    public var displayLabel: String { label.isEmpty ? bindingLabel : label }
    public func steps() throws -> [String] {
        guard (0...7).contains(modifiers), value.utf8.count <= 4096 else { throw Self.invalid("This shortcut is too large or has invalid modifiers.") }
        var result: [String]
        switch kind {
        case .action:
            guard Self.actions.contains(value), modifiers == 0, !appendEnter else { throw Self.invalid("Choose an available app action without key modifiers.") }
            return []
        case .key: result = [try TerminalKeyBinding.key(value, modifiers: modifiers)]
        case .text:
            guard !value.isEmpty, !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                throw Self.invalid("Enter a single line of text. Use Send Enter to submit it.")
            }
            result = try TerminalKeyBinding.custom(value, modifiers: modifiers)
        case .binding:
            guard modifiers == 0 else { throw Self.invalid("Write modifiers inside the advanced binding.") }
            result = try TerminalKeyBinding.parse(value)
        }
        if appendEnter { result.append("\r") }
        return result
    }
    public func validate() throws {
        guard !id.isEmpty, id.utf8.count <= 200, label.utf8.count <= 100, hint.utf8.count <= 200,
              !label.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              !hint.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains), Self.symbols.contains(symbol) else {
            throw Self.invalid("Choose a shorter label and a supported icon.")
        }
        _ = try steps()
    }
    static func invalid(_ message: String) -> PhrenKitError { .validation(message) }
}

public enum TerminalKeyBinding {
    /// Simple custom keys: Ctrl+b1 sends Ctrl+B then 1. Commas apply the
    /// modifiers to another key; doubled commas represent a literal comma.
    public static func custom(_ text: String, modifiers: Int) throws -> [String] {
        guard modifiers != 0 else { return [text] }
        var parts = [""], index = text.startIndex
        while index < text.endIndex {
            let char = text[index]; index = text.index(after: index)
            if char == "," {
                if index < text.endIndex, text[index] == "," { parts[parts.count - 1].append(","); index = text.index(after: index) }
                else { parts.append("") }
            } else { parts[parts.count - 1].append(char) }
        }
        guard parts.count <= 32 else { throw TerminalShortcut.invalid("Use at most 32 keystrokes.") }
        return try parts.map { part in
            guard let first = part.first else { throw TerminalShortcut.invalid("Choose a key after each comma.") }
            return [try key(String(first), modifiers: modifiers), String(part.dropFirst())].filter { !$0.isEmpty }
        }.flatMap { $0 }
    }
    public static func parse(_ text: String) throws -> [String] {
        guard !text.isEmpty, text.utf8.count <= 4096 else { throw TerminalShortcut.invalid("Enter a key binding.") }
        if text.hasPrefix("text:") {
            return try TerminalShortcut(kind: .text, value: String(text.dropFirst(5))).steps()
        }
        let tokens = text.split(whereSeparator: { $0 == "," || $0.isWhitespace })
        guard !tokens.isEmpty, tokens.count <= 32 else { throw TerminalShortcut.invalid("Use between 1 and 32 keystrokes.") }
        return try tokens.map { token in
            let parts = token.replacingOccurrences(of: "+", with: "-").split(separator: "-", omittingEmptySubsequences: false)
            var modifiers = 0
            for part in parts.dropLast() {
                let bit: Int
                switch part.lowercased() {
                case "c", "ctrl", "control": bit = 1
                case "m", "opt", "alt", "option": bit = 2
                case "s", "shift": bit = 4
                default: throw TerminalShortcut.invalid("Unknown modifier: \(part). Use Ctrl, Opt, or Shift.")
                }
                guard modifiers & bit == 0 else { throw TerminalShortcut.invalid("A modifier appears twice.") }
                modifiers |= bit
            }
            return try key(String(parts.last ?? ""), modifiers: modifiers)
        }
    }
    public static func key(_ name: String, modifiers: Int = 0) throws -> String {
        guard (0...7).contains(modifiers) else { throw TerminalShortcut.invalid("Invalid modifiers.") }
        let lowered = name.lowercased(), escape = "\u{1B}"
        let parameter = 1 + (modifiers & 4 != 0 ? 1 : 0) + (modifiers & 2 != 0 ? 2 : 0) + (modifiers & 1 != 0 ? 4 : 0)
        let finals = ["up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"]
        if let final = finals[lowered] { return escape + (modifiers == 0 ? "[" : "[1;\(parameter)") + final }
        let numbered = ["pageup": 5, "pgup": 5, "pagedown": 6, "pgdn": 6, "delete": 3,
                        "f5": 15, "f6": 17, "f7": 18, "f8": 19, "f9": 20, "f10": 21, "f11": 23, "f12": 24]
        if let number = numbered[lowered] { return escape + "[\(number)" + (modifiers == 0 ? "" : ";\(parameter)") + "~" }
        if let final = ["f1": "P", "f2": "Q", "f3": "R", "f4": "S"][lowered] {
            return escape + (modifiers == 0 ? "O" : "[1;\(parameter)") + final
        }
        if lowered == "tab", modifiers & 4 != 0, modifiers & 1 == 0 {
            return (modifiers & 2 != 0 ? escape : "") + escape + "[Z"
        }
        // Modified Enter must never collapse into an ordinary submission. Use
        // CSI-u for special-key combinations without a distinct legacy code.
        let specialCodes = ["esc": 27, "escape": 27, "tab": 9, "enter": 13, "return": 13, "bspace": 127, "backspace": 127]
        if let code = specialCodes[lowered], modifiers & (1 | 4) != 0 {
            return escape + "[\(code);\(parameter)u"
        }
        var value: String
        switch lowered {
        case "esc", "escape": value = escape
        case "tab": value = "\t"
        case "enter", "return": value = "\r"
        case "bspace", "backspace": value = "\u{7F}"
        case "space": value = " "
        case "dash": value = "-"
        case "plus": value = "+"
        case "comma": value = ","
        default:
            guard name.count == 1, !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                throw TerminalShortcut.invalid("Unknown key: \(name). Use a letter, a named key, or F1–F12.")
            }
            value = name
        }
        if modifiers & 4 != 0 {
            let shifted = Dictionary(uniqueKeysWithValues: zip(Array("`1234567890-=[]\\;'/.,"), Array("~!@#$%^&*()_+{}|:\"?><")).map { (String($0), String($1)) })
            value = shifted[value] ?? value.uppercased()
        }
        if modifiers & 1 != 0 {
            guard value.unicodeScalars.count == 1, let scalar = value.uppercased().unicodeScalars.first else {
                throw TerminalShortcut.invalid("Control needs an ASCII key.")
            }
            let code: UInt32
            if (64...95).contains(scalar.value) { code = scalar.value & 31 }
            else if [32, 50].contains(scalar.value) { code = 0 }
            else if [45, 54].contains(scalar.value) { code = scalar.value == 45 ? 31 : 30 }
            else if scalar.value == 63 || scalar.value == 127 { code = 127 }
            else { throw TerminalShortcut.invalid("This key has no Control sequence.") }
            value = String(UnicodeScalar(code)!)
        }
        return (modifiers & 2 != 0 ? escape : "") + value
    }
}

public struct TerminalShortcutPanel: Codable, Equatable, Sendable, Identifiable {
    public let id: TerminalShortcutPanelID
    public var enabled: Bool
    public var shortcuts: [TerminalShortcut]
    public var active: [TerminalShortcut] { shortcuts.filter(\.enabled) }
    public init(id: TerminalShortcutPanelID, enabled: Bool = true, shortcuts: [TerminalShortcut]) {
        self.id = id; self.enabled = enabled; self.shortcuts = shortcuts
    }
}

public struct TerminalShortcutPreferences: Codable, Equatable, Sendable {
    public static let storageKey = "terminal.shortcut-panels.v1"
    public let version: Int
    public var panels: [TerminalShortcutPanel]
    public var visiblePanels: [TerminalShortcutPanel] { panels.filter(\.enabled) }
    public init(panels: [TerminalShortcutPanel]) { version = 1; self.panels = panels }
    public static func defaults(favorites: String = "codex:/model,claude:/compact,copilot:/help") -> Self {
        let providers: [TerminalShortcutPanel] = [.codex, .claude, .copilot].map { id in
            TerminalShortcutPanel(id: id, shortcuts: AgentSlashCommand.menu(source: id.rawValue).map {
                TerminalShortcut(id: id.rawValue + ":" + $0.name, label: $0.name, hint: $0.detail, kind: .text, value: $0.name + " ")
            })
        }
        let all = providers.flatMap(\.shortcuts)
        let saved = favorites.split(separator: ",").map(String.init)
        var seen = Set<String>()
        let favoriteShortcuts = saved.filter { seen.insert($0).inserted }.compactMap { id -> TerminalShortcut? in
            guard var shortcut = all.first(where: { $0.id == id }) else { return nil }
            shortcut.id = "favorite:" + shortcut.id; return shortcut
        }
        func binding(_ label: String, _ value: String) -> TerminalShortcut {
            TerminalShortcut(id: "key:" + label, label: label, symbol: "keyboard", kind: .binding, value: value)
        }
        let uploads = ["photos", "camera", "files"].map { value in
            TerminalShortcut(id: "upload:" + value, label: value.capitalized,
                             symbol: value == "photos" ? "photo.on.rectangle" : value == "camera" ? "camera" : "doc", kind: .action, value: value)
        }
        return Self(panels: [TerminalShortcutPanel(id: .favorites, shortcuts: favoriteShortcuts),
                            TerminalShortcutPanel(id: .uploads, shortcuts: uploads)] + providers + [
            TerminalShortcutPanel(id: .herdr, shortcuts: [
                TerminalShortcut(id: "herdr:workspaces", label: "Workspaces & panes", hint: "Switch tabs, focus panes, and manage workspaces", symbol: "rectangle.split.3x1", kind: .action, value: "workspaces"),
                TerminalShortcut(id: "herdr:webServers", label: "Web servers", hint: "Open a running app in the browser", symbol: "globe", kind: .action, value: "webServers")]),
            TerminalShortcutPanel(id: .keys, shortcuts: [binding("Clear line", "Ctrl+e, Ctrl+u"), binding("Backspace", "BSpace"), binding("Enter", "Enter"), binding("⇧ Tab", "Shift+Tab"), binding("Home", "Ctrl+a"), binding("End", "Ctrl+e")]),
            TerminalShortcutPanel(id: .ctrl, enabled: false, shortcuts: ["c", "d", "z", "l", "a", "e", "r", "u"].map { binding("Ctrl+" + $0.uppercased(), "Ctrl+" + $0) }),
            TerminalShortcutPanel(id: .tmux, enabled: false, shortcuts: [binding("New window", "Ctrl+b, c"), binding("Next window", "Ctrl+b, n"), binding("Previous window", "Ctrl+b, p"), binding("Choose window", "Ctrl+b, w"), binding("Split vertically", "Ctrl+b, %"), binding("Split horizontally", "Ctrl+b, \""), binding("Zoom pane", "Ctrl+b, z"), binding("Detach", "Ctrl+b, d")])
        ])
    }
    public static func read(_ data: Data, favorites: String = "codex:/model,claude:/compact,copilot:/help") throws -> Self {
        if data.isEmpty { return defaults(favorites: favorites) }
        guard data.count <= 524_288 else { throw TerminalShortcut.invalid("Saved shortcuts are too large.") }
        let value = try JSONDecoder().decode(Self.self, from: data); try value.validate(); return value
    }
    public func encoded() throws -> Data {
        try validate()
        let data = try JSONEncoder().encode(self)
        guard data.count <= 524_288 else { throw TerminalShortcut.invalid("Saved shortcuts are too large.") }
        return data
    }
    public func validate() throws {
        guard version == 1, Set(panels.map(\.id)) == Set(TerminalShortcutPanelID.allCases),
              panels.count == TerminalShortcutPanelID.allCases.count, !visiblePanels.isEmpty else {
            throw TerminalShortcut.invalid("Keep at least one shortcut panel enabled.")
        }
        for panel in panels {
            guard panel.shortcuts.count <= 64, Set(panel.shortcuts.map(\.id)).count == panel.shortcuts.count else {
                throw TerminalShortcut.invalid("Use up to 64 different shortcuts in each panel.")
            }
            for shortcut in panel.shortcuts { try shortcut.validate() }
        }
    }
    public func selectedPanel(preferred: String, source: String) -> TerminalShortcutPanel {
        visiblePanels.first { $0.id.rawValue == preferred } ?? visiblePanels.first { $0.id.rawValue == source }
            ?? visiblePanels.first { $0.id == .keys } ?? visiblePanels[0]
    }
}
