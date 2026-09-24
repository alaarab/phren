package com.phren.kit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.math.ceil
import kotlin.math.max

internal val githubJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

// Models (GitHubModels.swift)

@Serializable
data class GitHubUser(
    val login: String,
    val name: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
)

@Serializable
data class GitHubRepo(
    val id: Long,
    @SerialName("full_name") val fullName: String,
    val name: String,
    val owner: Owner,
    @SerialName("private") val isPrivate: Boolean = false,
    @SerialName("default_branch") val defaultBranch: String = "main",
    @SerialName("pushed_at") val pushedAt: String? = null,
    val permissions: Permissions? = null,
) {
    @Serializable data class Owner(val login: String)
    @Serializable data class Permissions(val push: Boolean = false)
}

@Serializable
data class GitRef(val `object`: Obj) {
    @Serializable data class Obj(val sha: String)
}

@Serializable
data class GitTree(val sha: String, val truncated: Boolean = false, val tree: List<Entry>) {
    @Serializable
    data class Entry(val path: String, val type: String, val sha: String? = null, val size: Int? = null)
}

@Serializable
data class GitBlob(val sha: String, val content: String? = null, val encoding: String) {
    val decoded: ByteArray?
        get() {
            if (encoding != "base64" || content == null) return null
            return try {
                Base64.getMimeDecoder().decode(content)
            } catch (_: IllegalArgumentException) {
                null
            }
        }

    companion object {
        /**
         * Git's content identity for a file: `sha1("blob <byteCount>\0" + bytes)`,
         * the same value the Contents API returns as a file's `sha`. Lets the sync
         * engine recognise that the bytes it is about to PUT are already remote.
         */
        fun sha(text: String): String = sha(text.toByteArray(Charsets.UTF_8))

        fun sha(data: ByteArray): String {
            val md = MessageDigest.getInstance("SHA-1")
            md.update("blob ${data.size}\u0000".toByteArray(Charsets.UTF_8))
            md.update(data)
            return md.digest().joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        }
    }
}

@Serializable
data class ContentsPutResponse(val content: ContentInfo? = null, val commit: CommitInfo) {
    @Serializable data class ContentInfo(val sha: String, val path: String)
    @Serializable data class CommitInfo(val sha: String)
}

@Serializable
data class DeviceCodeResponse(
    @SerialName("device_code") val deviceCode: String,
    @SerialName("user_code") val userCode: String,
    @SerialName("verification_uri") val verificationUri: String,
    @SerialName("expires_in") val expiresIn: Int,
    val interval: Int,
)

sealed class GitHubError(message: String) : IOException(message) {
    /** Carries the failing request: a bare 404 on a `repos/…` path is usually token scope. */
    class Http(val status: Int, val msg: String, val method: String, val path: String?) :
        GitHubError(describe(status, msg, method, path))

    /** 409/422 sha mismatch on a contents PUT — the file changed remotely. */
    class ShaConflict(val path: String) : GitHubError("$path changed on GitHub while editing.")

    /** Primary or secondary/abuse limit; the latter carries `retry-after`. */
    class RateLimited(val resetAt: Instant?, val retryAfter: Double?) : GitHubError(rateLimitMessage(resetAt, retryAfter))

    object NotAuthenticated : GitHubError("Not signed in to GitHub.")
    object InvalidResponse : GitHubError("Unexpected response from GitHub.")
    object TreeTruncated : GitHubError("Repository tree too large to enumerate.")

    val isShaConflict: Boolean get() = this is ShaConflict

