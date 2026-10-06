import Foundation
import CoreGraphics
import ImageIO

/// 同实例真实钱包快照的拥有者；释放与接纳共用锁，不暴露Core句柄。
public final class CitizenWalletInspection: @unchecked Sendable {
    public let state: CitizenWalletState
    private let owner: CitizenSDKNative
    private let lock = NSLock()
    private var result: UInt64
    private var released: ((CitizenWalletInspection) -> Void)?
    internal init(owner: CitizenSDKNative, result: UInt64, state: CitizenWalletState) {
        self.owner = owner; self.result = result; self.state = state
    }
    internal func withResult<T>(owner: CitizenSDKNative, _ body: (UInt64) throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard self.owner === owner, result != 0 else { throw CitizenSDKError(.invalidState, "钱包检查资源已释放或跨实例") }
        return try body(result)
    }
    internal func onRelease(_ handler: @escaping (CitizenWalletInspection) -> Void) {
        lock.lock(); defer { lock.unlock() }; released = handler
    }
    public func repairHot(walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.repairHotWallet(self, walletIndex: walletIndex)
    }
    public func rename(walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.renameDiagnosticWallet(self, walletIndex: walletIndex, name: CitizenSDKInputLimits.accountName(name))
    }
    public func delete(walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try owner.deleteDiagnosticWallet(self, walletIndex: walletIndex)
    }
    public func release() throws {
        lock.lock()
        if result != 0 {
            do { try owner.releaseWalletInspection(result) }
            catch { lock.unlock(); throw error }
            result = 0
        }
        let handler = released; released = nil; lock.unlock()
        handler?(self)
    }
    deinit { try? release() }
}

/// Native Swift facade for one CitizenSDK Core instance.
///
/// 不暴露Core裸句柄，不提供页面或窗口。显式钱包输入和受控备份资源可短时
/// 携带敏感内容；普通签名只引用SDK金库，界面与展示文案由宿主负责。
public final class CitizenSdk: @unchecked Sendable {
    public let sessionID = UUID().uuidString
    private let stateLock = NSLock()
    private let native: CitizenSDKNative
    private var lifecycleValue: CitizenSDKLifecycle
    private var closed = false
    private var resourcesClosing = false
    private var preparedWallets: [ObjectIdentifier: CitizenSDKPreparedWallet] = [:]
    private var privateKeys: [ObjectIdentifier: CitizenSDKPrivateKey] = [:]
    private var qrReviews: [ObjectIdentifier: CitizenQRReview] = [:]
    private var walletInspections: [ObjectIdentifier: CitizenWalletInspection] = [:]
    private var qrCaptures: [ObjectIdentifier: CitizenSDKQrCapture] = [:]
    private var eventHandler: ((CitizenSDKEvent) -> Void)?

    private init(native: CitizenSDKNative, lifecycle: CitizenSDKLifecycle) {
        self.native = native
        lifecycleValue = lifecycle
        CitizenSDKCloseGate.shared.registerOpen(self)
    }

    /// 未选择链时不读取链资产；钱包、签名和链均由同一核心按模块装配。
    public static func open(modules: CitizenSDKModules = .full) throws -> CitizenSdk {
        try CitizenSDKNative.validateModules(modules)
        let native = try CitizenSDKNative.open(
            assets: modules.contains(.chain) ? CitizenSDKAssets.load() : nil, modules: modules
        )
        return try finishOpen(native)
    }

    internal static func open(storageRoot: URL, applicationID: String? = Bundle.main.bundleIdentifier,
                              assets: CitizenSDKAssets? = nil, modules: CitizenSDKModules = .full) throws -> CitizenSdk {
        try CitizenSDKNative.validateModules(modules)
        let native = try CitizenSDKNative.open(
            assets: modules.contains(.chain) ? (assets ?? CitizenSDKAssets.load()) : nil,
            storageRoot: storageRoot, applicationID: applicationID, modules: modules
        )
        return try finishOpen(native)
    }

    private static func finishOpen(_ native: CitizenSDKNative) throws -> CitizenSdk {
        try finalizeOpen(
            lifecycle: native.lifecycle,
            install: { lifecycle in
            let sdk = CitizenSdk(native: native, lifecycle: lifecycle)
            native.setEventListener { [weak sdk] event in sdk?.receive(event) }
            return sdk
            },
            cleanup: {
            // A freshly created instance is still in the destroyable CREATED
            // state. Preserve the initialization error while closing Core and
            // all host resources best-effort.
            native.setEventListener(nil)
            do { try native.close() }
            catch { native.enqueueForSupervisedClose() }
            }
        )
    }

    deinit {
        stateLock.lock()
        let needsRecovery = !closed
        let keys = Array(privateKeys.values)
        let captures = Array(qrCaptures.values)
        stateLock.unlock()
        keys.forEach { $0.requestClose() }
        captures.forEach { $0.requestClose() }
        if needsRecovery { native.enqueueForSupervisedClose() }
        CitizenSDKCloseGate.shared.forget(self)
    }

    /// One cleanup gate shared by the production constructor and source-level
    /// fault-injection tests. Any lifecycle or listener-install failure must
    /// close the freshly-created Core exactly once while preserving the
    /// original error.
    internal static func finalizeOpen<T>(
        lifecycle: () throws -> CitizenSDKLifecycle,
        install: (CitizenSDKLifecycle) throws -> T,
        cleanup: () -> Void
    ) throws -> T {
        do { return try install(lifecycle()) }
        catch { cleanup(); throw error }
    }

