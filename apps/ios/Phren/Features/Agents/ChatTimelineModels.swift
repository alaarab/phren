import PhrenKit
import Foundation


struct ChatTimelineEntry: Identifiable, Equatable {
    enum Kind: Equatable { case message, activity, readRun }
    var messages: [AgentChatMessage]
    var kind: Kind = .message
    var phren: PhrenToolPresentation? = nil
    /// A card of its own for the agent's bookkeeping calls; nil for the pill.
    var card: ToolCardKind? = nil
    /// A whole-list card (todos) that a later call replaced: shown folded
    /// to one line. Settled once in the grouping pass, never per row.
    var cardSuperseded = false
    /// A folded patch in this row is large enough to need the bounded
    /// accessibility path. Settled in preparation, never in a row's body.
    var hasLargeCollapsedChange = false
    /// The folded run's title, preview and inner groups: built once in
    /// preparation (cached by message id and content revision), so drawing a
    /// read-run row never re-groups or re-reads its presentations.
    var readRun: ChatReadRunPresentation? = nil
    /// The identifier and label a row keeps when it is far enough off screen
    /// to draw as a fixed-height placeholder. Empty stays fully drawn.
    var placeholderIdentifier = ""
    var placeholderLabel = ""
    var turnActivity: ChatTurnActivity? = nil
    /// The files a finished turn changed, drawn as one row at its end.
    var turnChanges: ChatTurnChanges? = nil
    /// A sent message the transcript has not echoed yet.
    var pendingEcho: ChatPendingEcho? = nil
    var id: String {
        turnActivity.map { "activity:\($0.ownerID)" } ?? turnChanges.map { "changes:\($0.ownerID)" }
            ?? pendingEcho.map { "pending:\($0.id)" } ?? messages[0].id
    }
    var isActivity: Bool { kind != .message }
    var isReadRun: Bool { kind == .readRun }

    /// A folded change whose diff summary is too big to expose row by row.
    static func largeCollapsedChange(_ messages: [AgentChatMessage]) -> Bool {
        messages.contains { message in
            message.isChange
                && DiffDocumentSummaryCache.value(for: message.text, key: message.renderKey).rowCount > 120
        }
    }

