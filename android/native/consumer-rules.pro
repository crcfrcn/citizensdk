# CitizenSDK resolves JNI entry points by exact class and method names. The
# public facade may be optimized, but its private JNI boundary must not be
# renamed or removed.
-keep class org.citizen.sdk.internal.Bindings { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHostServices { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHardwareVault$VaultFailure { *; }
# Rust JNI 按官方完整名称从 App ClassLoader 查找证书验证器，不能让缩减器移除。
-keep class org.rustls.platformverifier.** { *; }
-keep public class org.citizen.sdk.** { public protected *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    native <methods>;
}

# 实际Sdk接收JNI回调；只固定这些私有边界名称。
-keepclassmembers class org.citizen.sdk.CitizenSdk { private *** onNative*(...); }