    public var lifecycle: CitizenSDKLifecycle {
        stateLock.lock(); defer { stateLock.unlock() }
        return lifecycleValue
    }

    public func setEventHandler(_ handler: ((CitizenSDKEvent) -> Void)?) throws {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed else { throw CitizenSDKError(.invalidState, "CitizenSDK is closed") }
        eventHandler = handler
    }

    public func start() async throws {
        try await native.start().value()
    }

    /// Flutter薄绑定在参数解码前调用；公共接纳算法只在Rust Core实现。
    @_spi(CitizenSDKFlutter) public func acceptRequestSequence(_ sequence: Int64) throws {
        try native.acceptRequestSequence(sequence)
    }

    public func stop() async throws {
        try await native.stop().value()
    }

    public func refreshCapabilities() async throws {
        try await native.refreshCapabilities().value()
    }

    public func capabilities() throws -> CitizenSDKCapabilities { try native.capabilities() }
    public func finalizedHead() async throws -> CitizenBlockRef { try await native.finalizedHead().value() }
    public func syncStatus() async throws -> CitizenChainSyncStatus { try await native.syncStatus().value() }
    public func bestHead() async throws -> CitizenBlockRef { try await native.bestHead().value() }
    public func finalizedBlock(at number: UInt64) async throws -> CitizenBlockRef {
        try await native.finalizedBlock(at: number).value()
    }
    public func resolveFinalizedBlock(hash: Data, number: UInt64) async throws -> CitizenBlockRef {
        try await native.resolveFinalizedBlock(hash: hash, number: number).value()
    }
    public func blockHeader(_ block: CitizenBlockRef) async throws -> CitizenBlockHeader {
        try await native.blockHeader(block).value()
    }
    public func blockBody(_ block: CitizenBlockRef) async throws -> CitizenBlockBody {
        try await native.blockBody(block).value()
    }
    public func runtimeContext(_ block: CitizenBlockRef) async throws -> CitizenRuntimeContext {
        try await native.runtimeContext(block).value()
    }
    public func storage(_ block: CitizenBlockRef, key: Data) async throws -> Data? {
        try await native.storage(block, key: CitizenSDKInputLimits.storageKey(key)).value()
    }
    public func storageBatch(_ block: CitizenBlockRef, keys: [Data]) async throws -> [Data?] {
        try await native.storageBatch(block, keys: CitizenSDKInputLimits.storageKeys(keys)).value()
    }
    public func storageKeysPaged(_ finalizedBlock: CitizenBlockRef, prefix: Data,
                                 startKey: Data? = nil, limit: UInt32 = 1_000) async throws -> [Data] {
        guard finalizedBlock.finality == .finalized, (1...4_096).contains(prefix.count),
              startKey.map({ (1...4_096).contains($0.count) }) ?? true,
              (1...1_000).contains(limit) else {
            throw CitizenSDKError(.invalidArgument, "storage keys page request is invalid")
        }
        return try await native.storageKeysPaged(
            finalizedBlock, prefix: prefix, startKey: startKey, limit: limit).value()
    }
    public func callRuntimeAPI(_ block: CitizenBlockRef, method: String,
                               arguments: Data) async throws -> Data {
        guard (1...128).contains(method.utf8.count),
              method.range(of: #"^[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]+$"#,
                           options: .regularExpression) != nil,
              arguments.count <= 1_024 * 1_024 else {
            throw CitizenSDKError(.invalidArgument, "Runtime API request is invalid")
        }
        return try await native.callRuntimeAPI(block, method: method, arguments: arguments).value()
    }
    public func systemEvents(_ finalizedBlock: CitizenBlockRef) async throws -> Data? {
        guard finalizedBlock.finality == .finalized else {
            throw CitizenSDKError(.invalidArgument, "System.Events requires a finalized block")
        }
        return try await native.systemEvents(finalizedBlock).value()
    }
    public func exportState() async throws -> CitizenChainState { try await native.exportState().value() }
    public func importState(_ state: CitizenChainState) async throws { try await native.importState(state).value() }

    /// 返回 Core 固定链身份的创世哈希；只要求启用 chain，不要求启动或同步轻节点。
    public func genesisHash() throws -> Data { try native.genesisHash() }

    public func accountBalance(accountID: Data) async throws -> CitizenAccountBalance {
        try await native.accountBalance(CitizenSDKInputLimits.accountID(accountID)).value()
    }

    /// 同一已验证 finalized 块的批量余额；保持输入顺序和重复项，空列表仍交由 Core 校验状态。
    public func accountBalances(accountIDs: [Data]) async throws -> [CitizenAccountBalance] {
        try await native.accountBalances(CitizenSDKInputLimits.balanceAccountIDs(accountIDs)).value()
    }

    public func accountNonce(accountID: Data) async throws -> CitizenAccountNonce {
        try await native.accountNonce(CitizenSDKInputLimits.accountID(accountID)).value()
    }

    public func feeSnapshot() async throws -> CitizenFeeSnapshot { try await native.feeSnapshot().value() }
    public func walletState() throws -> CitizenSDKOperation<CitizenWalletState> { try native.walletState() }

