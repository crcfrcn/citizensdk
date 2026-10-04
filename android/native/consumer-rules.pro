# CitizenSDK resolves JNI entry points by exact class and method names. The
# public facade may be optimized, but its private JNI boundary must not be
# renamed or removed.
-keep class org.citizen.sdk.internal.CitizenSdkNative { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHostServices { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHostRecord { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHardwareVault$VaultFailure { *; }
# Rust JNI 按官方完整名称从 App ClassLoader 查找证书验证器，不能让缩减器移除。
-keep class org.rustls.platformverifier.** { *; }
-keep public class org.citizen.sdk.** { public protected *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    native <methods>;
}