    static func group(_ messages: [AgentChatMessage], foldingReads: Bool = true) -> [Self] {
        var entries: [Self] = []
        var previousMessageID: String?
        var calls: [String: Int] = [:], ambiguous: Set<String> = []
        // A background agent's completion, by the call it answers.
        var notifications: [String: String] = [:]
        // Claude Code's AskUserQuestion is drawn as the question card itself;
        // its transcript call and result rows would only repeat the JSON.
        var askedQuestions = Set<String>()
        for message in messages where message.role == .tool && !message.isToolResult && message.title == "AskUserQuestion" {
            if let id = message.toolCallID { askedQuestions.insert(id) }
        }
        for message in messages {
            // Completion metadata feeds the pinned Background panel. It is
            // transport state, not another conversation card.
            if message.role == .tool, message.title == "Background notification" {
                if let id = ChatBackgroundJobs.notificationCallID(message.text) { notifications[id] = message.text }
                continue
            }
            if message.role == .tool, !message.isToolResult, message.title == "AskUserQuestion" { continue }
            if message.role == .tool, message.isToolResult, let id = message.toolCallID, askedQuestions.contains(id) { continue }
            guard message.role == .tool else {
                entries.append(.init(messages: [message], kind: .message))
                // Phren's result may follow an assistant progress line. Keep
                // only its unanswered calls; ordinary tool grouping retains
                // the existing conversation barriers.
                calls = calls.filter { _, index in
                    let title = entries[index].messages.first?.title
                    return (PhrenToolPresentation.recognizes(title) || ToolCardKind.recognizes(title))
                        && !entries[index].messages.contains(where: \.isToolResult)
                }
                ambiguous.formIntersection(calls.keys)
                previousMessageID = message.id
                continue
            }
            // A result — or what the call changed on disk — joins its call.
            if message.isToolResult || message.isChange {
                if let key = message.toolCallID, !key.isEmpty, !ambiguous.contains(key), let index = calls[key] {
                    entries[index].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
                // Older transcripts lack IDs. Only pair an immediately adjacent,
                // unidentified call/result; never guess among parallel calls.
                if message.toolCallID == nil, let previous = entries.last,
                   previous.messages.count == 1, let call = previous.messages.first,
                   call.role == .tool, !call.isToolResult, call.toolCallID == nil,
                   call.id == previousMessageID {
                    entries[entries.count - 1].messages.append(message)
                    previousMessageID = message.id
                    continue
                }
            } else if let key = message.toolCallID, !key.isEmpty {
                if calls[key] != nil { ambiguous.insert(key) }
                else { calls[key] = entries.count }
            }
            entries.append(.init(messages: [message], kind: .activity))
            previousMessageID = message.id
        }
        for index in entries.indices {
            guard let call = entries[index].messages.first, call.role == .tool, !call.isToolResult else { continue }
            let result = entries[index].messages.first(where: \.isToolResult)
            if AgentToolClassification.kind(name: call.title, input: call.text) == .phren {
                entries[index].phren = PhrenToolPresentation(name: call.title ?? "", input: call.text, result: result?.text, isError: result?.isToolError == true)
            } else if ToolCardKind.recognizes(call.title) {
                entries[index].card = ToolCardKind(call: call, result: result, notification: call.toolCallID.flatMap { notifications[$0] })
            }
        }
        // Which todo lists a later call replaced — once, for the whole timeline.
        let lists = entries.map { entry -> AgentTodoPresentation? in
            if case .todos(let list) = entry.card { return list } else { return nil }
        }
        for (index, superseded) in AgentTodoPresentation.superseded(lists).enumerated() where superseded {
            entries[index].cardSuperseded = true
        }
        return foldingReads ? foldSameToolRuns(foldReadRuns(entries)) : entries
    }

    /// Two or more calls in a row of the same tool with the same kind of
    /// input ("Shell ×2") become one pill that opens to each call. Calls
    /// that changed files, carry pictures, went to the background or have a
    /// card of their own keep their own row.
    private static func foldSameToolRuns(_ entries: [Self]) -> [Self] {
        var result: [Self] = [], run: [Self] = [], runTool: String?
        func flush() {
            if run.count >= 2 { result.append(.init(messages: run.flatMap(\.messages), kind: .readRun)) }
            else { result.append(contentsOf: run) }
            run.removeAll(keepingCapacity: true); runTool = nil
        }
        for entry in entries {
            guard let tool = sameToolKey(entry) else { flush(); result.append(entry); continue }
            if tool != runTool { flush(); runTool = tool }
            run.append(entry)
        }
        flush()
        return result
    }

    private static func sameToolKey(_ entry: Self) -> String? {
        guard entry.kind == .activity, entry.phren == nil, entry.card == nil,
              !entry.messages.contains(where: { $0.isChange || !$0.resultImages.isEmpty }),
              let call = entry.messages.first(where: { $0.role == .tool && !$0.isToolResult }),
              !ChatBackgroundJobs.isBackground(call) else { return nil }
        let presentation = ToolPresentationCache.value(call)
        guard presentation.patch == nil, !presentation.editsFiles else { return nil }
        return presentation.title
    }

    /// Three or more calls in a row that only looked around become one row.
    /// Anything that changed a file, failed, or is still out there interrupts
    /// the run and keeps its own card.
    private static func foldReadRuns(_ entries: [Self]) -> [Self] {
        var result: [Self] = [], run: [Self] = []
        func flush() {
            if run.count >= 3 {
                result.append(.init(messages: run.flatMap(\.messages), kind: .readRun))
            } else { result.append(contentsOf: run) }
            run.removeAll(keepingCapacity: true)
        }
        for entry in entries {
            if entry.kind == .activity, ReadOnlyToolCall.looksAround(entry.messages) { run.append(entry) }
            else { flush(); result.append(entry) }
        }
        flush()
        return result
    }
}

/// A folded read run as its row draws it: the inner call/result cards and the
/// summary line. Built once in `ChatTranscriptPreparation`, keyed by the run's
/// first and last content revision, so no row's body re-groups or re-reads
/// presentations while scrolling.
struct ChatReadRunPresentation: Equatable {
    let groups: [ChatTimelineEntry]
    let title: String
    let preview: String
    /// Every call is the same tool ("Shell ×2"): its name, else nil.
    let sameTool: String?
    let status: ToolCardStatus
    let spokenLabel: String