    public func inspectWallets() throws -> CitizenSDKOperation<CitizenWalletInspection> {
        try resourceOperation {
            try native.inspectWallets().map { [self] inspection in
                inspection.onRelease { [weak self] value in
                    guard let self else { return }
                    self.stateLock.lock(); defer { self.stateLock.unlock() }
                    self.walletInspections.removeValue(forKey: ObjectIdentifier(value))
                }
                self.stateLock.lock()
                let accepting = !self.closed && !self.resourcesClosing
                let available = self.walletInspections.count < 64
                if accepting && available { self.walletInspections[ObjectIdentifier(inspection)] = inspection }
                self.stateLock.unlock()
                guard accepting && available else {
                    try inspection.release()
                    throw CitizenSDKError(accepting ? .queueFull : .cancelled, "钱包检查资源不能接纳")
                }
                return inspection
            }
        }
    }




    public func importColdAccount(accountID: Data, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        let account = try CitizenSDKInputLimits.accountID(accountID)
        let checkedName = name.isEmpty ? "" : try CitizenSDKInputLimits.accountName(name)
        return try native.importColdAccountID(account, name: checkedName)
    }

    public func importColdAccount(ss58Address: String, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        guard !ss58Address.isEmpty, ss58Address.utf8.count <= 64 else {
            throw CitizenSDKError(.invalidArgument, "cold account SS58 is invalid")
        }
        let checkedName = name.isEmpty ? "" : try CitizenSDKInputLimits.accountName(name)
        return try native.importColdAccountSS58(ss58Address, name: checkedName)
    }

