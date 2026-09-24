package com.phren.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PendingOpsPersistenceTests {
    /** `type` on AddFinding once collided with the class discriminator, so no queue with a finding could be saved. */
    @Test fun queueWithEveryOpRoundTrips() {
        val dir = kotlin.io.path.createTempDirectory().toFile()
        val file = java.io.File(dir, "pending-ops.json")
        val ops = listOf(
            PendingOp.AddFinding("phren", "Hello", "pattern"),
            PendingOp.EditFinding("phren", "fid:1", "Hi"),
            PendingOp.AddNote("phren", "2026-09-24", "10:00:00", "note"),
            PendingOp.PromoteNote("phren", "2026-09-24", "aa11bb22", "decision"),
            PendingOp.SaveAuthoredFile("phren/skills/a.md", "x"),
            PendingOp.SetSkillEnabled("global", "a", true),
        )
        val queue = PendingOpsQueue(pending = ops.map { QueuedOp(op = it) })
        assertNull(queue.save(file))
        assertEquals(ops, PendingOpsQueue.load(file).first.pending.map { it.op })
    }
}
