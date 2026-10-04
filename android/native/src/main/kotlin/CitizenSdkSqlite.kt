package org.citizen.sdk.internal

import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.util.Locale
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Small no-backup SQLite owner with explicit transactional serialization. */
internal abstract class CitizenSdkSqlite(
    directory: File,
    fileName: String,
    private val schemaVersion: Int = 1,
    private val incrementalVacuum: Boolean = false,
) : AutoCloseable {
    protected val lock = ReentrantLock(true)
    protected val database: SQLiteDatabase

    init {
        check(directory.exists() || directory.mkdirs()) { "unable to create CitizenSDK storage directory" }
        val file = File(directory, fileName)
        // SDK schema不使用LOCALIZED排序；禁用Android locale元数据，确保任何表创建前即可固定文件策略。
        database = SQLiteDatabase.openDatabase(
            file.absolutePath,
            null,
            SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.NO_LOCALIZED_COLLATORS,
        )
        lock.withLock {
            val version = database.rawQuery("PRAGMA user_version", null).use { cursor ->
                check(cursor.moveToFirst()) { "CitizenSDK schema version is unavailable" }
                cursor.getInt(0)
            }
            val objectCount = database.rawQuery(
                // Android为新文件自动创建android_metadata；它不是CitizenSDK schema对象。
                "SELECT count(*) FROM sqlite_master " +
                    "WHERE name NOT GLOB 'sqlite_*' AND name != 'android_metadata'",
                null,
            ).use { cursor ->
                check(cursor.moveToFirst()) { "CitizenSDK schema inventory is unavailable" }
                cursor.getInt(0)
            }
            val initialize = version == 0 && objectCount == 0
            check(initialize || version == schemaVersion) {
                "CitizenSDK database schema is unsupported; clear the old development database"
            }
            if (initialize) {
                executePragma(
                    if (incrementalVacuum) "PRAGMA auto_vacuum=INCREMENTAL"
                    else "PRAGMA auto_vacuum=NONE",
                )
                database.beginTransaction()
                try {
                    createSchema(database)
                    database.execSQL("PRAGMA user_version=$schemaVersion")
                    database.setTransactionSuccessful()
                } finally {
                    database.endTransaction()
                }
            }
            verifySchema(database)
            val autoVacuum = database.rawQuery("PRAGMA auto_vacuum", null).use { cursor ->
                check(cursor.moveToFirst()) { "CitizenSDK auto-vacuum mode is unavailable" }
                cursor.getInt(0)
            }
            check(autoVacuum == if (incrementalVacuum) 2 else 0) {
                "CitizenSDK database auto-vacuum policy differs from its fixed schema: " +
                    "actual=$autoVacuum expected=${if (incrementalVacuum) 2 else 0}"
            }
            check(database.enableWriteAheadLogging()) { "CitizenSDK WAL mode is unavailable" }
            database.setForeignKeyConstraintsEnabled(true)
            executePragma("PRAGMA synchronous=FULL")
            executePragma("PRAGMA busy_timeout=5000")
        }
    }

    /** Android拒绝用execSQL执行返回结果集的PRAGMA；查询必须完整消费后才算应用。 */
    private fun executePragma(statement: String) {
        database.rawQuery(statement, null).use { cursor -> while (cursor.moveToNext()) Unit }
    }

    protected abstract fun createSchema(database: SQLiteDatabase)

    /** Each concrete store returns the exact SQL it executes, so an existing
     * same-version database cannot smuggle in missing, changed, or extra objects. */
    protected open fun schemaStatements(): List<String> = emptyList()

    private fun verifySchema(database: SQLiteDatabase) {
        val expected = schemaStatements()
        if (expected.isEmpty()) return
        val count = database.rawQuery(
            "SELECT count(*) FROM sqlite_master " +
                "WHERE name NOT GLOB 'sqlite_*' AND name != 'android_metadata'",
            null,
        ).use { cursor -> check(cursor.moveToFirst()); cursor.getInt(0) }
        check(count == expected.size) { "CitizenSDK SQLite schema contains unexpected objects" }
        expected.forEach { sql ->
            val tablePrefix = "CREATE TABLE IF NOT EXISTS "
            val indexPrefix = "CREATE INDEX IF NOT EXISTS "
            val table = sql.startsWith(tablePrefix)
            val prefix = if (table) tablePrefix else indexPrefix
            check(table || sql.startsWith(indexPrefix)) { "invalid embedded CitizenSDK schema" }
            val tail = sql.substring(prefix.length)
            val name = tail.substringBefore(if (table) "(" else " ").trim()
            val actual = database.rawQuery(
                "SELECT sql FROM sqlite_master WHERE type = ? AND name = ?",
                arrayOf(if (table) "table" else "index", name),
            ).use { cursor ->
                check(cursor.moveToFirst()) { "CitizenSDK SQLite schema object is missing" }
                cursor.getString(0)
            }
            fun canonical(value: String) = value.lowercase(Locale.ROOT)
                .replace(Regex("\\s+"), "")
                .replace("ifnotexists", "")
            check(canonical(actual) == canonical(sql)) {
                "CitizenSDK SQLite schema differs from its fixed contract"
            }
        }
    }

    protected fun <T> transaction(block: (SQLiteDatabase) -> T): T = lock.withLock {
        database.beginTransaction()
        try {
            block(database).also { database.setTransactionSuccessful() }
        } finally {
            database.endTransaction()
        }
    }

    override fun close() = lock.withLock { database.close() }
}
