package com.phren.kit

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import java.time.Duration
import java.time.Instant

/** Provider-reported usage for one model response, never inferred from words (AgentChatProgress.swift). */
data class AgentTokenUsage(val input: Int, val output: Int, val cachedInput: Int?, val reasoningOutput: Int?) {
    val uncachedInput: Int? get() = cachedInput?.let { input - it }

    companion object {
        fun read(value: JsonObject?, inputIncludesCache: Boolean = true): AgentTokenUsage? {
            if (value == null) return null
            val input = count(value["input_tokens"]) ?: return null
            val output = count(value["output_tokens"]) ?: return null
            val cached = count(value["cached_input_tokens"] ?: value["cache_read_input_tokens"])
            // Claude reports cache reads/writes separately; Codex includes them in input.
            val totalInput = if (inputIncludesCache) input else input + (cached ?: 0) + (count(value["cache_creation_input_tokens"]) ?: 0)
            val reasoning = count(value["reasoning_output_tokens"])
            if ((cached ?: 0) > totalInput || (reasoning ?: 0) > output) return null
            return AgentTokenUsage(totalInput, output, cached, reasoning)
        }

        private fun count(value: JsonElement?): Int? {
            val d = value.double ?: return null
            if (!d.isFinite() || d < 0 || d > 1_000_000_000_000.0 || Math.floor(d) != d) return null
            return d.toLong().coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
        }
    }
}

data class AgentChatProgressEvent(val line: Int, val value: Value, val timestamp: Instant? = null) {
    sealed interface Value {
        data class Started(val date: Instant?) : Value
        data class Finished(val date: Instant?) : Value
        data object Stopped : Value
        data class Usage(val usage: AgentTokenUsage) : Value
    }

    companion object {
        fun read(raw: JsonObject, source: String, line: Int): AgentChatProgressEvent? {
            if (source == "codex" && raw["type"].str == "event_msg") {
                val payload = raw["payload"].obj ?: return null
                return when (payload["type"].str) {
                    "task_started" -> AgentChatProgressEvent(line, Value.Started(date(payload["started_at"], raw["timestamp"])))
                    "task_complete", "task_completed" -> AgentChatProgressEvent(line, Value.Finished(date(payload["completed_at"], raw["timestamp"])))
                    "turn_aborted", "task_aborted" -> AgentChatProgressEvent(line, Value.Stopped)
                    "token_count" -> AgentTokenUsage.read(payload["info"].obj?.get("last_token_usage").obj)?.let { AgentChatProgressEvent(line, Value.Usage(it)) }
                    else -> null
                }
            }
            if (source == "claude" && raw["isMeta"].bool != true && raw["isSidechain"].bool != true) {
                val message = raw["message"].obj
                if (message != null && message["role"].str == "assistant")
                    return AgentTokenUsage.read(message["usage"].obj, inputIncludesCache = false)?.let { AgentChatProgressEvent(line, Value.Usage(it)) }
            }
            if (source == "phren" || source == "opencode") {
                val data = raw["data"].obj
                if (data != null) return when (raw["type"].str) {
                    "user/message" -> AgentChatProgressEvent(line, Value.Started(date(null, raw["time"])))
                    "assistant/message" -> AgentTokenUsage.read(data["usage"].obj)?.let { AgentChatProgressEvent(line, Value.Usage(it)) }
                        ?: if (data["stop_reason"].str == "end_turn") AgentChatProgressEvent(line, Value.Finished(date(null, raw["time"]))) else null
                    else -> null
                }
            }
            if (source == "copilot" && !raw.has("agentId")) {
                val data = raw["data"].obj
                if (data != null) when (raw["type"].str) {
                    // The person's prompt starts the turn; `assistant.turn_start` opens each model call inside it.
                    "user.message" -> return if (data["source"] == null || data["source"].str == "user") AgentChatProgressEvent(line, Value.Started(date(null, raw["timestamp"]))) else null
                    // Copilot 1.0.87 writes no session.idle: its final answer ends the turn.
                    "assistant.message" -> return if (data["phase"].str == "final_answer") AgentChatProgressEvent(line, Value.Finished(date(null, raw["timestamp"]))) else null
                    "session.idle" -> return AgentChatProgressEvent(line, if (data["aborted"].bool == true) Value.Stopped else Value.Finished(date(null, raw["timestamp"])))
                    "abort" -> return AgentChatProgressEvent(line, Value.Stopped)
                    "assistant.usage" -> {
                        val counts = buildJsonObject {
                            data["inputTokens"]?.let { put("input_tokens", it) }
                            data["outputTokens"]?.let { put("output_tokens", it) }
                            data["cacheReadTokens"]?.let { put("cached_input_tokens", it) }
                        }
                        return AgentTokenUsage.read(counts)?.let { AgentChatProgressEvent(line, Value.Usage(it)) }
                    }
                }
            }
            return null
        }

        private fun date(value: JsonElement?, fallback: JsonElement?): Instant? {
            val n = value.double
            if (n != null && n.isFinite() && n > 0 && n < 100_000_000_000.0) return Instant.ofEpochMilli((n * 1000).toLong())
            return ISO8601Dates.parse(fallback.str)
        }
    }
}

