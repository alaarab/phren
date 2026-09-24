package com.phren.kit

/**
 * Hand-rolled parser for the CLI's root `stores.yaml` registry
 * (packages/cli/src/store-registry.ts `StoreRegistry`). Port of
 * StoresManifest.swift: `js-yaml`'s `dump` always renders this block style, so
 * a line-by-line indentation walk is sufficient. Anything outside the shape is
 * read tolerantly and ignored rather than rejected.
 */
data class StoresManifest(val stores: List<Entry> = emptyList()) {
    /** One `stores:` list entry. Only `name`, `role`, `projects` are read. */
    data class Entry(
        val id: String? = null,
        val name: String,
        /** Raw registry role string, kept as-is so a future role still parses. */
        val role: String,
        val projects: List<String> = emptyList(),
    ) {
        val isPrimary: Boolean get() = role == "primary"
    }

    /**
     * The non-primary entry (other than the store the project physically
     * lives in) whose `projects` list names `project`.
     */
    fun claimingEntry(project: String, physicalStoreName: String?): Entry? =
        stores.firstOrNull { !it.isPrimary && it.name != physicalStoreName && project in it.projects }

    companion object {
        val empty = StoresManifest()

        /** Never throws: a garbled registry yields fewer (or zero) entries. */
        fun parse(content: String): StoresManifest {
            val entries = mutableListOf<Entry>()
            var current: MutableEntry? = null
            var entryIndent: Int? = null
            var keyIndent: Int? = null
            var projectsMode = false
            var inStores = false

            fun flush() {
                current?.let { if (it.name.isNotEmpty()) entries += it.freeze() }
                current = null
                projectsMode = false
            }

            for (rawLine in content.split("\n")) {
                val line = rawLine.removeSuffix("\r")
                val trimmed = line.trim(' ', '\t')
                if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
                val indent = line.takeWhile { it == ' ' }.length

                if (indent == 0) {
                    if (trimmed == "stores:") {
                        inStores = true
                    } else if (inStores) {
                        flush()
                        inStores = false
                    }
                    continue
                }
                if (!inStores) continue

                val isDashLine = trimmed.startsWith("-")
                if (isDashLine && entryIndent == null) {
                    entryIndent = indent
                    keyIndent = indent + 2
                }
                if (isDashLine && indent == entryIndent) {
                    flush()
                    val entry = MutableEntry()
                    current = entry
                    val rest = trimmed.drop(1).trim(' ', '\t')
                    if (rest.isNotEmpty()) entry.apply(rest)
                    continue
                }
                val entry = current ?: continue
                val ki = keyIndent
                if (isDashLine && projectsMode && ki != null && indent > ki) {
                    val item = trimmed.drop(1).trim(' ', '\t')
                    if (item.isNotEmpty()) entry.projects += item
                    continue
                }
                projectsMode = false
                entry.apply(trimmed)
                if (trimmed.startsWith("projects:")) {
                    projectsMode = trimmed.removePrefix("projects:").trim(' ', '\t').isEmpty()
                }
            }
            flush()
            return StoresManifest(entries)
        }

        private class MutableEntry {
            var id: String? = null
            var name = ""
            var role = ""
            val projects = mutableListOf<String>()

            fun apply(pair: String) {
                val colon = pair.indexOf(':')
                if (colon < 0) return
                val key = pair.substring(0, colon).trim(' ', '\t')
                val value = unquoteYamlScalar(pair.substring(colon + 1).trim(' ', '\t'))
                when (key) {
                    "id" -> id = value.ifEmpty { null }
                    "name" -> name = value
                    "role" -> role = value
                    "projects" -> if (value.startsWith("[") && value.endsWith("]")) {
                        projects.clear()
                        projects += value.drop(1).dropLast(1).split(",").map { it.trim(' ', '\t') }.filter { it.isNotEmpty() }
                    }
                }
            }

            fun freeze() = Entry(id, name, role, projects.toList())
        }
    }
}

internal fun unquoteYamlScalar(value: String): String =
    if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))))
        value.substring(1, value.length - 1)
    else value

/**
 * The `.phren-team.yaml` a team store repo carries at its root. Transcribes
 * `readTeamBootstrap` (packages/cli/src/store-registry.ts:220) via
 * TeamBootstrap.swift.
 */
data class TeamBootstrap(
    val name: String,
    val description: String? = null,
    val defaultRole: String? = null,
) {
    /** A bootstrap file that names no role still means "team" (cli/team.ts:80). */
    val role: String get() = defaultRole ?: "team"

    companion object {
        const val FILE_NAME = ".phren-team.yaml"

        /** store-registry.ts:12 `StoreRole` */
        val validRoles = setOf("primary", "team", "readonly")

        fun parse(content: String): TeamBootstrap? {
            var name: String? = null
            var description: String? = null
            var defaultRole: String? = null
            for (rawLine in content.split("\n")) {
                val line = rawLine.removeSuffix("\r")
                if (line != line.trim(' ', '\t')) continue
                val trimmed = line
                if (trimmed.isEmpty() || trimmed.startsWith("#")) continue
                val colon = trimmed.indexOf(':')
                if (colon < 0) continue
                val key = trimmed.substring(0, colon).trim(' ', '\t')
                val value = unquoteYamlScalar(trimmed.substring(colon + 1).trim(' ', '\t'))
                if (value.isEmpty()) continue
                when (key) {
                    "name" -> name = value
                    "description" -> description = value
                    "default_role" -> defaultRole = value.takeIf { it in validRoles }
                }
            }
            return name?.let { TeamBootstrap(it, description, defaultRole) }
        }
    }
}
