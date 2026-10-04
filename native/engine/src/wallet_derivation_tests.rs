//! 已验证 Dart 钱包向量与 Rust 无根热钱包派生边界的差分测试。
//!
//! 测试直接读取仓库内冻结 JSON 金标，防止助记词 password 规范、BIP-39、`//index`
//! junction、sr25519 公钥或 CitizenChain SS58 任一环节静默漂移。

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::sync::Arc;

use crate::{
    error::EngineError,
    wallet_derivation::{
        derive_wallet_accounts, generate_mnemonic, validate_wallet_password, WalletEntropySource,
        WalletWordCount,
    },
};
use citizen_sdk_contracts::{
    citizen_ss58_address, ContractErrorCode, SecretBuffer, MAX_WALLET_ACCOUNT_INDEX,
};
use citizen_signer::Sr25519SoftwareSigner;
use futures::executor::block_on;
use serde_json::Value;

const DERIVATION_GOLDEN: &str =
    include_str!("../../../test/wallet/citizenchain-wallet-derivation-v1.json");
const PASSWORD_GOLDEN: &str =
    include_str!("../../../test/wallet/citizenchain-wallet-password-v1.json");

#[derive(Debug)]
struct FixedEntropy(Vec<u8>);

impl WalletEntropySource for FixedEntropy {
    fn fill(&self, output: &mut [u8]) -> citizen_sdk_contracts::ContractResult<()> {
        assert_eq!(output.len(), self.0.len(), "测试熵长度必须精确匹配");
        output.copy_from_slice(&self.0);
        Ok(())
    }
}

#[test]
fn frozen_json_derivation_vectors_match_every_secret_public_key_and_ss58() {
    let golden: Value = serde_json::from_str(DERIVATION_GOLDEN).expect("派生金标必须是有效 JSON");
    assert_eq!(golden["format_version"], 1);
    assert_eq!(golden["chain_id"], "citizenchain");
    assert_eq!(golden["algorithm"], "sr25519");
    assert_eq!(golden["signing_context"], "substrate");
    assert_eq!(golden["ss58_prefix"], 2027);

    let mnemonic = SecretBuffer::try_new(
        golden["mnemonic"]
            .as_str()
            .expect("金标 mnemonic")
            .as_bytes()
            .to_vec(),
    )
    .expect("金标助记词非空");
    let signer = Arc::new(Sr25519SoftwareSigner);

    for case in golden["cases"].as_array().expect("金标 cases") {
        let password = case["password"].as_str().expect("金标 password");
        let expected = case["accounts"].as_array().expect("金标 accounts");
        let indices: Vec<u32> = expected
            .iter()
            .map(|account| {
                u32::try_from(account["index"].as_u64().expect("金标 index"))
                    .expect("金标 index 位于 u32")
            })
            .collect();
        let derived = block_on(derive_wallet_accounts(
            signer.clone(),
            &mnemonic,
            password,
            &indices,
        ))
        .expect("冻结向量必须可派生");

        assert_eq!(derived.len(), expected.len());
        for (actual, expected) in derived.into_iter().zip(expected) {
            let expected_public =
                decode_fixed_hex::<32>(expected["account_id"].as_str().expect("金标 account_id"));
            let expected_secret = decode_fixed_hex::<32>(
                expected["child_mini_secret"]
                    .as_str()
                    .expect("金标 child_mini_secret"),
            );
            assert_eq!(actual.index(), expected["index"].as_u64().unwrap() as u32);
            assert_eq!(actual.public_key().as_bytes(), &expected_public);
            if let Some(ss58) = expected.get("ss58").and_then(Value::as_str) {
                assert_eq!(
                    citizen_ss58_address(citizen_sdk_contracts::AccountId32::from_bytes(
                        expected_public,
                    )),
                    ss58
                );
            }
            let secret = actual.into_secret();
            secret.with_secret(|bytes| assert_eq!(bytes, expected_secret));
        }
    }
}