    init(_ messages: [AgentChatMessage]) {
        // The outer grouping has already established the run. Re-grouping
        // restores the exact call/result cards shown before it was folded.
        var groups = ChatTimelineEntry.group(messages, foldingReads: false)
        for index in groups.indices {
            groups[index].hasLargeCollapsedChange = ChatTimelineEntry.largeCollapsedChange(groups[index].messages)
        }
        self.groups = groups
        let calls = groups.compactMap { $0.messages.first(where: { !$0.isToolResult && !$0.isChange }) }
        // What the agent did, in the order it did it: "Shell ×4 · Read ×2".
        var counts: [(name: String, count: Int)] = []
        for name in calls.map({ ToolPresentationCache.value($0).title }) {
            if let index = counts.firstIndex(where: { $0.name == name }) { counts[index].count += 1 }
            else { counts.append((name, 1)) }
        }
        title = counts.prefix(3).map { $0.count > 1 ? "\($0.name) ×\($0.count)" : $0.name }.joined(separator: " · ")
            + (counts.count > 3 ? " …" : "")
        // The last command, so the row still says where the agent got to.
        preview = calls.last.map { ToolPresentationCache.value($0).preview } ?? ""
        sameTool = counts.count == 1 ? counts[0].name : nil
        status = ChatToolSummary.status(messages)
        let operations = groups.count == 1 ? "operation" : "operations"
        // A run of one tool reads as that tool's calls; a mixed run as reads.
        spokenLabel = "\(title), \(groups.count) \(sameTool == nil || sameTool == "Read" ? "read " : "")\(operations)"
            + (status == .failed ? ", Failed" : "")
    }
}

/// Conservative classification: a call that was only looking around — it came
/// back, changed nothing on disk and did not fail. A call carrying a
/// filesystem-change attachment can never be folded, and neither can one that
/// is still running, failed, or went to the background — or one whose result
/// carries pictures, which show under its own card.
enum ReadOnlyToolCall {
    static func looksAround(_ messages: [AgentChatMessage]) -> Bool {
        guard !messages.contains(where: \.isChange), let result = messages.first(where: \.isToolResult),
              !failed(result), result.resultImages.isEmpty,
              let call = messages.first(where: { $0.role == .tool && !$0.isToolResult }) else { return false }
        guard !PhrenToolPresentation.recognizes(call.title), !ToolCardKind.interruptsRun(call.title), !ChatBackgroundJobs.isBackground(call) else { return false }
        // A web fetch or search is looking around too: three in a row fold.
        if WebToolPresentation.recognizes(call.title) { return true }
        let presentation = ToolPresentationCache.value(call)
        switch presentation.title {
        case "Read", "Browse", "List": return true
        // Codex's orchestration calls are looking around too: they carry an
        // opaque agent id or a timeout, and three in a row fold into one row.
        case "Wait Agent", "List Agents", "Send Message": return true
        // Phren Hook attaches what a call wrote, so a result carrying no
        // change is the agent finding something out — a build, a test run, a
        // grep — however long the command. Commands that read as writes keep
        // their own card for the folders the Hook does not cover; a command
        // that is plainly a read survives that heuristic's false positives.
        case "Shell", "Tools": return shell(presentation.body) || (presentation.patch == nil && !presentation.editsFiles)
        default:
            let raw = (call.title ?? "").split(separator: ".").last.map(String.init)?.lowercased() ?? ""
            return ["read", "glob", "grep", "ls"].contains(raw)
        }
    }

