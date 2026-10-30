package org.citizen.sdk

import androidx.test.core.app.ApplicationProvider
import org.citizen.sdk.internal.CitizenSdkDatabase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CitizenSdkStateStoreTest {

    @Test
    fun sqliteResourceBindsTypedValuesAndRollsBack() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/sqlite-" + System.nanoTime())
        try { CitizenSdkDatabase(directory).use { db ->
            db.acquire()
            try {
                db.execute("CREATE TABLE resource(row_index INTEGER, row_data BLOB)", emptyArray())
                db.begin()
                db.execute("INSERT INTO resource VALUES(?, ?)", arrayOf(1L, byteArrayOf(2)))
                db.end(false)
                db.cursor("SELECT count(*) FROM resource", emptyArray()).use { assertTrue(it.moveToFirst()); assertEquals(0L, it.getLong(0)) }
                assertTrue(runCatching { db.cursor("SELECT * FROM missing", emptyArray()).use { it.moveToFirst() } }.isFailure)
            } finally { db.release() }
        } } finally { directory.deleteRecursively() }
    }

    /** 同一系统SQLite连接提交、关闭和重开；仅拥有本测试临时目录。 */
    @Test
    fun committedRowsSurviveReopen() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/reopen-" + System.nanoTime())
        try {
            CitizenSdkDatabase(directory).use { db ->
                db.acquire()
                try {
                    db.execute("CREATE TABLE resource(row_index INTEGER, row_data BLOB)", emptyArray())
                    db.begin()
                    repeat(32) { db.execute("INSERT INTO resource VALUES(?, ?)", arrayOf(it.toLong(), byteArrayOf(2))) }
                    db.end(true)
                } finally { db.release() }
            }
            CitizenSdkDatabase(directory).use { db ->
                db.acquire()
                try { db.cursor("SELECT count(*) FROM resource", emptyArray()).use { assertTrue(it.moveToFirst()); assertEquals(32L, it.getLong(0)) } }
                finally { db.release() }
            }
        } finally { directory.deleteRecursively() }
    }

}