    public func importColdAccountCode(_ code: String, name: String = "") throws -> CitizenSDKOperation<CitizenWalletState> {
        let parsed = try parseForPurpose(code, purpose: .coldAccountImport)
        guard case let .accountID(text) = parsed.document.content else { throw CitizenSDKError(.integrity, "account code has no account ID") }
        var bytes = Data(capacity: 32)
        var index = text.index(text.startIndex, offsetBy: 2)
        for _ in 0..<32 {
            let end = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<end], radix: 16) else { throw CitizenSDKError(.integrity, "Core account ID is invalid") }
            bytes.append(byte); index = end
        }
        return try importColdAccount(accountID: bytes, name: name)
    }

    public func reorderWalletAccountsWithoutDefaultChange(expectedRevision: UInt64, accountIDs: [Data]) throws -> CitizenSDKOperation<CitizenWalletState> {
        guard (1...CitizenSDKInputLimits.maximumCatalogAccounts).contains(accountIDs.count) else { throw CitizenSDKError(.invalidArgument, "wallet catalog size is invalid") }
        return try native.reorderWalletAccounts(expectedRevision: expectedRevision,
            accountIDs: accountIDs.map { try CitizenSDKInputLimits.accountID($0) })
    }

    /// 默认顺序只经原默认账户授权的同一Core CAS提交，不在绑定层另建变更门。
    public func beginDefaultAccountChange(expectedRevision: UInt64, accountIDs: [Data], ttlSeconds: UInt64 = 90) throws -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        guard (1...256).contains(accountIDs.count), (1...300).contains(ttlSeconds) else {
            throw CitizenSDKError(.invalidArgument, "default-account change input is invalid")
        }
        return try native.beginDefaultAccountChange(expectedRevision: expectedRevision,
            accountIDs: accountIDs.map { try CitizenSDKInputLimits.accountID($0) }, ttlSeconds: ttlSeconds)
    }

    public func consumeDefaultAccountChange(sessionID: String, response: String) throws -> CitizenSDKOperation<CitizenDefaultAccountChangeOutcome> {
        try CitizenSigning.validateExternal(sessionID: sessionID, response: response)
        return try native.consumeDefaultAccountChange(sessionID: sessionID, response: response)
    }

    /// 付款选择与钱包级改名不进入签名/默认账户变更；原子修订由Core验证。
    public func setActiveWallet(expectedRevision: UInt64, walletIndex: UInt32) throws -> CitizenSDKOperation<CitizenWalletState> {
        try native.setActiveWallet(expectedRevision: expectedRevision, walletIndex: walletIndex)
    }

    public func renameWallet(expectedRevision: UInt64, walletIndex: UInt32, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try native.renameWallet(expectedRevision: expectedRevision, walletIndex: walletIndex, name: CitizenSDKInputLimits.accountName(name))
    }

    public func renameAccount(accountID: Data, name: String) throws -> CitizenSDKOperation<CitizenWalletState> {
        try native.renameAnyAccount(CitizenSDKInputLimits.accountID(accountID), name: CitizenSDKInputLimits.accountName(name))
    }

    public func deleteAccount(accountID: Data) throws -> CitizenSDKOperation<CitizenWalletState> {
        try native.deleteAnyAccount(CitizenSDKInputLimits.accountID(accountID))
    }

    public func setActiveWalletAccount(accountID: Data) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try native.setActiveAccount(CitizenSDKInputLimits.accountID(accountID)).map {
            guard let value = $0 else { throw CitizenSDKError(.integrity, "set active account returned no profile") }
            return value
        }
    }

    /// 普通清除不追加授权；“签名并删除”在Core内先完成真实授权签名。
    public func deleteWallet() throws -> CitizenSDKOperation<Void> { try native.deleteWallet() }
    public func signAndDeleteWallet() throws -> CitizenSDKOperation<Void> { try native.signAndDeleteWallet() }

    public func reconcileWalletCleanup() throws -> CitizenSDKOperation<CitizenWalletProfile?> {
        let cleanup = try native.reconcileWalletCleanup()
        let result = CitizenSDKOperation<CitizenWalletProfile?>(operationID: cleanup.operationID, cancel: cleanup.cancel)
        cleanup.observe { [native] outcome in
            switch outcome {
            case .success:
                do { try native.walletProfile().observe { result.complete($0) } }
                catch { result.complete(.failure(error)) }
            case let .failure(error): result.complete(.failure(error))
            }
        }
        return result
    }

    /// 签名是独立公开模块，不要求开启钱包管理或轻节点。
    public var signing: CitizenSigning {
        CitizenSigning(native: native, review: { [weak self] text in
            guard let self else { throw CitizenSDKError(.cancelled, "SDK is closed") }
            return try self.reviewQrRequest(text)
        }, signQr: { [native] review in
            try native.signQrRequest(review).map { document in
                CitizenQRSigned(document: document, qrImage: try native.qrEncode(document.canonicalText, scale: 4))
            }
        })
    }

    public func qrParse(_ text: String) throws -> CitizenQRDocument {
        try native.qrParse(text)
    }
    public func qrEncodeDocument(_ content: CitizenQRContent) throws -> CitizenQRDocument {
        try native.qrEncodeDocument(content.inputJSON)
    }
    @_spi(CitizenSDKFlutter) public func qrEncodeDocument(inputJSON: String) throws -> CitizenQRDocument {
        try native.qrEncodeDocument(inputJSON)
    }
    public func qrPrepareAccountAuthorization(action: UInt32, payload: Data, accountID: String) throws -> CitizenQRAuthorization {
        try native.qrPrepareAccountAuthorization(action: action, payload: payload, accountID: accountID)
    }

    public func qrCreateSignRequest(action: UInt16, signerAccountID: Data,
                                    reviewPayload: Data, ttlSeconds: UInt64 = 120) throws -> String {
        try native.qrCreateSignRequest(action: action, accountID: signerAccountID,
                                       payload: reviewPayload, ttl: ttlSeconds)
    }

    /// 同实例非消费验签；不会提交交易或改变目录。
    public func qrValidateSignResponse(sessionID: String, response: String) throws {
        try native.qrValidateSignResponse(sessionID: sessionID, response: response)
    }

    public func qrConsumeSignResponse(_ text: String) throws -> Data {
        try native.qrConsumeSignResponse(text)
    }

    public func qrCancelSignRequest(_ requestID: String) throws -> Bool {
        try native.qrCancelSignRequest(requestID)
    }

    public func qrEncodeAccountID(_ accountID: Data) throws -> String {
        try native.qrEncodeAccountID(accountID)
    }

    public func qrDecodeLuminance(_ data: Data, width: UInt32, height: UInt32,
                                  rowStride: UInt32) throws -> CitizenQRDocument {
        try native.qrDecodeLuminance(data, width: width, height: height, rowStride: rowStride)
    }

    public func qrEncode(_ text: String, scale: UInt32 = 4) throws -> CitizenQRImage {
        try native.qrEncode(text, scale: scale)
    }

    /// ImageIO仅解编码图片像素，所有码识别、协议与用途判断复用SDK唯一链路。
    public func decodeImage(_ encodedImage: Data, purpose: CitizenQRScanPurpose) throws -> [CitizenQRScanResult] {
        guard !encodedImage.isEmpty, encodedImage.count <= 16 * 1024 * 1024 else { throw CitizenSDKError(.invalidArgument, "encoded image size is invalid") }
        try native.requireQRModule()
        guard let source = CGImageSourceCreateWithData(encodedImage as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let rawWidth = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let rawHeight = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              (1...4096).contains(rawWidth.intValue), (1...4096).contains(rawHeight.intValue),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false] as CFDictionary),
              (1...4096).contains(image.width), (1...4096).contains(image.height) else {
            throw CitizenSDKError(.decode, "encoded image dimensions are invalid")
        }
        var pixels = Data(count: image.width * image.height * 4)
        var luminance = Data(count: image.width * image.height)
        defer { pixels.resetBytes(in: 0..<pixels.count); luminance.resetBytes(in: 0..<luminance.count) }
        try pixels.withUnsafeMutableBytes { bytes in
            guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else {
                throw CitizenSDKError(.unavailable, "image pixel buffer is unavailable")
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
        }
        luminance.withUnsafeMutableBytes { output in
            let output = output.bindMemory(to: UInt8.self)
            pixels.withUnsafeBytes { input in
                let input = input.bindMemory(to: UInt8.self)
                for index in 0..<output.count {
                    output[index] = UInt8((Int(input[index * 4]) * 77 + Int(input[index * 4 + 1]) * 150 + Int(input[index * 4 + 2]) * 29) >> 8)
                }
            }
        }
        do {
            return try native.qrDecodeLuminanceAll(luminance, width: UInt32(image.width), height: UInt32(image.height), rowStride: UInt32(image.width))
                .map { try CitizenQRScanResult(document: $0, purpose: purpose) }
        } catch let error as CitizenSDKError where error.code == .notFound { return [] }
    }

    private func reviewQrRequest(_ text: String) throws -> CitizenSDKOperation<CitizenQRReview> {
        try resourceOperation {
        try native.reviewQrSignRequest(text).map { [self] review in
            review.onRelease { [weak self] value in
                guard let self else { return }
                self.stateLock.lock(); defer { self.stateLock.unlock() }
                self.qrReviews.removeValue(forKey: ObjectIdentifier(value))
            }
            self.stateLock.lock()
            let accepting = !self.closed && !self.resourcesClosing
            if accepting { self.qrReviews[ObjectIdentifier(review)] = review }
            self.stateLock.unlock()
            guard accepting else { try review.release(); throw CitizenSDKError(.cancelled, "SDK is closed") }
            return review
        }
        }
    }

    /// 显式私钥查看只返回资源；警告、确认、显示与清屏仍由宿主原UI负责。
    @MainActor
    public func openPrivateKey(accountID: Data) async throws -> CitizenSDKPrivateKey {
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        defer { CitizenSDKCloseGate.shared.finish(self, token: ticket) }
        let resource = try CitizenSDKPrivateKey(native: native,
            accountID: CitizenSDKInputLimits.accountID(accountID)) { [weak self] resource in
                self?.removePrivateKey(resource)
            }
        guard registerPrivateKey(resource) else {
            resource.requestClose()
            throw CitizenSDKError(.cancelled, "SDK is closing resources")
        }
        CitizenSDKCloseGate.shared.finish(self, token: ticket)
        do { try await resource.waitUntilReady(); return resource }
        catch { try? await resource.close(); throw error }
    }

    private func registerPrivateKey(_ resource: CitizenSDKPrivateKey) -> Bool {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed && !resourcesClosing else { return false }
        privateKeys[ObjectIdentifier(resource)] = resource
        return true
    }
    private func removePrivateKey(_ resource: CitizenSDKPrivateKey) {
        stateLock.lock(); defer { stateLock.unlock() }
        privateKeys.removeValue(forKey: ObjectIdentifier(resource))
    }
    private func ownedPrivateKeys() -> [CitizenSDKPrivateKey] {
        stateLock.lock(); defer { stateLock.unlock() }
        return Array(privateKeys.values)
    }

    /// Binds one application-encoded opaque RuntimeCall to exact chain state without signing.
    public func prepareTransaction(sourceAccountID: Data,
                                   callData: Data) async throws -> CitizenPreparedTransaction {
        guard (1...1_024 * 1_024).contains(callData.count) else {
            throw CitizenSDKError(.invalidArgument, "callData must contain 1...1 MiB bytes")
        }
        return try await native.prepareTransaction(
            source: CitizenSDKInputLimits.accountID(sourceAccountID, label: "sourceAccountID"),
            callData: callData
        ).value()
    }

    public func cancelPreparedTransaction(preparationID: String) throws {
        guard preparationID.range(
            of: #"^0x[0-9a-f]{32}$"#,
            options: .regularExpression
        ) != nil else {
            throw CitizenSDKError(.invalidArgument, "preparationID is invalid")
        }
        try native.cancelPreparedTransaction(preparationID)
    }

    public func executePreparedTransaction(preparationID: String) async throws
        -> CitizenTransactionExecution {
        try await native.executePreparedTransaction(preparationID).value()
    }

    public func consumePreparedTransactionQrResponse(executionID: String, response: String)
        async throws -> CitizenTransactionExecutionCompleted {
        guard (1...2_331).contains(response.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "response must contain 1...2331 UTF-8 bytes")
        }
        let value = try await native
            .consumePreparedTransactionQrResponse(executionID, response: response).value()
        guard case let .completed(completed) = value else {
            throw CitizenSDKError(.integrity, "Core did not return a terminal transaction execution")
        }
        return completed
    }

    public func cancelPreparedTransactionExecution(executionID: String) throws {
        try native.cancelPreparedTransactionExecution(executionID)
    }

    /// Reads the local execution-only history. No account or business filtering is inferred.
    public func getTransactionHistory(beforeExecutionID: String? = nil, limit: UInt32 = 100)
        async throws -> CitizenTransactionHistoryPage {
        guard (1...100).contains(limit) else {
            throw CitizenSDKError(.invalidArgument, "limit must be in 1...100")
        }
        return try await native.getTransactionHistory(
            beforeExecutionID: beforeExecutionID,
            limit: limit
        ).value()
    }

    /// Advances a bounded batch of non-terminal SDK-submitted transactions.
    public func syncTransactionHistory() async throws -> CitizenTransactionHistoryPage {
        try await native.syncTransactionHistory().value()
    }

    /// Destroys only checkpoint-safe Core state. A running instance must first
    /// complete `stop`; accepted requests and owned resources fail BUSY.
    public func close() throws {
        stateLock.lock()
        if closed { stateLock.unlock(); return }
        let state = lifecycleValue
        stateLock.unlock()
        switch state {
        case .created, .stopped, .startFailed: break
        case .disposed: return
        case .running:
            throw CitizenSDKError(.invalidState, "A running CitizenSDK must complete stop before close")
        case .starting, .importingState:
            throw CitizenSDKError(.busy, "CitizenSDK lifecycle transition is still running")
        }
        try finishClose()
    }

    private func finishClose() throws {
        let registry = CitizenSDKCloseGate.shared
        guard let reservation = try registry.beginClose(self) else {
            commitClosedFacade(reservation: nil)
            return
        }
        do {
            let keys = ownedPrivateKeys()
            let captures = ownedCaptures()
            keys.forEach { $0.requestClose() }
            captures.forEach { $0.requestClose() }
            guard keys.isEmpty && captures.isEmpty else { throw CitizenSDKError(.busy, "private key resources are still draining") }
            try releasePreparedResources()
            try native.close()
        } catch {
            let requiresSupervisor = registry.failClose(
                self, reservation: reservation, teardownStarted: native.teardownStarted
            )
            if requiresSupervisor { enqueueForSupervisedClose() }
            throw error
        }
        commitClosedFacade(reservation: reservation)
    }

    /// Used only by the detach supervisor. Unlike Native-only recovery this
    /// retains the facade, respects active resource ownership, and runs a
    /// normal checkpointing stop before close when the Core is running.
    @_spi(CitizenSDKFlutter)
    public func supervisedClose() async throws {
        // Recovery must not consult `lifecycleValue`: the Core can complete a
        // stop before its lifecycle event reaches this facade. Native queries
        // the authoritative C lifecycle and resumes any partial ABI teardown.
        let registry = CitizenSDKCloseGate.shared
        guard let reservation = try registry.beginClose(self, origin: .supervised) else {
            commitClosedFacade(reservation: nil)
            return
        }
        do {
            for resource in ownedPrivateKeys() { try await resource.close() }
            for resource in ownedCaptures() { try await resource.close() }
            try releasePreparedResources()
            try await native.supervisedClose()
        } catch {
            // This method already runs under the lifecycle supervisor, so even
            // a pre-teardown failure stays closing between actor retries.
            _ = registry.failClose(
                self, reservation: reservation, teardownStarted: native.teardownStarted
            )
            throw error
        }
        commitClosedFacade(reservation: reservation)
    }

    /// Official Flutter adapter SPI; not part of the application-facing API.
    @_spi(CitizenSDKFlutter)
    public func enqueueForSupervisedClose() {
        Task { await CitizenSDKLifecycleSupervisor.shared.adopt(self) }
    }

    /// Commits public disposal only after successful Core destruction. The
    /// idempotent gate also makes concurrent explicit/reaper completion commit
    /// the registry tombstone exactly once.
    private func commitClosedFacade(
        reservation: CitizenSDKCloseGate.CloseReservation?
    ) {
        // Publish the destroyed tombstone first, without holding `stateLock`,
        // so no wallet UI can enter while facade disposal is being committed.
        CitizenSDKCloseGate.shared.commitClosed(self, reservation: reservation)
        stateLock.lock()
        let didCommit = !closed
        if didCommit {
            lifecycleValue = .disposed
            closed = true
            eventHandler = nil
        }
        stateLock.unlock()
    }

    public func validatePassword(_ password: String) throws -> CitizenWalletInputValidation {
        try CitizenSDKNative.validateWalletInput(password, kind: 1, wordCount: 0)
    }
    public func validateMnemonic(_ mnemonic: String, wordCount: UInt32) throws -> CitizenWalletInputValidation {
        try CitizenSDKNative.validateWalletInput(mnemonic, kind: 2, wordCount: wordCount)
    }
    public func wordSuggestions(_ prefix: String) throws -> [String] { try CitizenSDKNative.walletWordSuggestions(prefix) }

    public func prepareCreation(wordCount: UInt32, password: String = "") throws -> CitizenSDKOperation<CitizenSDKPreparedWallet> {
        try resourceOperation {
        try withWalletInputs(mnemonic: "", password: password) { _, password in
            try native.prepareWallet(wordCount: wordCount, password: password).map { [self, native] handle in
                let resource = CitizenSDKPreparedWallet(native: native, handle: handle) { [weak self] value in
                    guard let self else { return }
                    self.stateLock.lock(); defer { self.stateLock.unlock() }
                    self.preparedWallets.removeValue(forKey: ObjectIdentifier(value))
                }
                self.stateLock.lock()
                let accepting = !self.closed && !self.resourcesClosing
                if accepting { self.preparedWallets[ObjectIdentifier(resource)] = resource }
                self.stateLock.unlock()
                guard accepting else { try resource.release(); throw CitizenSDKError(.cancelled, "SDK is closed") }
                return resource
            }
        }
        }
    }

    public func importWallet(mnemonic: String, password: String = "") throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try native.importWallet(mnemonic: mnemonic, password: password).map {
                guard let value = $0 else { throw CitizenSDKError(.integrity, "wallet import returned no profile") }
                return value
            }
        }
    }

    public func addAccounts(mnemonic: String, password: String = "", indices: [UInt32]) throws -> CitizenSDKOperation<CitizenWalletProfile> {
        let indices = try CitizenSDKInputLimits.additionalIndices(indices)
        return try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try native.addAccounts(mnemonic: mnemonic, password: password, indices: indices)
        }
    }

    /// 下一编号由Core同一次身份校验和提交决定，宿主不能先读max+1再提交。
    public func addNextAccount(mnemonic: String, password: String = "") throws -> CitizenSDKOperation<CitizenWalletProfile> {
        try withWalletInputs(mnemonic: mnemonic, password: password) { mnemonic, password in
            try native.addNextAccount(mnemonic: mnemonic, password: password)
        }
    }

    private func withWalletInputs<T>(mnemonic: String, password: String,
        _ body: (CitizenSDKSensitiveBuffer, CitizenSDKSensitiveBuffer) throws -> T) throws -> T {
        func buffer(_ value: String) throws -> CitizenSDKSensitiveBuffer {
            guard value.utf8.count <= 1_024 else { throw CitizenSDKError(.invalidArgument, "wallet input exceeds 1024 bytes") }
            var copy = Data(value.utf8)
            defer { copy.resetBytes(in: 0..<copy.count) }
            return CitizenSDKSensitiveBuffer(data: copy)
        }
        let phrase = try buffer(mnemonic)
        defer { phrase.clear() }
        let password = try buffer(password)
        defer { password.clear() }
        return try body(phrase, password)
    }

    private func releasePreparedResources() throws {
        stateLock.lock()
        let owned = Array(preparedWallets.values)
        let reviews = Array(qrReviews.values)
        let inspections = Array(walletInspections.values)
        stateLock.unlock()
        try owned.forEach { try $0.release() }
        try reviews.forEach { try $0.release() }
        try inspections.forEach { try $0.release() }
    }

    /// 接纳至资源登记之间持有短生命周期票据；不是UI窗口所有权，不禁止同实例其它资源。
    private func resourceOperation<T: Sendable>(_ create: () throws -> CitizenSDKOperation<T>) throws -> CitizenSDKOperation<T> {
        try requireResourceAdmission()
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        do {
            let operation = try create()
            operation.observe { [self] _ in CitizenSDKCloseGate.shared.finish(self, token: ticket) }
            return operation
        } catch {
            CitizenSDKCloseGate.shared.finish(self, token: ticket)
            throw error
        }
    }

    public func parseForPurpose(_ text: String, purpose: CitizenQRScanPurpose) throws -> CitizenQRScanResult {
        try CitizenQRScanResult(document: native.qrParse(text), purpose: purpose)
    }

    public func openCapture(purpose: CitizenQRScanPurpose, listener: CitizenSDKQrCapture.Listener) async throws -> CitizenSDKQrCapture {
        let resource = try createCapture(purpose: purpose, listener: listener)
        do { try await resource.start(); return resource }
        catch { try? await resource.close(); throw error }
    }

    private func createCapture(purpose: CitizenQRScanPurpose, listener: CitizenSDKQrCapture.Listener) throws -> CitizenSDKQrCapture {
        try requireResourceAdmission()
        let ticket = try CitizenSDKCloseGate.shared.reserve(self)
        defer { CitizenSDKCloseGate.shared.finish(self, token: ticket) }
        try native.requireQRModule()
        let resource = CitizenSDKQrCapture(native: native, purpose: purpose, listener: listener) { [weak self] value in
            guard let self else { return }
            self.stateLock.lock(); defer { self.stateLock.unlock() }
            self.qrCaptures.removeValue(forKey: ObjectIdentifier(value))
        }
        stateLock.lock()
        let accepting = !closed && !resourcesClosing
        if accepting { qrCaptures[ObjectIdentifier(resource)] = resource }
        stateLock.unlock()
        guard accepting else { resource.requestClose(); throw CitizenSDKError(.cancelled, "SDK is closing resources") }
        return resource
    }
    private func ownedCaptures() -> [CitizenSDKQrCapture] {
        stateLock.lock(); defer { stateLock.unlock() }
        return Array(qrCaptures.values)
    }

    private func requireResourceAdmission() throws {
        stateLock.lock(); defer { stateLock.unlock() }
        guard !closed && !resourcesClosing else { throw CitizenSDKError(.cancelled, "SDK is closing resources") }
    }

    /// Flutter关闭先撤销已交付和仍在打开的资源，再等待其真实任务，避免权限等待死锁。
    @_spi(CitizenSDKFlutter)
    public func requestResourceClose() {
        stateLock.lock()
        resourcesClosing = true
        let keys = Array(privateKeys.values), captures = Array(qrCaptures.values)
        stateLock.unlock()
        keys.forEach { $0.requestClose() }
        captures.forEach { $0.requestClose() }
    }

    private func receive(_ event: CitizenSDKEvent) {
        stateLock.lock()
        if case let .lifecycleChanged(_, lifecycle) = event { lifecycleValue = lifecycle }
        let handler = eventHandler
        stateLock.unlock()
        if case .walletChanged = event { ownedPrivateKeys().forEach { $0.requestClose() } }
        handler?(event)
    }
}

