//! QR_V1 的唯一公开解析、审阅和安全签名 ABI；平台只展示公开事实和取得用户确认。

#[cfg(feature = "qr")]
mod enabled {
    use crate::{
        abi::{
            CitizenSdkAccountId, CitizenSdkBytesView, CitizenSdkErrorCode, CitizenSdkHandle,
            CitizenSdkRequestId, CitizenSdkResultHandle,
        },
        copy_to_host, copy_view,
        error::{FfiError, FfiResult},
        ffi_status, handles,
        ownership::{self, ExternalSigningPending, ResultPayload},
        requests, require_output,
        runtime::NativeRuntime,
    };
    use citizen_sdk_contracts::{
        AccountId32, ContractErrorCode, DefaultAccountChangeAuthorization, Modules,
        SigningCompletion, SigningIntent, Sr25519PublicKey, DEFAULT_ACCOUNT_CHANGE_QR_ACTION,
    };
    use citizen_sdk_engine::EngineError;
    use citizen_sdk_qr::{
        parse, AccountIdCode, QrClock, QrCode, QrError, QrErrorCode, QrSessionStore, SignRequest,
        SignResponse, SystemQrClock, MAX_QR_JSON_BYTES, MAX_QR_TEXT_BYTES,
    };
    use futures_util::FutureExt;
    use std::{
        collections::{HashMap, HashSet},
        ptr,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex, MutexGuard, OnceLock,
        },
    };

    type Sessions = QrSessionStore<SystemQrClock>;
    #[derive(Default)]
    struct OwnerSessions {
        outbound: Option<Sessions>,
        // Unified signing sessions are segregated from legacy low-level QR sessions and SDK-owned
        // wallet mutations so no public consume path can reinterpret another flow.
        generic_signing: HashSet<String>,
        default_changes: HashMap<String, DefaultAccountChangeAuthorization>,
        // 已接纳的签名 request_id 在期限内不再签第二次，即使调用方重新审阅同一个二维码。
        signing: HashMap<String, u64>,
    }
    static SESSIONS: OnceLock<Mutex<HashMap<CitizenSdkHandle, OwnerSessions>>> = OnceLock::new();

    /// 只读审阅数据加一次性原子领取；结果释放不会丢弃已经被签名作业持有的原始请求。
    #[derive(Debug)]
    pub(crate) struct QrReviewResult {
        pub(crate) json: String,
        request: SignRequest,
        claimed: AtomicBool,
        #[cfg(feature = "chain")]
        review: citizen_sdk_engine::QrReview,
    }

    fn lock_sessions() -> FfiResult<MutexGuard<'static, HashMap<CitizenSdkHandle, OwnerSessions>>> {
        SESSIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| FfiError::internal("二维码会话状态已损坏"))
    }
    fn runtime_with(handle: CitizenSdkHandle, modules: u32) -> FfiResult<Arc<NativeRuntime>> {
        let runtime = handles::get(handle)?;
        if !runtime.has_modules(modules) {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Unsupported,
                "实例没有所需二维码、链或签名模块",
            ));
        }
        Ok(runtime)
    }
    unsafe fn qr_text(view: CitizenSdkBytesView, name: &str) -> FfiResult<String> {
        let bytes = copy_view(view, name, MAX_QR_TEXT_BYTES)?;
        String::from_utf8(bytes).map_err(|_| FfiError::invalid("二维码文本必须是 UTF-8"))
    }
    fn map_qr_error(error: QrError) -> FfiError {
        let code = match error.code() {
            QrErrorCode::InvalidFormat | QrErrorCode::InvalidField => CitizenSdkErrorCode::Decode,
            QrErrorCode::UnsupportedKind => CitizenSdkErrorCode::Unsupported,
            QrErrorCode::Expired => CitizenSdkErrorCode::Timeout,
            QrErrorCode::MismatchedRequest
            | QrErrorCode::MismatchedAccount
            | QrErrorCode::AlreadyConsumed => CitizenSdkErrorCode::Conflict,
            QrErrorCode::InvalidSignature => CitizenSdkErrorCode::Integrity,
            QrErrorCode::CapacityExceeded => CitizenSdkErrorCode::InvalidArgument,
            QrErrorCode::EntropyUnavailable | QrErrorCode::ClockUnavailable => {
                CitizenSdkErrorCode::Unavailable
            }
        };
        FfiError::new(code, error.message())
    }
    fn encode_json(value: &serde_json::Value) -> FfiResult<String> {
        let json = serde_json::to_string(value)
            .map_err(|_| FfiError::internal("二维码公开事实无法编码"))?;
        if json.len() > MAX_QR_JSON_BYTES {
            return Err(FfiError::invalid("二维码公开事实超过 64 KiB"));
        }
        Ok(json)
    }
    fn current_request(text: &str) -> FfiResult<SignRequest> {
        match parse(text).map_err(map_qr_error)? {
            QrCode::SignRequest(request) => {
                request.require_signer().map_err(map_qr_error)?;
                Ok(request)
            }
            _ => Err(FfiError::invalid("二维码不是签名请求")),
        }
    }
    fn ensure_current(request: &SignRequest, cancelled: &AtomicBool) -> Result<(), EngineError> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(EngineError::Cancelled);
        }
        let now = SystemQrClock.now_epoch_seconds();
        if now == 0 {
            return Err(EngineError::contract(
                ContractErrorCode::Unavailable,
                "系统时钟不可用",
            ));
        }
        if request.expires_at <= now {
            return Err(EngineError::contract(
                ContractErrorCode::Timeout,
                "二维码请求已过期",
            ));
        }
        Ok(())
    }

    fn claim_signing_request(
        handle: CitizenSdkHandle,
        request: &SignRequest,
        claimed: &AtomicBool,
    ) -> FfiResult<()> {
        ensure_current(request, &AtomicBool::new(false))?;
        if claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Conflict,
                "审阅结果已经领取",
            ));
        }
        let claim = (|| {
            let mut registry = lock_sessions()?;
            let owner = registry.entry(handle).or_default();
            let now = SystemQrClock.now_epoch_seconds();
            owner.signing.retain(|_, expires| *expires > now);
            if owner.signing.contains_key(&request.request_id) {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "该二维码请求已经接纳签名",
                ));
            }
            if owner.signing.len() >= 64 {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Busy,
                    "二维码签名会话超过上限",
                ));
            }
            owner
                .signing
                .insert(request.request_id.clone(), request.expires_at);
            Ok(())
        })();
        if claim.is_err() {
            claimed.store(false, Ordering::SeqCst);
        }
        claim
    }
    fn hex(bytes: &[u8]) -> String {
        use std::fmt::Write;
        let mut text = String::with_capacity(2 + bytes.len() * 2);
        text.push_str("0x");
        for byte in bytes {
            let _ = write!(text, "{byte:02x}");
        }
        text
    }

    /// 取消只发出撤销信号，然后实际排空同一个 future；不会 drop 借用宿主缓冲的认证。
    async fn drain_cancel<F, T>(
        work: F,
        cancellation: requests::RequestCancellation,
        cancelled: Arc<AtomicBool>,
    ) -> FfiResult<T>
    where
        F: std::future::Future<Output = FfiResult<T>>,
    {
        let work = work.fuse();
        let cancellation = cancellation.fuse();
        futures_util::pin_mut!(work, cancellation);
        futures_util::select_biased! {
            _ = cancellation => {
                cancelled.store(true, Ordering::SeqCst);
                let _ = work.await;
                Err(FfiError::new(CitizenSdkErrorCode::Cancelled, "二维码操作已取消且认证已排空"))
            },
            result = work => result,
        }
    }
    pub(crate) fn drop_sessions_for_owner(handle: CitizenSdkHandle) {
        if let Ok(mut registry) = lock_sessions() {
            registry.remove(&handle);
        }
    }

    /// Create the QR_V1 adapter projection for one already validated generic signing intent.
    pub(crate) fn create_external_qr_session(
        handle: CitizenSdkHandle,
        action: u16,
        intent: &SigningIntent,
        ttl_seconds: u64,
    ) -> FfiResult<ExternalSigningPending> {
        let mut registry = lock_sessions()?;
        let owner = registry.entry(handle).or_default();
        let store = owner
            .outbound
            .get_or_insert_with(|| QrSessionStore::new(SystemQrClock));
        let request = store
            .create_with_transform(
                action,
                Sr25519PublicKey::from_bytes(intent.account_id().into_bytes()),
                intent.payload().to_vec(),
                intent.transform().clone(),
                ttl_seconds,
            )
            .map_err(map_qr_error)?;
        let encoded = match request.encode().map_err(map_qr_error) {
            Ok(value) => value,
            Err(error) => {
                store.cancel(&request.request_id);
                return Err(error);
            }
        };
        owner.generic_signing.insert(request.request_id.clone());
        Ok(ExternalSigningPending {
            account_id: intent.account_id(),
            payload_hash: intent.payload_hash().map_err(FfiError::from)?,
            expires_at: request.expires_at,
            session_id: request.request_id,
            transport_request: encoded,
        })
    }

    /// Verify and consume only a unified generic signing session from this SDK instance.
    pub(crate) fn consume_external_qr_session(
        handle: CitizenSdkHandle,
        session_id: &str,
        response_text: &str,
    ) -> FfiResult<SigningCompletion> {
        let QrCode::SignResponse(response) = parse(response_text).map_err(map_qr_error)? else {
            return Err(FfiError::invalid("external response 不是 QR_V1 签名响应"));
        };
        if response.request_id != session_id {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Conflict,
                "external response 与 session_id 不一致",
            ));
        }
        let mut registry = lock_sessions()?;
        let owner = registry.get_mut(&handle).ok_or_else(|| {
            FfiError::new(CitizenSdkErrorCode::Conflict, "没有当前实例的签名会话")
        })?;
        if !owner.generic_signing.contains(session_id) {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Conflict,
                "会话不属于通用 external signing 流程",
            ));
        }
        let store = owner.outbound.as_mut().ok_or_else(|| {
            FfiError::new(CitizenSdkErrorCode::Conflict, "没有对应二维码请求会话")
        })?;
        let (request, signature) = futures_executor::block_on(
            store.verify_and_consume_response(&citizen_signer::Sr25519SoftwareSigner, &response),
        )
        .map_err(map_qr_error)?;
        owner.generic_signing.remove(session_id);
        Ok(SigningCompletion::new(
            AccountId32::from_bytes(*request.require_signer().map_err(map_qr_error)?.as_bytes()),
            citizen_sdk_contracts::Hash32::from_bytes(
                citizen_sdk_contracts::blake2_256(&request.review_payload)
                    .map_err(FfiError::from)?,
            ),
            signature,
        ))
    }

    /// 只核原实例未消费请求的真实期限；错误响应不能借自己的期限销毁有效会话。
    pub(crate) fn external_qr_session_pending(handle: CitizenSdkHandle, session_id: &str) -> FfiResult<bool> {
        let registry = lock_sessions()?;
        let Some(owner) = registry.get(&handle) else { return Ok(false); };
        if !owner.generic_signing.contains(session_id) { return Ok(false); }
        match owner.outbound.as_ref() {
            Some(store) => store.is_pending(session_id).map_err(map_qr_error),
            None => Ok(false),
        }
    }

    /// Create the existing independent CitizenWallet action-12 adapter for an SDK wallet mutation.
    pub(crate) fn create_default_account_qr_session(
        handle: CitizenSdkHandle,
        authorization: DefaultAccountChangeAuthorization,
    ) -> FfiResult<ExternalSigningPending> {
        let intent = authorization.signing_intent().map_err(FfiError::from)?;
        let mut registry = lock_sessions()?;
        let owner = registry.entry(handle).or_default();
        let store = owner
            .outbound
            .get_or_insert_with(|| QrSessionStore::new(SystemQrClock));
        let request = store
            .create_with_transform_until(
                DEFAULT_ACCOUNT_CHANGE_QR_ACTION,
                Sr25519PublicKey::from_bytes(intent.account_id().into_bytes()),
                intent.payload().to_vec(),
                intent.transform().clone(),
                authorization.expires_at(),
            )
            .map_err(map_qr_error)?;
        let encoded = match request.encode().map_err(map_qr_error) {
            Ok(value) => value,
            Err(error) => {
                store.cancel(&request.request_id);
                return Err(error);
            }
        };
        owner
            .default_changes
            .insert(request.request_id.clone(), authorization);
        Ok(ExternalSigningPending {
            account_id: intent.account_id(),
            payload_hash: intent.payload_hash().map_err(FfiError::from)?,
            expires_at: request.expires_at,
            session_id: request.request_id,
            transport_request: encoded,
        })
    }

    /// Verify once, then release the frozen wallet mutation for Engine CAS. A valid signature makes
    /// the session terminal even if the later CAS observes drift; invalid signatures remain retryable.
    pub(crate) fn consume_default_account_qr_session(
        handle: CitizenSdkHandle,
        session_id: &str,
        response_text: &str,
    ) -> FfiResult<(
        DefaultAccountChangeAuthorization,
        citizen_sdk_contracts::Sr25519Signature,
    )> {
        let QrCode::SignResponse(response) = parse(response_text).map_err(map_qr_error)? else {
            return Err(FfiError::invalid("external response 不是 QR_V1 签名响应"));
        };
        if response.request_id != session_id {
            return Err(FfiError::new(
                CitizenSdkErrorCode::Conflict,
                "默认账户响应与 session_id 不一致",
            ));
        }
        let mut registry = lock_sessions()?;
        let owner = registry.get_mut(&handle).ok_or_else(|| {
            FfiError::new(CitizenSdkErrorCode::Conflict, "没有当前实例的钱包会话")
        })?;
        let authorization = owner
            .default_changes
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "会话不属于默认账户变更流程或已经消费",
                )
            })?;
        let store = owner.outbound.as_mut().ok_or_else(|| {
            FfiError::new(CitizenSdkErrorCode::Conflict, "没有对应二维码请求会话")
        })?;
        let (_, signature) = futures_executor::block_on(
            store.verify_and_consume_response(&citizen_signer::Sr25519SoftwareSigner, &response),
        )
        .map_err(map_qr_error)?;
        owner.default_changes.remove(session_id);
        Ok((authorization, signature))
    }

    pub(crate) fn cancel_unified_signing_session(
        handle: CitizenSdkHandle,
        session_id: &str,
    ) -> FfiResult<bool> {
        let mut registry = lock_sessions()?;
        let Some(owner) = registry.get_mut(&handle) else {
            return Ok(false);
        };
        let known = owner.generic_signing.remove(session_id)
            | owner.default_changes.remove(session_id).is_some();
        if !known {
            return Ok(false);
        }
        Ok(owner
            .outbound
            .as_mut()
            .is_some_and(|store| store.cancel(session_id)))
    }

    /// # Safety
    /// `text` 必须在调用期间可读；`out_required` 必须可写。`output` 非空时必须可写
    /// `output_capacity` 字节，且不能与其它参数非法重叠。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_parse(
        handle: CitizenSdkHandle,
        text: CitizenSdkBytesView,
        output: *mut u8,
        output_capacity: u64,
        out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            let code = parse(&qr_text(text, "qr text")?).map_err(map_qr_error)?;
            let json = encode_json(&code.normalized().map_err(map_qr_error)?)?;
            copy_to_host(json.as_bytes(), output, output_capacity, out_required)
        })
    }

    /// # Safety
    /// `signer_account_id` 必须指向可读账户；`review_payload` 必须在调用期间可读；
    /// `out_required` 及按容量提供的 `output` 必须指向有效可写内存。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_create_sign_request(
        handle: CitizenSdkHandle,
        action: u16,
        signer_account_id: *const CitizenSdkAccountId,
        review_payload: CitizenSdkBytesView,
        ttl_seconds: u64,
        output: *mut u8,
        output_capacity: u64,
        out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            if signer_account_id.is_null() {
                return Err(FfiError::invalid("signer_account_id 不能为空"));
            }
            let account_id = ptr::read(signer_account_id);
            let payload = copy_view(review_payload, "review_payload", MAX_QR_TEXT_BYTES)?;
            let mut registry = lock_sessions()?;
            let owner = registry.entry(handle).or_default();
            let store = owner
                .outbound
                .get_or_insert_with(|| QrSessionStore::new(SystemQrClock));
            let request = store
                .create(
                    action,
                    Sr25519PublicKey::from_bytes(account_id.bytes),
                    payload,
                    ttl_seconds,
                )
                .map_err(map_qr_error)?;
            let encoded = request.encode().map_err(map_qr_error)?;
            let query_only = output.is_null() && output_capacity == 0;
            let copied = copy_to_host(encoded.as_bytes(), output, output_capacity, out_required);
            // 长度查询/缓冲错误不留下消费者未收到的会话。
            if query_only || copied.is_err() {
                store.cancel(&request.request_id);
            }
            copied
        })
    }

    /// # Safety
    /// `text` 必须在同步复制期间可读，`out_request_id` 必须指向可写请求编号。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_review_qr_sign_request(
        handle: CitizenSdkHandle,
        text: CitizenSdkBytesView,
        out_request_id: *mut CitizenSdkRequestId,
    ) -> i32 {
        ffi_status(|| {
            let runtime = runtime_with(handle, Modules::QR | Modules::CHAIN)?;
            require_output(out_request_id, "out_request_id")?;
            let request = current_request(&qr_text(text, "sign request")?)?;
            #[cfg(not(feature = "chain"))]
            {
                let _ = (runtime, request);
                Err(FfiError::new(
                    CitizenSdkErrorCode::Unsupported,
                    "当前构建不包含链审阅",
                ))
            }
            #[cfg(feature = "chain")]
            {
                let id = requests::accept(runtime, true, move |runtime, _, cancellation| {
                    let cancelled = Arc::new(AtomicBool::new(false));
                    let token = Arc::clone(&cancelled);
                    let work = async {
                        ensure_current(&request, &token)?;
                        runtime.refresh_chain_readiness()?;
                        let review = runtime
                            .engine()
                            .review_qr_sign_request(request.clone())
                            .await?;
                        ensure_current(&request, &token)?;
                        let mut value = QrCode::SignRequest(request.clone())
                            .normalized()
                            .map_err(map_qr_error)?;
                        value["pallet_name"] = review.pallet_name().into();
                        value["call_name"] = review.call_name().into();
                        value["call_arguments"] = review.call_arguments().into();
                        value["genesis_hash"] = hex(review.genesis_hash().as_bytes()).into();
                        value["spec_version"] = review.spec_version().into();
                        value["transaction_version"] = review.transaction_version().into();
                        value["era"] = review.era().into();
                        value["nonce"] = review.nonce().to_string().into();
                        value["tip"] = review.tip().to_string().into();
                        value["block_hash"] = hex(review.block_hash().as_bytes()).into();
                        Ok(ResultPayload::QrReview(Arc::new(QrReviewResult {
                            json: encode_json(&value)?,
                            request,
                            claimed: AtomicBool::new(false),
                            review,
                        })))
                    };
                    runtime.drive(drain_cancel(
                        work,
                        cancellation.ok_or_else(|| FfiError::internal("二维码取消通道缺失"))?,
                        cancelled,
                    ))?
                })?;
                ptr::write(out_request_id, id);
                Ok(())
            }
        })
    }

    /// # Safety
    /// `review_result` 必须是当前实例仍持有的结果句柄，`out_request_id` 必须可写。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_sign_qr_request(
        handle: CitizenSdkHandle,
        review_result: CitizenSdkResultHandle,
        out_request_id: *mut CitizenSdkRequestId,
    ) -> i32 {
        ffi_status(|| {
            let runtime = runtime_with(handle, Modules::QR | Modules::SIGNING | Modules::CHAIN)?;
            require_output(out_request_id, "out_request_id")?;
            let owned = ownership::get(review_result)?;
            if owned.owner != handle || owned.code != CitizenSdkErrorCode::Ok {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "审阅结果不属于当前实例",
                ));
            }
            let ResultPayload::QrReview(review) = owned.payload else {
                return Err(FfiError::invalid("结果不是 QR 审阅"));
            };
            ensure_current(&review.request, &AtomicBool::new(false))?;
            #[cfg(not(all(feature = "chain", feature = "signing")))]
            {
                let _ = (runtime, review);
                Err(FfiError::new(
                    CitizenSdkErrorCode::Unsupported,
                    "当前构建不包含链扫码签名",
                ))
            }
            #[cfg(all(feature = "chain", feature = "signing"))]
            {
                claim_signing_request(handle, &review.request, &review.claimed)?;
                let job_review = Arc::clone(&review);
                let accepted = requests::accept(runtime, true, move |runtime, _, cancellation| {
                    let cancelled = Arc::new(AtomicBool::new(false));
                    let token = Arc::clone(&cancelled);
                    let work = async {
                        ensure_current(&job_review.request, &token)?;
                        runtime.refresh_provider_capabilities()?;
                        let signature = runtime
                            .engine()
                            .sign_qr_review(job_review.review.clone(), || {
                                ensure_current(&job_review.request, &token)
                            })
                            .await?;
                        ensure_current(&job_review.request, &token)?;
                        let response = SignResponse {
                current_account: None,
                            request_id: job_review.request.request_id.clone(),
                            expires_at: job_review.request.expires_at,
                            signer_public_key: job_review.request.require_signer().map_err(map_qr_error)?,
                            signature,
                        };
                        let mut value = QrCode::SignResponse(response)
                            .normalized()
                            .map_err(map_qr_error)?;
                        value["sign_request"] =
                            job_review.request.encode().map_err(map_qr_error)?.into();
                        Ok(ResultPayload::QrSigned(encode_json(&value)?))
                    };
                    runtime.drive(drain_cancel(
                        work,
                        cancellation.ok_or_else(|| FfiError::internal("二维码取消通道缺失"))?,
                        cancelled,
                    ))?
                });
                match accepted {
                    Ok(id) => {
                        ptr::write(out_request_id, id);
                        Ok(())
                    }
                    Err(error) => {
                        // 队列拒绝代表没有开始作业，可以准确撤销此一次领取；不回滚已开始的认证。
                        if let Ok(mut registry) = lock_sessions() {
                            if let Some(owner) = registry.get_mut(&handle) {
                                owner.signing.remove(&review.request.request_id);
                            }
                        }
                        review.claimed.store(false, Ordering::SeqCst);
                        Err(error)
                    }
                }
            }
        })
    }

    /// # Safety
    /// `out_required` 必须可写；`output` 非空时必须可写 `output_capacity` 字节。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_result_copy_qr(
        result: CitizenSdkResultHandle,
        output: *mut u8,
        output_capacity: u64,
        out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            let result = ownership::get(result)?;
            if result.code != CitizenSdkErrorCode::Ok {
                return Err(FfiError::new(result.code, result.message));
            }
            let text = match result.payload {
                ResultPayload::QrReview(review) => review.json.clone(),
                ResultPayload::QrSigned(json) => json,
                _ => return Err(FfiError::invalid("结果不是二维码公开事实")),
            };
            copy_to_host(text.as_bytes(), output, output_capacity, out_required)
        })
    }

    /// 同实例非消费预检；持有原会话锁至验签结束，不接收调用方替换的transform。
    /// # Safety
    /// 两个输入视图仅在本次调用借用，必须指向各自长度内可读的UTF-8。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_validate_sign_response(
        handle: CitizenSdkHandle,
        session_id: CitizenSdkBytesView,
        text: CitizenSdkBytesView,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            let session_id = String::from_utf8(copy_view(session_id, "session_id", 128)?)
                .map_err(|_| FfiError::invalid("session_id必须是UTF-8"))?;
            if session_id.is_empty() { return Err(FfiError::invalid("session_id不能为空")); }
            let QrCode::SignResponse(response) = parse(&qr_text(text, "sign response")?).map_err(map_qr_error)?
                else { return Err(FfiError::invalid("二维码不是签名响应")); };
            if response.request_id != session_id {
                return Err(FfiError::new(CitizenSdkErrorCode::Conflict, "响应与当前会话不一致"));
            }
            let registry = lock_sessions()?;
            let store = registry.get(&handle).and_then(|owner| owner.outbound.as_ref())
                .ok_or_else(|| FfiError::new(CitizenSdkErrorCode::Conflict, "没有本实例请求会话"))?;
            futures_executor::block_on(store.verify_response(
                &citizen_signer::Sr25519SoftwareSigner, &response,
            )).map_err(map_qr_error)?;
            Ok(())
        })
    }

    /// # Safety
    /// `text` 必须在调用期间可读，`out_signature` 必须至少可写 64 字节。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_consume_sign_response(
        handle: CitizenSdkHandle,
        text: CitizenSdkBytesView,
        out_signature: *mut u8,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            require_output(out_signature, "out_signature")?;
            let QrCode::SignResponse(response) =
                parse(&qr_text(text, "sign response")?).map_err(map_qr_error)?
            else {
                return Err(FfiError::invalid("二维码不是签名响应"));
            };
            let mut registry = lock_sessions()?;
            let owner = registry.get_mut(&handle).ok_or_else(|| {
                FfiError::new(CitizenSdkErrorCode::Conflict, "没有对应二维码请求会话")
            })?;
            if owner.default_changes.contains_key(&response.request_id) {
                return Err(FfiError::new(
                    CitizenSdkErrorCode::Conflict,
                    "默认账户会话只能由专用提交入口消费",
                ));
            }
            let store = owner.outbound.as_mut().ok_or_else(|| {
                FfiError::new(CitizenSdkErrorCode::Conflict, "没有对应二维码请求会话")
            })?;
            // 软件验签无宿主 await，短锁确保先验证、后消费、最后输出的原子顺序。
            let (_, signature) = futures_executor::block_on(
                store
                    .verify_and_consume_response(&citizen_signer::Sr25519SoftwareSigner, &response),
            )
            .map_err(map_qr_error)?;
            ptr::copy_nonoverlapping(signature.as_bytes().as_ptr(), out_signature, 64);
            Ok(())
        })
    }

    /// # Safety
    /// `request_id` 必须在调用期间可读，`out_cancelled` 必须至少可写 1 字节。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_cancel_sign_request(
        handle: CitizenSdkHandle,
        request_id: CitizenSdkBytesView,
        out_cancelled: *mut u8,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            require_output(out_cancelled, "out_cancelled")?;
            let request_id = String::from_utf8(copy_view(request_id, "request_id", 128)?)
                .map_err(|_| FfiError::invalid("request_id 必须是 UTF-8"))?;
            let cancelled = lock_sessions()?
                .get_mut(&handle)
                .and_then(|owner| owner.outbound.as_mut())
                .is_some_and(|store| store.cancel(&request_id));
            ptr::write(out_cancelled, u8::from(cancelled));
            Ok(())
        })
    }

    /// # Safety
    /// `account_id` 必须指向可读账户；`out_required` 及按容量提供的 `output`
    /// 必须指向有效可写内存。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_encode_account_id(
        handle: CitizenSdkHandle,
        account_id: *const CitizenSdkAccountId,
        output: *mut u8,
        output_capacity: u64,
        out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            runtime_with(handle, Modules::QR)?;
            if account_id.is_null() {
                return Err(FfiError::invalid("account_id 不能为空"));
            }
            let text = AccountIdCode {
                account_id: AccountId32::from_bytes(ptr::read(account_id).bytes),
            }
            .encode()
            .map_err(map_qr_error)?;
            copy_to_host(text.as_bytes(), output, output_capacity, out_required)
        })
    }


    /// 只调用同一Rust QR编码器；显式expires_at不因绑定往返重新计算。
    /// # Safety
    /// 输入及按容量提供的输出必须在本同步调用内有效。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_encode_document(
        handle: CitizenSdkHandle, input_json: CitizenSdkBytesView,
        buffer: *mut u8, capacity: u64, out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            let _runtime = runtime_with(handle, Modules::QR)?;
            let input = String::from_utf8(copy_view(input_json, "QR content", MAX_QR_JSON_BYTES)?)
                .map_err(|_| FfiError::invalid("二维码编码输入必须是UTF8"))?;
            let value = citizen_sdk_qr::encode_document(&input).map_err(map_qr_error)?;
            let json = encode_json(&value)?;
            copy_to_host(json.as_bytes(), buffer, capacity, out_required)
        })
    }

    /// 模板准备只返回公开字节与原因，不做签名、链查询或资格授权。
    /// # Safety
    /// 输入及按容量提供的输出必须在本同步调用内有效。
    #[no_mangle]
    pub unsafe extern "C" fn citizensdk_qr_prepare_account_authorization(
        handle: CitizenSdkHandle, action: u32, payload: CitizenSdkBytesView,
        account_id_utf8: CitizenSdkBytesView, buffer: *mut u8, capacity: u64, out_required: *mut u64,
    ) -> i32 {
        ffi_status(|| {
            let _runtime = runtime_with(handle, Modules::QR)?;
            let payload = copy_view(payload, "authorization payload", 1920)?;
            let account = String::from_utf8(copy_view(account_id_utf8, "account_id", 1024)?)
                .map_err(|_| FfiError::invalid("账户边界输入必须是UTF8"))?;
            let value = citizen_sdk_qr::prepare_account_authorization(action, &payload, &account);
            let json = encode_json(&value)?;
            copy_to_host(json.as_bytes(), buffer, capacity, out_required)
        })
    }
    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn cancellation_drains_pending_work_and_suppresses_its_late_success() {
            futures_executor::block_on(async {
                let (release, pending) = futures_channel::oneshot::channel::<()>();
                let (cancel, cancellation) = futures_channel::oneshot::channel();
                let cancelled = Arc::new(AtomicBool::new(false));
                let finished = Arc::new(AtomicBool::new(false));
                let completed = Arc::clone(&finished);
                let work = async move {
                    let _ = pending.await;
                    completed.store(true, Ordering::SeqCst);
                    Ok(17_u32)
                };
                let mut operation =
                    Box::pin(drain_cancel(work, cancellation, Arc::clone(&cancelled)));
                cancel.send(()).unwrap();
                assert!(futures_util::poll!(operation.as_mut()).is_pending());
                assert!(cancelled.load(Ordering::SeqCst));
                assert!(!finished.load(Ordering::SeqCst));
                release.send(()).unwrap();
                assert_eq!(
                    operation.await.unwrap_err().code,
                    CitizenSdkErrorCode::Cancelled
                );
                assert!(finished.load(Ordering::SeqCst));
            });
        }

        #[test]
        fn cancellation_before_work_is_visible_before_any_authentication() {
            futures_executor::block_on(async {
                let (cancel, cancellation) = futures_channel::oneshot::channel();
                let cancelled = Arc::new(AtomicBool::new(false));
                let token = Arc::clone(&cancelled);
                cancel.send(()).unwrap();
                let work = async move {
                    assert!(token.load(Ordering::SeqCst));
                    Ok(())
                };
                assert_eq!(
                    drain_cancel(work, cancellation, cancelled)
                        .await
                        .unwrap_err()
                        .code,
                    CitizenSdkErrorCode::Cancelled
                );
            });
        }

        #[test]
        fn expiry_and_cancel_guards_never_accept_a_caller_clock() {
            let request = SignRequest {
                request_id: "0123456789abcdef".into(),
                expires_at: 1,
                action: 0x0400,
                signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
                review_payload: vec![4, 0, 3],
            };
            assert!(
                matches!(ensure_current(&request, &AtomicBool::new(false)), Err(EngineError::Contract(error)) if error.code() == ContractErrorCode::Timeout)
            );
            assert_eq!(
                ensure_current(&request, &AtomicBool::new(true)),
                Err(EngineError::Cancelled)
            );
        }

        #[test]
        fn review_claim_is_once_only_even_after_reparsing_and_is_bounded_per_owner() {
            let owner = u64::MAX - 901;
            let mut request = SignRequest {
                request_id: "0123456789abcdef".into(),
                expires_at: SystemQrClock.now_epoch_seconds() + 300,
                action: 0x0400,
                signer_public_key: Some(Sr25519PublicKey::from_bytes([7; 32])),
                review_payload: vec![4, 0, 3],
            };
            let claimed = AtomicBool::new(false);
            claim_signing_request(owner, &request, &claimed).unwrap();
            assert_eq!(
                claim_signing_request(owner, &request, &claimed)
                    .unwrap_err()
                    .code,
                CitizenSdkErrorCode::Conflict
            );
            let reparsed_claim = AtomicBool::new(false);
            assert_eq!(
                claim_signing_request(owner, &request, &reparsed_claim)
                    .unwrap_err()
                    .code,
                CitizenSdkErrorCode::Conflict
            );
            assert!(!reparsed_claim.load(Ordering::SeqCst));
            for id in 1..64 {
                request.request_id = format!("request_number_{id:03}");
                claim_signing_request(owner, &request, &AtomicBool::new(false)).unwrap();
            }
            request.request_id = "request_number_064".into();
            assert_eq!(
                claim_signing_request(owner, &request, &AtomicBool::new(false))
                    .unwrap_err()
                    .code,
                CitizenSdkErrorCode::Busy
            );
            // 同一文本在另一实例不是同一个消费者会话；结果句柄另有 owner 门。
            claim_signing_request(owner - 1, &request, &AtomicBool::new(false)).unwrap();
            drop_sessions_for_owner(owner);
            drop_sessions_for_owner(owner - 1);
        }

        #[test]
        fn qr_result_copy_is_typed_bounded_and_invalid_after_release() {
            use crate::ownership::OwnedResult;
            let result = ownership::reserve(u64::MAX - 903)
                .unwrap()
                .commit(OwnedResult::success(
                    u64::MAX - 903,
                    ResultPayload::QrSigned("{\"kind\":2}".to_owned()),
                ))
                .unwrap();
            let mut required = 0;
            assert_eq!(
                unsafe {
                    citizensdk_result_copy_qr(result, std::ptr::null_mut(), 0, &mut required)
                },
                CitizenSdkErrorCode::Ok.as_i32()
            );
            assert_eq!(required, 10);
            let mut buffer = [0xa5; 2];
            assert_eq!(
                unsafe { citizensdk_result_copy_qr(result, buffer.as_mut_ptr(), 2, &mut required) },
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            assert_eq!(buffer, [0xa5; 2]);
            ownership::release(result).unwrap();
            assert_eq!(
                unsafe {
                    citizensdk_result_copy_qr(result, std::ptr::null_mut(), 0, &mut required)
                },
                CitizenSdkErrorCode::InvalidHandle.as_i32()
            );
            let wrong = ownership::reserve(u64::MAX - 903)
                .unwrap()
                .commit(OwnedResult::success(u64::MAX - 903, ResultPayload::Empty))
                .unwrap();
            assert_eq!(
                unsafe { citizensdk_result_copy_qr(wrong, std::ptr::null_mut(), 0, &mut required) },
                CitizenSdkErrorCode::InvalidArgument.as_i32()
            );
            ownership::release(wrong).unwrap();
        }
    }
}

