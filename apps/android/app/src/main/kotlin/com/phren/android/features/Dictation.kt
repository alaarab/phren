package com.phren.android.features

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import com.phren.kit.KeyValueStore
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import java.util.UUID

sealed interface DictationRecognitionEvent {
    data class Partial(val text: String) : DictationRecognitionEvent
    data class Finished(val text: String) : DictationRecognitionEvent
    data class Failed(val reason: String) : DictationRecognitionEvent
}

/** A speech engine that recognises one segment at a time (DictationRecognizing). */
interface DictationRecognizing {
    val audioLevel: Float
    val isRecognizerAvailable: Boolean
    fun startSegment(id: String, receive: (DictationRecognitionEvent) -> Unit)
    fun stopSegment(keepingAudioSession: Boolean)
}

/**
 * DictationSession.swift: recognition callbacks belong to one segment, and
 * only this owner can commit that segment or start its successor. Typed
 * edits become committed text before another callback can replace them.
 */
class DictationSession(private val recognizer: DictationRecognizing, private val transform: (String) -> String = { it }) {
    var draft by mutableStateOf("")
        private set
    var isRecording by mutableStateOf(false)
        private set
    var failureReason by mutableStateOf<String?>(null)
        private set
    private var committedText = ""
    private var partial = ""
    var readDraft: (() -> String)? = null
    var onDraftChange: ((String) -> Unit)? = null
    var onFailure: ((String) -> Unit)? = null
    private var segmentID: String? = null
    private var errorRestarts = 0
    private val maximumErrorRestarts = 1

    val audioLevel get() = recognizer.audioLevel
    val isRecognizerAvailable get() = recognizer.isRecognizerAvailable

    fun start(draft: String) {
        if (isRecording) return
        committedText = draft; partial = ""
        publishDraft()
        failureReason = null; errorRestarts = 0; isRecording = true
        beginSegment()
    }

    fun updateDraft(value: String) = replaceDraft(value, restarting = true)

    private fun replaceDraft(value: String, restarting: Boolean) {
        if (value == draft) return
        endSegment()
        committedText = value; partial = ""
        publishDraft()
        if (isRecording && restarting) beginSegment()
    }

    fun stop() {
        synchronizeDraft(restarting = false)
        endSegment()
        isRecording = false
        commitPartial()
        recognizer.stopSegment(keepingAudioSession = false)
    }

    /** Called only after the sender captured and accepted the draft; speech during delivery belongs to the next message. */
    fun send(): String {
        synchronizeDraft(restarting = false)
        endSegment()
        commitPartial()
        val submitted = draft
        committedText = ""
        publishDraft()
        if (isRecording) beginSegment()
        return submitted
    }

    private fun synchronizeDraft(restarting: Boolean = true) {
        readDraft?.invoke()?.let { if (it != draft) replaceDraft(it, restarting) }
    }

    private fun beginSegment() {
        val id = UUID.randomUUID().toString()
        segmentID = id
        try { recognizer.startSegment(id) { receive(it, id) } }
        catch (e: Exception) { receive(DictationRecognitionEvent.Failed(e.message ?: ""), id) }
    }

    private fun receive(event: DictationRecognitionEvent, id: String) {
        if (!isRecording || segmentID != id) return
        synchronizeDraft()
        if (segmentID != id) return
        when (event) {
            // The recogniser revises its guess, shorter as well as longer.
            is DictationRecognitionEvent.Partial -> { partial = event.text; publishDraft() }
            is DictationRecognitionEvent.Finished -> {
                if (event.text.length >= partial.length) partial = event.text
                endSegment(); commitPartial(); beginSegment()
            }
            is DictationRecognitionEvent.Failed -> {
                endSegment(); commitPartial()
                if (errorRestarts < maximumErrorRestarts) { errorRestarts++; beginSegment() }
                else {
                    isRecording = false
                    recognizer.stopSegment(keepingAudioSession = false)
                    val detail = event.reason.lines().joinToString(" ")
                    val message = if (detail.isBlank()) "Dictation stopped. Tap the microphone to try again." else "Dictation stopped: $detail"
                    failureReason = message
                    onFailure?.invoke(message)
                }
            }
        }
    }

    private fun endSegment() {
        segmentID = null
        recognizer.stopSegment(keepingAudioSession = isRecording)
    }

    private fun commitPartial() {
        committedText = join(committedText, transform(partial)); partial = ""
        publishDraft()
    }

    private fun publishDraft() {
        draft = join(committedText, transform(partial))
        onDraftChange?.invoke(draft)
    }

    companion object {
        fun join(base: String, addition: String): String = when {
            addition.isEmpty() -> base
            base.isEmpty() -> addition
            base.last().isWhitespace() -> base + addition
            else -> "$base $addition"
        }
    }
}

