package com.phren.kit

import kotlinx.serialization.Serializable
import java.io.File
import java.time.Instant

/**
 * One archived-findings document in the cold tier (`<project>/reference/topics/<slug>.md`),
 * catalogued from the recursive tree the engine already fetched (ColdStore.swift).
 */
@Serializable
data class ColdDocRef(
    val path: String,
    val sha: String,
    val size: Int? = null,
    val project: String,
    val slug: String,
) {
    val id: String get() = path

    /** `build-tooling` → `Build tooling`. */
    val displayName: String
        get() {
            val words = slug.split('-', '_').filter { it.isNotEmpty() }
            val first = words.firstOrNull() ?: return slug
            return (listOf(first.take(1).uppercase() + first.drop(1)) + words.drop(1)).joinToString(" ")
        }

    companion object {
        fun of(path: String, sha: String, size: Int?): ColdDocRef? {
            val parts = path.split("/")
            if (parts.size != 4 || !LocalStore.isReadableProjectDirName(parts[0]) ||
                parts[1] != "reference" || parts[2] != "topics" ||
                !parts[3].endsWith(".md") || parts[3].length <= 3
            ) return null
            return ColdDocRef(path, sha, size, parts[0], parts[3].dropLast(3))
        }

        fun of(entry: GitTree.Entry): ColdDocRef? {
            if (entry.type != "blob") return null
            val sha = entry.sha ?: return null
            return of(entry.path, sha, entry.size)
        }
    }
}

data class ColdSummary(
    val project: String,
    val topicCount: Int,
    val totalBytes: Int,
    /** Only once every topic has been hydrated at its current sha. */
    val findingCount: Int?,
)

/**
 * The cold tier's catalogue plus an LRU cache of hydrated documents under a
 * 4 MB budget, outside [LocalStore]'s mirrored `files/` tree.
 */
class ColdStore(rootDirectory: File) {
    sealed interface Hydration {
        data class Cached(val text: String) : Hydration
        data class Fetch(val sha: String) : Hydration
        data class TooLarge(val bytes: Int) : Hydration
        data object Unknown : Hydration
    }

    @Serializable
    internal data class State(
        override val schemaVersion: Int = CURRENT_SCHEMA_VERSION,
        val catalogue: Map<String, ColdDocRef> = emptyMap(),
        val cached: Map<String, CacheRecord> = emptyMap(),
    ) : VersionedDocument {
        companion object {
            const val CURRENT_SCHEMA_VERSION = 1
            const val DOCUMENT_NAME = "archived-findings cache records"
        }
    }

    @Serializable
    internal data class CacheRecord(
        val sha: String,
        val bytes: Int,
        val fileName: String,
        @Serializable(with = InstantSerializer::class) val lastAccessed: Instant,
        val findingCount: Int,
    )

    private val root = File(rootDirectory, "cold").also { it.mkdirs() }
    private val stateFile = File(rootDirectory, "cold-tier.json")
    private var state: State =
        PersistedState.load(State.serializer(), State.CURRENT_SCHEMA_VERSION, stateFile, State.DOCUMENT_NAME).value ?: State()

    init {
        // Bytes in cold/ nothing indexes any more are dropped.
        val known = state.cached.values.map { it.fileName }.toSet()
        root.listFiles()?.filter { it.name !in known }?.forEach { it.delete() }
    }

    // Catalogue

    @Synchronized
    fun replaceCatalogue(refs: List<ColdDocRef>) {
        val catalogue = LinkedHashMap<String, ColdDocRef>()
        refs.forEach { catalogue.putIfAbsent(it.path, it) }
        val cached = state.cached.toMutableMap()
        for ((path, record) in state.cached) {
            if (path !in catalogue) {
                File(root, record.fileName).delete()
                cached.remove(path)
            }
        }
        state = state.copy(catalogue = catalogue, cached = cached)
        persist()
    }

    /** Largest topics first, slug breaking ties. */
    @Synchronized
    fun topics(project: String): List<ColdDocRef> =
        state.catalogue.values.filter { it.project == project }
            .sortedWith(compareByDescending<ColdDocRef> { it.size ?: 0 }.thenBy { it.slug })

    @Synchronized
    fun projectSummaries(): Map<String, ColdSummary> =
        state.catalogue.values.groupBy { it.project }.mapValues { (project, refs) ->
            val counted = refs.mapNotNull { ref ->
                state.cached[ref.path]?.takeIf { it.sha == ref.sha }?.findingCount
            }
            ColdSummary(
                project = project,
                topicCount = refs.size,
                totalBytes = refs.sumOf { it.size ?: 0 },
                findingCount = if (counted.size == refs.size) counted.sum() else null,
            )
        }

    @Synchronized
    fun reference(path: String): ColdDocRef? = state.catalogue[path]

    // Hydration

    /** The only way in: the cached-sha vs tree-sha check can't be skipped. */
    @Synchronized
    fun hydration(path: String): Hydration {
        val ref = state.catalogue[path] ?: return Hydration.Unknown
        val record = state.cached[path]
        if (record != null && record.sha == ref.sha) {
            val text = try { File(root, record.fileName).readText() } catch (_: Exception) { null }
            if (text != null) {
                touch(path)
                return Hydration.Cached(text)
            }
        }
        val size = ref.size
        if (size != null && size > MAX_DOCUMENT_BYTES) return Hydration.TooLarge(size)
        return Hydration.Fetch(ref.sha)
    }

    @Synchronized
    fun cache(path: String, text: String, sha: String, findingCount: Int) {
        val fileName = fileName(path)
        try {
            atomicWrite(File(root, fileName), text)
        } catch (_: Exception) {
            return
        }
        state = state.copy(
            cached = state.cached + (path to CacheRecord(sha, text.toByteArray().size, fileName, Instant.now(), findingCount)),
        )
        evictToBudget()
        persist()
    }

    @Synchronized
    internal fun cachedPaths(): List<String> = state.cached.keys.sorted()

    @Synchronized
    internal fun cachedBytes(): Int = state.cached.values.sumOf { it.bytes }

    private fun touch(path: String) {
        val record = state.cached[path] ?: return
        state = state.copy(cached = state.cached + (path to record.copy(lastAccessed = Instant.now())))
        persist()
    }

    private fun evictToBudget() {
        var total = cachedBytes()
        if (total <= CACHE_BUDGET_BYTES) return
        val cached = state.cached.toMutableMap()
        val oldestFirst = state.cached.entries.sortedWith(compareBy<Map.Entry<String, CacheRecord>> { it.value.lastAccessed }.thenBy { it.key })
        for ((path, record) in oldestFirst) {
            if (total <= CACHE_BUDGET_BYTES) break
            File(root, record.fileName).delete()
            cached.remove(path)
            total -= record.bytes
        }
        state = state.copy(cached = cached)
    }

    private fun persist() {
        PersistedState.save(State.serializer(), State.CURRENT_SCHEMA_VERSION, state.copy(schemaVersion = State.CURRENT_SCHEMA_VERSION), stateFile, State.DOCUMENT_NAME)
    }

    companion object {
        /** 1 MB raw, against a largest observed topic doc of ~341 KB. */
        const val MAX_DOCUMENT_BYTES = 1_048_576
        const val CACHE_BUDGET_BYTES = 4 * 1_048_576

        private fun fileName(path: String) = path.replace("/", "__")
    }
}