    companion object {
        private fun wait(seconds: Int) = if (seconds >= 120) "${seconds / 60} minutes" else "${max(seconds, 1)} seconds"

        private fun rateLimitMessage(resetAt: Instant?, retryAfter: Double?): String {
            if (retryAfter != null) {
                return "GitHub is throttling requests (secondary rate limit) — retry in ${wait(ceil(retryAfter).toInt())}."
            }
            if (resetAt != null) {
                val secs = resetAt.epochSecond - Instant.now().epochSecond
                if (secs > 0) return "GitHub rate limit reached — try again in about ${wait(secs.toInt())}."
            }
            return "GitHub rate limit reached — try again shortly."
        }

        internal fun describe(status: Int, message: String, method: String, path: String?): String {
            val generic = "GitHub API error $status: $message"
            if (status == 401) {
                return "Your GitHub token has expired or been revoked. Sign out in Settings, then sign in again with a new token."
            }
            val slug = repoSlug(path) ?: return generic
            return when {
                status == 404 ->
                    "GitHub can't see $slug. It answers \"not found\" for private repositories a token isn't allowed to read, " +
                        "so this is usually token access rather than a missing repository. A fine-grained token must list " +
                        "$slug under Repository access, with Contents: Read and write and Metadata: Read."
                status == 403 && (method == "PUT" || method == "DELETE") ->
                    "Your GitHub token can't write to $slug. It needs Contents: Read and write on that repository. " +
                        "Fix the token on GitHub, then retry from Settings."
                else -> generic
            }
        }

        /** `repos/<owner>/<name>/…` → `<owner>/<name>`; null for user/auth paths. */
        fun repoSlug(path: String?): String? {
            if (path == null) return null
            val parts = path.substringBefore("?").split("/").filter { it.isNotEmpty() }
            if (parts.size < 3 || parts[0] != "repos") return null
            return "${parts[1]}/${parts[2]}"
        }
    }
}

/** The slice of the REST client the sync engine drives (GitHubAPI.swift). */
interface GitHubAPI {
    suspend fun headSha(owner: String, repo: String, branch: String): String?
    suspend fun tree(owner: String, repo: String, sha: String): GitTree
    suspend fun blob(owner: String, repo: String, sha: String): ByteArray
    suspend fun putFile(owner: String, repo: String, path: String, branch: String, content: ByteArray, message: String, sha: String?): ContentsPutResponse
    suspend fun deleteFile(owner: String, repo: String, path: String, branch: String, message: String, sha: String)
}

/** Only https://api.github.com is ever followed (GitHubRedirectPolicy). No HTTP cache. */
internal val sharedHttp: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .cache(null)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
}

private suspend fun OkHttpClient.execute(request: Request): Pair<Int, Pair<ByteArray, Response>> =
    withContext(Dispatchers.IO) {
        newCall(request).execute().use { r -> r.code to ((r.body.bytes()) to r) }
    }

/**
 * Minimal GitHub REST v3 client (port of GitHubClient.swift): user/repos
 * discovery, ref + tree + blob reads, and per-file contents PUT/DELETE writes
 * with sha optimistic concurrency.
 */
