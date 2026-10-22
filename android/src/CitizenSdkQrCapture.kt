package org.citizen.sdk

import android.Manifest
import android.content.pm.PackageManager
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** 纹理已应用的相机变换只计算一次；尺寸表示宿主追加旋转之前的真实纵横比。 */
internal data class CitizenQrPreview(val width: Int, val height: Int, val rotationDegrees: Int) {
    companion object {
        fun fromSurfaceTexture(width: Int, height: Int, rotationDegrees: Int,
                               targetRotation: Int, hasCameraTransform: Boolean): CitizenQrPreview {
            if (width <= 0 || height <= 0 || rotationDegrees !in listOf(0, 90, 180, 270) ||
                targetRotation !in 0..3) {
                throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "相机预览方向无效")
            }
            // CameraX PreviewTransformation：Surface已携带camera transform时，仅逆转目标显示方向。
            // Flutter引擎已应用SurfaceTexture矩阵，不能再让App旋转完整传感器角度。
            val remaining = if (hasCameraTransform) (360 - targetRotation * 90) % 360 else rotationDegrees
            val applied = (rotationDegrees - remaining + 360) % 360
            return if (applied % 180 == 90) CitizenQrPreview(height, width, remaining)
                else CitizenQrPreview(width, height, remaining)
        }
    }
}

/** CameraX亮度平面只复制有界像素；长整型预检避免恶意行/像素跨度溢出。 */
internal object CitizenSdkQrLuminance {
    fun copy(source: java.nio.ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): ByteArray {
        if (width !in 1..4096 || height !in 1..4096 || rowStride <= 0 || pixelStride <= 0 ||
            rowStride.toLong() < (width - 1L) * pixelStride + 1 ||
            (height - 1L) * rowStride + (width - 1L) * pixelStride + 1 > source.remaining().toLong()) {
            throw CitizenSdkException(CitizenSdkErrorCode.INTEGRITY, "相机亮度平面边界无效")
        }
        val input = source.duplicate()
        val base = input.position()
        return ByteArray(width * height).also { luminance ->
            for (y in 0 until height) for (x in 0 until width) {
                luminance[y * width + x] = input.get(base + y * rowStride + x * pixelStride)
            }
        }
    }
}

