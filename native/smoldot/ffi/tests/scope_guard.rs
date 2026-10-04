//! 防止已剥离的产品功能重新进入 CitizenSDK 原生边界。

const MANIFEST: &str = include_str!("../Cargo.toml");
const LIB_SOURCE: &str = include_str!("../src/lib.rs");
const NODE_HEADER: &str = include_str!("../../include/smoldot.h");
const PROVIDER_PUBLIC_SOURCE: &str = include_str!("../../provider/src/lib.rs");

#[test]
fn forbidden_product_capabilities_are_absent() {
    for forbidden in ["chat_mls", "openmls", "account_crypto", "account-crypto"] {
        assert!(
            !MANIFEST.contains(forbidden),
            "Cargo.toml 重新引入了禁止依赖: {forbidden}"
        );
        assert!(
            !LIB_SOURCE.contains(forbidden),
            "lib.rs 重新引入了禁止模块: {forbidden}"
        );
        assert!(
            !NODE_HEADER.contains(forbidden),
            "smoldot.h 重新公开了禁止接口: {forbidden}"
        );
    }
}

#[test]
fn typed_provider_does_not_publish_arbitrary_rpc_or_legacy_abi() {
    assert!(!PROVIDER_PUBLIC_SOURCE.contains("pub fn rpc"));
    assert!(!PROVIDER_PUBLIC_SOURCE.contains("extern \"C\""));
    assert!(!NODE_HEADER.contains("citizensdk_"));
}