#[cfg(feature = "qr")]
pub use enabled::*;
#[cfg(feature = "qr")]
pub(crate) use enabled::{
    cancel_unified_signing_session, consume_default_account_qr_session,
    consume_external_qr_session, create_default_account_qr_session, create_external_qr_session,
    drop_sessions_for_owner, external_qr_session_pending, QrReviewResult,
};

// 裁剪构建保留精确同一 ABI；不解析指针、不加载 QR/链/钱包依赖，统一明确拒绝。
#[cfg(not(feature = "qr"))]
use crate::abi::{
    CitizenSdkAccountId, CitizenSdkBytesView, CitizenSdkHandle, CitizenSdkRequestId,
    CitizenSdkResultHandle,
};
#[cfg(not(feature = "qr"))]
macro_rules! qr_unavailable {
    ($name:ident($($argument:ident: $kind:ty),*)) => {
        #[no_mangle]
        pub unsafe extern "C" fn $name($($argument: $kind),*) -> i32 {
            let _ = ($($argument),*);
            crate::ffi_status(|| Err(crate::error::FfiError::new(crate::abi::CitizenSdkErrorCode::Unsupported, "当前构建没有二维码模块")))
        }
    };
}
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_parse(handle: CitizenSdkHandle, text: CitizenSdkBytesView, output: *mut u8, output_capacity: u64, out_required: *mut u64));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_create_sign_request(handle: CitizenSdkHandle, action: u16, account: *const CitizenSdkAccountId, payload: CitizenSdkBytesView, ttl: u64, output: *mut u8, capacity: u64, required: *mut u64));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_review_qr_sign_request(handle: CitizenSdkHandle, text: CitizenSdkBytesView, request: *mut CitizenSdkRequestId));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_sign_qr_request(handle: CitizenSdkHandle, review: CitizenSdkResultHandle, request: *mut CitizenSdkRequestId));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_result_copy_qr(result: CitizenSdkResultHandle, output: *mut u8, capacity: u64, required: *mut u64));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_validate_sign_response(handle: CitizenSdkHandle, session_id: CitizenSdkBytesView, text: CitizenSdkBytesView));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_consume_sign_response(handle: CitizenSdkHandle, text: CitizenSdkBytesView, signature: *mut u8));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_cancel_sign_request(handle: CitizenSdkHandle, request: CitizenSdkBytesView, cancelled: *mut u8));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_encode_account_id(handle: CitizenSdkHandle, account: *const CitizenSdkAccountId, output: *mut u8, capacity: u64, required: *mut u64));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_encode_document(handle: CitizenSdkHandle, input: CitizenSdkBytesView, output: *mut u8, capacity: u64, required: *mut u64));
#[cfg(not(feature = "qr"))]
qr_unavailable!(citizensdk_qr_prepare_account_authorization(handle: CitizenSdkHandle, action: u32, payload: CitizenSdkBytesView, account: CitizenSdkBytesView, output: *mut u8, capacity: u64, required: *mut u64));
