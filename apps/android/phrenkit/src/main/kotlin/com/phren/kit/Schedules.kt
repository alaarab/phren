package com.phren.kit

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit
import java.util.UUID
import kotlinx.serialization.builtins.serializer

/** ISO-8601 read/write matching ISO8601Dates.swift. */
object ISO8601Dates {
    private val fractionalWriter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
    private val wholeWriter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(ZoneOffset.UTC)

    fun parse(text: String?): Instant? {
        if (text == null) return null
        try { return OffsetDateTime.parse(text).toInstant() } catch (_: DateTimeParseException) {}
        if (text.length == 10) try { return LocalDate.parse(text).atStartOfDay(ZoneOffset.UTC).toInstant() } catch (_: DateTimeParseException) {}
        return null
    }

    fun string(date: Instant, fractionalSeconds: Boolean = false): String =
        (if (fractionalSeconds) fractionalWriter else wholeWriter).format(date)
}

/** A `schedules.yaml` entry: an agent prompt run on a computer (SchedulesFile.swift). */
data class Schedule(
    val id: String,
    val name: String,
    val enabled: Boolean,
    val computer: String,
    val harness: Harness,
    val model: String? = null,
    val notify: Set<Notify> = Notify.defaults,
    val every: Every,
    val prompt: String,
    val createdAt: Instant,
    val updatedAt: Instant,
) {
    enum class Harness(val rawValue: String) { CLAUDE("claude"), CODEX("codex"), OPENCODE("opencode");
        companion object { fun from(raw: String?) = entries.firstOrNull { it.rawValue == raw } }
    }

    enum class Weekday(val rawValue: String) { MON("mon"), TUE("tue"), WED("wed"), THU("thu"), FRI("fri"), SAT("sat"), SUN("sun");
        companion object { fun from(raw: String?) = entries.firstOrNull { it.rawValue == raw } }
    }

    enum class Notify(val rawValue: String) { START("start"), FINISH("finish"), FAILURE("failure");
        companion object {
            val defaults = setOf(FINISH, FAILURE)
            fun from(raw: String?) = entries.firstOrNull { it.rawValue == raw }
        }
    }

    sealed interface Every {
        val kind: String
        data class Interval(val minutes: Int) : Every { override val kind = "interval" }
        data class Daily(val hour: Int, val minute: Int) : Every { override val kind = "daily" }
        data class Weekly(val days: Set<Weekday>, val hour: Int, val minute: Int) : Every { override val kind = "weekly" }
        /** A wall-clock time on the phone's calendar. */
        data class Once(val date: LocalDateTime) : Every { override val kind = "once" }
        data class Cron(val expression: String) : Every { override val kind = "cron" }
    }

    companion object {
        fun generateID(): String = UUID.randomUUID().toString().replace("-", "").lowercase().take(8)
    }
}

object SchedulesFile {
    const val FILE_NAME = "schedules.yaml"
    const val MAXIMUM_SCHEDULES = 64

    private val ID = JSRegex("""^[0-9a-fA-F]{8}$""")
    private val INTERVAL = JSRegex("""^[1-9][0-9]*[mhd]$""")
    private val TIME = JSRegex("""^([01]\d|2[0-3]):[0-5]\d$""")
    private val SAFE_SCALAR = JSRegex("""^[A-Za-z0-9][A-Za-z0-9._/@ -]*$""")
    private val DIGITS = JSRegex("""^[0-9]+$""")
    private val onceFormats = listOf("yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm").map { DateTimeFormatter.ofPattern(it) }

    fun parse(text: String): List<Schedule> {
        val lines = text.split("\n")
        val range = schedulesRange(lines) ?: return emptyList()
        val entries = mutableListOf<Map<String, String>>()
        var fields: MutableMap<String, String>? = null
        var index = range.first + 1
        fun finish() { fields?.let { entries += it }; fields = null }
        while (index < range.last + 1) {
            val raw = lines[index]
            val indent = indentation(raw)
            val trimmed = raw.trim(' ', '\t')
            if (trimmed.startsWith("- ") && indent > 0) {
                finish()
                fields = mutableMapOf()
                mapping(trimmed.drop(2))?.let { (k, v) -> fields!![k] = scalar(v) }
                index++
                continue
            }
            val pair = if (fields != null && trimmed.isNotEmpty() && !trimmed.startsWith("#")) mapping(trimmed) else null
            if (pair == null) { index++; continue }
            if (pair.first == "prompt" && pair.second.startsWith("|")) {
                val style = pair.second
                val block = mutableListOf<String>()
                index++
                while (index < range.last + 1) {
                    val line = lines[index]
                    if (line.trim(' ', '\t').isNotEmpty() && indentation(line) <= indent) break
                    block += line
                    index++
                }
                fields!![pair.first] = literal(block, indent, style)
                continue
            }
            fields!![pair.first] = scalar(pair.second)
            index++
        }
        finish()
        val schedules = mutableListOf<Schedule>()
        val ids = mutableSetOf<String>()
        for (entry in entries) {
            if (schedules.size >= MAXIMUM_SCHEDULES) break
            val s = schedule(entry) ?: continue
            if (ids.add(s.id)) schedules += s
        }
        return schedules
    }