    /// A result that reports failure: the provider's own error flag, or the
    /// non-zero exit the presentation appends to a command's output.
    static func failed(_ result: AgentChatMessage) -> Bool {
        if result.isToolError { return true }
        let body = ToolPresentationCache.value(result).body
        return String(body.suffix(40)).range(of: #"(?:^|\n)Exit code: -?\d+\s*$"#, options: .regularExpression) != nil
    }

    static func shell(_ command: String) -> Bool {
        let source = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !source.isEmpty, !source.contains("\n"),
              source.range(of: #"(?:;|`|\$\(|>>?|<<|\b(?:rm|mv|cp|tee|touch|mkdir|ln|chmod|chown|install|xargs)\b|\bfind\b[^|]*(?:-delete|-exec)|\bgit\s+(?:commit|push|checkout|switch|restore|reset|clean|merge|rebase|pull|fetch|add|rm|mv|stash|apply)\b)"#,
                           options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        let segments = source.components(separatedBy: "|").flatMap { $0.components(separatedBy: "&&") }
        return !segments.isEmpty && segments.allSatisfy { segment in
            let words = segment.trimmingCharacters(in: .whitespaces).split(whereSeparator: \.isWhitespace).map(String.init)
            guard let first = words.first?.lowercased() else { return false }
            if first == "git" { return words.count > 1 && ["diff", "log", "status", "show"].contains(words[1].lowercased()) }
            if first == "sed" { return words.dropFirst().contains { $0 == "-n" || ($0.hasPrefix("-") && $0.contains("n") && !$0.contains("i")) } }
            return ["cat", "head", "tail", "grep", "rg", "ls", "find", "wc", "echo", "pwd", "which", "type"].contains(first)
        }
    }
}

/// The agent's own bookkeeping calls, each with a card of its own instead of
/// the generic pill. One case per card family; `ChatToolCard` draws them.
/// To add a card: a PhrenKit presentation, a case here (recognized, built
/// in `init`), and a view in the `ChatToolCard` switch.
enum ToolCardKind: Equatable {
    /// A subagent: Claude Code's Task/Agent, Codex's spawn_agent.
    case agent(AgentSubagentPresentation)
    /// A checklist: TodoWrite, TaskCreate/TaskUpdate/TaskList, update_plan.
    case todos(AgentTodoPresentation)
    /// ExitPlanMode: the plan, awaiting review or answered.
    case plan(AgentPlanPresentation)
    /// EnterPlanMode: a one-line mode change.
    case planMode
    /// WebFetch / WebSearch: where the agent went, the result as Markdown.
    case web(WebToolPresentation)
    /// Claude Code's Skill tool: an inline chip, what it loaded behind a tap.
    case skill(SkillCallPresentation)
    /// `mcp__<server>__<tool>` for any server but phren.
    case mcp(MCPToolPresentation)

    static func recognizes(_ name: String?) -> Bool {
        AgentSubagentPresentation.recognizes(name) || AgentTodoPresentation.recognizes(name)
            || AgentPlanPresentation.recognizes(name) || AgentPlanPresentation.isPlanMode(name)
            || WebToolPresentation.recognizes(name) || SkillCallPresentation.recognizes(name) || MCPToolPresentation.recognizes(name)
    }

    /// A card that is a visible event — a skill, an MCP call, an agent —
    /// ends a read run. A fetch or search is still the agent looking
    /// around: it folds with reads when three are in a row, and keeps its
    /// card inside the expanded run.
    static func interruptsRun(_ name: String?) -> Bool {
        recognizes(name) && !WebToolPresentation.recognizes(name)
    }

    /// `notification`: a background agent's `<task-notification>`, when one
    /// has arrived for this call.
    init?(call: AgentChatMessage, result: AgentChatMessage?, notification: String? = nil) {
        let name = call.title ?? "", failed = result?.isToolError == true
        if let agent = AgentSubagentPresentation(name: name, input: call.text, result: result?.text, isError: failed, notification: notification) {
            self = .agent(agent)
        } else if let todos = AgentTodoPresentation(name: name, input: call.text, result: result?.text) {
            self = .todos(todos)
        } else if let plan = AgentPlanPresentation(name: name, input: call.text, result: result?.text, isError: failed) {
            self = .plan(plan)
        } else if AgentPlanPresentation.isPlanMode(name) {
            self = .planMode
        } else if let web = WebToolPresentation(name: name, input: call.text, result: result?.text, isError: failed) {
            self = .web(web)
        } else if let skill = SkillCallPresentation(name: name, input: call.text, result: result?.text, isError: failed) {
            self = .skill(skill)
        } else if let mcp = MCPToolPresentation(name: name, input: call.text, result: result?.text, isError: failed) {
            self = .mcp(mcp)
        } else { return nil }
    }

    /// The markdown a card renders, cut to what the row shows — the agent's
    /// report, the plan — so the preparation pass can parse it ahead of the
    /// row under `ChatTimelineEntry.cardMarkdownKey`. The full text opens in
    /// the reader.
    var markdownPreview: ToolOutputPreview? {
        switch self {
        case .agent(let agent): return agent.report.isEmpty ? nil : ToolOutputPreview(agent.report, lines: 8, characters: 1_000)
        case .plan(let plan): return plan.plan.isEmpty ? nil : ToolOutputPreview(plan.plan, lines: 14, characters: 2_000)
        case .web(let web): return web.resultMarkdown.map { ToolOutputPreview($0, lines: WebToolPresentation.previewLines, characters: 4_000) }
        default: return nil
        }
    }

    /// The short label the card keeps when its row is far enough off screen to
    /// draw as a placeholder.
    func offScreenLabel(callID: String) -> String {
        switch self {
        case .agent(let agent): return "\(agent.name), \(agent.description), \(agent.state.rawValue)"
        case .todos(let list): return "\(list.title), \(list.summary)"
        case .plan: return "Plan ready for review"
        case .planMode: return "Entered plan mode"
        case .web(let web): return "\(web.title), \(web.location)"
        case .skill(let skill): return "Skill \(skill.command)" + (skill.args.map { ", \($0)" } ?? "")
        case .mcp(let mcp): return "\(mcp.server) · \(mcp.verb)"
        }
    }
}

struct ChatBackgroundJob: Identifiable, Equatable {
    enum State: Equatable { case running, finished(exitCode: Int?) }
    let id: String
    let title: String
    let worker: String?
    let command: String
    let output: String
    let state: State
    let startedAt: Date
    let finishedAt: Date?
    /// Equality by what the row shows changing, not by the output text: the
    /// derived compare walked megabytes of Unicode on every SwiftUI update
    /// and iOS killed the app for hanging (watchdog, 2026-09-15 11:33).
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.state == rhs.state && lhs.startedAt == rhs.startedAt && lhs.finishedAt == rhs.finishedAt
            && lhs.title == rhs.title && lhs.worker == rhs.worker
            && lhs.output.utf8.count == rhs.output.utf8.count && lhs.command.utf8.count == rhs.command.utf8.count
    }
}

enum ChatBackgroundJobs {
    /// How long a finished job stays in the row before it leaves.
    static let finishedLinger: TimeInterval = 120

