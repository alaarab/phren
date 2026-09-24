package com.phren.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

/** A project's (or global's) agent instructions file (AgentInstructions.swift). */
object AgentInstructions {
    const val FILE_NAME = "AGENTS.md"
    const val LEGACY_FILE_NAME = "CLAUDE.md"

    fun isPath(path: String): Boolean {
        val parts = path.split("/")
        return parts.size == 2 && LocalStore.isReadableProjectDirName(parts[0]) && parts[1] in setOf(FILE_NAME, LEGACY_FILE_NAME)
    }

    fun template(scope: String) = "# ${if (scope == "global") "Global agent instructions" else scope}\n\n## Working instructions\n\n"
}

/** Validation for skills and instructions edited on the phone (AuthoredFile). */
object AuthoredFile {
    fun validate(path: String, current: String?, expected: String?, content: String?) {
        if (!(LocalStore.isSkillPath(path) || AgentInstructions.isPath(path))) throw PhrenKitError.Validation("That file cannot be edited here.")
        if (content != null) {
            if (content.isBlank()) throw PhrenKitError.EmptyInput("Add some instructions before saving.")
            SecretScanner.scan(content)?.let { throw PhrenKitError.SecretDetected(it) }
        }
        if (!(current == expected || current == content)) {
            throw PhrenKitError.Validation("$path changed since you opened it. Your draft is preserved. Review the latest version before saving again.")
        }
    }

    fun conflictingSkillPath(path: String, among: List<String>): String? {
        val skill = Skill.parse(path, "") ?: return null
        return among.sorted().firstOrNull { candidate ->
            if (candidate == path) return@firstOrNull false
            val other = Skill.parse(candidate, "") ?: return@firstOrNull false
            other.scope == skill.scope && other.name.lowercase() == skill.name.lowercase()
        }
    }
}

/** A skill in `<scope>/skills/<name>.md` or `<scope>/skills/<name>/SKILL.md`. */
data class Skill(
    val path: String,
    val name: String,
    val scope: Scope,
    val format: Format,
    val title: String? = null,
    val summary: String? = null,
    val content: String,
) {
    sealed interface Scope {
        val source: String
        data object Global : Scope { override val source = "global" }
        data class Project(val name: String) : Scope { override val source get() = name }
    }

    enum class Format { FLAT, FOLDER }

    val id: String get() = path

    companion object {
        fun parse(path: String, content: String): Skill? {
            val parts = path.split("/").filter { it.isNotEmpty() }
            if (parts.size < 3 || parts[1] != "skills") return null
            val scope: Scope = if (parts[0] == "global") Scope.Global else Scope.Project(parts[0])
            val (name, format) = when {
                parts.size == 3 && parts[2].endsWith(".md") -> parts[2].dropLast(3) to Format.FLAT
                parts.size == 4 && parts[3] == "SKILL.md" -> parts[2] to Format.FOLDER
                else -> return null
            }
            val front = SkillFile.parseFrontmatter(content).first
            return Skill(path, name, scope, format, front?.get("name"), front?.get("description"), content)
        }
    }
}

/** YAML frontmatter helpers for skills (SkillFile.swift). */
object SkillFile {
    fun parseFrontmatter(raw: String): Pair<Map<String, String>?, String> {
        var text = raw.removePrefix("﻿").replace("\r\n", "\n").replace("\r", "\n")
        if (!text.startsWith("---\n")) return null to text
        val afterOpen = 4
        var close = text.indexOf("\n---\n", afterOpen)
        var closeEnd = close + 5
        if (close < 0) {
            close = text.lastIndexOf("\n---")
            if (close < afterOpen) return null to text
            closeEnd = close + 4
        }
        val yaml = text.substring(afterOpen, close)
        val body = text.substring(closeEnd)
        val parsed = parseScalarYAML(yaml)
        return (if (parsed.isEmpty()) null else parsed) to body
    }

    internal fun parseScalarYAML(yaml: String): Map<String, String> {
        val result = linkedMapOf<String, String>()
        for (line in yaml.split("\n")) {
            if (line.startsWith("#") || line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-")) continue
            val colon = line.indexOf(':')
            if (colon < 0) continue
            val key = line.substring(0, colon).trim(' ', '\t')
            var value = line.substring(colon + 1).trim(' ', '\t')
            if (key.isEmpty() || value.isEmpty()) continue
            if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
                val single = value.startsWith("'")
                value = value.substring(1, value.length - 1)
                if (single) value = value.replace("''", "'")
            }
            result[key] = value
        }
        return result
    }

