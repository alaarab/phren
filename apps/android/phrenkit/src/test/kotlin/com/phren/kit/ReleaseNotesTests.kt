package com.phren.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ReleaseNotesTests {
    @Test fun sectionsGroupsBulletsAndWrappedLines() {
        val notes = ReleaseNotes("""
            # Changelog

            Preamble that is not part of any release.

            ## 0.0.6

            ### New

            - Shell commands show what they changed, right under
              the call.
            - Queue messages while the agent works.

            ### Fixed

            - "Couldn't move skill" for base64.

            ## 0.0.5 (build 40)

            Only a note here.

            ## Earlier

            Builds 1–39 predate this changelog.
        """.trimIndent())
        assertEquals(listOf("0.0.6", "0.0.5 (build 40)", "Earlier"), notes.releases.map { it.version })
        val latest = notes.release("0.0.6")!!
        assertEquals(listOf("New", "Fixed"), latest.groups.map { it.title })
        assertEquals(listOf("Shell commands show what they changed, right under the call.", "Queue messages while the agent works."), latest.groups[0].items)
        assertEquals(listOf("\"Couldn't move skill\" for base64."), latest.groups[1].items)
        assertTrue(latest.notes.isEmpty())
        assertEquals(listOf("Only a note here."), notes.release("0.0.5")?.notes)
        assertTrue(notes.release("0.0.5")!!.groups.isEmpty())
        assertNull(notes.release("0.0.7"))
        assertTrue(ReleaseNotes("").releases.isEmpty())
    }
}
