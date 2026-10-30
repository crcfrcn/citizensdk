// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
// 本黑盒实例夹具只组合真实 chain；不隐式要求交易或本地金库。
#![cfg(feature = "chain")]

mod resources;
use citizensdk::abi::citizensdk_create;
use citizensdk::abi::citizensdk_destroy;
use citizensdk::abi::CitizenSdkBytesView;
use citizensdk::abi::CitizenSdkCreateOptions;
use citizensdk::abi::CitizenSdkErrorCode;
use citizensdk::abi::CITIZENSDK_ABI_VERSION;
use citizensdk::{abi, store, types};

const MANIFEST: &[u8] = include_bytes!("../../../chain/manifest.json");
const CHAIN_SPEC: &[u8] = include_bytes!("../../../chain/chainspec.json");
const LIGHT_STATE: &[u8] = include_bytes!("../../../chain/light_sync_state.json");

fn view(bytes: &[u8]) -> CitizenSdkBytesView {
    CitizenSdkBytesView {
        data: bytes.as_ptr(),
        len: bytes.len() as u64,
    }
}

fn options() -> CitizenSdkCreateOptions {
    CitizenSdkCreateOptions {
        struct_size: std::mem::size_of::<CitizenSdkCreateOptions>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        asset_manifest: view(MANIFEST),
        chain_spec: view(CHAIN_SPEC),
        light_sync_state: view(LIGHT_STATE),
        system_name: view(b"CitizenSDK-test"),
        system_version: view(b"1.0.0"),
    }
}

#[test]
fn instance_handles_are_nonzero_monotonic_and_never_reused() {
    let resources = resources::Resources::new(citizensdk::types::Modules::CHAIN);
    let mut first = 0;
    let mut second = 0;
    assert_eq!(
        unsafe {
            citizensdk_create(
                &options(),
                citizensdk::types::Modules::CHAIN,
                &resources.config(),
                &mut first,
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe {
            citizensdk_create(
                &options(),
                citizensdk::types::Modules::CHAIN,
                &resources.config(),
                &mut second,
            )
        },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_ne!(first, 0);
    assert!(second > first);
    assert_eq!(
        unsafe { citizensdk_destroy(first) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_destroy(first) },
        CitizenSdkErrorCode::InvalidHandle.as_i32()
    );
    assert_eq!(
        unsafe { citizensdk_destroy(second) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
}