    fun frontmatterWarnings(content: String): List<String> {
        val front = parseFrontmatter(content).first ?: return listOf("missing or invalid YAML frontmatter")
        return listOf("name", "description").mapNotNull { field ->
            if (front[field]?.trim().isNullOrEmpty()) "missing required field \"$field\"" else null
        }
    }

    fun template(name: String) = "---\nname: $name\ndescription:\n---\n# $name"

    fun template(name: String, description: String, instructions: String): String {
        val summary = description.trim().replace("\r\n", " ").replace("\n", " ").replace("\r", " ").replace("'", "''")
        return "---\nname: $name\ndescription: '$summary'\n---\n\n$instructions\n"
    }
}

/** `.config/skill-preferences.json` (SkillPreferences.swift). */
data class SkillPreferences(val schemaVersion: Int, val enabledSkills: Map<String, Boolean>) {
    fun explicitSetting(scope: String, name: String): Boolean? = enabledSkills[key(scope, name)]

    companion object {
        const val PATH = ".config/skill-preferences.json"
        val empty = SkillPreferences(1, emptyMap())

        fun key(scope: String, name: String): String {
            val stem = name.replace(Regex("\\.md$", RegexOption.IGNORE_CASE), "")
            return "$scope:${stem.trim().lowercase()}"
        }

        fun parse(content: String?): SkillPreferences {
            if (content == null) return empty
            val obj = try { Json.parseToJsonElement(content).jsonObject } catch (e: Exception) { throw PhrenKitError.Validation("Skill settings are unreadable: ${e.message}") }
            val version = (obj["schemaVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull ?: throw PhrenKitError.Validation("Skill settings are unreadable.")
            if (version != 1) throw PhrenKitError.Validation("Update phren to read this store's skill settings.")
            if ((obj["schemaVersion"] as JsonPrimitive).isString) throw PhrenKitError.Validation("Skill settings are unreadable.")
            val skills = obj["enabledSkills"] as? JsonObject ?: throw PhrenKitError.Validation("Skill settings are unreadable.")
            // Decodable semantics: every value must be a real boolean.
            val enabled = skills.mapValues { (_, v) ->
                (v as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: throw PhrenKitError.Validation("Skill settings are unreadable.")
            }
            return SkillPreferences(version, enabled)
        }

        fun setting(content: String?, scope: String, name: String, enabled: Boolean, expected: Boolean?): String {
            if (!LocalStore.isSkillPath("$scope/skills/$name.md")) throw PhrenKitError.Validation("Invalid skill scope or name.")
            val current = parse(content)
            val existing = current.explicitSetting(scope, name)
            if (!(existing == expected || existing == enabled)) {
                throw PhrenKitError.Validation("This skill's setting changed on another device. Refresh and choose again.")
            }
            val document = LinkedHashMap<String, JsonElement>()
            if (content != null) document.putAll(Json.parseToJsonElement(content).jsonObject)
            val settings = (current.enabledSkills + (key(scope, name) to enabled)).toSortedMap()
            document["schemaVersion"] = JsonPrimitive(1)
            document["enabledSkills"] = JsonObject(settings.mapValues { JsonPrimitive(it.value) })
            return AppleJson.pretty(JsonObject(document)) + "\n"
        }
    }
}

/** Which computer carries which project (MachineRegistry.swift). */
data class MachineRegistry(
    val machines: Map<String, String> = emptyMap(),
    val profiles: Map<String, List<String>> = emptyMap(),
    val sourcePaths: Map<String, String> = emptyMap(),
) {
    fun hosts(project: String): List<String> = machines.filter { profiles[it.value]?.contains(project) == true }.keys.sorted()

    fun hosts(hostname: String, project: String): Boolean {
        val wanted = canonical(hostname)
        return machines.any { canonical(it.key) == wanted && profiles[it.value]?.contains(project) == true }
    }

    companion object {
        val empty = MachineRegistry()
        const val MACHINES_FILE = "machines.yaml"
        const val PROJECT_FILE = "phren.project.yaml"
        private val PROFILE_NAME = JSRegex("""^[A-Za-z0-9][A-Za-z0-9._-]*\.yaml$""")

        fun isProfilePath(path: String): Boolean {
            val parts = path.split("/")
            return parts.size == 2 && parts[0] == "profiles" && parts[1].endsWith(".yaml") && PROFILE_NAME.test(parts[1])
        }

        internal fun canonical(hostname: String): String = hostname.lowercase().removeSuffix(".local")

        fun parseMachines(content: String): Map<String, String> {
            val result = linkedMapOf<String, String>()
            for (raw in content.split("\n")) {
                val line = raw.trim(' ', '\t')
                if (line.isEmpty() || line.startsWith("#")) continue
                val colon = line.indexOf(':').takeIf { it >= 0 } ?: continue
                val host = unquote(line.substring(0, colon))
                val profile = unquote(line.substring(colon + 1))
                if (host.isNotEmpty() && profile.isNotEmpty()) result[host] = profile
            }
            return result
        }

        fun parseProfile(content: String): Pair<String?, List<String>> {
            var name: String? = null
            var projects = mutableListOf<String>()
            var inProjects = false
            for (raw in content.split("\n")) {
                val line = raw.trim(' ', '\t')
                if (line.isEmpty() || line.startsWith("#")) continue
                if (line.startsWith("- ")) {
                    if (inProjects) projects += unquote(line.drop(2))
                    continue
                }
                inProjects = false
                val colon = line.indexOf(':').takeIf { it >= 0 } ?: continue
                val key = line.substring(0, colon).trim(' ', '\t')
                val value = unquote(line.substring(colon + 1))
                if (key == "name") name = value
                else if (key == "projects") {
                    inProjects = true
                    if (value.startsWith("[")) projects = value.drop(1).dropLast(1).split(",").map { unquote(it) }.toMutableList()
                }
            }
            return name to projects.filter { it.isNotEmpty() }
        }

        fun parseSourcePath(content: String): String? {
            for (raw in content.split("\n")) {
                val line = raw.trim(' ', '\t')
                if (!line.startsWith("sourcePath:")) continue
                val value = unquote(line.removePrefix("sourcePath:"))
                return if (value.startsWith("/")) value else null
            }
            return null
        }

        internal fun unquote(value: String): String {
            var text = value.trim(' ', '\t')
            val hash = text.indexOf(" #")
            if (hash >= 0) text = text.substring(0, hash).trim(' ', '\t')
            if (text.length >= 2 && text.first() == text.last() && (text.first() == '"' || text.first() == '\'')) text = text.substring(1, text.length - 1)
            return text
        }
    }
}

/** A project's `config:` knobs in phren.project.yaml (ProjectKnobs.swift). */
@kotlinx.serialization.Serializable
data class ProjectKnobs(
    val findingSensitivity: FindingSensitivity? = null,
    val proactivity: Proactivity? = null,
    val proactivityFindings: Proactivity? = null,
    val proactivityTask: Proactivity? = null,
    val taskMode: TaskMode? = null,
) {
    @kotlinx.serialization.Serializable
    enum class FindingSensitivity { minimal, conservative, balanced, aggressive }
    @kotlinx.serialization.Serializable
    enum class Proactivity { high, medium, low }
    @kotlinx.serialization.Serializable
    enum class TaskMode { off, manual, suggest, auto }

    val setCount: Int get() = listOf(findingSensitivity, proactivity, proactivityFindings, proactivityTask, taskMode).count { it != null }

    private val rawValues: List<Pair<String, String?>>
        get() = listOf(
            "findingSensitivity" to findingSensitivity?.name,
            "proactivity" to proactivity?.name,
            "proactivityFindings" to proactivityFindings?.name,
            "proactivityTask" to proactivityTask?.name,
            "taskMode" to taskMode?.name,
        )

    /** Rewrites only the knob lines of the `config:` block, preserving everything else. */
    fun apply(yaml: String): String {
        val desired = rawValues
        val lines = yaml.split("\n").toMutableList()
        val trailing = if (lines.lastOrNull() == "") 1 else 0
        val contentEnd = lines.size - trailing
        val header = configHeaderIndex(lines)
        if (header == null) {
            val entries = desired.mapNotNull { (k, v) -> v?.let { "  $k: $it" } }
            if (entries.isEmpty()) return yaml
            lines.addAll(contentEnd, listOf("config:") + entries)
            return lines.joinToString("\n")
        }
        if (desired.any { it.second != null }) {
            val colon = lines[header].indexOf(':')
            if (colon >= 0) {
                val after = lines[header].substring(colon + 1).trim(' ', '\t')
                if (after.isEmpty() || after == "{}") lines[header] = "config:"
            }
        }
        var blockEnd = header + 1
        while (blockEnd < contentEnd) {
            val line = lines[blockEnd]
            val trimmed = line.trim(' ', '\t')
            if (trimmed.isNotEmpty() && line == trimmed) break
            blockEnd++
        }
        val indent = blockIndent(lines, header)
        val present = mutableSetOf<String>()
        val output = mutableListOf<String>()
        lines.forEachIndexed { index, line ->
            if (index > header && index < blockEnd) {
                val entry = scalarLine(line)
                if (entry != null && desired.any { it.first == entry.first }) {
                    present += entry.first
                    desired.first { it.first == entry.first }.second?.let { value ->
                        val lineIndent = line.takeWhile { it == ' ' || it == '\t' }
                        output += "$lineIndent${entry.first}: $value"
                    }
                } else output += line
            } else output += line
            if (index == blockEnd - 1) {
                for ((k, v) in desired) if (v != null && k !in present) output += "$indent$k: $v"
            }
        }
        return output.joinToString("\n")
    }

    companion object {
        fun parse(yaml: String): ProjectKnobs {
            val lines = yaml.split("\n")
            val header = configHeaderIndex(lines) ?: return ProjectKnobs()
            var knobs = ProjectKnobs()
            for (line in lines.drop(header + 1)) {
                val trimmed = line.trim(' ', '\t')
                if (trimmed.isNotEmpty() && line == trimmed) break
                val (key, value) = scalarLine(line) ?: continue
                knobs = when (key) {
                    "findingSensitivity" -> knobs.copy(findingSensitivity = FindingSensitivity.entries.firstOrNull { it.name == value })
                    "proactivity" -> knobs.copy(proactivity = Proactivity.entries.firstOrNull { it.name == value })
                    "proactivityFindings" -> knobs.copy(proactivityFindings = Proactivity.entries.firstOrNull { it.name == value })
                    "proactivityTask" -> knobs.copy(proactivityTask = Proactivity.entries.firstOrNull { it.name == value })
                    "taskMode" -> knobs.copy(taskMode = TaskMode.entries.firstOrNull { it.name == value })
                    else -> knobs
                }
            }
            return knobs
        }

        private fun configHeaderIndex(lines: List<String>): Int? {
            lines.forEachIndexed { index, line ->
                val trimmed = line.trim(' ', '\t')
                if (trimmed.isEmpty() || trimmed.startsWith("#") || line != trimmed) return@forEachIndexed
                val colon = trimmed.indexOf(':')
                if (colon >= 0 && trimmed.substring(0, colon).trim() == "config") return index
            }
            return null
        }

        private fun scalarLine(raw: String): Pair<String, String>? {
            if (!(raw.startsWith(" ") || raw.startsWith("\t"))) return null
            val trimmed = raw.trim(' ', '\t')
            if (trimmed.isEmpty() || trimmed.startsWith("#")) return null
            val colon = trimmed.indexOf(':').takeIf { it >= 0 } ?: return null
            val key = trimmed.substring(0, colon).trim(' ', '\t')
            if (key.isEmpty()) return null
            return key to MachineRegistry.unquote(trimmed.substring(colon + 1))
        }

        private fun blockIndent(lines: List<String>, header: Int): String {
            for (line in lines.drop(header + 1)) {
                val trimmed = line.trim(' ', '\t')
                if (trimmed.isNotEmpty() && line == trimmed) break
                if (trimmed.isNotEmpty()) {
                    val indent = line.takeWhile { it == ' ' || it == '\t' }
                    if (indent.isNotEmpty()) return indent
                }
            }
            return "  "
        }
    }
}

/**
 * `JSONSerialization.data(withJSONObject:options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])`
 * byte for byte, so a file iOS and Android both write never flips formatting.
 */
object AppleJson {
    fun pretty(e: JsonElement, indent: String = ""): String = when (e) {
        is JsonObject -> if (e.isEmpty()) "{\n\n$indent}" else e.toSortedMap().entries.joinToString(",\n", "{\n", "\n$indent}") { (k, v) ->
            "$indent  ${jsonString(k)} : ${pretty(v, "$indent  ")}"
        }
        is kotlinx.serialization.json.JsonArray -> if (e.isEmpty()) "[\n\n$indent]" else e.joinToString(",\n", "[\n", "\n$indent]") { "$indent  ${pretty(it, "$indent  ")}" }
        is JsonPrimitive -> if (e.isString) jsonString(e.content) else e.content
    }
}
