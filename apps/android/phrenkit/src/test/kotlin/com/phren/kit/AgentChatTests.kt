package com.phren.kit

import kotlinx.serialization.json.JsonObject
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** AgentChatTests.swift, case for case. */
class AgentChatTests {
    private fun child(json: String) = AgentChild.read(hookJson.parseToJsonElement(json) as JsonObject)
    private fun read(data: ByteArray, source: String) = AgentChatTranscript.read(data, source)
    private fun assistantRows(lines: Iterable<Int>) = lines.map { mapOf("line" to it, "raw" to mapOf("type" to "response_item", "payload" to mapOf("type" to "message", "role" to "assistant", "content" to "Message $it"))) }

    @Test fun chatScrollRepinsOnlyForContentGrowth() {
        val old = ChatScrollMetrics(900f, 500f, 400f)
        val grown = ChatScrollMetrics(980f, 500f, 400f)
        assertEquals(480f, ChatScrollMetrics.shouldRepin(old, grown, false))
        val keyboard = ChatScrollMetrics(900f, 300f, 400f)
        assertNull(ChatScrollMetrics.shouldRepin(old, keyboard, false), "A keyboard-only viewport change is not transcript growth")
        assertEquals(600f, keyboard.bottomOffset)
        val keyboardOvershoot = ChatScrollMetrics(900f, 300f, 750f)
        assertEquals(600f, ChatScrollMetrics.shouldRepin(old, keyboardOvershoot, false))
        assertNull(ChatScrollMetrics.shouldRepin(old, grown, true))
        val shortOld = ChatScrollMetrics(200f, 500f, 0f)
        val shortNew = ChatScrollMetrics(260f, 500f, 0f)
        assertNull(ChatScrollMetrics.shouldRepin(shortOld, shortNew, false))
        assertEquals(0f, shortNew.bottomOffset)
    }

    @Test fun childAgentTreeCountsNestedRunningAgents() {
        val data = """{"agents":[{"id":"a","provider":"codex","path":"/root/first","callId":"c1","state":"completed","children":[{"id":"b","provider":"codex","path":"/root/first/worker","callId":"c2","state":"running","children":[]}]},{"id":"c","provider":"codex","path":"/root/second","callId":"c3","state":"running","children":[]}]}""".toByteArray()
        val tree = AgentChildTree.read(data)
        assertEquals(2, tree.runningCount)
        assertEquals(3, tree.agentCount)
        assertEquals("worker", tree.agents[0].children[0].name)
    }

    @Test fun childAgentDecodesWithAndWithoutModel() {
        assertEquals("gpt-5-codex", child("""{"id":"a","provider":"codex","model":"gpt-5-codex","path":"/root/first","callId":"c1","state":"running","children":[]}""").model)
        assertNull(child("""{"id":"b","provider":"claude","path":"/root/second","callId":"c2","state":"completed","children":[]}""").model)
    }

    @Test fun blockedFanoutChildReadsAsRefusedAndNeverCompleted() {
        val blocked = child("""{"id":"a","provider":"opencode","path":"Clean the tree","callId":"fanout:a","state":"completed","reason":"blocked: doom_loop glob","children":[]}""")
        assertEquals("blocked: doom_loop glob", blocked.reason)
        assertTrue(blocked.permissionRefused)
        assertEquals("doom_loop glob", blocked.refusedDetail)
        assertEquals(AgentChild.State.FAILED, blocked.displayState)
        assertEquals("Permission refused", blocked.displayName)
        assertEquals(0, blocked.runningCount)
        assertEquals(1, blocked.refusedCount)
        assertEquals(listOf("a"), AgentChild.runningRows(listOf(blocked)).map { it.agent.id })

        val clean = child("""{"id":"b","provider":"codex","path":"Clean the tree","callId":"fanout:b","state":"completed","children":[]}""")
        assertNull(clean.reason)
        assertFalse(clean.permissionRefused)
        assertNull(clean.refusedDetail)
        assertEquals(AgentChild.State.COMPLETED, clean.displayState)
        assertEquals("Clean the tree", clean.displayName)
        assertEquals(emptyList(), AgentChild.runningRows(listOf(clean)))

        assertEquals(AgentChild.State.FAILED, child("""{"id":"c","provider":"claude","path":"Clean the tree","callId":"fanout:c","state":"failed","children":[]}""").displayState)
    }

