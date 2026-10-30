package org.citizen.sdk.internal

import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import org.citizen.sdk.CitizenSdkErrorCode
import org.citizen.sdk.CitizenSdkException
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** SQLite连接与文件锁资源；schema、记录和CAS由Rust唯一实现。 */
internal class CitizenSdkDatabase(private val directory: File, secure: Boolean = false) : AutoCloseable {
    private val lock = ReentrantLock(true)
    private val database: SQLiteDatabase
    init {
        check(directory.exists() || directory.mkdirs()) { "unable to create CitizenSDK storage directory" }
        database = SQLiteDatabase.openDatabase(
            File(directory, if (secure) "secure-state.sqlite3" else "public-state.sqlite3").absolutePath,
            null, SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.NO_LOCALIZED_COLLATORS,
        )
    }
    private var failed = false
    fun acquire() {
        lock.lock()
        if (failed) { lock.unlock(); throw CitizenSdkException(CitizenSdkErrorCode.STORAGE, "SQLite resource is retired") }
    }
    fun release() {
        try {
            if (database.inTransaction()) {
                // 未排空的事务不能成为下一请求的可见状态；退休连接，禁止重开或降级。
                failed = true
                database.close()
                throw CitizenSdkException(CitizenSdkErrorCode.STORAGE, "SQLite transaction did not end")
            }
        } finally { lock.unlock() }
    }
    fun begin() { database.beginTransactionNonExclusive() }
    fun end(commit: Boolean) {
        if (commit) database.setTransactionSuccessful()
        database.endTransaction()
    }
    fun wal() { check(database.enableWriteAheadLogging()) { "SQLite WAL is unavailable" } }
    private fun bind(program: SQLiteProgram, values: Array<Any?>) {
        values.forEachIndexed { i, value -> when (value) {
            null -> program.bindNull(i + 1)
            is Long -> program.bindLong(i + 1, value)
            is String -> program.bindString(i + 1, value)
            is ByteArray -> program.bindBlob(i + 1, value)
            else -> throw CitizenSdkException(CitizenSdkErrorCode.INVALID_ARGUMENT, "SQLite parameter type differs")
        } }
    }
    fun cursor(sql: String, values: Array<Any?>): Cursor {
        require(sql.length in 1..65536 && values.size <= 16)
        return database.rawQueryWithFactory(
        { _, driver, table, query -> bind(query, values); SQLiteCursor(driver, table, query) },
        sql, emptyArray(), "",
    )
    }
    fun execute(sql: String, values: Array<Any?>): Long {
        require(sql.length in 1..65536 && values.size <= 16)
        if (sql.equals("PRAGMA foreign_keys=ON", ignoreCase = true)) {
            database.setForeignKeyConstraintsEnabled(true)
            return 0
        }
        if (sql.trimStart().startsWith("PRAGMA", ignoreCase = true)) {
            cursor(sql, values).use { while (it.moveToNext()) Unit }
            return 0
        }
        return database.compileStatement(sql).use { bind(it, values); it.executeUpdateDelete().toLong() }
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


    override fun close() = lock.withLock { database.close() }
    companion object { private val vaultLocks = ConcurrentHashMap<String, ReentrantLock>() }
}
