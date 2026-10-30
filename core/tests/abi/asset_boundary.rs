// This black-box test intentionally crosses the exported raw-pointer ABI.
#![allow(unsafe_code)]
// 此黑盒夹具验证真实链资产；纯本地模块不读取这些资产。
#![cfg(feature = "chain")]

mod resources;
use citizensdk::abi::citizensdk_create;
use citizensdk::abi::citizensdk_destroy;
use citizensdk::abi::CitizenSdkBytesView;
use citizensdk::abi::CitizenSdkCreateOptions;
use citizensdk::abi::CitizenSdkErrorCode;
use citizensdk::abi::CitizenSdkHandle;
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

fn options(chain_spec: &[u8]) -> CitizenSdkCreateOptions {
    CitizenSdkCreateOptions {
        struct_size: std::mem::size_of::<CitizenSdkCreateOptions>() as u32,
        abi_version: CITIZENSDK_ABI_VERSION,
        asset_manifest: view(MANIFEST),
        chain_spec: view(chain_spec),
        light_sync_state: view(LIGHT_STATE),
        system_name: view(b"CitizenSDK-test"),
        system_version: view(b"1.0.0"),
    }
}

#[test]
fn assets_are_reverified_before_instance_creation() {
    let resources = resources::Resources::new(citizensdk::types::Modules::CHAIN);
    let mut drifted = CHAIN_SPEC.to_vec();
    drifted.push(b' ');
    let mut handle: CitizenSdkHandle = 0;
    // SAFETY: all views remain alive for the synchronous create call.
    let drift_code = unsafe {
        citizensdk_create(
            &options(&drifted),
            citizensdk::types::Modules::CHAIN,
            &resources.config(),
            &mut handle,
        )
    };
    assert_eq!(drift_code, CitizenSdkErrorCode::Integrity.as_i32());
    assert_eq!(handle, 0);

    // SAFETY: packaged static views and output pointer are valid.
    let code = unsafe {
        citizensdk_create(
            &options(CHAIN_SPEC),
            citizensdk::types::Modules::CHAIN,
            &resources.config(),
            &mut handle,
        )
    };
    assert_eq!(code, CitizenSdkErrorCode::Ok.as_i32());
    assert_ne!(handle, 0);
    // SAFETY: handle was returned by create and has no requests/results.
    assert_eq!(
        unsafe { citizensdk_destroy(handle) },
        CitizenSdkErrorCode::Ok.as_i32()
    );
}
