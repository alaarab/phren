package com.phren.kit

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import java.time.LocalDateTime
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Ports of main's SchedulesFileTests, ProjectKnobsTests, GraphAndSkillsTests,
 * AuthoredFileTests, SkillPreferencesTests, MachineRegistryTests and
 * SecretScannerTests.
 */
abstract class EngineTestBase {
    protected lateinit var directory: File

    @BeforeTest fun makeDir() { directory = Files.createTempDirectory("phren-kit").toFile() }
    @AfterTest fun removeDir() { directory.deleteRecursively() }

    protected fun makeEngine(local: Map<String, String>, remote: Map<String, String>? = null): Triple<SyncEngine, LocalStore, FakeGitHubClient> = runBlocking {
        val store = LocalStore(directory, "o", "r", "main")
        local.forEach { (p, c) -> store.write(p, c, GitBlob.sha(c)) }
        val client = FakeGitHubClient(remote ?: local)
        val engine = SyncEngine(client, store, directory)
        engine.setAutoFlush(false)
        Triple(engine, store, client)
    }

    protected fun FakeGitHubClient.writesTo(path: String) = writes.filter { it.path == path }
}

class SchedulesFileTests : EngineTestBase() {
    private fun schedule(id: String = "7f3a2c1d", prompt: String = "Run the tests.\n") = Schedule(
        id, "Nightly test sweep", true, "Desk", Schedule.Harness.CODEX, "gpt-5.6-sol", Schedule.Notify.defaults,
        Schedule.Every.Weekly(setOf(Schedule.Weekday.MON, Schedule.Weekday.TUE, Schedule.Weekday.WED, Schedule.Weekday.THU, Schedule.Weekday.FRI), 7, 30),
        prompt, ISO8601Dates.parse("2026-09-20T21:00:00.123Z")!!, ISO8601Dates.parse("2026-09-20T21:00:00.456Z")!!,
    )

    @Test fun parsesContractExample() {
        val yaml = """
            version: 1
            schedules:
              - id: 7f3a2c1d
                name: Nightly test sweep
                enabled: true
                computer: Desk
                harness: codex
                model: gpt-5.6-sol
                every: weekly
                at: "07:30"
                days: [mon, tue, wed, thu, fri]
                prompt: |
                  Run the full test suite, fix what is red, and leave a summary in tasks.
                createdAt: 2026-09-20T21:00:00Z
                updatedAt: 2026-09-20T21:00:00Z
        """.trimIndent()
        val v = SchedulesFile.parse(yaml).single()
        assertEquals("7f3a2c1d", v.id)
        assertEquals(Schedule.Harness.CODEX, v.harness)
        assertEquals("Run the full test suite, fix what is red, and leave a summary in tasks.\n", v.prompt)
        assertEquals(schedule().every, v.every)
        assertEquals(setOf(Schedule.Notify.FINISH, Schedule.Notify.FAILURE), v.notify)
    }

