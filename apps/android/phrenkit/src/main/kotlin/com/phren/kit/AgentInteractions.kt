package com.phren.kit

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant

private fun invalid(message: String) = PhrenKitError.Validation(message)

/** A permission request the Hook holds for the phone (AgentInteractions.swift). */
data class AgentApproval(
    /** Decision rows supplied by the Hook, in the provider's order. */
    val options: List<Option>?,
    val actionId: String,
    val title: String?,
    val toolName: String?,
    val message: String?,
    val expiresAt: String?,
    val details: String?,
    val terminalOnly: Boolean?,
    /** A Codex approval that is really a terminal dialog the Hook could read. */
    val choice: AgentPromptChoice?,
    /** Present when this ask is a conductor dispatch or hand-off. */
    val conductor: ConductorCall?,
) {
    data class Option(val label: String, val decision: ApprovalDecision)

    val id: String get() = actionId
    val expiration: Instant? get() = ISO8601Dates.parse(expiresAt)

    /** The human explanation first; the complete tool input stays available separately. */
    val explanation: String?
        get() {
            if (message.isNullOrEmpty()) return null
            val input = parseObject(message) ?: return message
            for (key in listOf("question", "prompt", "justification", "description", "command", "cmd", "plan")) {
                input[key].str?.takeIf { it.isNotEmpty() }?.let { return it }
            }
            return null
        }

    val command: String?
        get() {
            choice?.body?.takeIf { it.isNotEmpty() }?.let { return it }
            if (message.isNullOrEmpty()) return null
            val input = parseObject(message) ?: return message
            return (input["command"] ?: input["cmd"]).str
        }

    /** Claude Code asks questions through a permission request whose tool is `AskUserQuestion`. */
    val isQuestion: Boolean get() = toolName == "AskUserQuestion"
    val questionInput: JsonObject? get() = if (!isQuestion || message == null || message.toByteArray().size > 32_768) null else parseObject(message)
    val questionPrompt: AgentQuestionPrompt? get() = questionInput?.let { AgentQuestionPrompt.read(actionId, it["questions"]) }

    companion object {
        fun read(o: JsonObject): AgentApproval = AgentApproval(
            options = o["options"]?.let { raw -> (raw.objects ?: throw invalid("The approval has no usable identity.")).map {
                Option(it["label"].str ?: throw invalid("The approval has no usable identity."), ApprovalDecision.from(it["decision"].str) ?: throw invalid("The approval has no usable identity."))
            } },
            actionId = o["actionId"].str ?: throw invalid("The approval has no usable identity."),
            title = o["title"].str, toolName = o["toolName"].str, message = o["message"].str, expiresAt = o["expiresAt"].str,
            details = o["details"].str, terminalOnly = o["terminalOnly"].bool,
            choice = o["choice"].obj?.let(AgentPromptChoice::read),
            conductor = o["conductor"].obj?.let { ConductorCall(it["action"].str ?: throw invalid("The approval has no usable identity."), it["project"].str, it["computer"].str) },
        )
    }
}

/** A terminal prompt whose command and options the Hook could read, answered with `/v1/keys`. */
data class AgentPromptChoice(val title: String? = null, val body: String? = null, val options: List<Option>) {
    data class Option(val label: String, val key: String, val description: String? = null) {
        val answerKey: AgentAnswerKey?
            get() = when (key.lowercase()) {
                "esc", "escape" -> AgentAnswerKey.ESCAPE
                "enter", "return" -> AgentAnswerKey.ENTER
                "up" -> AgentAnswerKey.UP
                "down" -> AgentAnswerKey.DOWN
                "tab" -> AgentAnswerKey.TAB
                else -> AgentAnswerKey.from(key.lowercase())
            }
    }

    /** The question card: the asking sentence and command as text, one row per option. */
    fun prompt(id: String): AgentQuestionPrompt? {
        val text = listOf(title, body).mapNotNull { it?.trim() }.filter { it.isNotEmpty() }.joinToString("\n\n")
        if (options.size !in 2..12 || text.isEmpty() || text.toByteArray().size > 32_768 ||
            !options.all { it.label.isNotEmpty() && it.label.toByteArray().size <= 2_000 && it.answerKey != null }) return null
        return AgentQuestionPrompt(id, listOf(AgentQuestionPrompt.Question(question = text, options = options.map { AgentQuestionPrompt.Question.Option(it.label, it.description) })))
    }

