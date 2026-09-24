package com.phren.kit

import java.time.Duration
import java.time.Instant

object SessionRelativeTime {
    /** Compact and deliberately stable at minute/hour/day boundaries. */
    fun text(since: Instant, at: Instant): String {
        val elapsed = maxOf(0L, Duration.between(since, at).seconds)
        if (elapsed < 10) return "now"
        if (elapsed < 60) return "${elapsed}s ago"
        if (elapsed < 3_600) return "${elapsed / 60}m ago"
        if (elapsed < 86_400) return "${elapsed / 3_600}h ago"
        return "${elapsed / 86_400}d ago"
    }
}