/// 本地签名始终经核心账户归属检查与设备金库授权；公开验签不创建钱包或访问金库。
public struct CitizenSigning: Sendable {
    private let native: CitizenSDKNative
    private let reviewOperation: @Sendable (String) throws -> CitizenSDKOperation<CitizenQRReview>
    private let signQrOperation: @Sendable (CitizenQRReview) throws -> CitizenSDKOperation<CitizenQRSigned>
    internal init(native: CitizenSDKNative,
                  review: @escaping @Sendable (String) throws -> CitizenSDKOperation<CitizenQRReview>,
                  signQr: @escaping @Sendable (CitizenQRReview) throws -> CitizenSDKOperation<CitizenQRSigned>) {
        self.native = native; reviewOperation = review; signQrOperation = signQr
    }
    public func reviewQrRequest(_ text: String) throws -> CitizenSDKOperation<CitizenQRReview> { try reviewOperation(text) }
    public func signQrRequest(_ review: CitizenQRReview) throws -> CitizenSDKOperation<CitizenQRSigned> { try signQrOperation(review) }

    public func sign(accountID: Data, message: Data) throws -> CitizenSDKOperation<CitizenSignature> {
        try native.sign(accountID: CitizenSDKInputLimits.accountID(accountID),
                              message: CitizenSDKInputLimits.signingPayload(message))
    }