    fun render(schedules: List<Schedule>, original: String? = null): String {
        val replacement = renderBlock(schedules.take(MAXIMUM_SCHEDULES))
        if (original.isNullOrEmpty()) return (listOf("version: 1") + replacement).joinToString("\n") + "\n"
        val lines = original.split("\n").toMutableList()
        schedulesRange(lines)?.let { range ->
            repeat(range.last - range.first + 1) { lines.removeAt(range.first) }
            lines.addAll(range.first, replacement)
            var rendered = lines.joinToString("\n")
            if (original.endsWith("\n") && !rendered.endsWith("\n")) rendered += "\n"
            return rendered
        }
        if (lines.none { topLevelKey(it) == "version" }) lines.add(0, "version: 1")
        val trailingEmpty = lines.lastOrNull() == ""
        if (trailingEmpty) lines.removeAt(lines.lastIndex)
        if (lines.isNotEmpty() && lines.last().isNotEmpty()) lines += ""
        lines += replacement
        if (trailingEmpty) lines += ""
        return lines.joinToString("\n")
    }

    private fun schedule(f: Map<String, String>): Schedule? {
        val id = f["id"]?.takeIf { ID.test(it) } ?: return null
        val name = f["name"]?.takeIf { it.isNotEmpty() && it.length <= 80 } ?: return null
        val enabled = f["enabled"]?.let(::bool) ?: return null
        val computer = f["computer"]?.takeIf { it.isNotEmpty() } ?: return null
        val harness = Schedule.Harness.from(f["harness"]) ?: return null
        val every = frequency(f) ?: return null
        val prompt = f["prompt"]?.takeIf { it.isNotEmpty() && it.length <= 8_000 } ?: return null
        val createdAt = ISO8601Dates.parse(f["createdAt"]) ?: return null
        val updatedAt = ISO8601Dates.parse(f["updatedAt"]) ?: return null
        val notify = f["notify"]?.let { raw ->
            if (!raw.trim().startsWith("[")) return null
            val values = inlineList(raw)
            val parsed = values.mapNotNull { Schedule.Notify.from(it) }
            if (parsed.size != values.size) return null
            parsed.toSet()
        } ?: Schedule.Notify.defaults
        return Schedule(id, name, enabled, computer, harness, f["model"]?.ifEmpty { null }, notify, every, prompt, createdAt, updatedAt)
    }

    internal fun frequency(f: Map<String, String>): Schedule.Every? = when (f["every"]) {
        "interval" -> {
            val value = f["interval"]?.takeIf { INTERVAL.test(it) }
            val amount = value?.dropLast(1)?.toLongOrNull()
            if (value == null || amount == null) null
            else {
                val minutes = amount * when (value.last()) { 'd' -> 1_440; 'h' -> 60; else -> 1 }
                if (minutes > Int.MAX_VALUE || minutes < 5) null else Schedule.Every.Interval(minutes.toInt())
            }
        }
        "daily", "weekly" -> run {
            val at = f["at"]?.takeIf { TIME.test(it) } ?: return@run null
            val (h, m) = at.split(":").map { it.toInt() }
            if (f["every"] == "daily") return@run Schedule.Every.Daily(h, m)
            val raw = f["days"] ?: return@run null
            val list = inlineList(raw)
            val days = list.mapNotNull { Schedule.Weekday.from(it) }
            if (days.isEmpty() || days.size != list.size) null else Schedule.Every.Weekly(days.toSet(), h, m)
        }
        "once" -> run {
            val value = f["once"] ?: return@run null
            for (fmt in onceFormats) {
                try {
                    val d = LocalDateTime.parse(value, fmt)
                    if (fmt.format(d) == value) return@run Schedule.Every.Once(d)
                } catch (_: DateTimeParseException) {}
            }
            ISO8601Dates.parse(value)?.let { Schedule.Every.Once(LocalDateTime.ofInstant(it, ZoneId.systemDefault())) }
        }
        "cron" -> f["cron"]?.takeIf { it.trim().split(Regex("\\s+")).size == 5 }?.let { Schedule.Every.Cron(it) }
        else -> null
    }

