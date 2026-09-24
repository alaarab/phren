package com.phren.kit

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** One frame of the Hook's `/v1/overview` stream: the overview when it changed, or a heartbeat saying the phone's copy is current. */
sealed interface LiveOverviewFrame {
    data class Overview(val workspaces: LiveWorkspaces) : LiveOverviewFrame
    data class Heartbeat(val info: LiveHookInfo?) : LiveOverviewFrame

    companion object {
        /** Heartbeats are small; an overview is read with the same checks as a polled `/v1/workspaces` answer, Hook envelope included. */
        fun read(data: ByteArray): LiveOverviewFrame {
            if (data.size <= 16_384) {
                val envelope = runCatching { hookJson.parseToJsonElement(data.decodeToString()) as? JsonObject }.getOrNull()
                    ?: throw PhrenKitError.Validation("Phren Hook sent an unknown overview frame.")
                when (envelope["type"].str) {
                    "heartbeat" -> {
                        // The heartbeat's `phren` block has the overview envelope's shape.
                        val info = envelope["phren"].obj?.let { phren ->
                            LiveWorkspaces.read(buildJsonObject { put("kind", JsonPrimitive("herdr")); put("groups", kotlinx.serialization.json.JsonArray(emptyList())); put("phren", phren) }).phren
                        }
                        return Heartbeat(info)
                    }
                    "overview" -> Unit
                    else -> throw PhrenKitError.Validation("Phren Hook sent an unknown overview frame.")
                }
            }
            return Overview(LiveWorkspaces.read(data, requiringHook = true))
        }
    }
}