#[test]
fn frozen_json_password_contract_matches_acceptance_and_nfkd() {
    let golden: Value =
        serde_json::from_str(PASSWORD_GOLDEN).expect("password 金标必须是有效 JSON");
    assert_eq!(golden["format_version"], 1);
    assert_eq!(golden["normalization"], "NFKD");
    assert_eq!(golden["minimum_graphemes"], 6);
    assert_eq!(golden["maximum_graphemes"], 30);

    for accepted in golden["accepted"].as_array().expect("accepted 数组") {
        let raw = accepted["raw"].as_str().expect("accepted.raw");
        let normalized = accepted["normalized"]
            .as_str()
            .expect("accepted.normalized");
        assert_eq!(
            validate_wallet_password(raw)
                .unwrap_or_else(|error| panic!("应接受 password {raw:?}: {error}"))
                .as_str(),
            normalized
        );
    }
    for rejected in golden["rejected"].as_array().expect("rejected 数组") {
        let raw = rejected.as_str().expect("rejected 字符串");
        assert_contract_code(
            validate_wallet_password(raw).expect_err("冻结拒绝向量不得被接受"),
            ContractErrorCode::InvalidArgument,
        );
    }
}

#[test]
fn mnemonic_generation_and_index_validation_keep_the_public_boundary_narrow() {
    let twelve = generate_mnemonic(&FixedEntropy(vec![0; 16]), WalletWordCount::Words12)
        .expect("16 字节熵应生成 12 词");
    twelve.with_secret(|bytes| {
        assert_eq!(
            std::str::from_utf8(bytes)
                .unwrap()
                .split_whitespace()
                .count(),
            12
        )
    });

    let eighteen = generate_mnemonic(&FixedEntropy(vec![0; 24]), WalletWordCount::Words18)
        .expect("24 字节熵应生成 18 词");
    eighteen.with_secret(|bytes| {
        assert_eq!(
            std::str::from_utf8(bytes)
                .unwrap()
                .split_whitespace()
                .count(),
            18
        )
    });
    let eighteen_accounts = block_on(derive_wallet_accounts(
        Arc::new(Sr25519SoftwareSigner),
        &eighteen,
        "",
        &[0, 1, 1989],
    ))
    .expect("18 词必须支持恢复和派生");
    assert_eq!(eighteen_accounts.len(), 3);
    let protected = block_on(derive_wallet_accounts(
        Arc::new(Sr25519SoftwareSigner),
        &eighteen,
        "abcdef",
        &[0],
    ))
    .expect("18 词支持非空派生密码");
    assert_ne!(eighteen_accounts[0].public_key(), protected[0].public_key());

    let twenty_four = generate_mnemonic(&FixedEntropy(vec![0; 32]), WalletWordCount::Words24)
        .expect("32 字节熵应生成 24 词");
    twenty_four.with_secret(|bytes| {
        assert_eq!(
            std::str::from_utf8(bytes)
                .unwrap()
                .split_whitespace()
                .count(),
            24
        )
    });

    let signer = Arc::new(Sr25519SoftwareSigner);
    assert_contract_code(
        block_on(derive_wallet_accounts(signer.clone(), &twelve, "", &[]))
            .expect_err("空 index 列表必须拒绝"),
        ContractErrorCode::InvalidArgument,
    );
    assert_contract_code(
        block_on(derive_wallet_accounts(signer.clone(), &twelve, "", &[1, 1]))
            .expect_err("重复 index 必须拒绝"),
        ContractErrorCode::InvalidArgument,
    );
    assert_contract_code(
        block_on(derive_wallet_accounts(
            signer,
            &twelve,
            "",
            &[MAX_WALLET_ACCOUNT_INDEX + 1],
        ))
        .expect_err("越界 index 必须拒绝"),
        ContractErrorCode::InvalidArgument,
    );
}

fn assert_contract_code(error: EngineError, expected: ContractErrorCode) {
    match error {
        EngineError::Contract(contract) => assert_eq!(contract.code(), expected),
        other => panic!("期望 typed contract error，实际为 {other:?}"),
    }
}

fn decode_fixed_hex<const N: usize>(encoded: &str) -> [u8; N] {
    let encoded = encoded.strip_prefix("0x").unwrap_or(encoded);
    assert_eq!(encoded.len(), N * 2, "hex 固定长度不匹配");
    let mut output = [0_u8; N];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[index * 2..index * 2 + 2], 16)
            .expect("金标必须是小写或大写十六进制");
    }
    output
}