/** 相机只提供采集和Surface租约，不创建Activity、View、文字或确认按钮。 */
class CitizenSdkQrCapture internal constructor(
    private val sdk: CitizenSdk,
    private val activity: FragmentActivity,
    private val texture: SurfaceTexture,
    val purpose: CitizenQrScanPurpose,
    private val listener: Listener,
) : DefaultLifecycleObserver {
    interface Listener {
        fun onResult(result: CitizenQrScanResult)
        fun onError(error: CitizenSdkException)
        fun onPreview(width: Int, height: Int, rotationDegrees: Int)
        fun onClosed() = Unit
    }

    private val main = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "citizensdk-qr-frame") }
    private val revoked = AtomicBoolean(false)
    private val paused = AtomicBoolean(false)
    private val generation = java.util.concurrent.atomic.AtomicLong(0)
    private val opened = CompletableFuture<CitizenSdkQrCapture>()
    private val ended = CompletableFuture<Void>()
    val closed: CompletableFuture<Void> get() = ended
    private var provider: ProcessCameraProvider? = null
    private var preview: Preview? = null
    private var analysis: ImageAnalysis? = null
    private var camera: Camera? = null
    private var cameraObserver: androidx.lifecycle.Observer<androidx.camera.core.CameraState>? = null
    private var starting = false
    private var framesReturned = false
    private var surfaces = 0
    private var lastFrame = 0L
    private val displays = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit
        override fun onDisplayRemoved(displayId: Int) = Unit
        override fun onDisplayChanged(displayId: Int) {
            if (revoked.get() || paused.get()) return
            val display = activity.window.decorView.display ?: return
            if (display.displayId == displayId) preview?.targetRotation = display.rotation
        }
    }
    var previewWidth: Int = 0
        private set
    var previewHeight: Int = 0
        private set
    var rotationDegrees: Int = 0
        private set
    private var permission = activity.activityResultRegistry.register(
        "citizensdk-camera-${UUID.randomUUID()}", ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (!revoked.get()) {
            if (granted) startCamera()
            else fail(CitizenSdkException(CitizenSdkErrorCode.PERMISSION_DENIED, "camera permission was denied"))
        }
    }

    internal fun open(): CompletableFuture<CitizenSdkQrCapture> {
        checkMain()
        activity.lifecycle.addObserver(this)
        displays.registerDisplayListener(displayListener, main)
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else permission.launch(Manifest.permission.CAMERA)
        return opened
    }

    fun pause(): CompletableFuture<Void> = onMain {
        generation.incrementAndGet()
        paused.set(true)
        analysis?.clearAnalyzer()
        val owned = listOfNotNull(preview, analysis)
        if (owned.isNotEmpty()) provider?.unbind(*owned.toTypedArray())
        clearCameraObserver()
        camera = null
    }
    fun resume(): CompletableFuture<Void> = onMain {
        generation.incrementAndGet()
        paused.set(false)
        startCamera()
    }
    fun setTorch(enabled: Boolean): CompletableFuture<Void> {
        val result = CompletableFuture<Void>()
        main.post {
            if (revoked.get()) { result.completeExceptionally(closedError()); return@post }
            val current = camera
            if (current == null || !current.cameraInfo.hasFlashUnit()) {
                result.completeExceptionally(CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera torch is unavailable"))
                return@post
            }
            val operation = current.cameraControl.enableTorch(enabled)
            operation.addListener({
                try { operation.get(); result.complete(null) }
                catch (_: Throwable) { result.completeExceptionally(CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera torch operation failed")) }
            }, ContextCompat.getMainExecutor(activity))
        }
        return result
    }

    /** 关闭等待本资源的帧和Surface归还，不关闭共享CameraProvider或其它消费者的用例。 */
    fun close(): CompletableFuture<Void> {
        if (revoked.compareAndSet(false, true)) {
            main.post {
                permission.unregister()
                displays.unregisterDisplayListener(displayListener)
                activity.lifecycle.removeObserver(this)
                opened.completeExceptionally(closedError())
                analysis?.clearAnalyzer()
                preview?.setSurfaceProvider(null)
                val owned = listOfNotNull(preview, analysis)
                if (owned.isNotEmpty()) provider?.unbind(*owned.toTypedArray())
                clearCameraObserver()
                camera = null; preview = null; analysis = null
                executor.shutdown()
                Thread({
                    while (!executor.awaitTermination(1, TimeUnit.SECONDS)) { /* 等待有界ZXing帧调用真实归还。 */ }
                    main.post { framesReturned = true; settle() }
                }, "citizensdk-qr-drain").start()
                settle()
            }
        }
        return ended
    }

    override fun onStop(owner: LifecycleOwner) {
        if (!opened.isDone) close() else pause()
    }
    override fun onDestroy(owner: LifecycleOwner) { close() }

    private fun startCamera() {
        checkMain()
        if (revoked.get() || paused.get() || starting || camera != null) return
        starting = true
        val pending = try { ProcessCameraProvider.getInstance(activity) }
        catch (error: Throwable) { starting = false; fail(cameraError(error)); return }
        pending.addListener({
            starting = false
            if (revoked.get()) { settle(); return@addListener }
            if (paused.get()) return@addListener
            try {
                val current = pending.get()
                val selector = when {
                    current.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA) -> CameraSelector.DEFAULT_BACK_CAMERA
                    current.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) -> CameraSelector.DEFAULT_FRONT_CAMERA
                    else -> throw CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera is unavailable")
                }
                val frameGeneration = generation.get()
                val display = activity.window.decorView.display
                    ?: throw CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera display is unavailable")
                val output = Preview.Builder().setTargetRotation(display.rotation).build()
                output.setSurfaceProvider(ContextCompat.getMainExecutor(activity)) { request ->
                    if (revoked.get() || paused.get() || generation.get() != frameGeneration || preview !== output) request.willNotProvideSurface()
                    else {
                        val size = request.resolution
                        texture.setDefaultBufferSize(size.width, size.height)
                        request.setTransformationInfoListener(ContextCompat.getMainExecutor(activity)) { info ->
                            if (!revoked.get() && !paused.get() && generation.get() == frameGeneration && preview === output) {
                                try {
                                    val value = CitizenQrPreview.fromSurfaceTexture(size.width, size.height,
                                        info.rotationDegrees, output.targetRotation, info.hasCameraTransform())
                                    previewWidth = value.width; previewHeight = value.height; rotationDegrees = value.rotationDegrees
                                    listener.onPreview(previewWidth, previewHeight, rotationDegrees)
                                    opened.complete(this)
                                } catch (error: Throwable) { fail(cameraError(error)) }
                            }
                        }
                        val surface = Surface(texture)
                        surfaces += 1
                        request.provideSurface(surface, ContextCompat.getMainExecutor(activity)) {
                            surface.release()
                            surfaces -= 1
                            settle()
                        }
                    }
                }
                val input = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888).build()
                provider = current; preview = output; analysis = input
                input.setAnalyzer(executor) { image -> analyze(image, frameGeneration) }
                val bound = current.bindToLifecycle(activity, selector, output, input)
                camera = bound
                val observer = androidx.lifecycle.Observer<androidx.camera.core.CameraState> { state ->
                    if (state.error != null && !revoked.get() && generation.get() == frameGeneration && camera === bound)
                        fail(CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera was disconnected"))
                }
                cameraObserver = observer
                bound.cameraInfo.cameraState.observe(activity, observer)
            } catch (error: Throwable) { fail(cameraError(error)) }
        }, ContextCompat.getMainExecutor(activity))
    }

    private fun clearCameraObserver() {
        cameraObserver?.let { camera?.cameraInfo?.cameraState?.removeObserver(it) }
        cameraObserver = null
    }

    private fun analyze(image: ImageProxy, capturedGeneration: Long) {
        try {
            if (revoked.get() || paused.get() || generation.get() != capturedGeneration) return
            val now = System.nanoTime()
            if (now >= lastFrame && now - lastFrame < 100_000_000) return
            lastFrame = now
            check(image.format == ImageFormat.YUV_420_888)
            val width = image.width; val height = image.height
            val plane = image.planes[0]
            val luminance = CitizenSdkQrLuminance.copy(plane.buffer, width, height, plane.rowStride, plane.pixelStride)
            try {
                val document = sdk.qrDecodeLuminance(luminance, width, height, width)
                val result = CitizenQrScanResult.forPurpose(document, purpose)
                main.post {
                    if (!revoked.get() && !paused.get() && generation.get() == capturedGeneration) listener.onResult(result)
                }
            } finally { luminance.fill(0) }
        } catch (error: CitizenSdkException) {
            // 未识别到码不是错误；码型不符或无效内容报告后继续采集，不能提前结束资源。
            if (error.code != CitizenSdkErrorCode.NOT_FOUND) main.post { if (!revoked.get() && !paused.get() && generation.get() == capturedGeneration) listener.onError(error) }
        } catch (error: Throwable) {
            main.post { if (!revoked.get() && !paused.get() && generation.get() == capturedGeneration) listener.onError(cameraError(error)) }
        } finally { image.close() }
    }

    private fun onMain(action: () -> Unit): CompletableFuture<Void> {
        val result = CompletableFuture<Void>()
        main.post {
            try {
                if (revoked.get()) throw closedError()
                action(); result.complete(null)
            } catch (error: Throwable) { result.completeExceptionally(error) }
        }
        return result
    }
    private fun fail(error: CitizenSdkException) {
        opened.completeExceptionally(error)
        if (!revoked.get()) listener.onError(error)
        close()
    }
    private fun settle() {
        checkMain()
        if (revoked.get() && !starting && framesReturned && surfaces == 0 && ended.complete(null)) listener.onClosed()
    }
    private fun checkMain() = check(Looper.myLooper() == Looper.getMainLooper())
    private fun closedError() = CitizenSdkException(CitizenSdkErrorCode.CANCELLED, "camera capture is closed")
    private fun cameraError(error: Throwable) = error as? CitizenSdkException
        ?: CitizenSdkException(CitizenSdkErrorCode.UNAVAILABLE, "camera capture failed")
}