    internal fun timestampText(date: Instant) = ISO8601Dates.string(date, fractionalSeconds = true)

    internal fun intervalText(minutes: Int) = when {
        minutes % 1_440 == 0 -> "${minutes / 1_440}d"
        minutes % 60 == 0 -> "${minutes / 60}h"
        else -> "${minutes}m"
    }

    internal fun timeText(hour: Int, minute: Int) = "%02d:%02d".format(hour, minute)
    internal fun onceText(date: LocalDateTime): String = onceFormats[0].format(date)

    private fun renderBlock(schedules: List<Schedule>): List<String> {
        if (schedules.isEmpty()) return listOf("schedules: []")
        val lines = mutableListOf("schedules:")
        for (s in schedules) {
            lines += "  - id: ${yamlScalar(s.id)}"
            lines += "    name: ${yamlScalar(s.name)}"
            lines += "    enabled: ${if (s.enabled) "true" else "false"}"
            lines += "    computer: ${yamlScalar(s.computer)}"
            lines += "    harness: ${s.harness.rawValue}"
            s.model?.let { lines += "    model: ${yamlScalar(it)}" }
            lines += "    notify: [${Schedule.Notify.entries.filter { it in s.notify }.joinToString(", ") { it.rawValue }}]"
            lines += "    every: ${s.every.kind}"
            when (val e = s.every) {
                is Schedule.Every.Interval -> lines += "    interval: ${intervalText(e.minutes)}"
                is Schedule.Every.Daily -> lines += "    at: ${quoted(timeText(e.hour, e.minute))}"
                is Schedule.Every.Weekly -> {
                    lines += "    at: ${quoted(timeText(e.hour, e.minute))}"
                    lines += "    days: [${Schedule.Weekday.entries.filter { it in e.days }.joinToString(", ") { it.rawValue }}]"
                }
                is Schedule.Every.Once -> lines += "    once: ${yamlScalar(onceText(e.date))}"
                is Schedule.Every.Cron -> lines += "    cron: ${quoted(e.expression)}"
            }
            val trailing = s.prompt.reversed().takeWhile { it == '\n' }.length
            lines += "    prompt: ${when (trailing) { 0 -> "|-"; 1 -> "|"; else -> "|+" }}"
            val body = s.prompt.split("\n").toMutableList()
            if (s.prompt.endsWith("\n")) body.removeAt(body.lastIndex)
            body.forEach { lines += "      $it" }
            lines += "    createdAt: ${yamlScalar(timestampText(s.createdAt))}"
            lines += "    updatedAt: ${yamlScalar(timestampText(s.updatedAt))}"
        }
        return lines
    }

    private fun schedulesRange(lines: List<String>): IntRange? {
        val header = lines.indices.firstOrNull { topLevelKey(lines[it]) == "schedules" } ?: return null
        var end = header + 1
        while (end < lines.size) {
            val line = lines[end]
            val trimmed = line.trim(' ', '\t')
            if (trimmed.isNotEmpty() && !trimmed.startsWith("#") && indentation(line) == 0) break
            end++
        }
        return header until end
    }

    private fun topLevelKey(line: String): String? {
        if (indentation(line) != 0) return null
        val trimmed = line.trim(' ', '\t')
        if (trimmed.isEmpty() || trimmed.startsWith("#")) return null
        val colon = trimmed.indexOf(':').takeIf { it >= 0 } ?: return null
        return trimmed.substring(0, colon).trim()
    }

    private fun mapping(line: String): Pair<String, String>? {
        val colon = line.indexOf(':').takeIf { it >= 0 } ?: return null
        val key = line.substring(0, colon).trim(' ', '\t')
        if (key.isEmpty()) return null
        return key to line.substring(colon + 1).trim(' ', '\t')
    }

