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
                db.execute("CREATE TABLE resource(id INTEGER, value BLOB)", emptyArray())
                db.begin()
                db.execute("INSERT INTO resource VALUES(?, ?)", arrayOf(1L, byteArrayOf(2)))
                db.end(false)
                db.cursor("SELECT count(*) FROM resource", emptyArray()).use { assertTrue(it.moveToFirst()); assertEquals(0L, it.getLong(0)) }
                assertTrue(runCatching { db.cursor("SELECT * FROM missing", emptyArray()).use { it.moveToFirst() } }.isFailure)
            } finally { db.release() }
        } } finally { directory.deleteRecursively() }
    }

}