class GitHubClient(
    token: String? = null,
    private val http: OkHttpClient = sharedHttp,
    private val apiBase: String = API_BASE,
) : GitHubAPI {
    private val lock = Mutex()
    private var token: String? = token
    /** ETag cache for cheap ref polling: 304s don't count against the rate limit. */
    private val etags = mutableMapOf<String, String>()

    suspend fun setToken(token: String?) = lock.withLock {
        this.token = token
        etags.clear()
    }

    private class Reply(val status: Int, val data: ByteArray, val headers: okhttp3.Headers)

    private suspend fun request(
        path: String,
        method: String = "GET",
        accept: String = "application/vnd.github+json",
        etagKey: String? = null,
        body: String? = null,
    ): Reply {
        val (tok, etag) = lock.withLock { token to etagKey?.let { etags[it] } }
        if (tok == null) throw GitHubError.NotAuthenticated
        val builder = Request.Builder()
            .url(apiBase + path)
            .header("Authorization", "Bearer $tok")
            .header("Accept", accept)
            .header("X-GitHub-Api-Version", "2022-11-28")
        etag?.let { builder.header("If-None-Match", it) }
        val requestBody = body?.toRequestBody("application/json".toMediaType())
        builder.method(method, requestBody)
        val reply = withContext(Dispatchers.IO) {
            http.newCall(builder.build()).execute().use { r -> Reply(r.code, r.body.bytes(), r.headers) }
        }
        if (reply.status == 403 || reply.status == 429) {
            rateLimitError(reply.status, reply.headers, reply.data)?.let { throw it }
        }
        if (etagKey != null) {
            reply.headers["ETag"]?.let { e -> lock.withLock { etags[etagKey] = e } }
        }
        return reply
    }

    private suspend inline fun <reified T> get(path: String): T {
        val reply = request(path)
        ensureOK(reply.status, reply.data, path = path)
        return githubJson.decodeFromString(reply.data.decodeToString())
    }

    // Identity + repos

    suspend fun currentUser(): GitHubUser = get("user")

    /** Most recently pushed repos visible to the token. */
    suspend fun listRepos(page: Int = 1, perPage: Int = 100): List<GitHubRepo> =
        get("user/repos?sort=pushed&per_page=$perPage&page=$page&affiliation=owner,collaborator,organization_member")

    /** Every page of [listRepos], stopping at the first short page or the cap. */
    suspend fun listAllRepos(maxPages: Int = 5, perPage: Int = 100): List<GitHubRepo> {
        val all = mutableListOf<GitHubRepo>()
        val seen = mutableSetOf<Long>()
        for (page in 1..max(1, maxPages)) {
            val batch = listRepos(page, perPage)
            batch.filter { seen.add(it.id) }.let(all::addAll)
            if (batch.size < perPage) break
        }
        return all
    }

    suspend fun repo(owner: String, name: String): GitHubRepo = get(repoPath(owner, name))

    /** What a store probe learned; `NoAccess` because GitHub 404s both "no file" and "can't read". */
    sealed interface StoreProbe {
        data object IsStore : StoreProbe
        data object NotStore : StoreProbe
        data object NoAccess : StoreProbe
        data class Error(val message: String) : StoreProbe
    }

    /** Probes for `phren.root.yaml` at the repo root (phren-paths.ts ROOT_MANIFEST_FILENAME). */
    suspend fun probeStore(owner: String, name: String, disambiguate404: Boolean = true): StoreProbe = try {
        val path = repoPath(owner, name) + "/contents/phren.root.yaml"
        val reply = request(path)
        when (reply.status) {
            in 200..299 -> StoreProbe.IsStore
            401, 403 -> StoreProbe.NoAccess
            404 -> if (!disambiguate404) StoreProbe.NotStore
            else if (repoIsReadable(owner, name)) StoreProbe.NotStore else StoreProbe.NoAccess
            else -> StoreProbe.Error(GitHubError.Http(reply.status, "request failed", "GET", path).message ?: "")
        }
    } catch (e: Exception) {
        StoreProbe.Error(e.message ?: e.toString())
    }

    /** Probe for a repo the caller already listed — a 404 means "no manifest". */
    suspend fun probeStore(repo: GitHubRepo): StoreProbe = probeStore(repo.owner.login, repo.name, disambiguate404 = false)

    private suspend fun repoIsReadable(owner: String, name: String): Boolean = try {
        request(repoPath(owner, name)).status in 200..299
    } catch (_: Exception) {
        false
    }

    suspend fun isPhrenStore(owner: String, name: String): Boolean =
        probeStore(owner, name, disambiguate404 = false) == StoreProbe.IsStore

    // Git data reads

    /** Head commit SHA for a branch; null on 304 (nothing changed, the poll was free). */
    override suspend fun headSha(owner: String, repo: String, branch: String): String? {
        val path = repoPath(owner, repo) + "/git/ref/heads/" + encodePath(branch, nested = true)
        val reply = request(path, etagKey = "ref:$owner/$repo/$branch")
        if (reply.status == 304) return null
        ensureOK(reply.status, reply.data, path = path)
        return githubJson.decodeFromString<GitRef>(reply.data.decodeToString()).`object`.sha
    }

    override suspend fun tree(owner: String, repo: String, sha: String): GitTree {
        val tree: GitTree = get(repoPath(owner, repo) + "/git/trees/" + encodePath(sha) + "?recursive=1")
        if (tree.truncated) throw GitHubError.TreeTruncated
        return tree
    }

    override suspend fun blob(owner: String, repo: String, sha: String): ByteArray {
        val blob: GitBlob = get(repoPath(owner, repo) + "/git/blobs/" + encodePath(sha))
        return blob.decoded ?: throw GitHubError.InvalidResponse
    }

    // Contents writes

    override suspend fun putFile(owner: String, repo: String, path: String, branch: String, content: ByteArray, message: String, sha: String?): ContentsPutResponse {
        val payload = buildJsonObject {
            put("message", message)
            put("content", Base64.getEncoder().encodeToString(content))
            put("branch", branch)
            if (sha != null) put("sha", sha)
        }
        val endpoint = repoPath(owner, repo) + "/contents/" + encodePath(path, nested = true)
        val reply = request(endpoint, method = "PUT", body = payload.toString())
        if (reply.status == 409 || reply.status == 422) throw GitHubError.ShaConflict(path)
        ensureOK(reply.status, reply.data, "PUT", endpoint)
        return githubJson.decodeFromString(reply.data.decodeToString())
    }

    override suspend fun deleteFile(owner: String, repo: String, path: String, branch: String, message: String, sha: String) {
        val payload = buildJsonObject {
            put("message", message)
            put("sha", sha)
            put("branch", branch)
        }
        val endpoint = repoPath(owner, repo) + "/contents/" + encodePath(path, nested = true)
        val reply = request(endpoint, method = "DELETE", body = payload.toString())
        if (reply.status == 409 || reply.status == 422) throw GitHubError.ShaConflict(path)
        ensureOK(reply.status, reply.data, "DELETE", endpoint)
    }

    companion object {
        const val API_BASE = "https://api.github.com/"
        private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

        /** Percent-encodes each segment; refuses traversal, backslashes and control characters. */
        internal fun encodePath(value: String, nested: Boolean = false): String {
            val parts = value.split("/")
            if ((!nested && parts.size != 1) || parts.any { it.isEmpty() || it == "." || it == ".." } ||
                value.contains('\\') || value.any { it.isISOControl() }
            ) throw GitHubError.InvalidResponse
            return parts.joinToString("/") { part ->
                buildString {
                    for (b in part.toByteArray(Charsets.UTF_8)) {
                        val c = b.toInt().toChar()
                        if (b >= 0 && c in UNRESERVED) append(c) else append("%%%02X".format(b.toInt() and 0xFF))
                    }
                }
            }
        }

        internal fun repoPath(owner: String, repo: String) = "repos/${encodePath(owner)}/${encodePath(repo)}"

        private fun messageOf(data: ByteArray): String? = try {
            (Json.parseToJsonElement(data.decodeToString()).jsonObject["message"] as? JsonPrimitive)?.contentOrNull
        } catch (_: Exception) {
            null
        }

        /**
         * GitHub throttles in three shapes (GitHubClient.swift rateLimitError):
         * primary (`x-ratelimit-remaining: 0`), secondary (retry-after and/or a
         * "secondary rate limit" message), and a bare 429. `x-ratelimit-reset`
         * rides every response, so it's timing, never the signal.
         */
        internal fun rateLimitError(status: Int, headers: okhttp3.Headers, data: ByteArray): GitHubError? {
            val reset = headers["x-ratelimit-reset"]?.toDoubleOrNull()?.let { Instant.ofEpochSecond(it.toLong()) }
            val retryAfter = headers["retry-after"]?.toDoubleOrNull()
            if (headers["x-ratelimit-remaining"] == "0") return GitHubError.RateLimited(reset, retryAfter)
            if (retryAfter != null) {
                return GitHubError.RateLimited(Instant.now().plusMillis((retryAfter * 1000).toLong()), retryAfter)
            }
            val lowered = (messageOf(data) ?: "").lowercase()
            if (lowered.contains("secondary rate limit") || lowered.contains("abuse detection")) {
                return GitHubError.RateLimited(reset, null)
            }
            if (status == 429) return GitHubError.RateLimited(reset, null)
            return null
        }

        internal fun ensureOK(status: Int, data: ByteArray, method: String = "GET", path: String? = null) {
            if (status !in 200..299) {
                throw GitHubError.Http(status, messageOf(data) ?: "request failed", method, path)
            }
        }
    }
}