    private fun scalar(raw: String): String {
        val text = raw.trim(' ', '\t')
        if (text.startsWith("\"")) {
            val closing = text.lastIndexOf('"')
            if (closing > 0) {
                val remainder = text.substring(closing + 1).trim()
                if (remainder.isEmpty() || remainder.startsWith("#")) {
                    try {
                        return kotlinx.serialization.json.Json.decodeFromString(String.serializer(), text.substring(0, closing + 1))
                    } catch (_: Exception) {}
                }
            }
        }
        if (text.startsWith("'")) {
            val closing = text.lastIndexOf('\'')
            if (closing > 0) {
                val remainder = text.substring(closing + 1).trim()
                if (remainder.isEmpty() || remainder.startsWith("#")) return text.substring(1, closing).replace("''", "'")
            }
        }
        val comment = text.indexOf(" #")
        return if (comment >= 0) text.substring(0, comment).trim(' ', '\t') else text
    }

    private fun inlineList(raw: String): List<String> {
        val text = raw.trim(' ', '\t')
        if (!(text.startsWith("[") && text.endsWith("]"))) return emptyList()
        val contents = text.substring(1, text.length - 1)
        if (contents.isBlank()) return emptyList()
        return contents.split(",").map { scalar(it) }
    }

    private fun literal(lines: List<String>, keyIndent: Int, style: String): String {
        val indents = lines.filter { it.trim(' ', '\t').isNotEmpty() }.map(::indentation)
        val contentIndent = indents.minOrNull() ?: (keyIndent + 2)
        val body = lines.joinToString("\n") { line ->
            if (line.trim(' ', '\t').isEmpty()) "" else line.drop(minOf(contentIndent, line.length))
        } + if (lines.isEmpty()) "" else "\n"
        val trailing = body.reversed().takeWhile { it == '\n' }.length
        val stripped = body.dropLast(trailing)
        return when {
            style.startsWith("|-") -> stripped
            style.startsWith("|+") -> body
            else -> stripped + if (lines.isEmpty()) "" else "\n"
        }
    }

    private fun indentation(line: String) = line.takeWhile { it == ' ' || it == '\t' }.length

    private fun bool(text: String): Boolean? = when (text.lowercase()) { "true" -> true; "false" -> false; else -> null }

    private fun yamlScalar(value: String): String {
        val reserved = setOf("true", "false", "null", "yes", "no", "on", "off", "~")
        val safe = SAFE_SCALAR.test(value) && value.lowercase() !in reserved && !DIGITS.test(value)
        return if (safe) value else quoted(value)
    }

    private fun quoted(value: String): String =
        "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\""
}

/** Five-field cron, next-N matching (ScheduleCron.swift). */
object ScheduleCron {
    fun next(expression: String, count: Int, from: ZonedDateTime): List<ZonedDateTime>? {
        if (count < 0) return null
        val cron = Parsed.of(expression) ?: return null
        if (count == 0) return emptyList()
        val dates = mutableListOf<ZonedDateTime>()
        val start = from.toLocalDate()
        for (offset in 0 until 366 * 8) {
            val day = start.plusDays(offset.toLong())
            if (!cron.matches(day)) continue
            for (hour in cron.hour.values.sorted()) for (minute in cron.minute.values.sorted()) {
                val candidate = ZonedDateTime.ofLocal(day.atTime(hour, minute), from.zone, null)
                // Skip wall times a DST gap moved.
                if (candidate.toLocalDate() != day || candidate.hour != hour || candidate.minute != minute) continue
                if (!candidate.isAfter(from)) continue
                dates += candidate
                if (dates.size == count) return dates
            }
        }
        return null
    }

    private class Parsed(val minute: Field, val hour: Field, val day: Field, val month: Field, val weekday: Field) {
        fun matches(date: LocalDate): Boolean {
            if (date.monthValue !in month.values) return false
            val dayMatches = date.dayOfMonth in day.values
            val weekdayMatches = (date.dayOfWeek.value % 7) in weekday.values
            if (day.wildcard) return weekday.wildcard || weekdayMatches
            if (weekday.wildcard) return dayMatches
            return dayMatches || weekdayMatches
        }

