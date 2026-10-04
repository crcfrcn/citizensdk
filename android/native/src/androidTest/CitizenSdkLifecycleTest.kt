package org.citizen.sdk

import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class CitizenSdkLifecycleTest {
    @Test
    @Suppress("DEPRECATION")
    fun sdkOwnsNoWalletOrQrActivity() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val activities = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_ACTIVITIES).activities.orEmpty()
        assertTrue(activities.none { it.name.startsWith("org.citizen.sdk.ui.") })
        for (name in listOf("CitizenSdkWalletFlowActivity", "CitizenSdkQrFlowActivity")) {
            assertThrows(ClassNotFoundException::class.java) {
                Class.forName("org.citizen.sdk.ui.$name", false, javaClass.classLoader)
            }
        }
    }
}
