use citizen_sdk_contracts::{BlockFinality, ContractErrorCode, RuntimeContext, VerifiedBlockRef};

use crate::error::EngineError;

/// Maximum exact-block runtime contexts retained in process memory.
///
/// Eviction is deterministic FIFO while protecting the current best context.
/// An evicted block is fetched and validated again if requested later.
pub const MAX_RUNTIME_CONTEXTS: usize = 64;

/// Opaque request identity used to keep late in-flight completions from
/// replacing a newer best-head runtime context.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RuntimeContextRequest {
    block: VerifiedBlockRef,
    sequence: u64,
}

impl RuntimeContextRequest {
    pub const fn block(self) -> VerifiedBlockRef {
        self.block
    }
}

/// Exact-block runtime cache. Entries are immutable for their verified block;
/// `current_best` is advanced only by the latest request identity.
#[derive(Debug, Default)]
pub struct RuntimeContextCache {
    next_sequence: u64,
    latest_best_request: Option<u64>,
    current_best: Option<VerifiedBlockRef>,
    contexts: Vec<RuntimeContext>,
}

impl RuntimeContextCache {
    pub const fn new() -> Self {
        Self {
            next_sequence: 0,
            latest_best_request: None,
            current_best: None,
            contexts: Vec::new(),
        }
    }

    pub fn begin(&mut self, block: VerifiedBlockRef) -> Result<RuntimeContextRequest, EngineError> {
        let sequence = self.next_sequence;
        let next_sequence = sequence.checked_add(1).ok_or_else(|| {
            EngineError::contract(
                ContractErrorCode::Internal,
                "runtime context request sequence exhausted",
            )
        })?;
        self.next_sequence = next_sequence;
        if block.finality() == BlockFinality::Best {
            self.latest_best_request = Some(sequence);
        }
        Ok(RuntimeContextRequest { block, sequence })
    }

    pub fn complete(
        &mut self,
        request: RuntimeContextRequest,
        context: RuntimeContext,
    ) -> Result<RuntimeContext, EngineError> {
        // A block's metadata is immutable when the same hash/height advances
        // from best to finalized. Rebind only that verified finality marker;
        // any hash or height difference remains a hard context error.
        let context = if context.block() == request.block {
            context
        } else if context.block().hash() == request.block.hash()
            && context.block().number() == request.block.number()
        {
            RuntimeContext::try_new(
                request.block,
                context.version(),
                context.metadata().to_vec(),
            )
            .map_err(EngineError::from)?
        } else {
            return Err(EngineError::BlockContextMismatch(
                "runtime context does not match its request block".to_owned(),
            ));
        };
        if self.contexts.iter().any(|existing| {
            existing.block().hash() == context.block().hash()
                && existing.block().number() != context.block().number()
        }) {
            return Err(EngineError::BlockContextMismatch(
                "one block hash was associated with multiple heights".to_owned(),
            ));
        }
        if self.contexts.iter().any(|existing| {
            existing.block().hash() == context.block().hash()
                && existing.block().number() == context.block().number()
                && (existing.version() != context.version()
                    || existing.metadata() != context.metadata())
        }) {
            return Err(EngineError::BlockContextMismatch(
                "runtime context changed while one block advanced finality".to_owned(),
            ));
        }
        if let Some(existing) = self
            .contexts
            .iter()
            .find(|existing| existing.block() == context.block())
        {
            if existing != &context {
                return Err(EngineError::BlockContextMismatch(
                    "runtime context changed for an immutable block".to_owned(),
                ));
            }
        } else {
            if self.contexts.len() == MAX_RUNTIME_CONTEXTS {
                let eviction = self
                    .contexts
                    .iter()
                    .position(|existing| Some(existing.block()) != self.current_best)
                    .ok_or_else(|| {
                        EngineError::contract(
                            ContractErrorCode::Internal,
                            "runtime context cache has no safe eviction candidate",
                        )
                    })?;
                self.contexts.remove(eviction);
            }
            self.contexts.push(context.clone());
        }

        if request.block.finality() == BlockFinality::Best
            && self.latest_best_request == Some(request.sequence)
        {
            self.current_best = Some(request.block);
        }
        Ok(context)
    }

    pub fn get(&self, block: VerifiedBlockRef) -> Option<&RuntimeContext> {
        self.contexts
            .iter()
            .find(|context| context.block() == block)
    }