    @Test fun childAgentDecodesCheckoutDetails() {
        val both = child("""{"id":"a","provider":"codex","path":"/root/first","callId":"c1","state":"running","worktreeName":"phren-child-wt-ui","branch":"codex/child-worktree-ui","children":[]}""")
        val worktreeOnly = child("""{"id":"b","provider":"codex","path":"/root/second","callId":"c2","state":"running","worktreeName":"phren-child-wt-api","children":[]}""")
        val neither = child("""{"id":"c","provider":"claude","path":"/root/third","callId":"c3","state":"completed","children":[]}""")
        assertEquals("codex/child-worktree-ui", both.branch)
        assertEquals("phren-child-wt-ui", both.worktreeName)
        assertEquals("codex/child-worktree-ui", both.checkoutLabel)
        assertNull(worktreeOnly.branch)
        assertEquals("phren-child-wt-api", worktreeOnly.checkoutLabel)
        assertNull(neither.worktreeName)
        assertNull(neither.branch)
        assertNull(neither.checkoutLabel)
    }

    @Test fun childTranscriptReadsSidechainRowsAndRefusesAnotherConversation() {
        val child = "c".repeat(32)
        val rows = listOf(
            mapOf("line" to 0, "raw" to mapOf("type" to "user", "isSidechain" to true, "agentId" to "abc", "message" to mapOf("role" to "user", "content" to "Inspect the scripts"))),
            mapOf("line" to 1, "raw" to mapOf("type" to "assistant", "isSidechain" to true, "agentId" to "abc", "message" to mapOf("role" to "assistant", "content" to listOf(mapOf("type" to "text", "text" to "Review complete"))))),
        )
        val frame = jsonData(mapOf("type" to "backlog", "source" to "claude", "session" to child, "entries" to rows, "startLine" to 0, "totalLines" to 2, "hasMore" to false))
        assertEquals(0, read(frame, "claude").messages.size)
        val transcript = AgentChatTranscript.read(frame, "claude", sidechain = true, session = child)
        assertEquals(listOf("Inspect the scripts", "Review complete"), transcript.messages.map { it.text })
        assertEquals(listOf(AgentChatMessage.Role.USER, AgentChatMessage.Role.ASSISTANT), transcript.messages.map { it.role })
        assertFailsWith<Exception> { AgentChatTranscript.read(frame, "claude", sidechain = true, session = "d".repeat(32)) }
    }

    @Test fun attachmentsUseGeneratedNamesAndRejectUnsafeOrOversizedData() {
        val item = AgentAttachment.of("../../a screenshot.PNG", byteArrayOf(1, 2, 3), isImage = true)
        assertTrue(item.uploadName.endsWith(".png"))
        assertFalse(item.uploadName.contains("/"))
        assertFailsWith<Exception> { AgentAttachment.of("empty", ByteArray(0)) }
        assertFailsWith<Exception> { AgentAttachment.of("huge", ByteArray(AgentAttachment.MAXIMUM_BYTES + 1)) }
        assertEquals("/tmp/phren-upload-fixture/image.png", AgentAttachment.uploadedPath("""{"ok":true,"path":"/tmp/phren-upload-fixture/image.png"}""".toByteArray()))
        assertFailsWith<Exception> { AgentAttachment.uploadedPath("""{"ok":true,"path":"/tmp/image\ncommand"}""".toByteArray()) }
    }

    @Test fun uploadsAcceptOriginalPhrenHookResponseAndRejectExplicitFailures() {
        val path = "/Users/agent/.local/share/phren/bridge/uploads/session/image.png"
        assertEquals(path, AgentAttachment.uploadedPath(jsonData(mapOf("path" to path))))
        val responses = listOf(
            mapOf("ok" to false, "path" to path), mapOf("ok" to "true", "path" to path), mapOf("error" to "Upload failed", "path" to path),
            mapOf("path" to "relative/image.png"), mapOf("path" to "/tmp/image\ncommand"), mapOf("ok" to true),
        )
        for (response in responses) assertFailsWith<Exception>(response.toString()) { AgentAttachment.uploadedPath(jsonData(response)) }
    }

