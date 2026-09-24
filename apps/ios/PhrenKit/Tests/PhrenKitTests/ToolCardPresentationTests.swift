import XCTest
@testable import PhrenKit

final class ToolCardPresentationTests: XCTestCase {
    private func json(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed), as: UTF8.self)
    }

    // MARK: Web fetch / search

    func testFetchShowsHostAndPathAndKeepsPromptAndResultPreview() throws {
        let body = (1...20).map { "Line \($0) of the page." }.joined(separator: "\n")
        let fetch = try XCTUnwrap(WebToolPresentation(name: "WebFetch",
            input: try json(["url": "https://developer.apple.com/documentation/swiftui/scrollview/?language=swift#overview", "prompt": "Summarize nested scrolling"]),
            result: body))
        XCTAssertEqual(fetch.kind, .fetch); XCTAssertEqual(fetch.title, "Fetch")
        XCTAssertEqual(fetch.location, "developer.apple.com/documentation/swiftui/scrollview")
        XCTAssertEqual(fetch.url, "https://developer.apple.com/documentation/swiftui/scrollview/?language=swift#overview")
        XCTAssertEqual(fetch.prompt, "Summarize nested scrolling")
        XCTAssertEqual(fetch.status, .succeeded)
        XCTAssertEqual(fetch.resultMarkdown?.components(separatedBy: "\n").count, WebToolPresentation.previewLines)
        XCTAssertTrue(fetch.resultTruncated)
        XCTAssertEqual(fetch.result, body, "The whole result stays for Read all")
        let running = try XCTUnwrap(WebToolPresentation(name: "functions.WebFetch", input: try json(["url": "https://example.org/a/b/"])))
        XCTAssertEqual(running.status, .running); XCTAssertNil(running.resultMarkdown); XCTAssertNil(running.prompt)
        XCTAssertEqual(running.location, "example.org/a/b")
        XCTAssertEqual(WebToolPresentation(name: "WebFetch", input: try json(["url": "https://example.org"]), result: "Blocked", isError: true)?.status, .failed)
    }

    func testSearchQuotesTheQueryAndTurnsClaudeCodeLinksIntoMarkdownLinks() throws {
        let links = try json([["title": "ScrollView | Apple Developer", "url": "https://developer.apple.com/documentation/swiftui/scrollview"],
                              ["title": "Nested [scrolling]", "url": "https://example.org/nested"], ["url": "https://example.org/untitled"]])
        let result = "Web search results for query: \"SwiftUI nested scrolling\"\n\nLinks: \(links)\n\nSwiftUI's ScrollView hands nested scrolling to the inner view."
        let search = try XCTUnwrap(WebToolPresentation(name: "WebSearch", input: try json(["query": "SwiftUI nested scrolling"]), result: result))
        XCTAssertEqual(search.kind, .search); XCTAssertEqual(search.title, "Search")
        XCTAssertEqual(search.location, "“SwiftUI nested scrolling”"); XCTAssertEqual(search.query, "SwiftUI nested scrolling")
        XCTAssertNil(search.url); XCTAssertNil(search.prompt)
        let markdown = try XCTUnwrap(search.resultMarkdown)
        XCTAssertTrue(markdown.contains("• [ScrollView | Apple Developer](https://developer.apple.com/documentation/swiftui/scrollview)"), markdown)
        XCTAssertTrue(markdown.contains("• [Nested \\[scrolling\\]](https://example.org/nested)"), "Brackets in a title are escaped")
        XCTAssertTrue(markdown.contains("• [https://example.org/untitled](https://example.org/untitled)"), "A link without a title shows its address")
        XCTAssertFalse(markdown.contains("Links: ["), "The raw JSON line is gone")
        XCTAssertFalse(search.resultTruncated)
        XCTAssertEqual(search.result, result, "Read all keeps the raw result")
    }

    func testWebToolRecognitionAndMalformedInput() throws {
        for name in ["WebFetch", "web_fetch", "functions.WebSearch", "web_search"] { XCTAssertTrue(WebToolPresentation.recognizes(name), name) }
        for name in ["Read", "mcp__web__search", "Skill", nil] { XCTAssertFalse(WebToolPresentation.recognizes(name), name ?? "nil") }
        XCTAssertNil(WebToolPresentation(name: "Read", input: "{}"))
        let broken = try XCTUnwrap(WebToolPresentation(name: "WebFetch", input: "not json"))
        XCTAssertEqual(broken.location, "not json"); XCTAssertNil(broken.url)
        // An MCP-shaped result envelope is unwrapped to its text.
        let wrapped = try json(["content": [["type": "text", "text": "# Page\n\nBody"]]])
        XCTAssertEqual(WebToolPresentation(name: "WebFetch", input: try json(["url": "https://x.y/z"]), result: wrapped)?.resultMarkdown, "# Page\n\nBody")
    }

    // MARK: Skill chip

    func testSkillChipReadsTheCommandArgsAndHidesTheBody() throws {
        let skill = try XCTUnwrap(SkillCallPresentation(name: "Skill", input: try json(["skill": "design", "args": "the chat cards\nsecond line"]), result: "Launching skill: design\n\n# Design pass\n…"))
        XCTAssertEqual(skill.command, "/design")
        XCTAssertEqual(skill.args, "the chat cards", "Only the first line, the chip is one line tall")
        XCTAssertEqual(skill.status, .succeeded)
        XCTAssertEqual(skill.result, "Launching skill: design\n\n# Design pass\n…")
        let bare = try XCTUnwrap(SkillCallPresentation(name: "functions.Skill", input: try json(["skill": "/phren-learn"])))
        XCTAssertEqual(bare.command, "/phren-learn"); XCTAssertNil(bare.args); XCTAssertEqual(bare.status, .running)
        let long = try XCTUnwrap(SkillCallPresentation(name: "use_skill", input: try json(["name": "video", "arguments": String(repeating: "x", count: 300)])))
        XCTAssertEqual(long.args?.count, 121); XCTAssertTrue(long.args?.hasSuffix("…") == true)
        XCTAssertEqual(SkillCallPresentation(name: "Skill", input: try json(["skill": "design"]), result: "No such skill", isError: true)?.status, .failed)
    }

    func testSkillChipNeverInventsACommand() throws {
        XCTAssertNil(SkillCallPresentation(name: "Skill", input: "{}"), "No skill named: the raw pill shows the call")
        XCTAssertNil(SkillCallPresentation(name: "Skill", input: "broken"))
        XCTAssertNil(SkillCallPresentation(name: "Skill", input: try json(["skill": "two\nlines"])))
        XCTAssertNil(SkillCallPresentation(name: "Read", input: try json(["skill": "design"])))
        XCTAssertTrue(SkillCallPresentation.recognizes("functions.Skill")); XCTAssertFalse(SkillCallPresentation.recognizes("mcp__x__skill"))
    }

    // MARK: Generic MCP

    func testMCPCardHumanizesServerAndToolAndRowsTheInput() throws {
        let input = try json(["owner": "alaarab", "repo": "phren", "pull_number": 42, "draft": false,
                              "filters": ["state": "open", "sort": "updated"], "labels": ["ios", "chat"], "note": NSNull()])
        let card = try XCTUnwrap(MCPToolPresentation(name: "mcp__github__get_pull_request", input: input))
        XCTAssertEqual(card.server, "GitHub"); XCTAssertEqual(card.verb, "Get pull request")
        XCTAssertEqual(card.status, .running); XCTAssertEqual(card.resultLines, [])
        let rows = Dictionary(uniqueKeysWithValues: card.fields.map { ($0.name, $0.value) })
        XCTAssertEqual(rows["owner"], "alaarab"); XCTAssertEqual(rows["pull number"], "42"); XCTAssertEqual(rows["draft"], "false")
        XCTAssertEqual(rows["filters"], "{2 fields}"); XCTAssertEqual(rows["labels"], "2 items"); XCTAssertEqual(rows["note"], "—")
        XCTAssertEqual(card.hiddenFields, 0)
        XCTAssertFalse(card.fields.contains { $0.value.contains("{\"") }, "No raw JSON on the card")
        XCTAssertEqual(MCPToolPresentation(name: "functions.mcp__herdr__listPanes", input: "{}")?.server, "Herdr")
        XCTAssertEqual(MCPToolPresentation(name: "mcp__herdr__listPanes", input: "{}")?.verb, "List panes")
        XCTAssertEqual(MCPToolPresentation(name: "mcp__claude_ai_Gmail__search-mail", input: "{}")?.server, "Claude Ai Gmail")
        XCTAssertEqual(MCPToolPresentation(name: "mcp__claude_ai_Gmail__search-mail", input: "{}")?.verb, "Search mail")
        XCTAssertEqual(MCPToolPresentation(name: "mcp__acme__get_PR_info", input: "{}")?.verb, "Get PR info")
        let many = try json(Dictionary(uniqueKeysWithValues: (0..<12).map { ("key\($0)", "v") }))
        let wide = try XCTUnwrap(MCPToolPresentation(name: "mcp__acme__tool", input: many))
        XCTAssertEqual(wide.fields.count, MCPToolPresentation.maximumFields); XCTAssertEqual(wide.hiddenFields, 4)
        XCTAssertNotNil(MCPToolPresentation(name: "mcp__acme__tool", input: "broken"), "Malformed input still gets a card; rows are just empty")
    }

    func testMCPResultObjectsReadAsKeyLinesWithoutTopLevelBraces() throws {
        let payload = try json(["number": 42, "title": "Chat: cards for web, skills and MCP", "state": "open",
                                "user": ["login": "alaarab", "id": 7], "labels": [["name": "ios"], ["name": "chat"]], "zzz": "last", "aaa": "first"])
        let envelope = try json(["content": [["type": "text", "text": payload]]])
        let card = try XCTUnwrap(MCPToolPresentation(name: "mcp__github__get_pull_request", input: "{}", result: envelope))
        XCTAssertEqual(card.status, .succeeded)
        XCTAssertEqual(card.resultLines.prefix(3), ["title: Chat: cards for web, skills and MCP", "state: open", "number: 42"], "The keys a person looks for come first")
        XCTAssertTrue(card.resultLines.contains("user: id: 7 · login: alaarab"), "One level of a nested object")
        XCTAssertTrue(card.resultLines.contains("labels: 2 items"))
        XCTAssertEqual(card.resultLines.count, MCPToolPresentation.maximumResultLines)
        XCTAssertTrue(card.resultTruncated)
        XCTAssertFalse(card.resultLines.contains { $0.hasPrefix("{") || $0.contains("{\"") })
        // Text results read as their first lines; arrays as their size and items.
        let text = try XCTUnwrap(MCPToolPresentation(name: "mcp__herdr__list_panes", input: "{}", result: "3 panes\n1 codex\n2 claude"))
        XCTAssertEqual(text.resultLines, ["3 panes", "1 codex", "2 claude"]); XCTAssertFalse(text.resultTruncated)
        let list = try XCTUnwrap(MCPToolPresentation(name: "mcp__herdr__list_panes", input: "{}", result: try json([["title": "One"], ["title": "Two"]])))
        XCTAssertEqual(list.resultLines, ["2 items", "· title: One", "· title: Two"])
        let structured = try json(["content": [["type": "text", "text": "ignored"]], "structuredContent": ["count": 3]])
        XCTAssertEqual(MCPToolPresentation(name: "mcp__acme__count", input: "{}", result: structured)?.resultLines, ["count: 3"])
    }

    func testMCPFailuresAndRecognition() throws {
        let flagged = try XCTUnwrap(MCPToolPresentation(name: "mcp__github__merge_pull_request", input: "{}", result: "Pull request is not mergeable", isError: true))
        XCTAssertEqual(flagged.status, .failed); XCTAssertEqual(flagged.resultLines, ["Pull request is not mergeable"])
        let envelope = try json(["isError": true, "content": [["type": "text", "text": "Rate limited"]]])
        let mcpError = try XCTUnwrap(MCPToolPresentation(name: "mcp__github__merge_pull_request", input: "{}", result: envelope))
        XCTAssertEqual(mcpError.status, .failed); XCTAssertEqual(mcpError.resultLines, ["Rate limited"])
        for name in ["mcp__github__get_pull_request", "functions.mcp__herdr__list_panes", "mcp__a__b__c"] { XCTAssertTrue(MCPToolPresentation.recognizes(name), name) }
        for name in ["mcp__phren__add_task", "functions.mcp__phren__session", "mcp__github", "mcp____tool", "Read", "WebFetch", nil] {
            XCTAssertFalse(MCPToolPresentation.recognizes(name), name ?? "nil")
        }
        XCTAssertNil(MCPToolPresentation(name: "mcp__phren__add_task", input: "{}"), "Phren keeps its own card")
    }

    func testSentenceCaseAndPlainValues() {
        XCTAssertEqual(ToolCallText.sentence("get_pull_request"), "Get pull request")
        XCTAssertEqual(ToolCallText.sentence("listIssueComments"), "List issue comments")
        XCTAssertEqual(ToolCallText.sentence("search-code"), "Search code")
        XCTAssertEqual(ToolCallText.sentence("read_URL"), "Read URL")
        XCTAssertEqual(ToolCallText.plain(["a": 1]), "{1 field}")
        XCTAssertEqual(ToolCallText.plain([1, 2, 3]), "3 items")
        XCTAssertEqual(ToolCallText.plain(String(repeating: "x", count: 300)).count, 201)
        XCTAssertEqual(ToolCallText.plain(NSNumber(value: true)), "true")
        XCTAssertEqual(ToolCallText.plain(NSNumber(value: 1)), "1")
    }
}
