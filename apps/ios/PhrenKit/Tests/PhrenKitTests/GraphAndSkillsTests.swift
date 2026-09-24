import XCTest
@testable import PhrenKit

/// The graph's identity hashes are the contract that makes a tapped node
/// resolvable back to an exact FINDINGS.md bullet. Fixtures come from the real
/// CLI hashers (`scripts/generate-fixtures.mjs`), so a drift in either
/// implementation fails here rather than silently editing the wrong finding.
final class GraphIdentityTests: XCTestCase {
    private struct Sample: Decodable {
        let project: String
        let filename: String
        let snippet: String
        let scoreKey: String
        let nodeId: String
    }

    private func samples() throws -> [Sample] {
        try JSONDecoder().decode([Sample].self, from: Data(contentsOf: Fixtures.url("graph-identity.json")))
    }

    func testScoreKeysMatchCLI() throws {
        for sample in try samples() {
            XCTAssertEqual(
                GraphBuilder.entryScoreKey(project: sample.project, filename: sample.filename, snippet: sample.snippet),
                sample.scoreKey,
                "score key drifted for \(sample.snippet.prefix(40))"
            )
        }
    }

    func testNodeIdsMatchCLI() throws {
        for sample in try samples() {
            XCTAssertEqual(
                GraphBuilder.findingStableId(scoreKey: sample.scoreKey),
                sample.nodeId,
                "node id drifted for \(sample.snippet.prefix(40))"
            )
        }
    }

    /// `findBulletText` is the reverse lookup the app performs before editing.
    func testResolvesScoreKeyBackToTaggedBullet() {
        let markdown = """
        # myproj Findings
        ## 2026-09-06
        - [pattern] Use the shared cache for repeated lookups <!-- fid:aaaaaaaa -->
        - [pitfall] Use the shared cache for repeated lookups <!-- fid:bbbbbbbb -->
        - short
        """
        let key = GraphBuilder.entryScoreKey(
            project: "myproj", filename: "FINDINGS.md",
            snippet: "[pitfall] Use the shared cache for repeated lookups"
        )
        XCTAssertEqual(
            GraphBuilder.findBulletText(project: "myproj", scoreKey: key, findingsMarkdown: markdown),
            "[pitfall] Use the shared cache for repeated lookups",
            "must resolve to the pitfall line, not the identically-worded pattern line"
        )
        // Folded from testUnresolvableScoreKeyReturnsNil.
        do {
            XCTAssertNil(GraphBuilder.findBulletText(
                project: "myproj", scoreKey: "myproj/FINDINGS.md:000000000000",
                findingsMarkdown: "- [pattern] something else entirely"
            ))
        }
    }

    /// A node id must survive the trip through the renderer's JSON.
    func testPayloadBuildsNodesAndLinks() {
        let input = GraphBuilder.Input(
            findingsMarkdown: ["myproj": """
            ## 2026-09-06
            - [pattern] Use the shared cache for repeated lookups
            - Plain untagged finding with enough length
            - tiny
            """],
            tasks: [:],
            projects: ["myproj"],
            storeName: "test-store"
        )
        let payload = GraphBuilder.build(input)

        XCTAssertEqual(payload.nodes.filter { $0.group == "project" }.count, 1)
        // Two findings; "- tiny" is below the 10-char floor for plain bullets.
        let findings = payload.nodes.filter { $0.group.hasPrefix("topic:") }
        XCTAssertEqual(findings.count, 2)
        XCTAssertEqual(findings.first { $0.tagged }?.topicSlug, "pattern")
        XCTAssertEqual(findings.first { !$0.tagged }?.topicSlug, "general")
        XCTAssertEqual(findings.first?.date, "2026-09-06")
        // Every finding links back to its project node.
        XCTAssertEqual(payload.links.filter { $0.source == "myproj" }.count, 2)
        XCTAssertEqual(payload.nodes.first { $0.group == "project" }?.findingCount, 2)
    }

