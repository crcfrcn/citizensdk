# 保留JNI、系统证书验证器及原生返回模型所需的准确类名和成员。

-keep class org.citizen.sdk.internal.Bindings { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHostServices { *; }
-keep class org.citizen.sdk.internal.CitizenSdkHardwareVault$VaultFailure { *; }
# JNI returns the exact kotlin.Unit.INSTANCE singleton for completed void calls.
-keep class kotlin.Unit { *; }
# Rust JNI 按官方完整名称从 App ClassLoader 查找证书验证器，不能让缩减器移除。
-keep class org.rustls.platformverifier.** { *; }
-keep public class org.citizen.sdk.** { public protected *; }
-keepclasseswithmembers,includedescriptorclasses class * {
    native <methods>;
}

# 实际Sdk接收JNI回调；只固定这些私有边界名称。
-keepclassmembers class org.citizen.sdk.CitizenSdk { private *** onNative*(...); }