/** Turn timing bound to transcript lines across reconnects and older pages (AgentChatProgress). */
class AgentChatProgress {
    enum class Phase { WORKING, FINISHED, STOPPED }

    data class Turn(val startLine: Int, var endLine: Int? = null, var phase: Phase, val startedAt: Instant?, var finishedAt: Instant? = null) {
        fun elapsed(now: Instant = Instant.now()) = AgentChatProgress.elapsed(startedAt, finishedAt, phase, now)
    }

    var turns: List<Turn> = emptyList(); private set
    var phase: Phase? = null; private set
    var startedAt: Instant? = null; private set
    var finishedAt: Instant? = null; private set
    var usage: AgentTokenUsage? = null; private set
    var activityLine = -1; private set
    private var latestLine = -1

    fun elapsed(now: Instant = Instant.now()) = elapsed(startedAt, finishedAt, phase, now)

    fun receive(frame: AgentChatTranscript) {
        if (frame.kind == AgentChatTranscript.Kind.OLDER) {
            // An older page restores finished rows without replaying current activity.
            val history = AgentChatProgress().also { it.receiveCurrent(frame) }
            val known = turns.map { it.startLine }.toSet()
            turns = (turns + history.turns.filter { it.phase != Phase.WORKING && it.startLine !in known }).sortedBy { it.startLine }
            return
        }
        receiveCurrent(frame)
    }

    private fun receiveCurrent(frame: AgentChatTranscript) {
        if (frame.replacesConversation) { turns = emptyList(); phase = null; startedAt = null; finishedAt = null; usage = null; activityLine = -1; latestLine = -1 }
        val previous = latestLine
        for (event in frame.progressEvents.sortedBy { it.line }) {
            if (event.line <= previous) continue
            latestLine = event.line
            when (val v = event.value) {
                is AgentChatProgressEvent.Value.Started -> {
                    phase = Phase.WORKING; startedAt = v.date; finishedAt = null; usage = null; activityLine = event.line
                    turns = turns + Turn(event.line, phase = Phase.WORKING, startedAt = v.date)
                }
                is AgentChatProgressEvent.Value.Finished -> { phase = Phase.FINISHED; finishedAt = v.date; activityLine = event.line; finishTurn(v.date, event.line, Phase.FINISHED) }
                AgentChatProgressEvent.Value.Stopped -> { phase = Phase.STOPPED; finishedAt = event.timestamp; activityLine = event.line; finishTurn(event.timestamp, event.line, Phase.STOPPED) }
                is AgentChatProgressEvent.Value.Usage -> usage = v.usage
            }
        }
    }

    private fun finishTurn(date: Instant?, line: Int, phase: Phase) {
        val last = turns.lastOrNull() ?: return
        if (last.phase != Phase.WORKING) return
        turns = turns.dropLast(1) + last.copy(phase = phase, finishedAt = date, endLine = line)
    }

    companion object {
        fun elapsed(startedAt: Instant?, finishedAt: Instant?, phase: Phase?, now: Instant): Duration? {
            if (startedAt == null || phase == null) return null
            val end = if (phase == Phase.WORKING) now else finishedAt ?: return null
            return Duration.between(startedAt, end).let { if (it.isNegative) Duration.ZERO else it }
        }
    }
}

/** Claude Code's `/btw` side question, answered in a terminal panel the Hook reads (AgentSideAnswer). */
data class AgentSideAnswer(val id: String, val question: String, val state: State, val answer: String? = null) {
    enum class State(val raw: String) { PENDING("pending"), ANSWER("answer"), ERROR("error"), CANCELLED("cancelled") }

