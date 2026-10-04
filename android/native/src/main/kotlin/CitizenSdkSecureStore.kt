package org.citizen.sdk.internal

import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Wallet public profile, authenticated ciphertext and permanent vault tombstones. */
internal class CitizenSdkSecureStore(private val directory: File) :
    CitizenSdkSqlite(directory, "secure-state-v1.sqlite3") {
    override fun createSchema(database: SQLiteDatabase) {
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS wallet_profile (" +
                "wallet_index INTEGER PRIMARY KEY CHECK(wallet_index = 0), " +
                "revision INTEGER NOT NULL, record BLOB NOT NULL)",
        )
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS encrypted_secret (" +
                "record_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record BLOB NOT NULL)",
        )
        database.execSQL(
            "CREATE TABLE IF NOT EXISTS vault_generation (" +
                "record_key TEXT PRIMARY KEY, wallet_index INTEGER NOT NULL, generation BLOB NOT NULL, " +
                "state INTEGER NOT NULL, operation_id BLOB NOT NULL)",
        )
    }

    fun walletProfileLoad(): CitizenSdkHostRecord = lock.withLock {
        database.query(
            "wallet_profile",
            arrayOf("revision", "record"),
            "wallet_index = 0",
            null,
            null,
            null,
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) CitizenSdkHostRecord.absent(CitizenSdkHostDomain.WALLET_PROFILE)
            else CitizenSdkHostRecord.present(
                CitizenSdkHostDomain.WALLET_PROFILE,
                cursor.getLong(0),
                cursor.getBlob(1),
            )
        }
    }

    fun walletProfileCompareAndSwap(
        expectedRevision: Long,
        candidate: ByteArray,
    ): CitizenSdkHostRecord = transaction { db ->
        val revision = db.query(
            "wallet_profile",
            arrayOf("revision"),
            "wallet_index = 0",
            null,
            null,
            null,
            null,
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
        if (revision != expectedRevision || expectedRevision == Long.MAX_VALUE) {
            return@transaction CitizenSdkHostRecord.failure(CitizenSdkHostDomain.WALLET_PROFILE, 8)
        }
        val next = expectedRevision + 1L
        val values = ContentValues().apply {
            put("wallet_index", 0)
            put("revision", next)
            put("record", candidate.clone())
        }
        check(db.insertWithOnConflict("wallet_profile", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
        CitizenSdkHostRecord.present(CitizenSdkHostDomain.WALLET_PROFILE, next, candidate)
    }


    /** 只读逐条扫描，Core是密文信封/修订/状态的唯一解码器；失败不能当成不存在。 */
    fun hasAccountSecret(accountId: ByteArray): Boolean = lock.withLock {
        require(accountId.size == 32)
        database.rawQuery("SELECT revision, length(record), record FROM encrypted_secret LIMIT 65537", null).use { cursor ->
            var count = 0
            while (cursor.moveToNext()) {
                count++
                if (count > 65536 || cursor.getType(0) != android.database.Cursor.FIELD_TYPE_INTEGER ||
                    cursor.getLong(0) <= 0 || cursor.getType(2) != android.database.Cursor.FIELD_TYPE_BLOB ||
                    cursor.getLong(1) !in 1L..65536L) {
                    throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "密文存在性查询边界无效")
                }
                if (CitizenSdkNative.encryptedSecretRecordHasSecret(accountId, cursor.getLong(0), cursor.getBlob(2))) return@withLock true
            }
            false
        }
    }

    /** active和retired代际均参与物理钥核对，不以数据库标志代替系统枚举。 */
    fun vaultGenerations(): List<Pair<Int, ByteArray>> = lock.withLock {
        database.rawQuery("SELECT record_key, wallet_index, generation, state, length(generation), length(record_key) FROM vault_generation LIMIT 65537", null).use { cursor ->
            val values = ArrayList<Pair<Int, ByteArray>>()
            while (cursor.moveToNext()) {
                val index = cursor.getLong(1)
                if (values.size >= 65536 || cursor.getType(1) != android.database.Cursor.FIELD_TYPE_INTEGER ||
                    index !in 0L..0xffffffffL || cursor.getType(2) != android.database.Cursor.FIELD_TYPE_BLOB ||
                    cursor.getLong(4) != 16L || cursor.getType(3) != android.database.Cursor.FIELD_TYPE_INTEGER ||
                    cursor.getLong(3) !in STATE_ACTIVE.toLong()..STATE_RETIRED.toLong() || cursor.getLong(5) > 64 ||
                    cursor.getType(0) != android.database.Cursor.FIELD_TYPE_STRING) {
                    throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "金库代际事实无效")
                }
                val generation = cursor.getBlob(2)
                if (cursor.getString(0) != CitizenSdkRecordKey.walletGeneration(index.toInt(), generation)) {
                    throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "金库代际主键不一致")
                }
                values.add(index.toInt() to generation)
            }
            values
        }
    }

    fun encryptedSecretLoad(
        walletIndex: Int,
        kind: Int,
        generation: ByteArray,
        owner: ByteArray,
        accountId: ByteArray,
    ): CitizenSdkHostRecord = lock.withLock {
        val key = CitizenSdkRecordKey.secret(walletIndex, kind, generation, owner, accountId)
        database.query(
            "encrypted_secret",
            arrayOf("revision", "record"),
            "record_key = ?",
            arrayOf(key),
            null,
            null,
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) CitizenSdkHostRecord.absent(CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB)
            else CitizenSdkHostRecord.present(
                CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB,
                cursor.getLong(0),
                cursor.getBlob(1),
            )
        }
    }

    fun encryptedSecretCompareAndSwap(
        walletIndex: Int,
        kind: Int,
        generation: ByteArray,
        owner: ByteArray,
        accountId: ByteArray,
        expectedRevision: Long,
        candidate: ByteArray,
    ): CitizenSdkHostRecord = transaction { db ->
        val key = CitizenSdkRecordKey.secret(walletIndex, kind, generation, owner, accountId)
        val revision = db.query(
            "encrypted_secret",
            arrayOf("revision"),
            "record_key = ?",
            arrayOf(key),
            null,
            null,
            null,
        ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else 0L }
        if (revision != expectedRevision || expectedRevision == Long.MAX_VALUE) {
            return@transaction CitizenSdkHostRecord.failure(CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB, 8)
        }
        val next = expectedRevision + 1L
        val values = ContentValues().apply {
            put("record_key", key)
            put("revision", next)
            put("record", candidate.clone())
        }
        check(db.insertWithOnConflict("encrypted_secret", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
        CitizenSdkHostRecord.present(CitizenSdkHostDomain.ENCRYPTED_SECRET_BLOB, next, candidate)
    }

    fun ensureGeneration(
        walletIndex: Int,
        generation: ByteArray,
        provisioningOperationId: ByteArray,
    ): Boolean = transaction { db ->
        val key = CitizenSdkRecordKey.walletGeneration(walletIndex, generation)
        val existing = generationRecord(db, key)
        if (existing?.first == STATE_RETIRED) return@transaction false
        if (existing?.first == STATE_ACTIVE) {
            // A generation is admitted by exactly one provisioning operation.
            // Reusing its bytes under another operation must fail closed.
            return@transaction existing.second.contentEquals(provisioningOperationId)
        }
        val values = ContentValues().apply {
            put("record_key", key)
            put("wallet_index", walletIndex)
            put("generation", generation.clone())
            put("state", STATE_ACTIVE)
            put("operation_id", provisioningOperationId.clone())
        }
        check(db.insertOrThrow("vault_generation", null, values) != -1L)
        true
    }

    fun isGenerationActive(walletIndex: Int, generation: ByteArray): Boolean = lock.withLock {
        generationState(database, CitizenSdkRecordKey.walletGeneration(walletIndex, generation)) == STATE_ACTIVE
    }

    /** 同进程统一 owner 加操作系统文件锁，覆盖数据库状态与物理 Keystore 的跨进程副作用。 */
    fun <T> withVaultLock(body: () -> T): T {
        val file = File(directory, "vault.lock")
        val path = file.toPath()
        val processLock = vaultLocks.computeIfAbsent(file.absolutePath) { ReentrantLock() }
        return processLock.withLock {
            if (Files.isSymbolicLink(path)) throw IllegalStateException("CitizenSDK vault lock is a link")
            RandomAccessFile(file, "rw").use { owner ->
                file.setReadable(false, false); file.setWritable(false, false)
                file.setReadable(true, true); file.setWritable(true, true)
                val attributes = Files.readAttributes(
                    path,
                    BasicFileAttributes::class.java,
                    LinkOption.NOFOLLOW_LINKS,
                )
                check(attributes.isRegularFile && !attributes.isSymbolicLink) {
                    "CitizenSDK vault lock is not a regular file"
                }
                owner.channel.lock().use { body() }
            }
        }
    }

    /** Tombstone commits before the caller attempts physical Keystore deletion. */
    fun retireGeneration(
        walletIndex: Int,
        generation: ByteArray,
        cleanupOperationId: ByteArray,
    ) = transaction { db ->
        val key = CitizenSdkRecordKey.walletGeneration(walletIndex, generation)
        val values = ContentValues().apply {
            put("record_key", key)
            put("wallet_index", walletIndex)
            put("generation", generation.clone())
            put("state", STATE_RETIRED)
            put("operation_id", cleanupOperationId.clone())
        }
        check(db.insertWithOnConflict("vault_generation", null, values, SQLiteDatabase.CONFLICT_REPLACE) != -1L)
    }

    private fun generationState(db: SQLiteDatabase, key: String): Int? = db.query(
        "vault_generation",
        arrayOf("state"),
        "record_key = ?",
        arrayOf(key),
        null,
        null,
        null,
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else null }

    private fun generationRecord(db: SQLiteDatabase, key: String): Pair<Int, ByteArray>? = db.query(
        "vault_generation",
        arrayOf("state", "operation_id"),
        "record_key = ?",
        arrayOf(key),
        null,
        null,
        null,
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) to cursor.getBlob(1) else null }

    companion object {
        private val vaultLocks = ConcurrentHashMap<String, ReentrantLock>()
        internal const val STATE_ACTIVE = 1
        internal const val STATE_RETIRED = 2
    }
}
