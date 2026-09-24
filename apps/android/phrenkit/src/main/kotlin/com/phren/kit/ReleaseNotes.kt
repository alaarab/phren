package com.phren.kit

/**
 * The app's CHANGELOG.md for "What's new" (ReleaseNotes.swift): one
 * `## <version>` section per release, `### ` groups inside it, one `- `
 * bullet per change with indented continuation lines. Other text in a
 * section is kept as a note.
 */
class ReleaseNotes(markdown: String) {
    data class Group(val title: String, val items: List<String>)
    data class Release(val version: String, val groups: List<Group>, val notes: List<String>) {
        val isEmpty: Boolean get() = groups.all { it.items.isEmpty() } && notes.isEmpty()
    }

    val releases: List<Release>

    init {
        val out = mutableListOf<Release>()
        var version: String? = null
        val groups = mutableListOf<Group>()
        var title = ""
        val items = mutableListOf<String>()
        val notes = mutableListOf<String>()
        fun closeGroup() { if (items.isNotEmpty() || title.isNotEmpty()) groups += Group(title, items.toList()); items.clear(); title = "" }
        fun closeRelease() { closeGroup(); version?.let { out += Release(it, groups.toList(), notes.toList()) }; groups.clear(); notes.clear() }
        for (raw in markdown.take(262_144).split("\n")) {
            val line = raw.trim(' ', '\t')
            when {
                raw.startsWith("## ") -> { closeRelease(); version = raw.drop(3).trim(' ', '\t') }
                raw.startsWith("### ") -> { closeGroup(); title = raw.drop(4).trim(' ', '\t') }
                line.startsWith("- ") -> items += line.drop(2)
                line.isNotEmpty() && version != null && !raw.startsWith("#") -> {
                    if (raw.startsWith("  ") && items.isNotEmpty()) items[items.lastIndex] = items.last() + " " + line
                    else if (title.isEmpty()) notes += line
                }
            }
        }
        closeRelease()
        releases = out
    }

    /** "0.0.6" matches "## 0.0.6" and "## 0.0.6 (build 61)" alike. */
    fun release(version: String): Release? = releases.firstOrNull { it.version == version || it.version.startsWith("$version ") }
}