        companion object {
            fun of(expression: String): Parsed? {
                val p = expression.trim().split(Regex("\\s+"))
                if (p.size != 5) return null
                return Parsed(
                    Field.of(p[0], 0..59) ?: return null,
                    Field.of(p[1], 0..23) ?: return null,
                    Field.of(p[2], 1..31) ?: return null,
                    Field.of(p[3], 1..12) ?: return null,
                    Field.of(p[4], 0..7) { if (it == 7) 0 else it } ?: return null,
                )
            }
        }
    }

    private class Field(val values: Set<Int>, val wildcard: Boolean) {
        companion object {
            fun of(source: String, range: IntRange, normalize: (Int) -> Int = { it }): Field? {
                if (source.isEmpty()) return null
                val values = mutableSetOf<Int>()
                for (item in source.split(",")) {
                    if (item.isEmpty()) return null
                    val stepParts = item.split("/", limit = 2)
                    val base = stepParts[0]
                    val step = if (stepParts.size == 2) stepParts[1].toIntOrNull()?.takeIf { it > 0 } ?: return null else 1
                    val bounds = when {
                        base == "*" -> range
                        base.contains("-") -> {
                            val ends = base.split("-", limit = 2)
                            val lo = ends[0].toIntOrNull() ?: return null
                            val hi = ends.getOrNull(1)?.toIntOrNull() ?: return null
                            if (lo !in range || hi !in range || lo > hi) return null
                            lo..hi
                        }
                        else -> {
                            val v = base.toIntOrNull()?.takeIf { it in range } ?: return null
                            if (stepParts.size == 2) v..range.last else v..v
                        }
                    }
                    var v = bounds.first
                    while (v <= bounds.last) {
                        values += normalize(v)
                        if (v > bounds.last - step) break
                        v += step
                    }
                }
                if (values.isEmpty()) return null
                return Field(values, source == "*")
            }
        }
    }
}

/** When a schedule runs next on its computer (ScheduleNextRun.swift). */
object ScheduleNextRun {
    /** `Once` is stored as the wall-clock time the user picked, so no phone zone is needed. */
    fun next(schedule: Schedule, lastStartedAt: Instant?, computerZone: ZoneId): Instant? {
        if (!schedule.enabled) return null
        val after = lastStartedAt ?: schedule.createdAt
        return when (val e = schedule.every) {
            is Schedule.Every.Interval -> if (e.minutes > 0) after.plus(e.minutes.toLong(), ChronoUnit.MINUTES) else null
            is Schedule.Every.Once -> {
                if (lastStartedAt != null) return null
                val candidate = ZonedDateTime.ofLocal(e.date, computerZone, null)
                if (candidate.toLocalDateTime() != e.date) null else candidate.toInstant()
            }
            is Schedule.Every.Cron -> ScheduleCron.next(e.expression, 1, after.atZone(computerZone))?.firstOrNull()?.toInstant()
            is Schedule.Every.Daily -> calendarRun(after, e.hour, e.minute, null, computerZone)
            is Schedule.Every.Weekly -> calendarRun(after, e.hour, e.minute, e.days, computerZone)
        }
    }

    fun reminderDate(nextRun: Instant?, enabled: Boolean, running: Boolean, now: Instant): Instant? =
        if (enabled && !running && nextRun != null && nextRun.isAfter(now)) nextRun else null

    private fun calendarRun(after: Instant, hour: Int, minute: Int, days: Set<Schedule.Weekday>?, zone: ZoneId): Instant? {
        if (hour !in 0..23 || minute !in 0..59) return null
        val start = after.atZone(zone).toLocalDate()
        for (offset in 0 until 370) {
            val day = start.plusDays(offset.toLong())
            if (days != null && weekday(day.dayOfWeek) !in days) continue
            val candidate = ZonedDateTime.ofLocal(day.atTime(hour, minute), zone, null)
            if (!candidate.toInstant().isAfter(after) || candidate.hour != hour || candidate.minute != minute) continue
            return candidate.toInstant()
        }
        return null
    }

    private fun weekday(d: DayOfWeek) = when (d) {
        DayOfWeek.MONDAY -> Schedule.Weekday.MON
        DayOfWeek.TUESDAY -> Schedule.Weekday.TUE
        DayOfWeek.WEDNESDAY -> Schedule.Weekday.WED
        DayOfWeek.THURSDAY -> Schedule.Weekday.THU
        DayOfWeek.FRIDAY -> Schedule.Weekday.FRI
        DayOfWeek.SATURDAY -> Schedule.Weekday.SAT
        DayOfWeek.SUNDAY -> Schedule.Weekday.SUN
    }
}

