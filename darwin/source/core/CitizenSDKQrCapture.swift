import Foundation
@preconcurrency import AVFoundation
import CoreVideo

public struct CitizenQRPreview: Sendable, Equatable {
    public let width: UInt32
    public let height: UInt32
    public let rotationDegrees: UInt32
}

/// 无窗口采集资源。相机、借用帧和停止都在同一串行队列；UI只接纹理及公开事实。
public final class CitizenSDKQrCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    public struct Listener: Sendable {
        public let result: @Sendable (CitizenQRScanResult) -> Void
        public let error: @Sendable (CitizenSDKError) -> Void
        public let frame: @Sendable (CitizenQRPreview) -> Void
        public let closed: @Sendable () -> Void
        public init(result: @escaping @Sendable (CitizenQRScanResult) -> Void,
                    error: @escaping @Sendable (CitizenSDKError) -> Void,
                    frame: @escaping @Sendable (CitizenQRPreview) -> Void,
                    closed: @escaping @Sendable () -> Void) {
            self.result = result; self.error = error; self.frame = frame; self.closed = closed
        }
    }
    public let purpose: CitizenQRScanPurpose
    private let native: CitizenSDKNative
    private let listener: Listener
    private let ended: @Sendable (CitizenSDKQrCapture) -> Void
    private let queue = DispatchQueue(label: "org.citizen.sdk.qr-camera")
    private let gate = NSLock()
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let ready = CitizenSDKOperation<Void>(cancel: { false })
    private let drained = CitizenSDKOperation<Void>(cancel: { false })
    private var revoked = false
    private var paused = false
    private var started = false
    private var generation: UInt64 = 0
    private var lastFrame: UInt64 = 0
    private var device: AVCaptureDevice?
    private var notifications: [NSObjectProtocol] = []
    private var pixel: CVPixelBuffer?
    private var previewValue: CitizenQRPreview?

    internal init(native: CitizenSDKNative, purpose: CitizenQRScanPurpose, listener: Listener,
                  ended: @escaping @Sendable (CitizenSDKQrCapture) -> Void) {
        self.native = native; self.purpose = purpose; self.listener = listener; self.ended = ended
        super.init()
    }

    public var preview: CitizenQRPreview? {
        gate.lock(); defer { gate.unlock() }
        return previewValue
    }

    /// 返回CF拥有的不可变帧引用；宿主纹理系统保留它直到渲染结束，不借用相机裸指针。
    public func copyPixelBuffer() -> CVPixelBuffer? {
        gate.lock(); defer { gate.unlock() }
        return revoked ? nil : pixel
    }

    internal func start() async throws {
        startPermission()
        try await ready.value()
    }

    private func startPermission() {
        guard isActive else { return }
        guard let usage = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String,
              !usage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail(CitizenSDKError(.permissionDenied, "camera usage declaration is missing")); return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: queue.async { [self] in configure() }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                guard let self, self.isActive else { return }
                if granted { self.queue.async { [self] in self.configure() } }
                else { self.fail(CitizenSDKError(.permissionDenied, "camera permission was denied")) }
            }
        case .denied, .restricted: fail(CitizenSDKError(.permissionDenied, "camera permission is unavailable"))
        @unknown default: fail(CitizenSDKError(.unavailable, "camera authorization state is unavailable"))
        }
    }

    public func pause() async throws {
        try await control { [self] in
            gate.lock(); paused = true; generation &+= 1; gate.unlock()
            if session.isRunning { session.stopRunning() }
        }
    }
    public func resume() async throws {
        try await control { [self] in
            gate.lock(); paused = false; generation &+= 1; gate.unlock()
            if started && !session.isRunning { session.startRunning() }
        }
    }
    public func setTorch(_ enabled: Bool) async throws {
        try await control { [self] in
            guard let device, device.hasTorch, device.isTorchAvailable else { throw CitizenSDKError(.unavailable, "camera torch is unavailable") }
            try device.lockForConfiguration(); defer { device.unlockForConfiguration() }
            if enabled { try device.setTorchModeOn(level: 1) } else { device.torchMode = .off }
        }
    }

    public func close() async throws {
        requestClose()
        try await drained.value()
    }
    internal func requestClose() {
        gate.lock()
        let first = !revoked
        revoked = true; paused = true; generation &+= 1; pixel = nil
        gate.unlock()
        guard first else { return }
        ready.complete(.failure(CitizenSDKError(.cancelled, "camera capture is closed")))
        queue.async { [self] in
            stopDevice()
            // 同队列之前的帧/ZXing借用已结束；晚到权限回调只能看到revoked。
            drained.complete(.success(()))
            ended(self)
            listener.closed()
        }
    }

    private var isActive: Bool { gate.lock(); defer { gate.unlock() }; return !revoked }
    private func control(_ action: @escaping @Sendable () throws -> Void) async throws {
        let result = CitizenSDKOperation<Void>(cancel: { false })
        queue.async { [self] in
            guard isActive else { result.complete(.failure(CitizenSDKError(.cancelled, "camera capture is closed"))); return }
            result.complete(Result { try action() })
        }
        try await result.value()
    }

    private func configure() {
        guard isActive, !started else { return }
        guard let device = AVCaptureDevice.default(for: .video) else { fail(CitizenSDKError(.unavailable, "camera is unavailable")); return }
        do {
            let input = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            guard session.canAddInput(input), session.canAddOutput(output), session.canSetSessionPreset(.hd1280x720) else {
                session.commitConfiguration(); fail(CitizenSDKError(.unavailable, "camera configuration is unavailable")); return
            }
            session.sessionPreset = .hd1280x720
            session.addInput(input)
            output.alwaysDiscardsLateVideoFrames = true
            // Flutter平台纹理接BGRA；码识别仍只把有界亮度副本交给同一ZXing。
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.setSampleBufferDelegate(self, queue: queue)
            session.addOutput(output)
            #if os(iOS)
            if let connection = output.connection(with: .video), connection.isVideoOrientationSupported { connection.videoOrientation = .portrait }
            #endif
            session.commitConfiguration()
            self.device = device
            let center = NotificationCenter.default
            for name in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification] {
                notifications.append(center.addObserver(forName: name, object: session, queue: nil) { [weak self] _ in
                    self?.fail(CitizenSDKError(.unavailable, "camera capture was interrupted"))
                })
            }
            notifications.append(center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: nil) { [weak self] _ in
                self?.fail(CitizenSDKError(.unavailable, "camera was disconnected"))
            })
            guard isActive else { stopDevice(); return }
            session.startRunning(); started = true
            if !session.isRunning { fail(CitizenSDKError(.unavailable, "camera could not start")) }
        } catch { fail(CitizenSDKError(.unavailable, "camera input could not be configured")) }
    }

    private func stopDevice() {
        notifications.forEach(NotificationCenter.default.removeObserver); notifications.removeAll()
        output.setSampleBufferDelegate(nil, queue: nil)
        if session.isRunning { session.stopRunning() }
        session.beginConfiguration()
        session.inputs.forEach(session.removeInput); session.outputs.forEach(session.removeOutput)
        session.commitConfiguration()
        device = nil; started = false
    }
    private func fail(_ error: CitizenSDKError) {
        guard isActive else { return }
        ready.complete(.failure(error)); listener.error(error); requestClose()
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard isActive, let frame = CMSampleBufferGetImageBuffer(sampleBuffer),
              CVPixelBufferGetPixelFormatType(frame) == kCVPixelFormatType_32BGRA else { return }
        let width = CVPixelBufferGetWidth(frame), height = CVPixelBufferGetHeight(frame), stride = CVPixelBufferGetBytesPerRow(frame)
        guard width > 0, height > 0, width <= 4096, height <= 4096, stride >= width * 4 else { return }
        let preview = CitizenQRPreview(width: UInt32(width), height: UInt32(height), rotationDegrees: 0)
        gate.lock()
        let accepting = !revoked
        if accepting { pixel = frame; previewValue = preview }
        let snapshot = generation; let decoding = accepting && !paused
        gate.unlock()
        guard accepting else { return }
        listener.frame(preview); ready.complete(.success(()))
        let now = DispatchTime.now().uptimeNanoseconds
        guard decoding, now >= lastFrame, now - lastFrame >= 100_000_000 else { return }
        lastFrame = now
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(frame)?.assumingMemoryBound(to: UInt8.self) else { return }
        var luminance = Data(count: width * height)
        defer { luminance.resetBytes(in: 0..<luminance.count) }
        luminance.withUnsafeMutableBytes { pixels in
            let destination = pixels.bindMemory(to: UInt8.self)
            for y in 0..<height { for x in 0..<width {
                let source = base.advanced(by: y * stride + x * 4)
                destination[y * width + x] = UInt8((Int(source[2]) * 77 + Int(source[1]) * 150 + Int(source[0]) * 29) >> 8)
            } }
        }
        do {
            let document = try native.qrDecodeLuminance(luminance, width: UInt32(width), height: UInt32(height), rowStride: UInt32(width))
            let result = try CitizenQRScanResult(document: document, purpose: purpose)
            gate.lock(); let current = !revoked && !paused && generation == snapshot; gate.unlock()
            if current { listener.result(result) }
        } catch let error as CitizenSDKError {
            if error.code != .notFound && isActive { listener.error(error) }
        } catch { if isActive { listener.error(CitizenSDKError(.decode, "QR frame could not be decoded")) } }
    }
}