/**
 * GitHub OAuth Device Flow (DeviceFlowAuth.swift). No client secret is
 * embedded — the OAuth App must have "Device Flow" enabled.
 */
class DeviceFlowAuth(
    private val clientID: String = DEFAULT_CLIENT_ID,
    private val http: OkHttpClient = sharedHttp,
    private val base: String = "https://github.com/",
) {
    sealed interface PollState {
        data class Authorized(val token: String) : PollState
        data object Pending : PollState
        data class SlowDown(val extraSeconds: Int) : PollState
        data object Expired : PollState
        data object Denied : PollState
    }

    private suspend fun post(path: String, params: Map<String, String>): JsonObject {
        val form = FormBody.Builder().apply { params.forEach { (k, v) -> add(k, v) } }.build()
        val request = Request.Builder().url(base + path).header("Accept", "application/json").post(form).build()
        val (code, data) = withContext(Dispatchers.IO) {
            http.newCall(request).execute().use { it.code to it.body.bytes() }
        }
        if (code !in 200..299) throw GitHubError.InvalidResponse
        return try {
            Json.parseToJsonElement(data.decodeToString()).jsonObject
        } catch (_: Exception) {
            throw GitHubError.InvalidResponse
        }
    }

    /** Step 1: request a device + user code to display. */
    suspend fun requestCode(): DeviceCodeResponse {
        val json = post("login/device/code", mapOf("client_id" to clientID, "scope" to SCOPE))
        return githubJson.decodeFromJsonElement(DeviceCodeResponse.serializer(), json)
    }

    /** Step 2: one poll of the token endpoint. */
    suspend fun poll(deviceCode: String): PollState {
        val json = post(
            "login/oauth/access_token",
            mapOf(
                "client_id" to clientID,
                "device_code" to deviceCode,
                "grant_type" to "urn:ietf:params:oauth:grant-type:device_code",
            ),
        )
        (json["access_token"] as? JsonPrimitive)?.contentOrNull?.let { return PollState.Authorized(it) }
        return when ((json["error"] as? JsonPrimitive)?.contentOrNull) {
            "authorization_pending" -> PollState.Pending
            "slow_down" -> PollState.SlowDown(5)
            "expired_token" -> PollState.Expired
            "access_denied" -> PollState.Denied
            else -> throw GitHubError.InvalidResponse
        }
    }

    /** Run the full poll loop until a terminal state. */
    suspend fun waitForAuthorization(code: DeviceCodeResponse): PollState {
        var interval = code.interval.toLong()
        val deadline = System.currentTimeMillis() + code.expiresIn * 1000L
        while (System.currentTimeMillis() < deadline) {
            delay(interval * 1000)
            when (val state = poll(code.deviceCode)) {
                is PollState.Authorized -> return state
                PollState.Pending -> continue
                is PollState.SlowDown -> interval += state.extraSeconds
                PollState.Expired, PollState.Denied -> return state
            }
        }
        return PollState.Expired
    }

    companion object {
        /** Replace after registering the OAuth App (apps/ios/README.md). */
        const val DEFAULT_CLIENT_ID = "REPLACE_WITH_PHREN_OAUTH_CLIENT_ID"

        val isConfigured: Boolean get() = !DEFAULT_CLIENT_ID.startsWith("REPLACE_WITH_")

        /** `repo` is a classic scope — required for private store repos. */
        const val SCOPE = "repo"
    }
}