    pub fn current_best(&self) -> Option<&RuntimeContext> {
        let block = self.current_best?;
        self.get(block)
    }

    /// 只失效可变 best 指针，保留准确块的不可变 metadata 缓存。
    pub fn invalidate_current_best(&mut self) {
        self.current_best = None;
        self.latest_best_request = None;
    }
}

#[cfg(test)]
mod tests {
    use citizen_sdk_contracts::{
        ContractErrorCode, Hash32, RuntimeContext, RuntimeVersion, VerifiedBlockRef,
    };

    use super::{RuntimeContextCache, MAX_RUNTIME_CONTEXTS};
    use crate::EngineError;

    #[test]
    #[allow(clippy::expect_used)]
    fn invalidation_rejects_late_best_completion_but_keeps_exact_context() {
        let block = VerifiedBlockRef::best(Hash32::from_bytes([1; 32]), 1);
        let mut cache = RuntimeContextCache::new();
        let request = cache.begin(block).expect("request");
        cache.invalidate_current_best();
        let context =
            RuntimeContext::try_new(block, RuntimeVersion::new(1, 1), vec![1]).expect("context");
        cache
            .complete(request, context.clone())
            .expect("exact context");
        assert!(cache.current_best().is_none());
        assert_eq!(cache.get(block), Some(&context));
    }

    #[test]
    fn request_sequence_exhaustion_is_permanent_and_never_reuses_identity() {
        let mut cache = RuntimeContextCache::new();
        cache.next_sequence = u64::MAX - 1;
        let block = VerifiedBlockRef::best(Hash32::from_bytes([0x7f; 32]), 7);
        let last = cache
            .begin(block)
            .unwrap_or_else(|error| panic!("last request failed: {error}"));
        assert_eq!(last.sequence, u64::MAX - 1);
        assert_eq!(cache.latest_best_request, Some(u64::MAX - 1));

        for _ in 0..2 {
            let error = cache
                .begin(block)
                .err()
                .unwrap_or_else(|| panic!("exhausted sequence must fail"));
            match error {
                EngineError::Contract(error) => {
                    assert_eq!(error.code(), ContractErrorCode::Internal)
                }
                other => panic!("unexpected exhaustion error: {other}"),
            }
            assert_eq!(cache.next_sequence, u64::MAX);
            assert_eq!(cache.latest_best_request, Some(u64::MAX - 1));
        }
    }

    #[test]
    fn runtime_contexts_are_bounded_and_current_best_is_not_evicted() {
        let mut cache = RuntimeContextCache::new();
        let protected = VerifiedBlockRef::best(Hash32::from_bytes([0xff; 32]), 1);
        let protected_request = cache
            .begin(protected)
            .unwrap_or_else(|error| panic!("protected request failed: {error}"));
        let protected_context =
            RuntimeContext::try_new(protected, RuntimeVersion::new(1, 1), vec![0xff])
                .unwrap_or_else(|error| panic!("protected context failed: {error}"));
        cache
            .complete(protected_request, protected_context)
            .unwrap_or_else(|error| panic!("protected completion failed: {error}"));

        for index in 0..(MAX_RUNTIME_CONTEXTS + 16) {
            let number = u64::try_from(index + 2)
                .unwrap_or_else(|error| panic!("height conversion failed: {error}"));
            let marker = u8::try_from(index + 2)
                .unwrap_or_else(|error| panic!("marker conversion failed: {error}"));
            let block = VerifiedBlockRef::finalized(Hash32::from_bytes([marker; 32]), number);
            let request = cache
                .begin(block)
                .unwrap_or_else(|error| panic!("request failed: {error}"));
            let context = RuntimeContext::try_new(
                block,
                RuntimeVersion::new(marker.into(), marker.into()),
                vec![marker],
            )
            .unwrap_or_else(|error| panic!("context failed: {error}"));
            cache
                .complete(request, context)
                .unwrap_or_else(|error| panic!("completion failed: {error}"));
        }

        assert_eq!(cache.contexts.len(), MAX_RUNTIME_CONTEXTS);
        assert!(cache.get(protected).is_some());
        assert_eq!(
            cache.current_best().map(RuntimeContext::block),
            Some(protected)
        );
        let first_evicted = VerifiedBlockRef::finalized(Hash32::from_bytes([0x02; 32]), 2);
        assert!(cache.get(first_evicted).is_none());
    }
}