    @Test fun streamMergesOlderPagesAndReconnectsWithoutDuplicates() {
        fun page(kind: String, lines: List<Int>, total: Int = 12) = read(jsonData(mapOf("type" to kind, "source" to "codex", "entries" to assistantRows(lines),
            "startLine" to (lines.minOrNull() ?: 0), "totalLines" to total, "hasMore" to ((lines.minOrNull() ?: 0) > 0))), "codex")
        val history = AgentChatHistory()
        history.receive(page("backlog", listOf(8, 9)))
        history.receive(page("append", listOf(10, 11)))
        history.receive(page("older", listOf(0, 1, 2, 3)))
        history.receive(page("backlog", listOf(8, 9, 10, 11)))
        assertEquals(listOf(0, 1, 2, 3, 8, 9, 10, 11), history.messages.map { it.line })
        assertEquals(0, history.startLine)
        assertFalse(history.hasMore)
        val unchanged = history.copy()
        history.receive(page("backlog", listOf(8, 9, 10, 11)))
        assertEquals(unchanged, history, "Repeated snapshots must not invalidate the chat view")
        history.receive(page("backlog", listOf(0, 1), total = 2))
        assertEquals(unchanged, history, "A delayed backlog must not roll the transcript back")
    }

    @Test fun reconnectBacklogsCannotRollHistoryBackAndMergeNewLines() {
        fun page(lines: List<Int>, total: Int) = read(jsonData(mapOf("type" to "backlog", "source" to "codex", "entries" to assistantRows(lines),
            "startLine" to lines.min(), "totalLines" to total, "hasMore" to true)), "codex")
        val history = AgentChatHistory()
        history.receive(page(listOf(8, 9, 10, 11), 12))
        history.receive(page(listOf(8, 9), 10))
        assertEquals(listOf(8, 9, 10, 11), history.messages.map { it.line })
        assertEquals(12, history.totalLines)
        history.receive(page(listOf(12, 13), 14))
        assertEquals(listOf(8, 9, 10, 11, 12, 13), history.messages.map { it.line })
        assertEquals(14, history.totalLines)
    }

    @Test fun fakeStreamIdleReconnectNeverShrinksThenCatchUpAndReplace() {
        fun frame(kind: String, lines: IntRange?, total: Int, reset: Boolean = false) = read(jsonData(mapOf(
            "type" to kind, "source" to "codex", "entries" to (lines?.let { assistantRows(it) } ?: emptyList()), "startLine" to (lines?.first ?: 0),
            "totalLines" to total, "hasMore" to ((lines?.first ?: 0) > 0), "reset" to reset,
        )), "codex")
        val history = AgentChatHistory()
        history.receive(frame("backlog", 0..9, 10))
        history.receive(frame("append", 10..14, 15))
        assertEquals((0..14).toList(), history.messages.map { it.line })
        history.receive(frame("backlog", 0..4, 5))
        assertEquals((0..14).toList(), history.messages.map { it.line })
        assertEquals(15, history.totalLines)
        history.receive(frame("append", 15..19, 20))
        assertEquals((0..19).toList(), history.messages.map { it.line })
        history.receive(frame("backlog", null, 0, reset = true))
        assertEquals((0..19).toList(), history.messages.map { it.line })
        assertTrue(!history.hasMore || history.startLine != null)
        history.receive(frame("backlog", 0..2, 3, reset = true))
        assertEquals(listOf(0, 1, 2), history.messages.map { it.line })
        assertEquals(3, history.totalLines)
        assertFalse(history.hasMore)
    }

    @Test fun emptyFinalHistoryPageClosesPaginationWithoutLosingMessages() {
        val history = AgentChatHistory()
        history.receive(read("""{"type":"backlog","source":"codex","startLine":8,"totalLines":9,"hasMore":true,"entries":[{"line":8,"raw":{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Recent message"}}}]}""".toByteArray(), "codex"))
        history.receive(read("""{"type":"older","source":"codex","totalLines":9,"hasMore":false,"entries":[]}""".toByteArray(), "codex"))
        assertFalse(history.hasMore)
        assertEquals(listOf("Recent message"), history.messages.map { it.text })
    }

    @Test fun paneIdentityRequiresTheExactAgentAndConversation() {
        val host = UUID.randomUUID()
        val list = panes()
        val target = list.panes[0].target(host, "w7", "w7:t1")
        assertEquals("w7:p1", list.validate(target).id)
        assertFailsWith<Exception> { list.validate(AgentChatTarget(host, "w7", "w7:t1", "w7:p1", "codex", "different-session")) }
        assertFailsWith<Exception> { list.validate(AgentChatTarget(host, "w7", "w7:t1", "w7:p2", "codex", "session-one")) }
        assertEquals("w7:p1", panes("blocked").validate(target, sending = true).id)
        assertFailsWith<Exception> { AgentChatTarget(host, "w7&tab=w8", "w7:t1", "w7:p1", "codex", "session-one") }
    }

