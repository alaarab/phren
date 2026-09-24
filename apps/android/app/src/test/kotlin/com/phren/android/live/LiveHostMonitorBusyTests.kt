package com.phren.android.live

import com.phren.kit.LiveHost
import com.phren.kit.LiveWorkspaces
import com.phren.kit.live.LiveConnectionError
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.time.Instant
import org.junit.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Seen 2026-09-24: a saturated Mac mini answered /v1/health in under a second
 * while /v1/workspaces outlasted the phone's 20 s wait. The phone called it
 * offline and disabled every tile, though chat and terminal would have worked.
 */
class LiveHostMonitorBusyTests {
    private val host = LiveHost(name = "Mini", address = "mini.invalid", username = "fixture")
    private val working = LiveWorkspaces.read("""{"kind":"herdr","groups":[{"id":"w1","label":"phren","children":[{"id":"w1:t1","label":"1","title":"Build","agent":"claude","agentStatus":"working","cwd":"/work/phren"}]}]}""".toByteArray())

    private suspend fun eventually(condition: () -> Boolean) = withTimeout(5_000) { while (!condition()) delay(10) }

    @Test fun busyComputerKeepsItsSessionsUsableUntilTheOverviewCatchesUp() = runBlocking {
        var overloaded = false
        var healthAnswers = true
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val monitor = LiveHostMonitor(scope, fetchSnapshot = { _, _ -> if (overloaded) throw LiveConnectionError.Timeout() else working },
            openStream = null, pollInterval = 20, probe = { if (!healthAnswers) throw LiveConnectionError.Disconnected() })
        scope.launch { monitor.run(host) }
        eventually { monitor.isFresh() }

        overloaded = true
        eventually { monitor.busy }
        // Long past the answer's freshness: only the Hook's health keeps it live.
        monitor.lastUpdated = Instant.now().minusSeconds(FRESH_SECONDS + 1)
        assertNull(monitor.message, "a computer whose Hook answers is not offline")
        assertTrue(monitor.isLive(), "its last known sessions stay tappable")
        assertFalse(monitor.isStale())
        assertFalse(monitor.isConnecting, "busy, not connecting")
        assertNotNull(monitor.snapshot, "the last known sessions are kept")

        // A computer that doesn't answer at all is still offline.
        healthAnswers = false
        eventually { monitor.message != null }
        assertFalse(monitor.busy)
        assertFalse(monitor.isLive())

        // The overview catches up: live again.
        overloaded = false; healthAnswers = true
        eventually { monitor.message == null && !monitor.busy && monitor.isFresh() }
        scope.cancel()
    }

    @Test fun keyProblemsAreNeverBusy() {
        assertFalse(worthProbing(LiveConnectionError.UntrustedHost("SHA256:x")))
        assertFalse(worthProbing(LiveConnectionError.ChangedHost()))
        assertFalse(worthProbing(LiveConnectionError.Authentication()))
        assertTrue(worthProbing(LiveConnectionError.Timeout()))
    }
}
