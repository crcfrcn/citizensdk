//! 固定 light-base 来源快照的 18 个必需文件。
//!
//! include_bytes 在编译测试时直接要求每个文件存在；逐字节 SHA-256 由
//! 塔塔文档库中的 CitizenSDK 来源记录和导入审计共同记录。

const REQUIRED_FILES: [(&str, &[u8]); 18] = [
    ("Cargo.toml", include_bytes!("../Cargo.toml")),
    ("examples/basic.rs", include_bytes!("../examples/basic.rs")),
    ("src/database.rs", include_bytes!("../src/database.rs")),
    (
        "src/json_rpc_service.rs",
        include_bytes!("../src/json_rpc_service.rs"),
    ),
    (
        "src/json_rpc_service/background.rs",
        include_bytes!("../src/json_rpc_service/background.rs"),
    ),
    ("src/lib.rs", include_bytes!("../src/lib.rs")),
    (
        "src/network_service.rs",
        include_bytes!("../src/network_service.rs"),
    ),
    (
        "src/network_service/tasks.rs",
        include_bytes!("../src/network_service/tasks.rs"),
    ),
    ("src/platform.rs", include_bytes!("../src/platform.rs")),
    (
        "src/platform/address_parse.rs",
        include_bytes!("../src/platform/address_parse.rs"),
    ),
    (
        "src/platform/default.rs",
        include_bytes!("../src/platform/default.rs"),
    ),
    (
        "src/platform/with_prefix.rs",
        include_bytes!("../src/platform/with_prefix.rs"),
    ),
    (
        "src/runtime_service.rs",
        include_bytes!("../src/runtime_service.rs"),
    ),
    (
        "src/sync_service.rs",
        include_bytes!("../src/sync_service.rs"),
    ),
    (
        "src/sync_service/parachain.rs",
        include_bytes!("../src/sync_service/parachain.rs"),
    ),
    (
        "src/sync_service/standalone.rs",
        include_bytes!("../src/sync_service/standalone.rs"),
    ),
    (
        "src/transactions_service.rs",
        include_bytes!("../src/transactions_service.rs"),
    ),
    ("src/util.rs", include_bytes!("../src/util.rs")),
];

#[test]
fn all_required_upstream_files_are_present_and_non_empty() {
    for (path, content) in REQUIRED_FILES {
        assert!(!content.is_empty(), "light-base 来源文件为空: {path}");
    }
}