    @Test fun historyWindowKeepsPagingPastItsMemoryLimitDuringLiveUpdates() {
        fun page(lines: IntRange, kind: String = "backlog", total: Int = 5_000) = read(jsonData(mapOf("type" to kind, "source" to "codex",
            "entries" to assistantRows(lines), "startLine" to lines.first, "totalLines" to total, "hasMore" to (lines.first > 0))), "codex")
        val history = AgentChatHistory()
        for (start in 0 until 5_000 step 1_000) history.receive(page(start until start + 1_000))
        assertEquals(4_000, history.messages.size)
        assertTrue(history.hasMore)
        assertFalse(history.hasNewer)
        history.receive(page(500 until 1_000, "older"))
        assertEquals(500, history.messages.first().line)
        assertEquals(4_499, history.messages.last().line)
        assertTrue(history.hasMore)
        assertTrue(history.hasNewer)
        history.receive(page(5_000 until 5_010, "append", 5_010))
        history.receive(page(4_900 until 5_010, total = 5_010))
        assertEquals(500, history.messages.first().line, "Reconnect/live output must preserve the older window")
        assertEquals(4_499, history.messages.last().line)
        history.receive(page(0 until 500, "older", 5_010))
        assertEquals(0, history.messages.first().line)
        assertEquals(4_000, history.messages.size)
        assertFalse(history.hasMore)
        assertTrue(history.hasNewer)
        history.receive(page(0 until 2, total = 2))
        assertTrue(history.hasNewer, "A stale reconnect cannot reset the retained window")
        assertEquals(4_000, history.messages.size)
    }

    @Test fun paneListsRejectMismatchedLocationsAndDuplicateIDs() {
        val data = """{"kind":"herdr","groupId":"w7","childId":"w7:t1","panes":[{"id":"w7:p1","label":"1"},{"id":"w7:p1","label":"2"}]}""".toByteArray()
        assertFailsWith<Exception> { AgentChatPanes.read(data, "w8", "w8:t1") }
        assertFailsWith<Exception> { AgentChatPanes.read(data, "w7", "w7:t1") }
    }