    /// `firstSeen` / `finishedSeen`: when the phone first saw each job, and
    /// first saw it finished — the transcript carries no clock for either.
    static func parse(_ messages: [AgentChatMessage], firstSeen: [String: Date], finishedSeen: [String: Date] = [:], now: Date = .now, includeExpired: Bool = false) -> [ChatBackgroundJob] {
        var results: [String: AgentChatMessage] = [:]
        var notifications: [String: (summary: String, status: String, output: String, at: Date?)] = [:]
        for message in messages where message.role == .tool {
            if message.isToolResult, let id = message.toolCallID { results[id] = message }
            if message.title == "Background notification",
               let id = tag("tool-use-id", in: message.text) {
                notifications[id] = (tag("summary", in: message.text) ?? "Background command finished",
                                     tag("status", in: message.text) ?? "completed",
                                     tag("output", in: message.text) ?? "",
                                     message.timestamp)
            }
        }
        return messages.compactMap { message in
            guard message.role == .tool, !message.isToolResult, !message.isChange, let id = message.toolCallID else { return nil }
            let result = results[id]
            let resultText = result.map { ToolPresentationCache.value($0).body } ?? ""
            // A call flagged for the background, or one the agent moved there
            // after it outran its timeout.
            guard isBackground(message) || resultLooksBackgrounded(resultText) else { return nil }
            let presentation = ToolPresentationCache.value(message)
            let notification = notifications[id]
            let output = notification?.output.isEmpty == false ? notification!.output : resultText
            let worker = BackgroundJobLabel.parse(command: presentation.body)
            let tool = message.title?.split(separator: ".").last.map(String.init)
            let description = tool == "Bash" ? presentation.description : nil
            let summary = worker.map { "Worker: \($0.label)" } ?? description ?? notification?.summary ?? presentation.preview
            let code = exitCode(notification?.summary) ?? exitCode(resultText)
            // The tool result of a background call arrives at once and only
            // says the job started; done means the task notification came,
            // or the result carried real output instead of that notice.
            let status = notification?.status.lowercased() ?? ""
            let finished = ["completed", "failed", "killed", "cancelled", "canceled", "stopped"].contains(status)
                || (result != nil && !resultText.isEmpty && !resultLooksBackgrounded(resultText))
            // The transcript's own clock first; the phone's first sighting
            // only when the source stamps nothing.
            let startedAt = message.timestamp ?? firstSeen[id] ?? now
            let finishedAt = finished ? (notification?.at ?? result?.timestamp ?? finishedSeen[id] ?? now) : nil
            // Finished jobs linger long enough to be read, then leave.
            if !includeExpired, let finishedAt, now.timeIntervalSince(finishedAt) > finishedLinger { return nil }
            return ChatBackgroundJob(id: id, title: summary.isEmpty ? "Background command" : summary,
                                     worker: worker?.provider,
                                     command: presentation.body, output: output,
                                     state: finished ? .finished(exitCode: code) : .running,
                                     startedAt: startedAt, finishedAt: finishedAt)
        }
    }

