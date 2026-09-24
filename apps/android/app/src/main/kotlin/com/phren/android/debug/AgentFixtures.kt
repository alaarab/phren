package com.phren.android.debug

import com.phren.kit.LiveHost
import com.phren.kit.LiveSessionPreferences
import com.phren.kit.LiveWorkspaces
import com.phren.kit.live.LiveConnectionError
import java.time.Instant
import java.util.UUID

/**
 * The iOS `--store-tour-fixture --automatic-sessions-fixture --all-sessions-fixture`
 * computers and their overviews (UITestFixtures.swift, LiveHostMonitor.fetch),
 * so the Agents tab can be compared with the iOS captures. Debug launches only.
 */
object AgentFixtures {
    val hostIDs = listOf(UUID.fromString("A1000000-0000-0000-0000-000000000001"), UUID.fromString("A1000000-0000-0000-0000-000000000002"))
    private val hookIDs = listOf(UUID.fromString("C1000000-0000-0000-0000-000000000001"), UUID.fromString("C1000000-0000-0000-0000-000000000002"))
    /** When the fixture's sessions last changed: two minutes and five seconds ago. */
    private val activityDate: Instant = Instant.now().minusSeconds(125)

    fun preferences(): String {
        val mac = LiveHost(hostIDs[0], "Mac mini", "mini", username = "sam", hookComputerID = hookIDs[0], fingerprint = "SHA256:" + "A".repeat(43))
        val linux = LiveHost(hostIDs[1], "linuxbox", "linuxbox", username = "sam", hookComputerID = hookIDs[1], fingerprint = "SHA256:" + "B".repeat(43))
        return LiveSessionPreferences.saving(linux, LiveSessionPreferences.saving(mac, ""))
    }

    /** The store knows both computers carry the tour's projects. */
    val machines = "Mac mini: mac\nlinuxbox: linuxbox\n"
    fun profile(name: String) = "name: $name\nprojects:\n  - phren\n  - mina\n  - atlas\n"

    fun snapshot(host: LiveHost, previous: Instant?, offline: Boolean): LiveWorkspaces {
        val remote = host.id == hostIDs[1]
        if (remote && previous != null && offline) throw LiveConnectionError.Disconnected()
        val project = if (remote) "mina" else "phren"
        val agents = if (remote) "codex" to "claude" else "claude" to "copilot"
        val title = if (remote) "Review the deployment" else "Ship the onboarding flow"
        val other = if (remote) "Fix the widget timeline" else "Write the release notes"
        val branch = if (remote) "feature/widgets" else "release/1.0"
        val status = if (remote) "waiting" else "working"
        val changed = ",\"lastChangedAt\":\"$activityDate\""
        val tabs = listOf(
            """{"id":"w1:t1","label":"1","title":"$title","agent":"${agents.first}","agentStatus":"$status","cwd":"/work/$project","branch":"main","contextUsedPercent":${if (remote) 62 else 37}$changed}""",
            """{"id":"w1:t2","label":"2","title":"$other","agent":"${agents.second}","agentStatus":"idle","cwd":"/work/$project","branch":"$branch"}""",
        )
        return LiveWorkspaces.read("""{"kind":"herdr","groups":[{"id":"w1","label":"$project","children":[${tabs.joinToString(",")}]}]}""".toByteArray())
    }
}