    @Test fun singleOversizedClaudeRowIsRejectedBeforeReplacingHistory() {
        val blocks = List(65_000) { mapOf("type" to "text", "text" to "x") }
        val oversized = frame(listOf(mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to blocks))), "claude")
        assertTrue(oversized.size < 2 * 1_024 * 1_024)
        val history = AgentChatHistory()
        val recent = read(frame(listOf(mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to "Keep this conversation"))), "claude"), "claude")
        history.receive(recent)
        assertFailsWith<AgentChatTranscript.TooManyMessages> { history.receive(read(oversized, "claude")) }
        assertEquals(recent.messages, history.messages)
    }

    @Test fun claudeMessageBudgetCoversMixedBlocksAcrossRows() {
        val blocks = List(3_997) { mapOf<String, Any>("type" to "text", "text" to "x") } + listOf(
            mapOf("type" to "thinking", "thinking" to "Hidden"), mapOf("type" to "text", "text" to ""),
            mapOf("type" to "image"), mapOf("type" to "tool_use", "name" to "Read", "id" to "read-1", "input" to emptyMap<String, Any>()),
        )
        val first = mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to blocks))
        val last = mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to listOf(mapOf("type" to "tool_result", "tool_use_id" to "read-1", "content" to "Result"))))
        val accepted = read(frame(listOf(first, last), "claude"), "claude")
        assertEquals(4_000, accepted.messages.size)
        assertEquals("Result", accepted.messages.last().text)
        assertFailsWith<AgentChatTranscript.TooManyMessages> { read(frame(listOf(first, last, last), "claude"), "claude") }
        val plain = mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to "One more"))
        assertFailsWith<Exception> { read(frame(listOf(first, last, plain), "claude"), "claude") }
    }

    @Test fun emptyClaudeBlocksDoNotConsumeVisibleMessageBudget() {
        val blocks = List(65_000) { mapOf("type" to "text", "text" to "") } + listOf(mapOf("type" to "text", "text" to "Visible message"))
        val value = read(frame(listOf(mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to blocks))), "claude"), "claude")
        assertEquals(listOf("Visible message"), value.messages.map { it.text })
        assertEquals("0:65000", value.messages.first().id)
    }

    @Test fun codexMessagesAndToolsExcludeSystemAndEncryptedReasoning() {
        fun item(payload: Map<String, Any>) = mapOf("type" to "response_item", "payload" to payload)
        val rows = listOf(
            item(mapOf("type" to "message", "role" to "system", "content" to listOf(mapOf("type" to "text", "text" to "private setup")))),
            item(mapOf("type" to "reasoning", "encrypted_content" to "private reasoning")),
            item(mapOf("type" to "message", "role" to "user", "content" to listOf(mapOf("type" to "input_text", "text" to "Fix the screen")))),
            item(mapOf("type" to "custom_tool_call", "name" to "apply_patch", "input" to "Edit the view")),
            item(mapOf("type" to "custom_tool_call_output", "output" to "Applied")),
            mapOf("type" to "event_msg", "payload" to mapOf("type" to "agent_message", "message" to "Done")),
            item(mapOf("type" to "message", "role" to "assistant", "content" to listOf(mapOf("type" to "output_text", "text" to "Done")))),
        )
        val transcript = read(frame(rows, "codex"), "codex")
        val r = AgentChatMessage.Role.entries
        assertEquals(listOf(r[0], r[2], r[2], r[1]), transcript.messages.map { it.role })
        assertEquals(listOf("Fix the screen", "Edit the view", "Applied", "Done"), transcript.messages.map { it.text })
        assertTrue(transcript.hasMore)
        assertFailsWith<Exception> { read(frame(rows, "codex"), "claude") }
    }

    @Test fun imagesInsideToolResultsAreAddressable() {
        val claude = listOf(
            mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to listOf(mapOf("type" to "tool_use", "id" to "t1", "name" to "Read", "input" to mapOf("file_path" to "/x.png"))))),
            mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to listOf(mapOf("type" to "text", "text" to "ok"),
                mapOf("type" to "tool_result", "tool_use_id" to "t1", "content" to listOf(mapOf("type" to "text", "text" to "here"), mapOf("type" to "image")))))),
        )
        val result = read(frame(claude, "claude"), "claude").messages.first { it.isToolResult }
        assertEquals(listOf(AgentChatMessage.ImageRef(1, 1)), result.resultImages)
        val codex = listOf(mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call_output", "call_id" to "c1",
            "output" to listOf(mapOf("type" to "input_image", "image_url" to "data:image/png;base64,")))))
        assertEquals(listOf(AgentChatMessage.ImageRef(0, null)), read(frame(codex, "codex"), "codex").messages[0].resultImages)
    }

    @Test fun shellChangesAttachedByTheHookBecomePatchPartsUnderTheirCall() {
        val patch = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n"
        val rows = listOf(
            mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call", "name" to "exec_command", "call_id" to "c1", "arguments" to "{\"cmd\":\"sed -i s/1/2/ src/a.ts\"}")),
            mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call_output", "call_id" to "c1", "output" to ""),
                "phren_changes" to mapOf("c1" to listOf(
                    mapOf("root" to "/work/app", "path" to "src/a.ts", "status" to "M", "added" to 1, "removed" to 1, "patch" to patch),
                    mapOf("root" to "/work/app", "path" to "src/b.ts", "status" to "A", "added" to 1, "removed" to 0, "patch" to "diff --git a/src/b.ts b/src/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/b.ts\n@@ -0,0 +1 @@\n+export {};\n"),
                    mapOf("root" to "/work/app", "path" to "", "status" to "M", "patch" to "ignored")))),
            mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call_output", "call_id" to "c2", "output" to "other"),
                "phren_changes" to mapOf("c1" to listOf(mapOf("path" to "x", "patch" to "@@\n+y")))),
        )
        val messages = read(frame(rows, "codex"), "codex").messages
        assertEquals(listOf("exec_command", "Tool result", "Changes", "Changes", "Tool result"), messages.map { it.title })
        assertEquals(listOf(false, false, true, true, false), messages.map { it.isChange })
        assertEquals("*** Update File: src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n", messages[2].text)
        assertEquals("*** Add File: src/b.ts\n@@ -0,0 +1 @@\n+export {};\n", messages[3].text)
        assertEquals("c1", messages[2].toolCallID)
        assertEquals(5, messages.map { it.id }.toSet().size)
    }

    @Test fun claudeBlocksSeparateVisibleTextToolCallsAndResults() {
        val rows = listOf(
            mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to "Review this")),
            mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to listOf(mapOf("type" to "thinking", "thinking" to "hidden"),
                mapOf("type" to "text", "text" to "Checking"), mapOf("type" to "tool_use", "name" to "Read", "input" to mapOf("path" to "app.swift"))))),
            mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to listOf(mapOf("type" to "tool_result", "content" to listOf(mapOf("type" to "text", "text" to "File contents")))))),
            mapOf("type" to "user", "isMeta" to true, "message" to mapOf("role" to "user", "content" to "hook metadata")),
        )
        val value = read(frame(rows, "claude"), "claude")
        val r = AgentChatMessage.Role.entries
        assertEquals(listOf(r[0], r[1], r[2], r[2]), value.messages.map { it.role })
        assertEquals("File contents", value.messages.last().text)
        assertFalse(value.messages.any { it.text.contains("hidden") || it.text.contains("metadata") })
    }

    @Test fun toolIDsAndEmptyResultsSurviveAllProviderParsers() {
        val sources = listOf(
            "codex" to listOf(
                mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call", "name" to "test", "arguments" to "", "call_id" to "c1")),
                mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call_output", "output" to "", "call_id" to "c1"))),
            "claude" to listOf(
                mapOf("message" to mapOf("role" to "assistant", "content" to listOf(mapOf("type" to "tool_use", "name" to "test", "id" to "c1", "input" to emptyMap<String, Any>())))),
                mapOf("message" to mapOf("role" to "user", "content" to listOf(mapOf("type" to "tool_result", "tool_use_id" to "c1", "content" to emptyList<Any>()))))),
            "copilot" to listOf(
                mapOf("type" to "tool.execution_start", "data" to mapOf("toolName" to "test", "toolCallId" to "c1", "arguments" to emptyMap<String, Any>())),
                mapOf("type" to "tool.execution_complete", "data" to mapOf("toolCallId" to "c1", "result" to mapOf("content" to "")))),
        )
        for ((source, rows) in sources) {
            val messages = read(frame(rows, source), source).messages
            assertEquals(listOf("c1", "c1"), messages.map { it.toolCallID }, source)
            assertEquals(listOf(false, true), messages.map { it.isToolResult }, source)
        }
        val oversized = listOf(mapOf("type" to "response_item", "payload" to mapOf("type" to "function_call_output", "output" to "Result remains readable", "call_id" to "x".repeat(513))))
        val message = read(frame(oversized, "codex"), "codex").messages.first()
        assertEquals("Result remains readable", message.text)
        assertNull(message.toolCallID)
    }

    @Test fun claudeCompactionCollapsesToASingleBoundedPart() {
        val rows = listOf(
            mapOf("type" to "system", "phrenCompacted" to true, "timestamp" to "2026-09-12T01:00:00Z"),
            mapOf("type" to "user", "isCompactSummary" to true, "timestamp" to "2026-09-12T01:00:00Z", "message" to mapOf("role" to "user", "content" to "s".repeat(6_000))),
        )
        val transcript = read(frame(rows, "claude"), "claude")
        assertEquals(1, transcript.messages.size)
        val message = transcript.messages.first()
        assertTrue(message.isCompaction)
        assertEquals(4_000, message.text.length)
        assertFalse(transcript.messages.any { it.role == AgentChatMessage.Role.USER })

        val legacy = "This session is being continued from a previous conversation that ran out of context. " + "t".repeat(5_000)
        val legacyTranscript = read(frame(listOf(mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to legacy))), "claude"), "claude")
        assertEquals(1, legacyTranscript.messages.size)
        assertTrue(legacyTranscript.messages.first().isCompaction)
        assertEquals(4_000, legacyTranscript.messages.first().text.length)
        assertFalse(legacyTranscript.messages.any { it.role == AgentChatMessage.Role.USER })
    }

    private fun panes(status: String = "idle"): AgentChatPanes = AgentChatPanes.read(jsonData(mapOf("kind" to "herdr", "groupId" to "w7", "childId" to "w7:t1", "panes" to listOf(
        mapOf("id" to "w7:p1", "label" to "1", "agent" to "codex", "agentStatus" to status, "sessionId" to "session-one"),
        mapOf("id" to "w7:p2", "label" to "2", "agent" to "claude", "sessionId" to "session-two"),
    ))), "w7", "w7:t1")

    private fun frame(rows: List<Map<String, Any>>, source: String) = jsonData(mapOf("type" to "backlog", "source" to source,
        "entries" to rows.mapIndexed { i, raw -> mapOf("line" to i, "raw" to raw) }, "hasMore" to true, "totalLines" to rows.size))
}

