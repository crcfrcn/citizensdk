package org.citizen.sdk

import androidx.fragment.app.FragmentActivity
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/** Flutter仅注册v2数据通道及纹理，不注册SDK页面或窗口。 */
class CitizenSdkPlugin :
    FlutterPlugin,
    MethodChannel.MethodCallHandler,
    ActivityAware {
    private var methodChannel: MethodChannel? = null
    private var eventChannel: EventChannel? = null
    private var sessions: CitizenSdkFlutterSessions? = null
    private var activity: FragmentActivity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        check(sessions == null) { "CitizenSDK Flutter plugin is already attached" }
        val registry = CitizenSdkFlutterSessions(binding.applicationContext, binding.textureRegistry)
        sessions = registry
        methodChannel = MethodChannel(
            binding.binaryMessenger,
            CitizenSdkFlutterCodec.METHOD_CHANNEL,
        ).also { it.setMethodCallHandler(this) }
        eventChannel = EventChannel(
            binding.binaryMessenger,
            CitizenSdkFlutterCodec.EVENT_CHANNEL,
        ).also { it.setStreamHandler(registry) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel?.setMethodCallHandler(null)
        eventChannel?.setStreamHandler(null)
        methodChannel = null
        eventChannel = null

        val registry = sessions ?: return
        activity?.let(registry::detachActivity)
        activity = null
        // The asynchronous close path first waits accepted work, then performs
        // checkpointed stop, then destroy. Engine detach never calls destroy
        // directly and never turns a stop failure into silent data loss.
        registry.onCancel(listOf(CitizenSdkFlutterCodec.PROTOCOL_VERSION))
        CitizenSdkFlutterProcessOrphans.supervise(registry)
        sessions = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val registry = sessions
        if (registry == null) {
            result.error(
                "citizensdk.invalidState",
                "CitizenSDK Flutter plugin is detached",
                CitizenSdkFlutterCodec.errorDetails(
                    CitizenSdkErrorCode.INVALID_STATE,
                    "CitizenSDK Flutter plugin is detached",
                    null,
                    null,
                    call.method,
                ),
            )
            return
        }
        var envelope: CitizenSdkFlutterCodec.Request.Empty? = null
        try {
            // 只解外壳并调用Core接纳，再解方法参数；参数拒绝也消耗这一准确序号。
            envelope = CitizenSdkFlutterCodec.envelope(call.method, call.arguments)
            envelope?.let(registry::acceptRequestSequence)
            registry.dispatch(CitizenSdkFlutterCodec.decode(call.method, call.arguments), result)
        } catch (error: CitizenSdkException) {
            result.error(
                "citizensdk.${CitizenSdkFlutterCodec.errorName(error.code)}",
                "CitizenSDK request admission failed",
                CitizenSdkFlutterCodec.errorDetails(error.code, "CitizenSDK request admission failed",
                    envelope?.sessionId, envelope?.requestSequence, call.method, error.stage),
            )
        } catch (failure: CitizenSdkFlutterCodec.ContractFailure) {
            registry.diagnoseRejected(envelope, CitizenSdkErrorCode.fromValue(failure.errorCode), failure.stage)
            result.error(
                "citizensdk.${failure.stableName}",
                failure.message,
                CitizenSdkFlutterCodec.errorDetails(
                    CitizenSdkErrorCode.fromValue(failure.errorCode),
                    failure.message,
                    failure.sessionId ?: envelope?.sessionId,
                    failure.requestSequence ?: envelope?.requestSequence,
                    call.method,
                    failure.stage,
                ),
            )
        } catch (_: Throwable) {
            result.error(
                "citizensdk.internal",
                "CitizenSDK Flutter request decoding failed",
                CitizenSdkFlutterCodec.errorDetails(
                    CitizenSdkErrorCode.INTERNAL,
                    "CitizenSDK Flutter request decoding failed",
                    null,
                    null,
                    call.method,
                ),
            )
        }
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        val host = binding.activity as? FragmentActivity
        activity = host
        if (host != null) sessions?.attachActivity(host)
    }

    override fun onDetachedFromActivityForConfigChanges() = detachCurrentActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        // Configuration changes replace only the UI host. Sessions, native
        // instances, event counters and accepted requests remain intact.
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivity() = detachCurrentActivity()

    private fun detachCurrentActivity() {
        val host = activity ?: return
        sessions?.detachActivity(host)
        activity = null
    }
}