    companion object {
        fun read(frame: JsonObject): AgentSideAnswer {
            val bad = PhrenKitError.Validation("The computer returned an invalid side answer.")
            val id = frame["id"].str?.takeIf { parseUUID(it) != null } ?: throw bad
            val question = frame["question"].str?.takeIf { it.isNotEmpty() && it.toByteArray().size <= 4_096 } ?: throw bad
            val state = State.entries.firstOrNull { it.raw == frame["state"].str } ?: throw bad
            val answer = frame["answer"].str
            if ((answer != null && answer.toByteArray().size > 131_072) || (state == State.ANSWER && answer.isNullOrEmpty())) throw bad
            return AgentSideAnswer(id, question, state, answer)
        }

        /** `/btw <question>` for Claude Code. */
        fun question(source: String, text: String): String? {
            if (source != "claude") return null
            val trimmed = text.trim()
            if (!trimmed.lowercase().startsWith("/btw") || trimmed.length <= 4 || !trimmed[4].isWhitespace()) return null
            return trimmed.drop(4).split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").ifEmpty { null }
        }
    }
}

/** Claude's spinner line as the Hook reads it (AgentChatSpinner). Anything malformed drops the value. */
data class AgentChatSpinner(
    val verb: String,
    val elapsed: Int? = null,
    val tokens: Int? = null,
    val direction: Direction? = null,
    val thinking: Boolean = false,
    /** "thought for 4s". */
    val thoughtFor: Int? = null,
) {
    enum class Direction(val raw: String) { UP("up"), DOWN("down") }

    /** "↓ 3.1k tokens". */
    val tokenText: String?
        get() {
            val t = tokens ?: return null
            val arrow = if (direction == Direction.UP) "↑" else "↓"
            return "$arrow ${if (t < 1_000) "$t" else "%.1fk".format(t / 1_000.0)} tokens"
        }

    val details: List<String>
        get() = buildList {
            tokenText?.let { add(it) }
            if (thinking) add("thinking") else thoughtFor?.let { add("thought for ${it}s") }
        }

    companion object {
        private val verbPattern = Regex("^[A-Z][\\p{L}'-]{1,30}$")

        fun verb(value: JsonElement?): String? = value.str?.takeIf { verbPattern.matches(it) }

        /** Absent → Result(null); malformed → null. */
        private fun count(raw: JsonElement?, limit: Int): Result<Int?>? {
            if (raw == null) return Result.success(null)
            val d = raw.double ?: return null
            if (Math.floor(d) != d || d < 0 || d > limit) return null
            return Result.success(d.toInt())
        }

        fun read(value: JsonElement?): AgentChatSpinner? {
            val o = value.obj ?: return null
            val verb = verb(o["verb"]) ?: return null
            val elapsed = count(o["elapsed"], 1_000_000) ?: return null
            val thoughtFor = count(o["thoughtFor"], 1_000_000) ?: return null
            var tokens: Int? = null
            var direction: Direction? = null
            o["tokens"]?.let { raw ->
                val t = raw.obj ?: return null
                tokens = count(t["count"], 1_000_000_000)?.getOrNull() ?: return null
                direction = Direction.entries.firstOrNull { it.raw == t["direction"].str } ?: return null
            }
            var thinking = false
            o["thinking"]?.let { raw ->
                thinking = (raw as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull ?: return null
            }
            return AgentChatSpinner(verb, elapsed.getOrNull(), tokens, direction, thinking, thoughtFor.getOrNull())
        }

        /** The finished line's verb in Claude's past tense ("Brewed for"). */
        fun pastTense(verb: String): String? = pastTenses[verb]

        private val pastTenses = mapOf(
            "Accomplishing" to "Accomplished", "Actioning" to "Actioned", "Actualizing" to "Actualized", "Baking" to "Baked",
            "Booping" to "Booped", "Brewing" to "Brewed", "Calculating" to "Calculated", "Cerebrating" to "Cerebrated",
            "Channelling" to "Channelled", "Churning" to "Churned", "Clauding" to "Clauded", "Coalescing" to "Coalesced",
            "Cogitating" to "Cogitated", "Combobulating" to "Combobulated", "Computing" to "Computed", "Concocting" to "Concocted",
            "Conjuring" to "Conjured", "Considering" to "Considered", "Contemplating" to "Contemplated", "Cooking" to "Cooked",
            "Crafting" to "Crafted", "Creating" to "Created", "Crunching" to "Crunched", "Deciphering" to "Deciphered",
            "Deliberating" to "Deliberated", "Determining" to "Determined", "Discombobulating" to "Discombobulated",
            "Divining" to "Divined", "Doing" to "Did", "Effecting" to "Effected", "Elucidating" to "Elucidated",
            "Enchanting" to "Enchanted", "Envisioning" to "Envisioned", "Finagling" to "Finagled", "Flibbertigibbeting" to "Flibbertigibbeted",
            "Forging" to "Forged", "Forming" to "Formed", "Frolicking" to "Frolicked", "Generating" to "Generated",
            "Germinating" to "Germinated", "Hatching" to "Hatched", "Herding" to "Herded", "Honking" to "Honked",
            "Hustling" to "Hustled", "Ideating" to "Ideated", "Imagining" to "Imagined", "Incubating" to "Incubated",
            "Inferring" to "Inferred", "Jiving" to "Jived", "Manifesting" to "Manifested", "Marinating" to "Marinated",
            "Meandering" to "Meandered", "Moseying" to "Moseyed", "Mulling" to "Mulled", "Mustering" to "Mustered",
            "Musing" to "Mused", "Noodling" to "Noodled", "Percolating" to "Percolated", "Perusing" to "Perused",
            "Philosophising" to "Philosophised", "Pondering" to "Pondered", "Pontificating" to "Pontificated",
            "Precipitating" to "Precipitated", "Processing" to "Processed", "Puttering" to "Puttered", "Puzzling" to "Puzzled",
            "Reticulating" to "Reticulated", "Ruminating" to "Ruminated", "Sautéing" to "Sautéed", "Schlepping" to "Schlepped",
            "Shimmying" to "Shimmied", "Shucking" to "Shucked", "Simmering" to "Simmered", "Smooshing" to "Smooshed",
            "Spelunking" to "Spelunked", "Spinning" to "Spun", "Stewing" to "Stewed", "Sussing" to "Sussed",
            "Synthesizing" to "Synthesized", "Thinking" to "Thought", "Tinkering" to "Tinkered", "Transmuting" to "Transmuted",
            "Unfurling" to "Unfurled", "Unravelling" to "Unravelled", "Vibing" to "Vibed", "Wandering" to "Wandered",
            "Whirlpooling" to "Whirlpooled", "Whirring" to "Whirred", "Wibbling" to "Wibbled", "Wizarding" to "Wizarded",
            "Working" to "Worked", "Wrangling" to "Wrangled",
        )
    }
}

/** A key the phone may press in an agent's terminal to answer its prompt; the Hook accepts exactly this set. */
enum class AgentAnswerKey(val rawValue: String) {
    ENTER("Enter"), UP("Up"), DOWN("Down"), TAB("Tab"), YES("y"), NO("n"),
    ONE("1"), TWO("2"), THREE("3"), ESCAPE("Escape"),
    FOUR("4"), FIVE("5"), SIX("6"), SEVEN("7"), EIGHT("8"), NINE("9"),
    /** Codex's "yes, and don't ask again for commands that start with …". */
    PROCEED_ALWAYS("p"),
    /** Codex's "answer the last queued follow-up". */
    ALT_UP("AltUp");

    val label: String get() = when (this) {
        ENTER -> "Enter"; UP -> "↑"; DOWN -> "↓"; TAB -> "Tab"; YES -> "Y"; NO -> "N"; ESCAPE -> "Esc"; ALT_UP -> "⌥↑"; else -> rawValue
    }

    val spoken: String get() = when (this) {
        ENTER -> "Press Enter"; UP -> "Move up"; DOWN -> "Move down"; TAB -> "Press Tab"; YES -> "Answer yes"; NO -> "Answer no"
        ESCAPE -> "Press Escape"; ALT_UP -> "Open the queued question"; else -> "Press $rawValue"
    }

    companion object {
        /** What the composer row shows, in the order a prompt is usually answered. */
        val row = listOf(YES, NO, ENTER, UP, DOWN, ESCAPE)
        fun from(raw: String): AgentAnswerKey? = entries.firstOrNull { it.rawValue == raw }
    }
}

/** A conductor `dispatch` or `hand_off` the Hook is asking about (ConductorCall). */
data class ConductorCall(val action: String, val project: String? = null, val computer: String? = null)

/** The Hook's approval answers (ApprovalDecision). */
enum class ApprovalDecision(val rawValue: String) {
    APPROVE("approve"), DENY("deny"), ALLOW_PROJECT("allow-project"), ALLOW_EVERYWHERE("allow-everywhere");
    val allows: Boolean get() = this != DENY
    companion object { fun from(raw: String?) = entries.firstOrNull { it.rawValue == raw } }
}

@Suppress("unused") private val keepObject = JsonObject::class