class LocalCommandTests {
    private fun message(text: String) = AgentChatMessage("1:0", 1, AgentChatMessage.Role.USER, null, text)
    private val K = AgentChatMessage.LocalCommand.Kind.entries

    @Test fun slashCommandReadsNameAndArguments() {
        val command = message("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>").localCommand
        assertEquals(AgentChatMessage.LocalCommand.Kind.COMMAND, command?.kind); assertEquals("/model", command?.text)
        assertEquals("/review ultra 12", message("<command-name>/review</command-name><command-message>review</command-message><command-args>ultra 12</command-args>").localCommand?.text)
    }

    @Test fun shellLineAndOutput() {
        assertEquals(AgentChatMessage.LocalCommand(K[1], "pwd"), message("<bash-input>pwd</bash-input>").localCommand)
        val output = message("<bash-stdout>/home/sam/Projects/hub</bash-stdout><bash-stderr></bash-stderr>").localCommand
        assertEquals(K[2], output?.kind); assertEquals("/home/sam/Projects/hub", output?.text)
        assertEquals("", message("<bash-stdout></bash-stdout><bash-stderr></bash-stderr>").localCommand?.text)
        assertEquals(AgentChatMessage.LocalCommand(K[2], "Set model to Opus 5"), message("<local-command-stdout>Set model to Opus 5</local-command-stdout>").localCommand)
    }