/**
 * The flat hook JSON shape of a schedule (Schedule's Codable):
 * `{id, name, enabled, computer, harness, model?, notify, every, at?, days?, interval?, once?, cron?, prompt, createdAt, updatedAt}`.
 */
object ScheduleJson : kotlinx.serialization.KSerializer<Schedule> {
    override val descriptor = kotlinx.serialization.json.JsonObject.serializer().descriptor

    fun toJson(s: Schedule): kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.buildJsonObject {
        put("id", kotlinx.serialization.json.JsonPrimitive(s.id))
        put("name", kotlinx.serialization.json.JsonPrimitive(s.name))
        put("enabled", kotlinx.serialization.json.JsonPrimitive(s.enabled))
        put("computer", kotlinx.serialization.json.JsonPrimitive(s.computer))
        put("harness", kotlinx.serialization.json.JsonPrimitive(s.harness.rawValue))
        s.model?.let { put("model", kotlinx.serialization.json.JsonPrimitive(it)) }
        put("notify", kotlinx.serialization.json.JsonArray(Schedule.Notify.entries.filter { it in s.notify }.map { kotlinx.serialization.json.JsonPrimitive(it.rawValue) }))
        put("every", kotlinx.serialization.json.JsonPrimitive(s.every.kind))
        when (val e = s.every) {
            is Schedule.Every.Interval -> put("interval", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.intervalText(e.minutes)))
            is Schedule.Every.Daily -> put("at", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.timeText(e.hour, e.minute)))
            is Schedule.Every.Weekly -> {
                put("at", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.timeText(e.hour, e.minute)))
                put("days", kotlinx.serialization.json.JsonArray(Schedule.Weekday.entries.filter { it in e.days }.map { kotlinx.serialization.json.JsonPrimitive(it.rawValue) }))
            }
            is Schedule.Every.Once -> put("once", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.onceText(e.date)))
            is Schedule.Every.Cron -> put("cron", kotlinx.serialization.json.JsonPrimitive(e.expression))
        }
        put("prompt", kotlinx.serialization.json.JsonPrimitive(s.prompt))
        put("createdAt", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.timestampText(s.createdAt)))
        put("updatedAt", kotlinx.serialization.json.JsonPrimitive(SchedulesFile.timestampText(s.updatedAt)))
    }

    fun fromJson(o: kotlinx.serialization.json.JsonObject): Schedule {
        fun str(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        fun req(k: String) = str(k) ?: throw kotlinx.serialization.SerializationException("missing $k")
        val fields = mutableMapOf("every" to req("every"))
        for (k in listOf("interval", "at", "once", "cron")) str(k)?.let { fields[k] = it }
        (o["days"] as? kotlinx.serialization.json.JsonArray)?.let { arr ->
            fields["days"] = "[" + arr.joinToString(",") { (it as kotlinx.serialization.json.JsonPrimitive).content } + "]"
        }
        val every = SchedulesFile.frequency(fields) ?: throw kotlinx.serialization.SerializationException("Invalid schedule frequency.")
        val harness = Schedule.Harness.from(req("harness")) ?: throw kotlinx.serialization.SerializationException("bad harness")
        val notify = (o["notify"] as? kotlinx.serialization.json.JsonArray)?.map {
            Schedule.Notify.from((it as kotlinx.serialization.json.JsonPrimitive).content) ?: throw kotlinx.serialization.SerializationException("bad notify")
        }?.toSet() ?: Schedule.Notify.defaults
        val enabled = (o["enabled"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toBooleanStrictOrNull()
            ?: throw kotlinx.serialization.SerializationException("missing enabled")
        return Schedule(
            req("id"), req("name"), enabled, req("computer"), harness, str("model"), notify, every, req("prompt"),
            ISO8601Dates.parse(req("createdAt")) ?: throw kotlinx.serialization.SerializationException("Invalid schedule timestamp."),
            ISO8601Dates.parse(req("updatedAt")) ?: throw kotlinx.serialization.SerializationException("Invalid schedule timestamp."),
        )
    }

    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: Schedule) =
        (encoder as kotlinx.serialization.json.JsonEncoder).encodeJsonElement(toJson(value))

    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): Schedule =
        fromJson((decoder as kotlinx.serialization.json.JsonDecoder).decodeJsonElement() as kotlinx.serialization.json.JsonObject)
}