/** Validation for pasted personal access tokens. */
object PATValidator {
    fun looksLikeToken(raw: String): Boolean {
        val t = raw.jsTrimmed
        return t.startsWith("github_pat_") || t.startsWith("ghp_") || t.startsWith("gho_")
    }

    /** Returns the authenticated user when the token is valid. */
    suspend fun validate(token: String): GitHubUser = GitHubClient(token.jsTrimmed).currentUser()
}

/**
 * GitHub token storage (KeychainStore.swift). The backend is pluggable: the
 * app installs an Android Keystore-encrypted implementation at startup; the
 * default in-memory one exists only so PhrenKit tests run on a plain JVM.
 */
object KeychainStore {
    @Serializable
    enum class TokenKind { @SerialName("oauth") OAUTH, @SerialName("pat") PAT }

    @Serializable
    data class StoredToken(val token: String, val kind: TokenKind)

    interface Backend {
        fun save(stored: StoredToken)
        fun load(): StoredToken?
        fun delete()
    }

    @Volatile
    var backend: Backend = object : Backend {
        @Volatile private var value: StoredToken? = null
        override fun save(stored: StoredToken) { value = stored }
        override fun load(): StoredToken? = value
        override fun delete() { value = null }
    }

    fun save(stored: StoredToken) = backend.save(stored)
    fun load(): StoredToken? = backend.load()
    fun delete() = backend.delete()
}