    @Test fun notifyRoundTripsAndDefaultsWhenAbsent() {
        val expected = schedule().copy(notify = setOf(Schedule.Notify.START, Schedule.Notify.FAILURE))
        val rendered = SchedulesFile.render(listOf(expected))
        assertTrue(rendered.contains("notify: [start, failure]"))
        assertEquals(listOf(expected), SchedulesFile.parse(rendered))
        val without = rendered.split("\n").filter { !it.trim().startsWith("notify:") }.joinToString("\n")
        assertEquals(Schedule.Notify.defaults, SchedulesFile.parse(without).single().notify)
        assertEquals(emptyList(), SchedulesFile.parse(rendered.replace("notify: [start, failure]", "notify: [start, pager]")))
        val json = ScheduleJson.toJson(expected)
        assertEquals(expected, ScheduleJson.fromJson(json))
        assertEquals(listOf("start", "failure"), json["notify"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun codableUsesTheFlatHookShape() {
        val o = ScheduleJson.toJson(schedule())
        assertEquals("weekly", o["every"]!!.jsonPrimitive.content)
        assertEquals("2026-09-20T21:00:00.123Z", o["createdAt"]!!.jsonPrimitive.content)
        assertEquals("07:30", o["at"]!!.jsonPrimitive.content)
        assertEquals(listOf("mon", "tue", "wed", "thu", "fri"), (o["days"] as JsonArray).map { it.jsonPrimitive.content })
    }

    @Test fun typedFrequenciesRoundTrip() {
        val frequencies = listOf(
            Schedule.Every.Interval(5), Schedule.Every.Interval(360), Schedule.Every.Interval(2_880),
            Schedule.Every.Daily(7, 30), Schedule.Every.Weekly(setOf(Schedule.Weekday.FRI, Schedule.Weekday.MON), 18, 5),
            Schedule.Every.Once(LocalDateTime.of(2026, 9, 21, 9, 30)), Schedule.Every.Cron("0 7 * * 1-5"),
        )
        for (f in frequencies) {
            val v = schedule().copy(every = f)
            assertEquals(listOf(v), SchedulesFile.parse(SchedulesFile.render(listOf(v))))
            assertEquals(v, ScheduleJson.fromJson(ScheduleJson.toJson(v)))
        }
    }

    @Test fun invalidValuesAreRejected() {
        val yaml = SchedulesFile.render(listOf(schedule().copy(every = Schedule.Every.Daily(7, 30))))
        assertTrue(SchedulesFile.parse(yaml.replace("07:30", "24:00")).isEmpty())
        assertTrue(SchedulesFile.parse(yaml.replace("07:30", "0٧:30")).isEmpty())
        assertTrue(SchedulesFile.parse(yaml.replace("7f3a2c1d", "'")).isEmpty())
        for (interval in listOf("4m", "0h", "999999999999999999999d")) {
            val invalid = yaml.replace("every: daily", "every: interval").replace("at: \"07:30\"", "interval: $interval")
            assertTrue(SchedulesFile.parse(invalid).isEmpty(), interval)
        }
        val badDate = yaml.replace("every: daily", "every: once").replace("at: \"07:30\"", "once: 2026-02-30T09:00:00")
        assertTrue(SchedulesFile.parse(badDate).isEmpty())
    }

    @Test fun renderPreservesUnknownTopLevelContent() {
        val original = "# owned by phren\nversion: 1\nsource: phone\nschedules: []\npolicy:\n  review: required"
        val expected = schedule(prompt = "First line\n\nThird line\n")
        val rendered = SchedulesFile.render(listOf(expected), original)
        assertTrue(rendered.contains("source: phone"))
        assertTrue(rendered.contains("policy:\n  review: required"))
        assertEquals(listOf(expected), SchedulesFile.parse(rendered))
    }

    @Test fun blockPromptKeepsBlankLinesAndChomping() {
        val yaml = "version: 1\nschedules:\n  - id: 7f3a2c1d\n    name: Notes\n    enabled: true\n    computer: Desk\n    harness: claude\n    every: daily\n    at: \"09:15\"\n    prompt: |-\n      First\n\n      Third\n    createdAt: 2026-09-20T21:00:00Z\n    updatedAt: 2026-09-20T21:00:00Z"
        assertEquals("First\n\nThird", SchedulesFile.parse(yaml).single().prompt)
    }

    @Test fun capsAndDuplicates() {
        val entries = (0 until 65).map { i ->
            SchedulesFile.render(listOf(schedule(id = "%08x".format(i + 1)))).removePrefix("version: 1\nschedules:\n")
        }
        assertEquals(64, SchedulesFile.parse("version: 1\nschedules:\n" + entries.joinToString("")).size)
        val first = schedule()
        assertEquals(listOf(first), SchedulesFile.parse(SchedulesFile.render(listOf(first, first.copy(name = "Repeated")))))
    }

    @Test fun snapshotAndStaleSave() = runBlocking {
        val current = SchedulesFile.render(listOf(schedule()))
        val (engine, store, _) = makeEngine(mapOf("demo/schedules.yaml" to current))
        assertEquals(listOf(schedule()), store.snapshot().schedules["demo"])
        assertEquals(current, store.snapshot().schedulesContent["demo"])
        assertTrue(LocalStore.isWritablePath("demo/schedules.yaml"))
        assertFalse(LocalStore.isSchedulesPath("global/schedules.yaml"))
        val error = runCatching {
            engine.enqueue(PendingOp.SaveSchedules("demo", SchedulesFile.render(listOf(schedule(prompt = "Changed.\n")), current), SchedulesFile.render(emptyList())))
        }.exceptionOrNull()
        assertTrue(error?.message?.contains("changed since") == true)
        assertEquals(current, store.read("demo/schedules.yaml"))
        assertTrue(engine.pendingOps().isEmpty())
    }

    @Test fun cronNextRuns() {
        val from = java.time.ZonedDateTime.of(2026, 9, 24, 8, 0, 0, 0, java.time.ZoneId.of("America/Los_Angeles"))
        val next = ScheduleCron.next("0 7 * * 1-5", 2, from)!!
        assertEquals(listOf(25, 28), next.map { it.dayOfMonth })
        assertTrue(next.all { it.hour == 7 && it.minute == 0 })
        assertNull(ScheduleCron.next("61 * * * *", 1, from))
    }
}

class ProjectKnobsTests : EngineTestBase() {
    @Test fun parsesTheFiveKnobs() {
        val yaml = "ownership: repo-managed\nsourcePath: /home/sam/Projects/demo\nconfig:\n  findingSensitivity: balanced\n  proactivity: low\n  proactivityFindings: \"medium\" # a note\n  proactivityTask: 'high'\n  taskMode: manual\n  retentionPolicy:\n    ttlDays: 90"
        assertEquals(
            ProjectKnobs(ProjectKnobs.FindingSensitivity.balanced, ProjectKnobs.Proactivity.low, ProjectKnobs.Proactivity.medium, ProjectKnobs.Proactivity.high, ProjectKnobs.TaskMode.manual),
            ProjectKnobs.parse(yaml),
        )
        assertEquals(ProjectKnobs(), ProjectKnobs.parse("sourcePath: /home/sam/demo\n"))
        assertEquals(ProjectKnobs(), ProjectKnobs.parse("config:\n  taskMode: sometimes\n"))
    }

    @Test fun applyPreservesSiblingsAndNestedBlocks() {
        val yaml = "ownership: repo-managed\nsourcePath: /home/sam/Projects/demo\nconfig:\n  findingSensitivity: balanced\n  retentionPolicy:\n    ttlDays: 90\n    decay:\n      d30: 0.9"
        assertEquals(
            "ownership: repo-managed\nsourcePath: /home/sam/Projects/demo\nconfig:\n  findingSensitivity: aggressive\n  retentionPolicy:\n    ttlDays: 90\n    decay:\n      d30: 0.9\n  taskMode: suggest",
            ProjectKnobs(findingSensitivity = ProjectKnobs.FindingSensitivity.aggressive, taskMode = ProjectKnobs.TaskMode.suggest).apply(yaml),
        )
        assertEquals("config:\n  findingSensitivity: balanced\n", ProjectKnobs(findingSensitivity = ProjectKnobs.FindingSensitivity.balanced).apply("config:\n  findingSensitivity: balanced\n  taskMode: auto\n"))
        assertEquals("", ProjectKnobs().apply(""))
        assertEquals("config:\n  proactivity: low\n", ProjectKnobs(proactivity = ProjectKnobs.Proactivity.low).apply(""))
        assertEquals("sourcePath: /home/sam/demo\nconfig:\n  taskMode: off\n", ProjectKnobs(taskMode = ProjectKnobs.TaskMode.off).apply("sourcePath: /home/sam/demo\nconfig: {}\n"))
        val desired = ProjectKnobs(ProjectKnobs.FindingSensitivity.aggressive, ProjectKnobs.Proactivity.low, ProjectKnobs.Proactivity.high, ProjectKnobs.Proactivity.medium, ProjectKnobs.TaskMode.auto)
        val base = "ownership: detached\nconfig:\n  findingSensitivity: conservative\n  proactivityFindings: high"
        assertEquals(desired, ProjectKnobs.parse(desired.apply(base)))
        val once = desired.apply(base)
        assertEquals(once, desired.apply(once))
    }

    @Test fun setProjectKnobsWritesAndRefusesStale() = runBlocking {
        val existing = "ownership: repo-managed\nsourcePath: /home/sam/Projects/demo\nconfig:\n  retentionPolicy:\n    ttlDays: 90\n"
        val (engine, store, client) = makeEngine(mapOf("demo/phren.project.yaml" to existing))
        engine.enqueue(PendingOp.SetProjectKnobs("demo", ProjectKnobs(findingSensitivity = ProjectKnobs.FindingSensitivity.aggressive, taskMode = ProjectKnobs.TaskMode.suggest), existing))
        val written = store.read("demo/phren.project.yaml")!!
        assertTrue(written.contains("ttlDays: 90") && written.contains("findingSensitivity: aggressive") && written.contains("taskMode: suggest"))
        engine.flushNow()
        assertEquals(written, client.remoteContent("demo/phren.project.yaml"))
        assertEquals(ProjectKnobs(findingSensitivity = ProjectKnobs.FindingSensitivity.aggressive, taskMode = ProjectKnobs.TaskMode.suggest), store.snapshot().projectKnobs["demo"])
        val stale = runCatching { engine.enqueue(PendingOp.SetProjectKnobs("demo", ProjectKnobs(taskMode = ProjectKnobs.TaskMode.off), "config:\n  taskMode: manual\n")) }.exceptionOrNull()
        assertTrue(stale?.message?.contains("changed since") == true)
    }

    @Test fun knobsOpSurvivesQueueReload() = runBlocking {
        val (engine, _, _) = makeEngine(emptyMap())
        val op = PendingOp.SetProjectKnobs("demo", ProjectKnobs(proactivity = ProjectKnobs.Proactivity.low), null)
        engine.enqueue(op)
        val (queue, issue) = PendingOpsQueue.load(File(directory, "pending-ops.json"))
        assertNull(issue)
        assertEquals(listOf<PendingOp>(op), queue.pending.map { it.op })
    }
}

class GraphAndSkillsTests {
    @Test fun scoreKeysAndNodeIdsMatchCLI() {
        for (sample in Fixtures.array("graph-identity.json")) {
            val key = GraphBuilder.entryScoreKey(sample.str("project")!!, sample.str("filename")!!, sample.str("snippet")!!)
            assertEquals(sample.str("scoreKey"), key)
            assertEquals(sample.str("nodeId"), GraphBuilder.findingStableId(key))
        }
    }

    @Test fun resolvesScoreKeyBackToTaggedBullet() {
        val md = "# myproj Findings\n## 2026-09-06\n- [pattern] Use the shared cache for repeated lookups <!-- fid:aaaaaaaa -->\n- [pitfall] Use the shared cache for repeated lookups <!-- fid:bbbbbbbb -->\n- short"
        val key = GraphBuilder.entryScoreKey("myproj", "FINDINGS.md", "[pitfall] Use the shared cache for repeated lookups")
        assertEquals("[pitfall] Use the shared cache for repeated lookups", GraphBuilder.findBulletText("myproj", key, md))
        assertNull(GraphBuilder.findBulletText("myproj", "myproj/FINDINGS.md:000000000000", "- [pattern] something else entirely"))
    }

    @Test fun payloadBuildsNodesAndLinks() {
        val payload = GraphBuilder.build(GraphBuilder.Input(
            mapOf("myproj" to "## 2026-09-06\n- [pattern] Use the shared cache for repeated lookups\n- Plain untagged finding with enough length\n- tiny"),
            emptyMap(), listOf("myproj"), "test-store",
        ))
        val findings = payload.nodes.filter { it.group.startsWith("topic:") }
        assertEquals(2, findings.size)
        assertEquals("pattern", findings.first { it.tagged }.topicSlug)
        assertEquals("general", findings.first { !it.tagged }.topicSlug)
        assertEquals("2026-09-06", findings.first().date)
        assertEquals(2, payload.links.count { it.source == "myproj" })
        assertEquals(2, payload.nodes.first { it.group == "project" }.findingCount)
        val json = Json.parseToJsonElement(payload.jsonString()).jsonObject
        assertTrue("nodes" in json && "links" in json)
    }

    @Test fun skillPaths() {
        listOf("global/skills/audit/SKILL.md", "global/skills/codex.md", "myproj/skills/parity.md", "myproj/skills/deploy/SKILL.md").forEach { assertTrue(LocalStore.isSkillPath(it), it) }
        listOf(
            "myproj/FINDINGS.md", "global/AGENTS.md", "global/skills/audit/reference.md", "global/skills/audit/nested/SKILL.md",
            "global/skills/notmarkdown.txt", "skills/orphan.md", "global/skills/../../etc/passwd.md", "global/skills/..md", "global/skills/.hidden.md",
        ).forEach { assertFalse(LocalStore.isSkillPath(it), it) }
        assertTrue(LocalStore.isWritablePath("global/AGENTS.md"))
        assertFalse(LocalStore.isWritablePath("myproj/summary.md"))
        assertFalse(LocalStore.isSyncedPath("global/tasks.md"))
    }

    @Test fun skillFrontmatter() {
        val sample = "---\nname: audit\ndescription: Full codebase audit.\n---\n\n# Audit\n\nBody text."
        val (front, body) = SkillFile.parseFrontmatter(sample)
        assertEquals("audit", front?.get("name"))
        assertTrue(body.startsWith("\n# Audit"))
        assertEquals("x", SkillFile.parseFrontmatter("﻿---\r\nname: x\r\ndescription: y\r\n---\r\nbody").first?.get("name"))
        assertEquals(null to "# No frontmatter", SkillFile.parseFrontmatter("# No frontmatter"))
        assertEquals(emptyList(), SkillFile.frontmatterWarnings(sample))
        assertEquals(listOf("missing required field \"description\""), SkillFile.frontmatterWarnings("---\nname: x\n---\nbody"))
        val folder = Skill.parse("global/skills/audit/SKILL.md", sample)!!
        assertEquals(Skill.Format.FOLDER, folder.format)
        assertEquals(Skill.Scope.Global, folder.scope)
        assertEquals(Skill.Scope.Project("myproj"), Skill.parse("myproj/skills/parity.md", sample)!!.scope)
        val content = SkillFile.template("audit", "Use the agent's checks: build # first\nthen review", "# Audit\n\nRead the code.")
        assertEquals("Use the agent's checks: build # first then review", Skill.parse("demo/skills/audit.md", content)?.summary)
    }
}

class AuthoredFileTests : EngineTestBase() {
    private val skillPath = "demo/skills/audit.md"
    private val instructionsPath = "demo/AGENTS.md"

    @Test fun editablePaths() {
        listOf("global/AGENTS.md", "global/CLAUDE.md", instructionsPath, "demo/CLAUDE.md", skillPath, "global/skills/audit/SKILL.md").forEach {
            assertTrue(LocalStore.isWritablePath(it), it); assertTrue(LocalStore.isSyncedPath(it), it)
        }
        listOf("AGENTS.md", "/demo/AGENTS.md", "demo//AGENTS.md", "demo/../AGENTS.md", "demo/GEMINI.md", "profiles/AGENTS.md",
            "demo.archived/AGENTS.md", "global/FINDINGS.md", "global/skills//audit.md", "/global/skills/audit.md",
            "global/skills/audit.md/", "demo/skills/audit/script.sh").forEach { assertFalse(LocalStore.isWritablePath(it), it) }
    }

    @Test fun staleWritesAreRejected() {
        for (content in listOf("Phone draft", null)) assertFailsWith<PhrenKitError> { AuthoredFile.validate(skillPath, "Remote draft", "Opened draft", content) }
        assertFailsWith<PhrenKitError> { AuthoredFile.validate(skillPath, "Existing", null, "New") }
        AuthoredFile.validate(skillPath, "Already saved", "Old", "Already saved")
        AuthoredFile.validate(skillPath, null, "Old", null)
        assertFailsWith<PhrenKitError> { AuthoredFile.validate(instructionsPath, null, null, " \n\t") }
        assertFailsWith<PhrenKitError> { AuthoredFile.validate("demo/tasks.md", null, null, "Wrong editor") }
    }

    @Test fun createKeepsInstructionsVerbatim() = runBlocking {
        val (engine, store, _) = makeEngine(emptyMap())
        val content = "---\ncustom: { nested: true }\n---\n\n# Rules\n<!-- keep this -->\nUse the project's scripts.\n"
        val op = PendingOp.SaveAuthoredFile(instructionsPath, content, null)
        engine.enqueue(op)
        assertEquals(content, store.snapshot().instructions["demo"])
        assertEquals(listOf<PendingOp>(op), PendingOpsQueue.load(File(directory, "pending-ops.json")).first.pending.map { it.op })
    }

    @Test fun rejectsSameSkillNameAcrossShapes() = runBlocking {
        val (engine, store, _) = makeEngine(mapOf("demo/skills/Audit/SKILL.md" to "Original"))
        val error = runCatching { engine.enqueue(PendingOp.SaveAuthoredFile(skillPath, "New", null)) }.exceptionOrNull()
        assertTrue(error?.message?.contains("already exists") == true)
        assertNull(store.read(skillPath))
        assertNull(AuthoredFile.conflictingSkillPath(skillPath, listOf("global/skills/audit.md")))
    }

    @Test fun moveSkillCreatesBeforeDeletingAndCarriesSetting() = runBlocking {
        val content = "---\nname: audit\ndescription: 'x'\n---\n\nRules\n"
        val prefs = "{\n  \"enabledSkills\" : {\n    \"demo:audit\" : false\n  },\n  \"schemaVersion\" : 1\n}\n"
        val (engine, store, client) = makeEngine(mapOf(skillPath to content, SkillPreferences.PATH to prefs))
        engine.moveSkill(Skill.parse(skillPath, content)!!, "other")
        assertEquals(
            listOf<PendingOp>(
                PendingOp.SaveAuthoredFile("other/skills/audit.md", content, null),
                PendingOp.DeleteAuthoredFile(skillPath, content),
                PendingOp.SetSkillEnabled("other", "audit", false, null),
            ),
            engine.pendingOps().map { it.op },
        )
        assertEquals(listOf("other/skills/audit.md"), store.snapshot().skills.map { it.path })
        assertEquals(false, SkillPreferences.parse(store.read(SkillPreferences.PATH)).explicitSetting("other", "audit"))
        engine.flushNow()
        assertEquals(content, client.remoteContent("other/skills/audit.md"))
        assertNull(client.remoteContent(skillPath))
    }

    @Test fun backgroundPullPreservesPendingDraft() = runBlocking {
        val (engine, store, client) = makeEngine(mapOf(instructionsPath to "Opened"))
        val op = PendingOp.SaveAuthoredFile(instructionsPath, "Phone", "Opened")
        engine.enqueue(op)
        client.setRemote(instructionsPath, "Computer")
        engine.pull(force = true)
        assertEquals("Phone", store.read(instructionsPath))
        assertEquals(GitBlob.sha("Opened"), store.blobSha(instructionsPath))
        client.failNextPut(instructionsPath)
        engine.flushNow()
        assertEquals("Computer", client.remoteContent(instructionsPath))
        assertEquals("Computer", store.read(instructionsPath))
        val failed = engine.failedOps()
        assertEquals(listOf<PendingOp>(op), failed.map { it.op })
        assertEquals(emptyList(), failed.first().paths)
    }

    @Test fun offlineEditsCoalesceAndConflictsDontBlockOthers() = runBlocking {
        val (engine, _, client) = makeEngine(mapOf(skillPath to "Opened"))
        engine.enqueue(PendingOp.SaveAuthoredFile(skillPath, "Draft one", "Opened"))
        engine.enqueue(PendingOp.SaveAuthoredFile(skillPath, "Draft two", "Draft one"))
        engine.flushNow()
        assertEquals(listOf("Draft two"), client.writesTo(skillPath).map { it.content })

        engine.enqueue(PendingOp.SaveAuthoredFile(skillPath, "Phone", "Draft two"))
        engine.enqueue(PendingOp.AddTask("other", "Review the app"))
        client.setRemote(skillPath, "Computer")
        client.failNextPut(skillPath)
        engine.flushNow()
        assertTrue(client.remoteContent("other/tasks.md")?.contains("Review the app") == true)
        assertEquals(1, engine.failedOps().size)
    }

    @Test fun remoteDeletionDoesNotResurrect() = runBlocking {
        val (engine, store, client) = makeEngine(mapOf(skillPath to "Opened"), remote = emptyMap())
        engine.enqueue(PendingOp.SaveAuthoredFile(skillPath, "Phone", "Opened"))
        client.failNextPut(skillPath)
        engine.flushNow()
        assertNull(client.remoteContent(skillPath))
        assertNull(store.read(skillPath))
        assertEquals(1, engine.failedOps().size)
    }
}

class SkillPreferencesTests : EngineTestBase() {
    @Test fun readsCLISettings() {
        val prefs = SkillPreferences.parse(Fixtures.text("skill-preferences.json"))
        assertEquals(false, prefs.explicitSetting("myproj", "Audit.MD"))
        assertEquals(true, prefs.explicitSetting("global", "audit"))
        assertNull(prefs.explicitSetting("other", "audit"))
    }

    @Test fun onlyPreferencesUnderConfig() {
        assertTrue(LocalStore.isWritablePath(SkillPreferences.PATH))
        listOf(".config/install-preferences.json", ".config//skill-preferences.json", "/.config/skill-preferences.json").forEach {
            assertFalse(LocalStore.isWritablePath(it)); assertFalse(LocalStore.isSyncedPath(it))
        }
    }

    @Test fun changesOneKeyPreservingUnknownAndPrintsLikeFoundation() {
        val original = """{"schemaVersion":1,"enabledSkills":{"demo:audit":false,"other:audit":true},"future":{"keep":[1,2]}}"""
        val changed = SkillPreferences.setting(original, "demo", "audit", true, false)
        assertEquals(mapOf("demo:audit" to true, "other:audit" to true), SkillPreferences.parse(changed).enabledSkills)
        assertEquals(
            "{\n  \"enabledSkills\" : {\n    \"demo:audit\" : true,\n    \"other:audit\" : true\n  },\n  \"future\" : {\n    \"keep\" : [\n      1,\n      2\n    ]\n  },\n  \"schemaVersion\" : 1\n}\n",
            changed,
        )
    }

    @Test fun malformedAndConflictingAreRefused() {
        for (bad in listOf("broken", "[]", """{"schemaVersion":2,"enabledSkills":{}}""", """{"schemaVersion":true,"enabledSkills":{}}""", """{"schemaVersion":1,"enabledSkills":{"demo:audit":"false"}}""")) {
            assertFailsWith<PhrenKitError>(bad) { SkillPreferences.setting(bad, "demo", "audit", false, null) }
        }
        val existing = """{"schemaVersion":1,"enabledSkills":{"demo:audit":true}}"""
        assertFailsWith<PhrenKitError> { SkillPreferences.setting(existing, "demo", "audit", false, null) }
        SkillPreferences.setting(existing, "demo", "audit", true, null)
        assertFailsWith<PhrenKitError> { SkillPreferences.setting(null, "../outside", "audit", false, null) }
    }

    @Test fun offlineSettingsMergeOtherDevices() = runBlocking {
        val (engine, store, client) = makeEngine(emptyMap())
        engine.enqueue(PendingOp.SetSkillEnabled("demo", "audit", false, null))
        client.setRemote(SkillPreferences.PATH, SkillPreferences.setting(null, "other", "audit", true, null))
        client.failNextPut(SkillPreferences.PATH)
        engine.flushNow()
        assertEquals(mapOf("demo:audit" to false, "other:audit" to true), SkillPreferences.parse(client.remoteContent(SkillPreferences.PATH)).enabledSkills)
        assertTrue(engine.failedOps().isEmpty())
        assertEquals(mapOf("demo:audit" to false, "other:audit" to true), SkillPreferences.parse(store.snapshot().skillPreferencesContent).enabledSkills)
    }
}

class MachineRegistryTests : EngineTestBase() {
    @Test fun parsesAndLooksUp() {
        assertEquals(
            mapOf("Mac.home.example" to "mac-mini", "Desk.local" to "mac-mini", "linuxbox" to "personal", "WORK-LAPTOP" to "ql-laptop"),
            MachineRegistry.parseMachines("# machine-name: profile-name\nMac.home.example: mac-mini\nDesk.local: mac-mini\nlinuxbox: personal\n\"WORK-LAPTOP\": 'ql-laptop'\n"),
        )
        val (name, projects) = MachineRegistry.parseProfile("name: mac-mini\nprojects:\n  - alphalens\n  - phren # the app\n  - \"objectstudio\"\nother: 1\n")
        assertEquals("mac-mini", name)
        assertEquals(listOf("alphalens", "phren", "objectstudio"), projects)
        assertEquals(listOf("a", "b"), MachineRegistry.parseProfile("name: inline\nprojects: [a, b]\n").second)
        assertNull(MachineRegistry.parseSourcePath("sourcePath: relative/path\n"))
        val r = MachineRegistry(mapOf("Desk.local" to "mac-mini", "linuxbox" to "personal"), mapOf("mac-mini" to listOf("phren", "alphalens"), "personal" to listOf("phren")))
        assertEquals(listOf("Desk.local", "linuxbox"), r.hosts("phren"))
        assertTrue(r.hosts("desk", "phren"))
        assertFalse(r.hosts("linuxbox", "alphalens"))
    }

    @Test fun registryPathsAndSnapshot() = runBlocking {
        listOf("machines.yaml", "profiles/mac-mini.yaml").forEach { assertTrue(LocalStore.isSyncedPath(it)); assertFalse(LocalStore.isWritablePath(it)) }
        assertFalse(LocalStore.isSyncedPath("profiles/nested/x.yaml"))
        val store = LocalStore(directory, "o", "r", "main")
        store.write("machines.yaml", "mini.local: home\n", "1")
        store.write("profiles/home.yaml", "name: home\nprojects:\n  - phren\n", "2")
        store.write("phren/phren.project.yaml", "sourcePath: /Users/me/phren\n", "3")
        store.write("phren/FINDINGS.md", "# Findings\n", "4")
        val snapshot = store.snapshot()
        assertEquals(listOf("mini.local"), snapshot.machines.hosts("phren"))
        assertEquals("/Users/me/phren", snapshot.machines.sourcePaths["phren"])
        assertEquals(listOf("phren"), snapshot.projects.map { it.name })
    }
}

class SecretScannerTests {
    @Test fun newShapes() {
        assertEquals("SSH private key", SecretScanner.scan("-----BEGIN PRIVATE KEY-----"))
        for (label in listOf("RSA", "EC", "OPENSSH", "DSA", "ENCRYPTED")) assertEquals("SSH private key", SecretScanner.scan("-----BEGIN $label PRIVATE KEY-----"))
        assertEquals("GitHub fine-grained token", SecretScanner.scan("use github_pat_" + "11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345 for the API"))
        assertEquals("Google API key", SecretScanner.scan("maps key AIza" + "SyD-0123456789abcdefghijklmnopqrstu"))
        assertEquals("Slack webhook URL", SecretScanner.scan("post to https://hooks.slack.com/services/" + "T00000000/B00000000/abcdefghijklmnopqrstuvwx"))
        assertEquals("URL with embedded credentials", SecretScanner.scan("remote is https://" + "octocat:ghs_aBcDeF0123456789xyz@github.com/acme/repo.git"))
        assertEquals("bearer token", SecretScanner.scan("curl -H \"Authorization: Bearer " + "aBcDeF0123456789ghIjKlMnOpQrStUv\" https://api.example.com"))
        assertEquals("registry auth token", SecretScanner.scan("//npm.pkg.github.com/:_authToken=" + "ghs0123456789abcdefXYZ"))
    }

    @Test fun previousShapes() {
        assertEquals("AWS access key", SecretScanner.scan("key is AKIA" + "IOSFODNN7EXAMPLE"))
        assertEquals("JWT token", SecretScanner.scan("token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc_def-ghi"))
        assertEquals("GitHub personal access token", SecretScanner.scan("ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"))
        assertEquals("connection string with credentials", SecretScanner.scan("mongodb://admin:password123@host:27017/db"))
        assertEquals("long base64 secret", SecretScanner.scan("the dump contained dGhpc0lzQV9mYWtlU2VjcmV0QmxvYjEyMzQ1Njc4OTBhYmNkZWZnaA/+=="))
    }

    @Test fun placeholdersAndProsePass() {
        listOf(
            "the injected line is _authToken = '__PHREN_NPM_TOKEN__'", "config uses api_key = \"YOUR_API_KEY_HERE\"",
            "set token: PHREN_EMBEDDING_API_KEY when using a cloud endpoint", "run with Authorization: Bearer \$GITHUB_TOKEN please",
            "remote https://user:\${GH_PAT}@github.com/acme/repo", "set token=<your-token-here> in the config",
            "api_key: \"{{ vault_api_key_value }}\"", "log shows password = \"xxxxxxxxxxxxxxxxxxxxxxxx\"", "token: ************************",
            "Always use parameterized queries for SQL", "", "git commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a is the fix",
            "Run it from /Projects/AbletonExtensions/critic/mudpie before recording.",
            "addFindingToFile/addFindingsToFile/upsertCanonical resolve across stores",
        ).forEach { assertNull(SecretScanner.scan(it), it) }
        assertEquals("API key or secret", SecretScanner.scan("token = \"<placeholder>\" and api_key = " + "aBcD3fGh1JkLmN0pQrStUvWxYz012345"))
        listOf("<token>", "{{ api_key }}", "\${GITHUB_TOKEN}", "%API_KEY%", "__PHREN_NPM_TOKEN__", "\$GH_PAT", "YOUR_API_KEY_HERE",
            "xxxxxxxx", "************", "00000000", "changeme", "REDACTED", "your-token", "api_key_goes_here", "''", "   ", "'__TEMPLATE__'",
        ).forEach { assertTrue(SecretScanner.looksLikePlaceholderSecret(it), it) }
        listOf("aBcD3fGh1JkLmN0pQrStUvWxYz012345", "password123", "hunter2", "AKIAIOSFODNN7EXAMPLE").forEach { assertFalse(SecretScanner.looksLikePlaceholderSecret(it), it) }
    }
}