    /// The renderer is handed this string directly, so it has to be valid JSON.
    func testPayloadEncodesToJSON() throws {
        let payload = GraphBuilder.build(GraphBuilder.Input(
            findingsMarkdown: ["myproj": "- [bug] A finding that is long enough"],
            tasks: [:], projects: ["myproj"], storeName: "s"
        ))
        let json = try payload.jsonString()
        let decoded = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        XCTAssertNotNil(decoded?["nodes"])
        XCTAssertNotNil(decoded?["links"])
    }
}

final class SkillPathTests: XCTestCase {
    func testRecognizesBothSkillShapes() {
        XCTAssertTrue(LocalStore.isSkillPath("global/skills/audit/SKILL.md"))
        XCTAssertTrue(LocalStore.isSkillPath("global/skills/codex.md"))
        XCTAssertTrue(LocalStore.isSkillPath("myproj/skills/parity.md"))
        XCTAssertTrue(LocalStore.isSkillPath("myproj/skills/deploy/SKILL.md"))
    }

    func testRejectsNonSkillPaths() {
        XCTAssertFalse(LocalStore.isSkillPath("myproj/FINDINGS.md"))
        XCTAssertFalse(LocalStore.isSkillPath("global/AGENTS.md"))
        // Only SKILL.md inside a folder skill — supporting files aren't synced.
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/audit/reference.md"))
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/audit/nested/SKILL.md"))
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/notmarkdown.txt"))
        XCTAssertFalse(LocalStore.isSkillPath("skills/orphan.md"))
    }

    /// Path traversal must not survive into a write path.
    func testRejectsTraversal() {
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/../../etc/passwd.md"))
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/..md"))
        XCTAssertFalse(LocalStore.isSkillPath("global/skills/.hidden.md"))
    }
}

final class SkillFileTests: XCTestCase {
    private let sample = """
    ---
    name: audit
    description: Full codebase audit.
    ---

    # Audit

    Body text.
    """

    func testParsesFrontmatter() {
        let (frontmatter, body) = SkillFile.parseFrontmatter(sample)
        XCTAssertEqual(frontmatter?["name"], "audit")
        XCTAssertEqual(frontmatter?["description"], "Full codebase audit.")
        XCTAssertTrue(body.hasPrefix("\n# Audit"))
    }

    func testHandlesCRLFAndBOM() {
        let crlf = "\u{FEFF}---\r\nname: x\r\ndescription: y\r\n---\r\nbody"
        let (frontmatter, _) = SkillFile.parseFrontmatter(crlf)
        XCTAssertEqual(frontmatter?["name"], "x")
    }

    func testNoFrontmatterIsAllBody() {
        let (frontmatter, body) = SkillFile.parseFrontmatter("# No frontmatter")
        XCTAssertNil(frontmatter)
        XCTAssertEqual(body, "# No frontmatter")
    }

    func testWarnsOnMissingRequiredFields() {
        XCTAssertEqual(SkillFile.frontmatterWarnings(for: sample), [])
        XCTAssertEqual(SkillFile.frontmatterWarnings(for: "# nothing"), ["missing or invalid YAML frontmatter"])
        let missing = "---\nname: x\n---\nbody"
        XCTAssertEqual(SkillFile.frontmatterWarnings(for: missing), ["missing required field \"description\""])
    }

    func testParsesSkillFromPath() {
        let folder = Skill.parse(path: "global/skills/audit/SKILL.md", content: sample)
        XCTAssertEqual(folder?.name, "audit")
        XCTAssertEqual(folder?.format, .folder)
        XCTAssertEqual(folder?.scope, .global)
        XCTAssertEqual(folder?.title, "audit")

        let flat = Skill.parse(path: "myproj/skills/parity.md", content: sample)
        XCTAssertEqual(flat?.name, "parity")
        XCTAssertEqual(flat?.format, .flat)
        XCTAssertEqual(flat?.scope, .project("myproj"))

        XCTAssertNil(Skill.parse(path: "myproj/FINDINGS.md", content: sample))
    }

    /// The editor round-trips the whole file, so an unrecognized frontmatter
    /// shape must not be rewritten.
    func testContentIsPreservedVerbatim() {
        let odd = "---\nname: x\ndescription: y\nhooks:\n  post: echo hi\n---\n\nbody\n"
        let skill = Skill.parse(path: "global/skills/x.md", content: odd)
        XCTAssertEqual(skill?.content, odd)
    }
}
