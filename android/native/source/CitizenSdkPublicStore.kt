package org.citizen.sdk.internal

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.io.File
import kotlin.concurrent.withLock

internal class CitizenSdkHistoryFailure(val errorCode: Int, message: String) : IllegalArgumentException(message)

/** Public/reconstructable state; this database never receives wallet secrets or App business fields. */
internal class CitizenSdkPublicStore(directory: File) :
    CitizenSdkSqlite(directory, "public-state-v1.sqlite3", schemaVersion = 2, incrementalVacuum = true) {
    override fun createSchema(database: SQLiteDatabase) = SCHEMA.forEach(database::execSQL)
    override fun schemaStatements(): List<String> = SCHEMA

    fun chainDatabaseLoad(): CitizenSdkHostRecord = loadSingleton(CitizenSdkHostDomain.CHAIN_DATABASE)

    fun chainDatabaseCompareAndSwap(expectedRevision: Long, candidate: ByteArray): CitizenSdkHostRecord =
        compareAndSwapSingleton(CitizenSdkHostDomain.CHAIN_DATABASE, expectedRevision, candidate)

    fun runtimeCacheLoad(blockHash: ByteArray): CitizenSdkHostRecord = lock.withLock {
        val key = CitizenSdkRecordKey.blockHash(blockHash)
        database.query("runtime_cache", arrayOf("record"), "record_key = ?", arrayOf(key), null, null, null)
            .use { cursor ->
                if (!cursor.moveToFirst()) CitizenSdkHostRecord.absent(CitizenSdkHostDomain.RUNTIME_CACHE)
                else CitizenSdkHostRecord.present(CitizenSdkHostDomain.RUNTIME_CACHE, 0, cursor.getBlob(0))
            }
    }

    fun runtimeCacheStore(blockHash: ByteArray, candidate: ByteArray) = transaction { db ->
        val values = ContentValues().apply {
            put("record_key", CitizenSdkRecordKey.blockHash(blockHash))
            put("record", candidate.clone())
        }
        check(db.insertWithOnConflict("runtime_cache", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
        db.execSQL(
            "DELETE FROM runtime_cache WHERE rowid NOT IN " +
                "(SELECT rowid FROM runtime_cache ORDER BY rowid DESC LIMIT 64)",
        )
    }

    fun runtimeCacheDelete(blockHash: ByteArray) = transaction { db ->
        db.delete("runtime_cache", "record_key = ?", arrayOf(CitizenSdkRecordKey.blockHash(blockHash)))
    }

    /** Executes Core's fixed-width THQ1 index, exact-record, or stable-cursor page query. */
    fun transactionHistoryQuery(queryBytes: ByteArray): CitizenSdkHostRecord {
        val query = HistoryReader(queryBytes).readQuery()
        return lock.withLock {
            val index = historyIndex(database)
            if (query.kind != 1 && index.revision != query.expectedRevision) {
                return@withLock CitizenSdkHostRecord.failure(CitizenSdkHostDomain.TRANSACTION_HISTORY, 8)
            }
            val records = when (query.kind) {
                1 -> emptyList()
                2 -> historyExact(database, query.exactId)
                else -> historyPage(database, query)
            }
            val visible = records.take(query.limit)
            CitizenSdkHostRecord.present(
                CitizenSdkHostDomain.TRANSACTION_HISTORY,
                index.revision,
                HistoryWriter.batch(index, visible, records.size > visible.size),
            )
        }
    }

    /** Applies deletes, opaque upserts, and the next aggregate index in one SQLite transaction. */
    fun transactionHistoryMutate(expectedRevision: Long, mutationBytes: ByteArray): CitizenSdkHostRecord {
        val mutation = HistoryReader(mutationBytes).readMutation(expectedRevision)
        val result = transaction { db ->
            var computed = historyIndex(db)
            if (computed.revision != expectedRevision) {
                return@transaction CitizenSdkHostRecord.failure(CitizenSdkHostDomain.TRANSACTION_HISTORY, 8)
            }
            mutation.deletes.forEach { executionId ->
                val current = historyResource(db, executionId)
                    ?: throw CitizenSdkHistoryFailure(9, "history delete target is missing")
                if (!current.retentionTerminal) {
                    throw CitizenSdkHistoryFailure(9, "history mutation cannot delete an open execution")
                }
                computed = computed.minus(current)
                check(db.delete("transaction_history_records", "execution_id = ?", arrayOf(executionId)) == 1)
            }
            mutation.upserts.forEach { record ->
                historyResource(db, record.executionId)?.let { computed = computed.minus(it) }
                computed = computed.plus(record)
                val values = ContentValues().apply {
                    put("execution_id", record.executionId)
                    put("created_at_millis", record.created)
                    put("updated_at_millis", record.updated)
                    put("durable_weight", record.weight)
                    put("retention_terminal", if (record.retentionTerminal) 1 else 0)
                    put("chain_terminal", if (record.chainTerminal) 1 else 0)
                    put("record", record.record.clone())
                }
                check(db.insertWithOnConflict(
                    "transaction_history_records", null, values, SQLiteDatabase.CONFLICT_REPLACE,
                ) != -1L)
            }
            computed = computed.copy(revision = mutation.next.revision)
            if (computed != mutation.next) {
                throw CitizenSdkHistoryFailure(9, "history mutation aggregate is inconsistent")
            }
            val meta = ContentValues().apply {
                put("singleton", 1)
                put("revision", mutation.next.revision)
                put("record_count", mutation.next.recordCount)
                put("durable_weight", mutation.next.durableWeight)
                put("open_count", mutation.next.openCount)
                put("open_weight", mutation.next.openWeight)
            }
            check(db.insertWithOnConflict(
                "transaction_history_meta", null, meta, SQLiteDatabase.CONFLICT_REPLACE,
            ) != -1L)
            CitizenSdkHostRecord.present(
                CitizenSdkHostDomain.TRANSACTION_HISTORY,
                mutation.next.revision,
                HistoryWriter.batch(mutation.next, emptyList(), false),
            )
        }
        if (result.errorCode == 0 && mutation.deletes.isNotEmpty()) reclaimHistoryPages()
        return result
    }

    private fun historyIndex(db: SQLiteDatabase): HistoryIndex = db.rawQuery(
        "SELECT revision, record_count, durable_weight, open_count, open_weight " +
            "FROM transaction_history_meta WHERE singleton = 1",
        null,
    ).use { cursor ->
        if (!cursor.moveToFirst()) return@use HistoryIndex.EMPTY
        val result = HistoryIndex(
            cursor.positiveLong(0), cursor.boundedInt(1, 4096), cursor.boundedLong(2, MAX_WEIGHT),
            cursor.boundedInt(3, 4096), cursor.boundedLong(4, MAX_WEIGHT),
        )
        if (result.openCount > result.recordCount || result.openWeight > result.durableWeight) {
            throw CitizenSdkHistoryFailure(9, "history meta is inconsistent")
        }
        result
    }

    private fun historyExact(db: SQLiteDatabase, executionId: String): List<HistoryDescriptor> =
        db.query(
            "transaction_history_records", HISTORY_COLUMNS, "execution_id = ?", arrayOf(executionId),
            null, null, null, "1",
        ).use { cursor -> if (cursor.moveToFirst()) listOf(cursor.historyDescriptor()) else emptyList() }

    private fun historyPage(db: SQLiteDatabase, query: HistoryQuery): List<HistoryDescriptor> {
        var selection = when (query.kind) {
            4 -> "retention_terminal = 1"
            5 -> "chain_terminal = 0"
            else -> "1 = 1"
        }
        val arguments = mutableListOf<String>()
        query.cursorId?.let { cursorId ->
            selection += if (query.kind == 3) {
                " AND (created_at_millis < ? OR (created_at_millis = ? AND execution_id < ?))"
            } else {
                " AND (created_at_millis > ? OR (created_at_millis = ? AND execution_id > ?))"
            }
            arguments += query.cursorCreated.toString()
            arguments += query.cursorCreated.toString()
            arguments += cursorId
        }
        val order = if (query.kind == 3) {
            "created_at_millis DESC, execution_id DESC"
        } else {
            "created_at_millis ASC, execution_id ASC"
        }
        return db.query(
            "transaction_history_records", HISTORY_COLUMNS, selection, arguments.toTypedArray(),
            null, null, order, (query.limit + 1).toString(),
        ).use { cursor ->
            val records = mutableListOf<HistoryDescriptor>()
            while (cursor.moveToNext()) records += cursor.historyDescriptor()
            records
        }
    }

    private fun historyResource(db: SQLiteDatabase, executionId: String): HistoryResource? = db.query(
        "transaction_history_records", arrayOf("durable_weight", "retention_terminal"),
        "execution_id = ?", arrayOf(executionId), null, null, null, "1",
    ).use { cursor ->
        if (!cursor.moveToFirst()) null
        else HistoryResource(cursor.boundedLong(0, MAX_WEIGHT), cursor.boundedInt(1, 1) != 0)
    }

    private fun reclaimHistoryPages() = lock.withLock {
        val pages = database.rawQuery("PRAGMA page_count", null).use { cursor ->
            check(cursor.moveToFirst()); cursor.getLong(0)
        }
        val free = database.rawQuery("PRAGMA freelist_count", null).use { cursor ->
            check(cursor.moveToFirst()); cursor.getLong(0)
        }
        if (free > 16 && free * 4 > pages) {
            database.execSQL("PRAGMA incremental_vacuum(128)")
            database.rawQuery("PRAGMA wal_checkpoint(PASSIVE)", null).use { cursor ->
                check(cursor.moveToFirst()) { "history WAL checkpoint did not complete" }
            }
        }
    }

    private fun loadSingleton(domain: Int): CitizenSdkHostRecord = lock.withLock {
        database.query(
            "singleton_records", arrayOf("revision", "record"), "domain = ?",
            arrayOf(domain.toString()), null, null, null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) CitizenSdkHostRecord.absent(domain)
            else CitizenSdkHostRecord.present(domain, cursor.getLong(0), cursor.getBlob(1))
        }
    }

    private fun compareAndSwapSingleton(
        domain: Int,
        expectedRevision: Long,
        candidate: ByteArray,
    ): CitizenSdkHostRecord = transaction { db ->
        val actualRevision = db.query(
            "singleton_records", arrayOf("revision"), "domain = ?",
            arrayOf(domain.toString()), null, null, null,
        ).use { cursor -> if (!cursor.moveToFirst()) 0L else cursor.getLong(0) }
        if (actualRevision != expectedRevision || expectedRevision == Long.MAX_VALUE) {
            return@transaction CitizenSdkHostRecord.failure(domain, 8)
        }
        val nextRevision = expectedRevision + 1L
        val values = ContentValues().apply {
            put("domain", domain); put("revision", nextRevision); put("record", candidate.clone())
        }
        check(db.insertWithOnConflict(
            "singleton_records", null, values, SQLiteDatabase.CONFLICT_REPLACE,
        ) != -1L)
        CitizenSdkHostRecord.present(domain, nextRevision, candidate)
    }

    private fun Cursor.positiveLong(column: Int): Long = getLong(column).also {
        if (it <= 0) throw CitizenSdkHistoryFailure(9, "history integer is outside its valid range")
    }

    private fun Cursor.boundedLong(column: Int, maximum: Long): Long = getLong(column).also {
        if (it !in 0..maximum) throw CitizenSdkHistoryFailure(9, "history integer is outside its valid range")
    }

    private fun Cursor.boundedInt(column: Int, maximum: Int): Int = getInt(column).also {
        if (it !in 0..maximum) throw CitizenSdkHistoryFailure(9, "history integer is outside its valid range")
    }

    private fun Cursor.historyDescriptor() = HistoryDescriptor(
        executionId = getString(0).also { if (!ID_REGEX.matches(it)) throw CitizenSdkHistoryFailure(9, "bad execution ID") },
        created = boundedLong(1, Long.MAX_VALUE),
        updated = boundedLong(2, Long.MAX_VALUE),
        weight = boundedLong(3, MAX_WEIGHT),
        retentionTerminal = boundedInt(4, 1) != 0,
        chainTerminal = boundedInt(5, 1) != 0,
        record = getBlob(6).also { if (it.isEmpty() || it.size > MAX_WIRE) throw CitizenSdkHistoryFailure(9, "bad history record") },
    )

    companion object {
        private const val MAX_WIRE = 32 * 1024 * 1024
        private const val MAX_WEIGHT = 31L * 1024L * 1024L
        private val ID_REGEX = Regex("[0-9a-f]{32}")
        private val HISTORY_COLUMNS = arrayOf(
            "execution_id", "created_at_millis", "updated_at_millis", "durable_weight",
            "retention_terminal", "chain_terminal", "record",
        )
        private val SCHEMA = listOf(
            "CREATE TABLE IF NOT EXISTS singleton_records (" +
                "domain INTEGER PRIMARY KEY CHECK(domain = 1), " +
                "revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision > 0), " +
                "record BLOB NOT NULL CHECK(typeof(record) = 'blob' AND length(record) <= 524288))",
            "CREATE TABLE IF NOT EXISTS runtime_cache (" +
                "record_key TEXT PRIMARY KEY, record BLOB NOT NULL " +
                "CHECK(typeof(record) = 'blob' AND length(record) <= 8388608))",
            "CREATE TABLE IF NOT EXISTS transaction_history_meta (" +
                "singleton INTEGER PRIMARY KEY CHECK(singleton = 1), " +
                "revision INTEGER NOT NULL CHECK(revision > 0), " +
                "record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 4096), " +
                "durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 0 AND 32505856), " +
                "open_count INTEGER NOT NULL CHECK(open_count BETWEEN 0 AND record_count), " +
                "open_weight INTEGER NOT NULL CHECK(open_weight BETWEEN 0 AND durable_weight))",
            "CREATE TABLE IF NOT EXISTS transaction_history_records (" +
                "execution_id TEXT PRIMARY KEY CHECK(length(execution_id) = 32 AND execution_id NOT GLOB '*[^0-9a-f]*'), " +
                "created_at_millis INTEGER NOT NULL CHECK(created_at_millis >= 0), " +
                "updated_at_millis INTEGER NOT NULL CHECK(updated_at_millis >= created_at_millis), " +
                "durable_weight INTEGER NOT NULL CHECK(durable_weight BETWEEN 1 AND 32505856), " +
                "retention_terminal INTEGER NOT NULL CHECK(retention_terminal IN (0,1)), " +
                "chain_terminal INTEGER NOT NULL CHECK(chain_terminal IN (0,1) AND chain_terminal <= retention_terminal), " +
                "record BLOB NOT NULL CHECK(length(record) BETWEEN 1 AND 33554432))",
            "CREATE INDEX IF NOT EXISTS transaction_history_newest_idx ON " +
                "transaction_history_records(created_at_millis DESC, execution_id DESC)",
            "CREATE INDEX IF NOT EXISTS transaction_history_retention_idx ON " +
                "transaction_history_records(retention_terminal, created_at_millis, execution_id)",
            "CREATE INDEX IF NOT EXISTS transaction_history_reconcile_idx ON " +
                "transaction_history_records(chain_terminal, created_at_millis, execution_id)",
        )
    }
}

private data class HistoryIndex(
    val revision: Long,
    val recordCount: Int,
    val durableWeight: Long,
    val openCount: Int,
    val openWeight: Long,
) {
    fun minus(record: HistoryResource): HistoryIndex {
        if (recordCount == 0 || durableWeight < record.weight ||
            (!record.retentionTerminal && (openCount == 0 || openWeight < record.weight))
        ) throw CitizenSdkHistoryFailure(9, "history aggregate underflow")
        return copy(
            recordCount = recordCount - 1,
            durableWeight = durableWeight - record.weight,
            openCount = openCount - if (record.retentionTerminal) 0 else 1,
            openWeight = openWeight - if (record.retentionTerminal) 0 else record.weight,
        )
    }

    fun plus(record: HistoryDescriptor): HistoryIndex {
        if (recordCount >= 4096 || durableWeight > MAX_WEIGHT - record.weight) {
            throw CitizenSdkHistoryFailure(4, "history capacity is exceeded")
        }
        return copy(
            recordCount = recordCount + 1,
            durableWeight = durableWeight + record.weight,
            openCount = openCount + if (record.retentionTerminal) 0 else 1,
            openWeight = openWeight + if (record.retentionTerminal) 0 else record.weight,
        )
    }

    companion object {
        val EMPTY = HistoryIndex(0, 0, 0, 0, 0)
        private const val MAX_WEIGHT = 31L * 1024L * 1024L
    }
}

private data class HistoryResource(val weight: Long, val retentionTerminal: Boolean)
private data class HistoryDescriptor(
    val executionId: String,
    val created: Long,
    val updated: Long,
    val weight: Long,
    val retentionTerminal: Boolean,
    val chainTerminal: Boolean,
    val record: ByteArray,
)
private data class HistoryQuery(
    val kind: Int,
    val expectedRevision: Long,
    val limit: Int,
    val exactId: String,
    val cursorCreated: Long,
    val cursorId: String?,
)
private data class HistoryMutation(
    val next: HistoryIndex,
    val deletes: List<String>,
    val upserts: List<HistoryDescriptor>,
)

private class HistoryReader(private val bytes: ByteArray) {
    private var offset = 0

    fun readQuery(): HistoryQuery {
        magic("THQ1")
        val kind = u8()
        val expected = long()
        val limit = int()
        val exact = id()
        val hasCursor = boolean()
        val cursorCreated = long()
        val cursor = id()
        finish()
        val exactZero = exact.all { it == '0' }
        val cursorZero = cursor.all { it == '0' }
        val valid = kind in 1..5 && when (kind) {
            1 -> expected == -1L && limit == 0
            2 -> limit == 1 && !exactZero && !hasCursor
            else -> limit in 1..100 && exactZero
        } && if (hasCursor) kind >= 3 && !cursorZero && cursorCreated >= 0
        else cursorCreated == 0L && cursorZero
        if (!valid) fail(4, "history query shape is invalid")
        return HistoryQuery(kind, expected, limit, exact, cursorCreated, cursor.takeIf { hasCursor })
    }

    fun readMutation(expected: Long): HistoryMutation {
        magic("THM1")
        val next = index()
        val deleteCount = int()
        if (deleteCount !in 0..4096) fail(4, "history delete batch is invalid")
        val identities = HashSet<String>()
        val deletes = List(deleteCount) {
            id().also { if (it.all { byte -> byte == '0' } || !identities.add(it)) fail(4, "duplicate history ID") }
        }
        val upsertCount = int()
        if (upsertCount !in 0..100) fail(4, "history upsert batch is invalid")
        val upserts = List(upsertCount) {
            descriptor().also { if (!identities.add(it.executionId)) fail(4, "conflicting history ID") }
        }
        finish()
        if (expected < 0 || expected == Long.MAX_VALUE || next.revision != expected + 1) {
            fail(4, "history mutation revision is invalid")
        }
        return HistoryMutation(next, deletes, upserts)
    }

    private fun index(): HistoryIndex {
        val value = HistoryIndex(long(), int(), long(), int(), long())
        if (value.revision < 0 || value.recordCount !in 0..4096 ||
            value.durableWeight !in 0..MAX_WEIGHT || value.openCount !in 0..value.recordCount ||
            value.openWeight !in 0..value.durableWeight
        ) fail(4, "history index is invalid")
        return value
    }

    private fun descriptor(): HistoryDescriptor {
        val id = id()
        val created = long()
        val updated = long()
        val weight = long()
        val retention = boolean()
        val chain = boolean()
        val record = byteField()
        if (id.all { it == '0' } || created < 0 || updated < created || weight !in 1..MAX_WEIGHT ||
            chain && !retention || record.isEmpty()
        ) fail(4, "history descriptor is invalid")
        return HistoryDescriptor(id, created, updated, weight, retention, chain, record)
    }

    private fun magic(value: String) {
        if (offset + 4 > bytes.size || bytes.copyOfRange(offset, offset + 4).decodeToString() != value) {
            fail(3, "history wire magic is invalid")
        }
        offset += 4
    }
    private fun u8(): Int = if (offset < bytes.size) bytes[offset++].toInt() and 0xff else fail(3, "truncated history wire")
    private fun boolean(): Boolean = u8().let { if (it > 1) fail(3, "invalid history boolean") else it == 1 }
    private fun int(): Int {
        if (offset + 4 > bytes.size) fail(3, "truncated history wire")
        var result = 0
        repeat(4) { result = result or (u8() shl (it * 8)) }
        return result
    }
    private fun long(): Long {
        if (offset + 8 > bytes.size) fail(3, "truncated history wire")
        var result = 0L
        repeat(8) { result = result or (u8().toLong() shl (it * 8)) }
        return result
    }
    private fun id(): String {
        if (offset + 16 > bytes.size) fail(3, "truncated history ID")
        return buildString(32) {
            repeat(16) { append(bytes[offset++].toUByte().toString(16).padStart(2, '0')) }
        }
    }
    private fun byteField(): ByteArray {
        val count = int()
        if (count < 0 || count > MAX_WIRE || offset + count > bytes.size) fail(3, "invalid history bytes")
        return bytes.copyOfRange(offset, offset + count).also { offset += count }
    }
    private fun finish() { if (offset != bytes.size) fail(3, "history wire has trailing bytes") }
    private fun fail(code: Int, message: String): Nothing = throw CitizenSdkHistoryFailure(code, message)

    companion object {
        private const val MAX_WIRE = 32 * 1024 * 1024
        private const val MAX_WEIGHT = 31L * 1024L * 1024L
    }
}

private object HistoryWriter {
    fun batch(index: HistoryIndex, records: List<HistoryDescriptor>, hasMore: Boolean): ByteArray {
        val bytes = ArrayList<Byte>()
        fun u8(value: Int) { bytes += value.toByte() }
        fun int(value: Int) { repeat(4) { u8(value ushr (it * 8)) } }
        fun long(value: Long) { repeat(8) { u8((value ushr (it * 8)).toInt()) } }
        fun id(value: String) { value.chunked(2).forEach { u8(it.toInt(16)) } }
        "THB1".encodeToByteArray().forEach { bytes += it }
        long(index.revision); int(index.recordCount); long(index.durableWeight)
        int(index.openCount); long(index.openWeight); u8(if (hasMore) 1 else 0); int(records.size)
        records.forEach { record ->
            id(record.executionId); long(record.created); long(record.updated); long(record.weight)
            u8(if (record.retentionTerminal) 1 else 0); u8(if (record.chainTerminal) 1 else 0)
            int(record.record.size); record.record.forEach { bytes += it }
        }
        if (bytes.size > 32 * 1024 * 1024) throw CitizenSdkHistoryFailure(4, "history response is too large")
        return bytes.toByteArray()
    }
}
