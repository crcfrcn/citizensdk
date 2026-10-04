use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use crate::{
    abi::{CitizenSdkErrorCode, CitizenSdkHandle},
    error::{FfiError, FfiResult},
    runtime::NativeRuntime,
};

static NEXT_INSTANCE: AtomicU64 = AtomicU64::new(1);
static INSTANCES: OnceLock<Mutex<HashMap<CitizenSdkHandle, Arc<NativeRuntime>>>> = OnceLock::new();

fn instances() -> &'static Mutex<HashMap<CitizenSdkHandle, Arc<NativeRuntime>>> {
    INSTANCES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn reserve_handle() -> FfiResult<CitizenSdkHandle> {
    NEXT_INSTANCE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_add(1).filter(|next| *next != 0)
        })
        .map_err(|_| FfiError::internal("instance handle space is exhausted"))
}

pub fn insert(runtime: Arc<NativeRuntime>) -> FfiResult<()> {
    let mut registry = instances()
        .lock()
        .map_err(|_| FfiError::internal("instance registry is poisoned"))?;
    if registry.insert(runtime.handle(), runtime).is_some() {
        return Err(FfiError::internal("instance handle collision"));
    }
    Ok(())
}

pub fn get(handle: CitizenSdkHandle) -> FfiResult<Arc<NativeRuntime>> {
    if handle == 0 {
        return Err(invalid_handle());
    }
    instances()
        .lock()
        .map_err(|_| FfiError::internal("instance registry is poisoned"))?
        .get(&handle)
        .cloned()
        .ok_or_else(invalid_handle)
}

pub fn remove(handle: CitizenSdkHandle, expected: &Arc<NativeRuntime>) -> FfiResult<()> {
    let mut registry = instances()
        .lock()
        .map_err(|_| FfiError::internal("instance registry is poisoned"))?;
    let Some(current) = registry.get(&handle) else {
        return Err(invalid_handle());
    };
    if !Arc::ptr_eq(current, expected) {
        return Err(invalid_handle());
    }
    registry.remove(&handle);
    Ok(())
}

fn invalid_handle() -> FfiError {
    FfiError::new(
        CitizenSdkErrorCode::InvalidHandle,
        "CitizenSDK instance handle is invalid",
    )
}