    public func begin(_ intent: CitizenSigningIntent) throws -> CitizenSDKOperation<CitizenSigningOutcome> {
        try native.beginSigning(intent)
    }

    public func consumeExternalSignature(sessionID: String,
                                         response: String) throws -> CitizenSDKOperation<CitizenSigningOutcome> {
        try Self.validateExternal(sessionID: sessionID, response: response)
        return try native.consumeExternalSignature(
            sessionID: sessionID, response: response)
    }

    public func cancel(sessionID: String) throws -> Bool {
        guard (1...128).contains(sessionID.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "external signing sessionID is invalid")
        }
        return try native.cancelSigningSession(sessionID)
    }

    internal static func validateExternal(sessionID: String, response: String) throws {
        guard (1...128).contains(sessionID.utf8.count),
              (1...2_331).contains(response.utf8.count) else {
            throw CitizenSDKError(.invalidArgument, "external signing response is invalid")
        }
    }

    public static func verify(accountID: Data, signature: Data, message: Data) throws -> Bool {
        try CitizenSDKNative.verify(accountID: CitizenSDKInputLimits.accountID(accountID),
                                    signature: signature,
                                    message: CitizenSDKInputLimits.signingPayload(message))
    }
    public static func encodePayload(_ payload: CitizenSigningPayload) throws -> Data {
        try CitizenSDKNative.encodePayload(kind: payload.kind, fieldsJSON: payload.fieldsJSON, payload: payload.payloadBytes)
    }
    @_spi(CitizenSDKFlutter) public static func encodePayload(kind: UInt32, fieldsJSON: String, payload: Data) throws -> Data {
        try CitizenSDKNative.encodePayload(kind: kind, fieldsJSON: fieldsJSON, payload: payload)
    }
}

