package org.citizen.sdk

import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import org.citizen.sdk.internal.CitizenSdkPublicStore
import org.citizen.sdk.internal.CitizenSdkSecureStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CitizenSdkStateStoreTest {

    @Test
    fun secretPresenceRejectsCorruptRowsAndChecksGenerations() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/presence-" + System.nanoTime())
        val bytes = { hex: String -> hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray() }
        val sealed = bytes("43534852010038000500000000000000b8000000000000009481a10e6546da63b1c160907fb48acbfa35c6ffdee717bfd4a0094b3d9e57b901000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")
        val tombstone = bytes("43534852010038000500000000000000600000000000000017b5fd919396d702e90558844acef60fb5a38a41f42bdfa34a449075559ce09101000700000008080808080808080808080808080808090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010200000000000000030e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e")
        val second = bytes("43534852010038000500000000000000b800000000000000bbf644dec5dde868148f6f1ffe1151f121f1de7e78e2b7ecd7c9e35e0cdd48a501000700000058585858585858585858585858585858090909090909090909090909090909090a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a010100000000000000020b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b010000000c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c300000000d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d")
        val account = ByteArray(32) { 10 }; val owner = ByteArray(16) { 9 }; val generation = ByteArray(16) { 8 }
        try {
            CitizenSdkSecureStore(directory).use { store ->
                assertTrue(!store.hasAccountSecret(account))
                store.encryptedSecretCompareAndSwap(7, 1, generation, owner, account, 0, sealed)
                assertTrue(store.hasAccountSecret(account))
                assertTrue(!store.hasAccountSecret(ByteArray(32) { 11 }))
                store.encryptedSecretCompareAndSwap(7, 1, generation, owner, account, 1, tombstone)
                assertTrue(!store.hasAccountSecret(account))
                store.encryptedSecretCompareAndSwap(7, 1, ByteArray(16) { 88 }, owner, account, 0, second)
                assertTrue(store.hasAccountSecret(account))
                assertTrue(runCatching { store.hasAccountSecret(ByteArray(31)) }.isFailure)
                store.encryptedSecretCompareAndSwap(7, 1, generation, owner, account, 2, byteArrayOf(1))
                assertTrue(runCatching { store.hasAccountSecret(ByteArray(32) { 12 }) }.exceptionOrNull() is CitizenSdkException)
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun generationProjectionKeepsRetiredPhysicalKeyCandidates() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/generations-" + System.nanoTime())
        try {
            CitizenSdkSecureStore(directory).use { store ->
                assertTrue(store.vaultGenerations().isEmpty())
                val generation = ByteArray(16) { 4 }
                assertTrue(store.ensureGeneration(0, generation, ByteArray(16) { 5 }))
                store.retireGeneration(0, generation, ByteArray(16) { 6 })
                val values = store.vaultGenerations()
                assertEquals(1, values.size); assertEquals(0, values[0].first)
                assertTrue(values[0].second.contentEquals(generation))
            }
        } finally { directory.deleteRecursively() }
    }

    @Test
    fun chainStateCasReturnsExactDurableRevision() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/public-${System.nanoTime()}")
        CitizenSdkPublicStore(directory).use { store ->
            assertFalse(store.chainDatabaseLoad().present)
            val first = store.chainDatabaseCompareAndSwap(0, byteArrayOf(1, 2, 3))
            assertTrue(first.present)
            assertEquals(1L, first.revision)
            assertEquals(8, store.chainDatabaseCompareAndSwap(0, byteArrayOf(4)).errorCode)
        }
    }

    @Test
    fun runtimeCacheAtomicallyRetainsLatestSixtyFourWrites() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/runtime-${System.nanoTime()}")
        CitizenSdkPublicStore(directory).use { store ->
            for (index in 0 until 80) {
                store.runtimeCacheStore(blockHash(index), byteArrayOf(index.toByte()))
            }
            for (index in 0 until 80) {
                assertEquals(index >= 16, store.runtimeCacheLoad(blockHash(index)).present)
            }

            // REPLACE 必须把已有 key 提升为最新，而不是增加第 65 条。
            store.runtimeCacheStore(blockHash(16), byteArrayOf(99))
            store.runtimeCacheStore(blockHash(80), byteArrayOf(80))
            assertTrue(store.runtimeCacheLoad(blockHash(16)).present)
            assertFalse(store.runtimeCacheLoad(blockHash(17)).present)
            assertTrue(store.runtimeCacheLoad(blockHash(80)).present)

            val databaseFile = File(directory, "public-state-v1.sqlite3")
            SQLiteDatabase.openDatabase(databaseFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { database ->
                database.execSQL(
                    "CREATE TRIGGER runtime_cache_prune_failure BEFORE DELETE ON runtime_cache " +
                        "BEGIN SELECT RAISE(ABORT, 'test prune failure'); END",
                )
            }
            var pruneFailed = false
            try {
                store.runtimeCacheStore(blockHash(81), byteArrayOf(81))
            } catch (_: Throwable) {
                pruneFailed = true
            }
            assertTrue(pruneFailed)
            assertFalse(store.runtimeCacheLoad(blockHash(81)).present)
            assertTrue(store.runtimeCacheLoad(blockHash(18)).present)
            SQLiteDatabase.openDatabase(databaseFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use { database ->
                database.execSQL("DROP TRIGGER runtime_cache_prune_failure")
            }
        }
    }

    @Test
    fun retiredGenerationCannotBeResurrectedOrRebound() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val directory = File(context.noBackupFilesDir, "citizensdk-test/secure-${System.nanoTime()}")
        val generation = ByteArray(16) { 1 }
        val provisioning = ByteArray(16) { 2 }
        CitizenSdkSecureStore(directory).use { store ->
            assertTrue(store.ensureGeneration(0, generation, provisioning))
            assertFalse(store.ensureGeneration(0, generation, ByteArray(16) { 3 }))
            store.retireGeneration(0, generation, ByteArray(16) { 4 })
            assertFalse(store.ensureGeneration(0, generation, provisioning))
        }
    }


    private fun blockHash(index: Int): ByteArray =
        ByteArray(32).also { bytes -> bytes[31] = index.toByte() }
}
