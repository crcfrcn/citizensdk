use crate::types::BlockFinality;
use crate::types::ContractErrorCode;
use crate::types::RuntimeContext;
use crate::types::VerifiedBlockRef;

use crate::error::EngineError;

/// Maximum exact-block runtime contexts retained in process memory.
///
/// Eviction is deterministic FIFO while protecting the current best context.
/// An evicted block is fetched and validated again if requested later.
pub const MAX_RUNTIME_CONTEXTS: usize = 64;
// 条数和metadata总字节同时受限，不改变合法读取结果的大小合同。
const MAX_RUNTIME_CONTEXT_BYTES: usize = 64 * 1024 * 1024;

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
            let size = context.metadata().len();
            let advances_best = request.block.finality() == BlockFinality::Best
                && self.latest_best_request == Some(request.sequence);
            // 当前best仍保留；新best可以替换旧best。放不下的其他合法结果直接返回、不缓存。
            while self.contexts.len() >= MAX_RUNTIME_CONTEXTS
                || self
                    .contexts
                    .iter()
                    .map(|value| value.metadata().len())
                    .sum::<usize>()
                    > MAX_RUNTIME_CONTEXT_BYTES.saturating_sub(size)
            {
                let Some(eviction) = self.contexts.iter().position(|existing| {
                    advances_best || Some(existing.block()) != self.current_best
                }) else {
                    return Ok(context);
                };
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
#[path = "../tests/context.rs"]
mod tests;