    @Test fun ordinaryMessagesAreNotCommands() {
        assertNull(message("Say \"go\" and I'll cut v0.11.27").localCommand)
        assertNull(message("look at <command-name> in the docs").localCommand)
        assertNull(AgentChatMessage("1:0", 1, AgentChatMessage.Role.ASSISTANT, null, "<bash-input>pwd</bash-input>").localCommand)
    }
}

class MergedUserTurnTests {
    private fun read(entries: List<Map<String, Any>>) = AgentChatTranscript.read(jsonData(mapOf("type" to "backlog", "source" to "claude", "entries" to entries)), "claude")
    private fun user(content: Any) = mapOf("type" to "user", "message" to mapOf("role" to "user", "content" to content))
    private val image = mapOf("type" to "image", "source" to mapOf("type" to "base64", "data" to ""))

    @Test fun textAndImageBlocksOfOneTurnBecomeOneBubble() {
        val raw = user(listOf(mapOf("type" to "text", "text" to "[Image #3]Look at this\n\nAttached files on this computer:\n/tmp/shot.png"), image, image))
        val transcript = read(listOf(mapOf("line" to 4, "raw" to raw)))
        assertEquals(1, transcript.messages.size)
        val message = transcript.messages.first()
        assertEquals("4:0", message.id)
        assertEquals(AgentChatMessage.Role.USER, message.role)
        assertEquals(listOf(1, 2), message.imageBlocks)
        assertTrue(message.text.startsWith("[Image #3]Look at this"))
    }

    @Test fun imageOnlyTurnKeepsItsPlaceholder() {
        val message = read(listOf(mapOf("line" to 1, "raw" to user(listOf(image, image))))).messages.first()
        assertEquals("[Image attachment]", message.text)
        assertEquals(listOf(0, 1), message.imageBlocks)
    }

    @Test fun uploadMarkerBecomesAnUploadImageAndLeavesTheText() {
        val path = "/Users/x/.local/share/phren/bridge/uploads/aaaa-1111/0f0f-phren-1a1a.png"
        val raw = user(listOf(mapOf("type" to "text", "text" to "[Image: source: $path]"), mapOf("type" to "text", "text" to "Why does this header wrap?")))
        val transcript = read(listOf(mapOf("line" to 6, "raw" to raw)))
        assertEquals(1, transcript.messages.size)
        val message = transcript.messages.first()
        assertEquals("6:0", message.id)
        assertEquals(listOf(path), message.uploadImages)
        assertEquals("Why does this header wrap?", message.text)
        assertTrue(message.imageBlocks.isEmpty())
        val plain = read(listOf(mapOf("line" to 6, "raw" to user("Why does this header wrap?")))).messages.first()
        assertNotEquals(plain.renderKey, message.renderKey)
        assertNotEquals(plain, message)
    }