/** Dictation language, replacement words and vocabulary (SpeechSettings). */
object SpeechSettings {
    const val LOCALE_KEY = "speech.locale.v1"
    const val REPLACEMENTS_KEY = "speech.replacements.v1"
    const val PROJECTS_KEY = "speech.vocabulary.projects.v1"
    private val rows = ListSerializer(ListSerializer(String.serializer()))

    fun replacements(prefs: KeyValueStore): List<Pair<String, String>> =
        runCatching { Json.decodeFromString(rows, prefs.getString(REPLACEMENTS_KEY) ?: return emptyList()) }.getOrDefault(emptyList())
            .mapNotNull { if (it.size == 2 && it[0].isNotEmpty()) it[0] to it[1] else null }

    fun setReplacements(prefs: KeyValueStore, value: List<Pair<String, String>>) =
        prefs.putString(REPLACEMENTS_KEY, Json.encodeToString(rows, value.map { listOf(it.first, it.second) }))

    fun rememberProjects(prefs: KeyValueStore, names: List<String>) {
        val sorted = names.toSortedSet().joinToString("\n")
        if (prefs.getString(PROJECTS_KEY) != sorted) prefs.putString(PROJECTS_KEY, sorted)
    }

    /** Words the recogniser should prefer: the app's name, project names and every replacement target. */
    fun vocabulary(prefs: KeyValueStore): List<String> {
        val projects = prefs.getString(PROJECTS_KEY)?.split("\n")?.filter { it.isNotEmpty() } ?: emptyList()
        val spoken = projects.flatMap { name ->
            val words = name.split('-', '_', '.').filter { it.isNotEmpty() }
            if (words.size > 1) listOf(name, words.joinToString(" ")) else listOf(name)
        }
        val seen = mutableSetOf<String>()
        return (listOf("phren") + spoken + replacements(prefs).map { it.second }).filter { it.isNotEmpty() && seen.add(it.lowercase()) }
    }

    /** Every replacement applied, whole words only, case-insensitive. */
    fun apply(prefs: KeyValueStore, text: String): String = replacements(prefs).fold(text) { result, (from, to) ->
        Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(from) + "(?![\\p{L}\\p{N}])", RegexOption.IGNORE_CASE).replace(result, Regex.escapeReplacement(to))
    }
}

/**
 * On-device dictation over SpeechRecognizer (the SpeechTranscriber twin).
 * Android ends a recognition at each pause; each ending is a finished
 * segment, and the session starts the next one while recording.
 */
class AndroidSpeechRecognizer(private val context: Context, private val prefs: KeyValueStore) : DictationRecognizing {
    enum class PermissionState { NOT_DETERMINED, AUTHORIZED, DENIED }

    override var audioLevel by mutableFloatStateOf(0f)
        private set
    override val isRecognizerAvailable: Boolean get() = SpeechRecognizer.isRecognitionAvailable(context)
    private var recognizer: SpeechRecognizer? = null
    private var receive: ((DictationRecognitionEvent) -> Unit)? = null
    private var lastPartial = ""

    private fun intent() = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        // On-device when the device can: the audio never leaves the phone.
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 4000L)
        prefs.getString(SpeechSettings.LOCALE_KEY)?.takeIf { it.isNotEmpty() }?.let { putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }
        if (android.os.Build.VERSION.SDK_INT >= 33) putExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(SpeechSettings.vocabulary(prefs)))
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) { audioLevel = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f) }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onError(error: Int) {
            // A pause with nothing heard ends the segment; the session keeps listening.
            if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) receive?.invoke(DictationRecognitionEvent.Finished(lastPartial))
            else receive?.invoke(DictationRecognitionEvent.Failed(describe(error)))
        }
        override fun onResults(results: Bundle?) { receive?.invoke(DictationRecognitionEvent.Finished(best(results) ?: lastPartial)) }
        override fun onPartialResults(partialResults: Bundle?) {
            best(partialResults)?.let { lastPartial = it; receive?.invoke(DictationRecognitionEvent.Partial(it)) }
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun best(bundle: Bundle?) = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf { it.isNotBlank() }

    private fun describe(error: Int) = when (error) {
        SpeechRecognizer.ERROR_AUDIO -> "the microphone couldn't record."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "the speech service couldn't be reached."
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "microphone access is off."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "the speech service is busy."
        else -> ""
    }

    override fun startSegment(id: String, receive: (DictationRecognitionEvent) -> Unit) {
        if (!isRecognizerAvailable) throw IllegalStateException("Dictation isn't available in this language on this device.")
        this.receive = receive
        lastPartial = ""
        val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener); recognizer = it }
        r.startListening(intent())
    }

    override fun stopSegment(keepingAudioSession: Boolean) {
        receive = null
        recognizer?.cancel()
        if (!keepingAudioSession) {
            audioLevel = 0f
            recognizer?.destroy(); recognizer = null
        }
    }

    companion object {
        fun permission(context: Context): PermissionState =
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) PermissionState.AUTHORIZED
            else PermissionState.NOT_DETERMINED
    }
}