    /// Ids of jobs that are finished as of these messages, for the caller to
    /// stamp with the time it first saw them so.
    static func finishedIDs(_ messages: [AgentChatMessage], firstSeen: [String: Date]) -> Set<String> {
        Set(parse(messages, firstSeen: firstSeen, finishedSeen: [:], now: .now, includeExpired: true).filter { $0.state != .running }.map(\.id))
    }

    /// Claude Code's own notice, as the whole point of the result — not a
    /// command whose *output* merely mentions one (printing a task log, say).
    private static func resultLooksBackgrounded(_ text: String) -> Bool {
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return first.hasPrefix("command running in background with id")
            || first.range(of: #"^command did not complete within its \d+s timeout and was moved to the background"#, options: .regularExpression) != nil
    }

    static func backgroundIDs(_ messages: [AgentChatMessage]) -> Set<String> {
        Set(parse(messages, firstSeen: [:], finishedSeen: [:], now: .now, includeExpired: true).map(\.id))
    }
    /// Cheap first: a plain substring scan says no for almost every call
    /// before any regex runs. Four regexes over every tool call's text on
    /// each body evaluation hung the main thread for seconds on a big page
    /// (watchdog kills on 2026-09-15). Results are cached per message.
    private static let backgroundFlags = NSCache<NSString, NSNumber>()
    static func isBackground(_ message: AgentChatMessage) -> Bool {
        let key = "\(message.id)|\(message.text.utf8.count)" as NSString
        if let cached = backgroundFlags.object(forKey: key) { return cached.boolValue }
        let value = computeIsBackground(message)
        backgroundFlags.setObject(NSNumber(value: value), forKey: key)
        return value
    }
    private static func computeIsBackground(_ message: AgentChatMessage) -> Bool {
        guard message.text.contains("background") else { return false }
        guard ["shell", "tools"].contains(ToolPresentationCache.value(message).title.lowercased()) else { return false }
        let text = message.text.lowercased()
        return text.range(of: #"[\"']?run_in_background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
            || text.range(of: #"[\"']?background[\"']?\s*[:=]\s*true"#, options: .regularExpression) != nil
    }
    /// The call a `<task-notification>` answers.
    static func notificationCallID(_ text: String) -> String? { tag("tool-use-id", in: text) }
    private static func tag(_ name: String, in text: String) -> String? {
        guard let open = text.range(of: "<\(name)>"), let close = text.range(of: "</\(name)>", range: open.upperBound..<text.endIndex) else { return nil }
        return String(text[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private static func exitCode(_ text: String?) -> Int? {
        guard let text, let match = text.range(of: #"(?i)exit (?:code )?(-?\d+)"#, options: .regularExpression) else { return nil }
        return text[match].split(whereSeparator: { !$0.isNumber && $0 != "-" }).last.flatMap { Int($0) }
    }
}


struct ToolOutputPreview {
    let text: String
    let truncated: Bool
    init(_ output: String, lines maximumLines: Int = 6, characters: Int = 640) {
        let bounded = output.prefix(characters + 1)
        let prefix = String(bounded.prefix(characters))
        let lines = prefix.components(separatedBy: .newlines)
        let visible = lines.prefix(maximumLines).joined(separator: "\n")
        truncated = bounded.count > characters || lines.count > maximumLines
        text = visible + (truncated ? "…" : "")
    }
}

struct ChatToolSummary {
    let title: String
    let icon: String
    let preview: String
    let count: Int
    /// How the calls stand: failed when any failed, running while any has
    /// no result yet, otherwise done.
    let status: ToolCardStatus
    /// The preview names a file (a Read's path): drawn in the path color.
    let previewIsPath: Bool

    init(_ messages: [AgentChatMessage]) {
        // What a call changed on disk is listed under it, not counted as a call.
        let calls = messages.filter { $0.title != "Tool result" && !$0.isChange }
        let presentations = calls.map(ToolPresentationCache.value)
        let names = presentations.map(\.title)
        title = Set(names).count == 1 ? names[0] : calls.isEmpty ? "Tool results" : "Activity"
        icon = Self.icon(title)
        count = max(1, calls.isEmpty ? messages.count : calls.count)
        preview = presentations.last?.preview ?? messages.last.map { ToolPresentationCache.value($0).preview } ?? ""
        status = Self.status(messages)
        previewIsPath = preview.range(of: #"^[~.]?/?[\w.@-]+(?:/[\w.@-]+)+(?::\d+)?$"#, options: .regularExpression) != nil
    }

    static func icon(_ title: String) -> String {
        switch title {
        case "Shell": return "terminal"
        case "Browse": return "globe"
        case "Patch": return "pencil.line"
        case "Write": return "doc.badge.plus"
        case "Read": return "doc.text"
        case "List": return "folder"
        default: return "wrench.and.screwdriver"
        }
    }

    static func status(_ messages: [AgentChatMessage]) -> ToolCardStatus {
        let results = messages.filter(\.isToolResult)
        if results.contains(where: ReadOnlyToolCall.failed) { return .failed }
        let calls = messages.filter { $0.role == .tool && !$0.isToolResult && !$0.isChange }
        let answered = Set(results.compactMap(\.toolCallID))
        let open = calls.contains { call in call.toolCallID.map { !answered.contains($0) } ?? results.isEmpty }
        return open || results.isEmpty ? .running : .done
    }
}