/** 原关闭预约状态机的非UI部分：允许多个资源接纳票据，部分teardown失败保持只准关闭重试。 */
internal final class CitizenSDKCloseGate: @unchecked Sendable {
    enum Status { case open, owned, closing, closed }
    struct CloseReservation: Equatable, Sendable {
        let token: UUID
        let retryCommitted: Bool
    }
    enum CloseOrigin { case explicit, supervised }
    private enum State { case open(Set<UUID>), closing(CloseReservation?), closed }
    static let shared = CitizenSDKCloseGate()
    private let lock = NSLock()
    private var states: [ObjectIdentifier: State] = [:]

    func registerOpen(_ sdk: AnyObject) {
        lock.lock(); defer { lock.unlock() }
        precondition(states[ObjectIdentifier(sdk)] == nil)
        states[ObjectIdentifier(sdk)] = .open([])
    }
    func reserve(_ sdk: AnyObject) throws -> UUID {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        guard case var .open(tickets) = states[key] else {
            if case .closing = states[key] { throw CitizenSDKError(.busy, "SDK is closing") }
            throw CitizenSDKError(.invalidState, "SDK is closed or unregistered")
        }
        let token = UUID(); tickets.insert(token); states[key] = .open(tickets)
        return token
    }
    func finish(_ sdk: AnyObject, token: UUID) {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        if case var .open(tickets) = states[key] { tickets.remove(token); states[key] = .open(tickets) }
    }
    func beginClose(_ sdk: AnyObject, origin: CloseOrigin = .explicit) throws -> CloseReservation? {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        switch states[key] {
        case let .open(tickets):
            guard tickets.isEmpty else { throw CitizenSDKError(.busy, "resource admission has not settled") }
            let reservation = CloseReservation(token: UUID(), retryCommitted: origin == .supervised)
            states[key] = .closing(reservation)
            return reservation
        case .closing(nil):
            let reservation = CloseReservation(token: UUID(), retryCommitted: true)
            states[key] = .closing(reservation)
            return reservation
        case .closing: throw CitizenSDKError(.busy, "another close attempt is active")
        case .closed: return nil
        case nil: throw CitizenSDKError(.invalidState, "SDK is not registered")
        }
    }
    @discardableResult
    func failClose(_ sdk: AnyObject, reservation: CloseReservation, teardownStarted: Bool) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        guard case let .closing(current?) = states[key], current == reservation else { return false }
        states[key] = teardownStarted || reservation.retryCommitted ? .closing(nil) : .open([])
        return teardownStarted && !reservation.retryCommitted
    }
    func commitClosed(_ sdk: AnyObject, reservation: CloseReservation?) {
        lock.lock(); defer { lock.unlock() }
        let key = ObjectIdentifier(sdk)
        if case .closed = states[key] { return }
        guard let reservation, case let .closing(current?) = states[key], current == reservation else {
            preconditionFailure("close reservation changed before Core destruction")
        }
        states[key] = .closed
    }
    func forget(_ sdk: AnyObject) { lock.lock(); states.removeValue(forKey: ObjectIdentifier(sdk)); lock.unlock() }
    func status(_ sdk: AnyObject) -> Status? {
        lock.lock(); defer { lock.unlock() }
        switch states[ObjectIdentifier(sdk)] {
        case let .open(tickets): return tickets.isEmpty ? .open : .owned
        case .closing: return .closing
        case .closed: return .closed
        case nil: return nil
        }
    }
}