    @Test fun threeUploadMarkersInOneTextBecomeThreePictures() {
        val text = "Look at these [Image: source: /work/phone/uploads/a.png] [Image: source: /work/phone/uploads/b.JPEG]\n[Image: source: /work/phone/uploads/c.webp]"
        val message = read(listOf(mapOf("line" to 2, "raw" to user(text)))).messages.first()
        assertEquals(listOf("/work/phone/uploads/a.png", "/work/phone/uploads/b.JPEG", "/work/phone/uploads/c.webp"), message.uploadImages)
        assertEquals("Look at these", message.text)
        val only = read(listOf(mapOf("line" to 3, "raw" to user(listOf(
            mapOf("type" to "text", "text" to "[Image: source: /work/phone/uploads/a.png]"), mapOf("type" to "text", "text" to "[Image: source: /work/phone/uploads/b.png]")))))).messages.first()
        assertEquals("[Image attachment]", only.text)
        assertEquals(2, only.uploadImages.size)
        val many = (0 until 12).joinToString(" ") { "[Image: source: /work/phone/uploads/$it.png]" }
        assertEquals(8, read(listOf(mapOf("line" to 4, "raw" to user(many)))).messages.first().uploadImages.size)
    }

    @Test fun uploadMarkerNamingSomethingOtherThanAnImageIsLeftAlone() {
        val text = "[Image: source: /work/phone/uploads/notes.pdf] see the notes [Image: source: relative/shot.png] and [Image: source: /work/phone/uploads/shot.png]"
        val message = read(listOf(mapOf("line" to 5, "raw" to user(text)))).messages.first()
        assertEquals(listOf("/work/phone/uploads/shot.png"), message.uploadImages)
        assertEquals("[Image: source: /work/phone/uploads/notes.pdf] see the notes [Image: source: relative/shot.png] and", message.text)
        val none = read(listOf(mapOf("line" to 7, "raw" to user("[Image: source: /work/phone/uploads/notes.pdf] read this")))).messages.first()
        assertTrue(none.uploadImages.isEmpty())
        assertEquals("[Image: source: /work/phone/uploads/notes.pdf] read this", none.text)
        val reply = read(listOf(mapOf("line" to 8, "raw" to mapOf("type" to "assistant", "message" to mapOf("role" to "assistant", "content" to "I saw [Image: source: /work/phone/uploads/shot.png]"))))).messages.first()
        assertTrue(reply.uploadImages.isEmpty())
    }

    @Test fun toolResultsInTheSameRowStayApart() {
        val raw = user(listOf(mapOf("type" to "tool_result", "tool_use_id" to "t1", "content" to "done"), mapOf("type" to "text", "text" to "and now this")))
        assertEquals(listOf(AgentChatMessage.Role.TOOL, AgentChatMessage.Role.USER), read(listOf(mapOf("line" to 1, "raw" to raw))).messages.map { it.role })
    }

    @Test fun harnessPreambleTurnsAreNotBubbles() {
        fun codexUser(text: String) = mapOf("type" to "response_item", "payload" to mapOf("type" to "message", "role" to "user", "content" to listOf(mapOf("type" to "input_text", "text" to text))))
        val codex = mapOf("type" to "backlog", "source" to "codex", "entries" to listOf(
            mapOf("line" to 0, "raw" to codexUser("<environment_context>\n  <cwd>/home/a/p</cwd>\n</environment_context>")),
            mapOf("line" to 1, "raw" to codexUser("Fix the header")),
        ))
        assertEquals(listOf("Fix the header"), AgentChatTranscript.read(jsonData(codex), "codex").messages.map { it.text })
        val claude = mapOf("type" to "backlog", "source" to "claude", "entries" to listOf(
            mapOf("line" to 0, "raw" to user("<system-reminder>internal</system-reminder>")),
            mapOf("line" to 1, "raw" to user("hello")),
        ))
        assertEquals(listOf("hello"), AgentChatTranscript.read(jsonData(claude), "claude").messages.map { it.text })
    }
}