    /** The yes/allow row's key, else the first row's. */
    val approveKey: AgentAnswerKey?
        get() = (options.firstOrNull { Regex("^(yes|allow|approve|proceed|continue|run)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it.label) } ?: options.firstOrNull())?.answerKey

    /** The no/deny row's key, else Escape. */
    val rejectKey: AgentAnswerKey
        get() = options.firstOrNull { Regex("^(no|deny|reject|don'?t|cancel|skip)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it.label) }?.answerKey ?: AgentAnswerKey.ESCAPE

    fun answerKey(selections: List<Int>): AgentAnswerKey? = selections.firstOrNull()?.let { options.getOrNull(it)?.answerKey }

    companion object {
        fun read(o: JsonObject) = AgentPromptChoice(o["title"].str, o["body"].str,
            (o["options"].objects ?: throw invalid("Invalid prompt choice.")).map {
                Option(it["label"].str ?: throw invalid("Invalid prompt choice."), it["key"].str ?: throw invalid("Invalid prompt choice."), it["description"].str)
            })
    }
}

/** A prompt the agent draws in its own terminal because nobody held it; answered with keys. */
data class AgentTerminalPrompt(
    val toolName: String?,
    val message: String?,
    val choice: AgentPromptChoice? = null,
    val queued: Boolean = false,
    val questions: List<AgentQuestionPrompt.Question>? = null,
    val questionIndex: Int? = null,
) {
    /** A released AskUserQuestion, answered with the option's digit. */
    val questionPrompt: AgentQuestionPrompt? get() = questions?.takeIf { it.isNotEmpty() }?.let { AgentQuestionPrompt("terminal-question", it) }

    val explanation: String?
        get() {
            if (message.isNullOrEmpty()) return null
            parseObject(message)?.let { input ->
                for (key in listOf("justification", "description", "command", "cmd", "plan")) input[key].str?.takeIf { it.isNotEmpty() }?.let { return it }
            }
            return message
        }

    val command: String? get() = parseObject(message)?.let { input -> listOf("command", "cmd").mapNotNull { input[it].str }.firstOrNull { it.isNotEmpty() } }

    companion object {
        fun read(o: JsonObject) = AgentTerminalPrompt(o["toolName"].str, o["message"].str, o["choice"].obj?.let(AgentPromptChoice::read),
            o["queued"].bool ?: false, o["questions"].objects?.map(AgentQuestionPrompt.Question::read), o["questionIndex"].int)
    }
}

data class AgentInteractionStatus(
    val approval: AgentApproval?,
    val terminalPrompt: AgentTerminalPrompt? = null,
    val activity: String? = null,
    val modelName: String? = null,
    /** The pane's terminal is reading a password: the phone offers its secret sheet only then. */
    val passwordPrompt: Boolean = false,
    val questionsSupported: Boolean = true,
    val asyncQuestionsSupported: Boolean = false,
    val capabilities: LiveCapabilities? = null,
    val pendingQuestions: List<AgentQuestionPrompt>? = null,
    val branch: String? = null,
    /** The agent is summarizing the conversation to reclaim context. */
    val compacting: Boolean = false,
    /** The Codex pane is active but its persisted history stopped advancing. */
    val historyStalled: Boolean = false,
    val historyStalledSince: Instant? = null,
) {
    companion object {
        fun read(data: ByteArray, target: AgentChatTarget): AgentInteractionStatus? {
            if (data.size > 1_048_576) throw invalid("Agent status is too large.")
            val frame = hookJson.parseToJsonElement(data.decodeToString()).obj ?: return null
            val status = frame["agentStatus"].obj ?: return null
            if (status["source"].str != target.source || status["session"].str != target.sessionID) throw invalid("Status belongs to a different conversation.")
            var approval: AgentApproval? = null
            status["pendingApproval"].obj?.let { raw ->
                val candidate = try { AgentApproval.read(raw) } catch (e: PhrenKitError) { throw e } catch (_: Exception) { throw invalid("The approval has no usable identity.") }
                if (candidate.actionId.isEmpty() || candidate.actionId.toByteArray().size > 512) throw invalid("The approval has no usable identity.")
                approval = candidate
            }
            var terminalPrompt: AgentTerminalPrompt? = null
            if (approval == null) status["terminalPrompt"].obj?.let { raw ->
                terminalPrompt = runCatching { AgentTerminalPrompt.read(raw) }.getOrNull()
                terminalPrompt?.message?.let { m ->
                    if (m.toByteArray().size > 32_768) terminalPrompt = AgentTerminalPrompt(terminalPrompt?.toolName, m.take(32_768), terminalPrompt?.choice, terminalPrompt?.queued ?: false)
                }
            }
            val caps = status["capabilities"].obj
            val capabilities = caps?.let { runCatching { hookJson.decodeFromJsonElement(LiveCapabilities.serializer(), it) }.getOrNull() }
            val activity = status["status"].str?.takeIf { it in listOf("working", "idle", "done", "waiting", "blocked", "error") }
            return AgentInteractionStatus(
                approval, terminalPrompt, activity,
                modelName = status["modelName"].str?.take(100),
                passwordPrompt = status["passwordPrompt"].bool ?: false,
                questionsSupported = caps?.get("questions").bool ?: true,
                asyncQuestionsSupported = caps?.get("asyncQuestions").bool ?: false,
                capabilities = capabilities,
                pendingQuestions = status["pendingQuestions"].objects?.take(64)?.mapNotNull { raw ->
                    val id = raw["toolUseId"].str ?: return@mapNotNull null
                    AgentQuestionPrompt.read(id, raw["questions"])?.copy(isAsync = true)
                },
                branch = status["branch"].str?.let { if (it.isEmpty()) null else it.take(200) },
                compacting = status["compacting"].bool ?: false,
                historyStalled = status["historyStalled"].bool ?: false,
                historyStalledSince = ISO8601Dates.parse(status["historyStalledSince"].str),
            )
        }
    }
}

data class AgentQuestionPrompt(
    val toolUseId: String,
    val questions: List<Question>,
    /** Async Codex questions remain pending after the tool acknowledges receipt. */
    val isAsync: Boolean? = null,
) {
    data class Question(
        val id: String? = null,
        val header: String? = null,
        val question: String,
        val multiSelect: Boolean? = null,
        val options: List<Option>,
        /** Claude Code: `choice` (default), or `text` / `number` for a typed answer. */
        val kind: String? = null,
    ) {
        data class Option(val label: String, val description: String? = null, private val rawPreview: String? = null) {
            /** A mockup or snippet rendered monospaced beside the choice, bounded. */
            val preview: String? get() = rawPreview?.let { if (it.isEmpty()) null else it.take(4_000) }
        }

        val isFreeText: Boolean get() = kind == "text" || kind == "number"

        companion object {
            fun read(o: JsonObject) = Question(o["id"].str, o["header"].str, o["question"].str ?: throw invalid("Invalid question."), o["multiSelect"].bool,
                (o["options"].objects ?: throw invalid("Invalid question.")).map { Option(it["label"].str ?: throw invalid("Invalid question."), it["description"].str, it["preview"].str) },
                o["kind"].str)
        }
    }

    val id: String get() = toolUseId

    @JvmName("answerBodySelections")
    fun answerBody(target: AgentChatTarget, selections: List<List<Int>>): String {
        if (selections.size != questions.size) throw invalid("Answer every question.")
        for ((q, indexes) in questions.zip(selections)) {
            if (indexes.isEmpty() || indexes.size != indexes.toSet().size || (q.multiSelect != true && indexes.size != 1) || !indexes.all { it in q.options.indices })
                throw invalid("Choose an available answer for every question.")
        }
        return buildJsonObject {
            put("source", target.source); put("sessionId", target.sessionID); put("toolUseId", toolUseId)
            put("questions", JsonArray(questions.map { q -> buildJsonObject {
                put("id", q.id ?: ""); put("header", q.header ?: ""); put("question", q.question); put("multiSelect", q.multiSelect ?: false)
                put("options", JsonArray(q.options.map { JsonPrimitive(it.label) }))
            } }))
            put("answers", JsonArray(questions.zip(selections).map { (q, s) -> buildJsonObject {
                put("questionId", q.id ?: ""); put("optionIndexes", JsonArray(s.map { JsonPrimitive(it) }))
            } }))
        }.toString()
    }

    /** Async Codex questions take the same choice or typed response the terminal sends. */
    fun answerBody(target: AgentChatTarget, answers: List<AgentQuestionAnswer>): String {
        if (isAsync != true) return answerBody(target, answers.map { it.selections })
        if (!isAnswered(answers)) throw invalid("Answer every question.")
        return buildJsonObject {
            put("source", target.source); put("sessionId", target.sessionID); put("toolUseId", toolUseId)
            put("answers", JsonArray(answers.map { a -> buildJsonObject {
                put("optionIndexes", JsonArray(a.selections.map { JsonPrimitive(it) })); put("text", a.typed)
            } }))
        }.toString()
    }

    /** Claude Code reads `answers[question text]`: the request's own input plus `answers`. */
    fun answeredInput(original: JsonObject, answers: List<AgentQuestionAnswer>): JsonObject {
        if (answers.size != questions.size || questions.map { it.question }.toSet().size != questions.size) throw invalid("Answer every question.")
        val values = questions.zip(answers).associate { (q, a) -> q.question to a.value(q) }
        return JsonObject(original + ("answers" to JsonObject(values)))
    }

    fun isAnswered(answers: List<AgentQuestionAnswer>) = runCatching { answeredInput(JsonObject(emptyMap()), answers) }.isSuccess

    companion object {
        /** A bounded, well-formed question set from a transcript block or a permission request, or nothing. */
        fun read(id: String, questions: JsonElement?, isAsync: Boolean = false): AgentQuestionPrompt? {
            if (id.isEmpty() || id.toByteArray().size > 512) return null
            val raw = questions.objects ?: return null
            val parsed = try {
                raw.map { q ->
                    if (isAsync) {
                        val options = q["options"].strings?.map { Question.Option(it) } ?: emptyList()
                        Question(q["id"].str, q["header"].str, q["title"].str ?: return null, q["multiSelect"].bool, options,
                            if (options.isEmpty()) "text" else q["kind"].str)
                    } else Question.read(q)
                }
            } catch (_: Exception) { return null }
            if (parsed.size !in 1..8 || !parsed.all { q ->
                    q.question.isNotEmpty() && q.question.toByteArray().size <= 4_000 && q.options.size in (if (q.isFreeText) 0..12 else 1..12) && q.options.all { it.label.isNotEmpty() }
                }) return null
            return AgentQuestionPrompt(id, parsed, isAsync)
        }
    }
}

/** Option indexes and/or typed text for one question. */
data class AgentQuestionAnswer(val selections: List<Int> = emptyList(), val text: String = "") {
    val typed: String get() = text.trim()

    fun value(question: AgentQuestionPrompt.Question): JsonElement {
        if (typed.toByteArray().size > 4_000 || selections.size != selections.toSet().size || !selections.all { it in question.options.indices })
            throw invalid("Choose an available answer for every question.")
        val labels = selections.sorted().map { question.options[it].label }
        if (question.isFreeText) {
            if (selections.isNotEmpty() || typed.isEmpty()) throw invalid("Type an answer.")
            return JsonPrimitive(typed)
        }
        if (question.multiSelect == true) {
            val all = labels + (if (typed.isEmpty()) emptyList() else listOf(typed))
            if (all.isEmpty()) throw invalid("Choose at least one answer.")
            return JsonArray(all.map { JsonPrimitive(it) })
        }
        return when {
            labels.size == 1 && typed.isEmpty() -> JsonPrimitive(labels[0])
            labels.isEmpty() && typed.isNotEmpty() -> JsonPrimitive(typed)
            else -> throw invalid("Choose one answer.")
        }
    }
}

sealed interface AgentQuestionEvent {
    data class Question(val prompt: AgentQuestionPrompt) : AgentQuestionEvent
    data class Resolved(val id: String) : AgentQuestionEvent
    data class Reply(val text: String) : AgentQuestionEvent

    companion object {
        fun read(raw: JsonObject, source: String): List<AgentQuestionEvent> {
            var blocks = emptyList<JsonObject>()
            if (source == "codex" && raw["type"].str == "response_item") raw["payload"].obj?.let { blocks = listOf(it) }
            if (source == "claude" && raw["isMeta"].bool != true && raw["isSidechain"].bool != true) raw["message"].obj?.let { blocks = it["content"].objects ?: emptyList() }
            return blocks.mapNotNull { block ->
                val kind = block["type"].str ?: ""
                if (source == "codex" && kind == "message" && block["role"].str == "user") {
                    val text = block["content"].objects?.mapNotNull { it["text"].str }?.joinToString("\n") ?: ""
                    return@mapNotNull if (text.isEmpty()) null else Reply(text)
                }
                if (kind in listOf("function_call_output", "custom_tool_call_output", "tool_result")) {
                    val id = (block["call_id"] ?: block["tool_use_id"]).str
                    if (id != null) {
                        val output = parseObject(block["output"].str)
                        if (output != null && output["accepted"].bool == true) return@mapNotNull null
                        return@mapNotNull Resolved(id)
                    }
                }
                val name = (block["name"].str ?: "").removePrefix("functions.")
                if (kind !in listOf("function_call", "tool_use") || name !in listOf("request_user_input", "request_user_input_async", "AskUserQuestion")) return@mapNotNull null
                val id = (block["call_id"] ?: block["id"]).str?.takeIf { it.isNotEmpty() && it.toByteArray().size <= 512 } ?: return@mapNotNull null
                var input = block["input"].obj
                block["arguments"].str?.let { input = parseObject(it) }
                AgentQuestionPrompt.read(id, input?.get("questions"), name == "request_user_input_async")?.let { Question(it) }
            }
        }
    }
}

/** Keeps asynchronous questions visible across acknowledgements and replies (AgentQuestionState). */
class AgentQuestionState {
    var pending: List<AgentQuestionPrompt> = emptyList(); private set
    private val answered = mutableSetOf<String>()

    fun resolve(id: String) {
        if (pending.none { it.id == id }) return
        pending = pending.filter { it.id != id }
        answered += id
    }

    fun replaceAsync(prompts: List<AgentQuestionPrompt>) {
        pending = pending.filter { it.isAsync != true } + prompts.filter { it.id !in answered }
    }

    fun receive(events: List<AgentQuestionEvent>, reset: Boolean = false) {
        if (reset) pending = pending.filter { it.isAsync == true }
        for (event in events) when (event) {
            is AgentQuestionEvent.Question -> if (event.prompt.id !in answered && pending.none { it.id == event.prompt.id }) pending = pending + event.prompt
            is AgentQuestionEvent.Resolved -> resolve(event.id)
            is AgentQuestionEvent.Reply -> for (prompt in pending.toList()) {
                if (prompt.isAsync == true && prompt.questions.all { q ->
                        val quote = q.question.split("\n").joinToString("\n") { "> $it" } + "\n\n"
                        val at = event.text.indexOf(quote)
                        at >= 0 && event.text.substring(at + quote.length).isNotBlank()
                    }) resolve(prompt.id)
            }
        }
    }
}

/** A repository's working changes, as the diff route reports them (AgentRepositoryDiff). */
data class AgentRepositoryDiff(val branch: String?, val root: String, val launchPath: String, val files: List<File>, val related: List<Related>?) {
    data class File(val path: String, val status: String, val sections: List<Section>) { val id get() = path }
    data class Section(val id: String, val kind: String, val binary: Boolean? = null, val loadState: String? = null, val patch: String? = null,
                       /** For a `committed` section: the commit's hash, subject and age. */ val note: String? = null)
    /** Another repository a command wrote into, with the changes under the paths it named. */
    data class Related(val root: String, val branch: String?, val files: List<File>) { val id get() = root }

    companion object {
        private fun file(o: JsonObject) = File(o["path"].str ?: throw invalid("The repository response is invalid."), o["status"].str ?: throw invalid("The repository response is invalid."),
            (o["sections"].objects ?: throw invalid("The repository response is invalid.")).map {
                Section(it["id"].str ?: throw invalid("The repository response is invalid."), it["kind"].str ?: throw invalid("The repository response is invalid."),
                    it["binary"].bool, it["loadState"].str, it["patch"].str, it["note"].str)
            })

        fun read(data: ByteArray): AgentRepositoryDiff {
            if (data.size > 8_388_608) throw invalid("The repository diff is too large.")
            val o = hookJson.parseToJsonElement(data.decodeToString()).obj ?: throw invalid("The repository response is invalid.")
            val result = AgentRepositoryDiff(o["branch"].str, o["root"].str ?: throw invalid("The repository response is invalid."),
                o["launchPath"].str ?: throw invalid("The repository response is invalid."), (o["files"].objects ?: throw invalid("The repository response is invalid.")).map(::file),
                o["related"].objects?.map { Related(it["root"].str ?: throw invalid("The repository response is invalid."), it["branch"].str,
                    (it["files"].objects ?: throw invalid("The repository response is invalid.")).map(::file)) })
            val related = result.related ?: emptyList()
            if (!result.root.startsWith("/") || !result.launchPath.startsWith("/") || result.files.size > 5_000 || result.files.map { it.path }.toSet().size != result.files.size ||
                related.size > 8 || !related.all { r -> r.root.startsWith("/") && r.files.size <= 5_000 && r.files.map { it.path }.toSet().size == r.files.size })
                throw invalid("The repository response is invalid.")
            return result
        }

        fun statusPath(data: ByteArray): String {
            val o = runCatching { hookJson.parseToJsonElement(data.decodeToString()).obj }.getOrNull()
            val url = o?.get("url").str
            if (o?.get("git").bool != true || url == null || !Regex("^/apps/diff/diff_[a-f0-9]+/$").matches(url))
                throw invalid("This pane is not in a Git repository, or its diff is unavailable.")
            return url + "api/status"
        }
    }
}

@Suppress("unused") private val keepArrayBuilder = buildJsonArray { }
