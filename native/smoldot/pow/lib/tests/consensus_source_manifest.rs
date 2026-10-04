//! 固定本阶段链头、终局性和验证原语的 26 个来源文件。
//!
//! `include_bytes` 在后续编译测试时要求每个文件存在；逐字节 SHA-256 由
//! 塔塔文档库中的 CitizenSDK 来源记录和导入审计共同记录。

const REQUIRED_FILES: [(&str, &[u8]); 26] = [
    ("src/chain.rs", include_bytes!("../src/chain.rs")),
    ("src/finality.rs", include_bytes!("../src/finality.rs")),
    ("src/header.rs", include_bytes!("../src/header.rs")),
    ("src/verify.rs", include_bytes!("../src/verify.rs")),
    (
        "src/chain/async_tree.rs",
        include_bytes!("../src/chain/async_tree.rs"),
    ),
    (
        "src/chain/blocks_tree.rs",
        include_bytes!("../src/chain/blocks_tree.rs"),
    ),
    (
        "src/chain/blocks_tree/finality.rs",
        include_bytes!("../src/chain/blocks_tree/finality.rs"),
    ),
    (
        "src/chain/blocks_tree/tests.rs",
        include_bytes!("../src/chain/blocks_tree/tests.rs"),
    ),
    (
        "src/chain/blocks_tree/verify.rs",
        include_bytes!("../src/chain/blocks_tree/verify.rs"),
    ),
    (
        "src/chain/chain_information.rs",
        include_bytes!("../src/chain/chain_information.rs"),
    ),
    (
        "src/chain/chain_information/build.rs",
        include_bytes!("../src/chain/chain_information/build.rs"),
    ),
    (
        "src/chain/fork_tree.rs",
        include_bytes!("../src/chain/fork_tree.rs"),
    ),
    (
        "src/finality/decode.rs",
        include_bytes!("../src/finality/decode.rs"),
    ),
    (
        "src/finality/verify.rs",
        include_bytes!("../src/finality/verify.rs"),
    ),
    (
        "src/header/aura.rs",
        include_bytes!("../src/header/aura.rs"),
    ),
    (
        "src/header/babe.rs",
        include_bytes!("../src/header/babe.rs"),
    ),
    (
        "src/header/grandpa.rs",
        include_bytes!("../src/header/grandpa.rs"),
    ),
    (
        "src/header/tests.rs",
        include_bytes!("../src/header/tests.rs"),
    ),
    (
        "src/header/tests/header-kusama-7472481",
        include_bytes!("../src/header/tests/header-kusama-7472481"),
    ),
    (
        "src/header/tests/header-polkadot-512271",
        include_bytes!("../src/header/tests/header-polkadot-512271"),
    ),
    (
        "src/verify/aura.rs",
        include_bytes!("../src/verify/aura.rs"),
    ),
    (
        "src/verify/babe.rs",
        include_bytes!("../src/verify/babe.rs"),
    ),
    (
        "src/verify/body_only.rs",
        include_bytes!("../src/verify/body_only.rs"),
    ),
    (
        "src/verify/header_only.rs",
        include_bytes!("../src/verify/header_only.rs"),
    ),
    (
        "src/verify/inherents.rs",
        include_bytes!("../src/verify/inherents.rs"),
    ),
    ("src/verify/pow.rs", include_bytes!("../src/verify/pow.rs")),
];

#[test]
fn all_consensus_source_files_are_present_and_non_empty() {
    for (path, content) in REQUIRED_FILES {
        assert!(!content.is_empty(), "链共识来源文件为空: {path}");
    }
}
