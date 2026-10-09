// Smoldot
// Copyright (C) 2024 VoyagerRhett
// SPDX-License-Identifier: GPL-3.0-or-later WITH Classpath-exception-2.0

//! PoW（工作量证明）区块头验证。
//!
//! 轻客户端的安全性主要依赖 GRANDPA 最终性，而非重新验证 PoW 哈希。
//! 此模块验证区块头的 PoW 格式是否正确（seal 存在且可解码），
//! 不重复执行完整的哈希难度计算。

use crate::header;

/// PoW 验证配置。
pub struct VerifyConfig<'a> {
    /// 待验证区块的头。
    pub block_header: header::HeaderRef<'a>,
    /// 当前 PoW 难度目标（轻客户端用于格式校验，不做完整哈希验证）。
    pub difficulty: u128,
}

/// PoW 验证成功的结果。
pub struct VerifySuccess {
    /// seal 中的 nonce 值。
    pub nonce: u64,
}

/// PoW 验证错误。
#[derive(Debug, derive_more::Display, derive_more::Error)]
pub enum VerifyError {
    /// 区块头中没有 PoW seal。
    MissingSeal,
    /// seal 数据无法解码为 u64 nonce（SCALE 编码应为 8 字节）。
    InvalidSealFormat,
}

/// 验证 PoW 区块头格式。
///
/// 检查区块头包含有效的 PoW seal（可解码为 u64 nonce）。
/// 轻客户端不重复执行 blake2_256 哈希+难度验证，安全性由 GRANDPA 最终性保证。
pub fn verify_header(config: VerifyConfig<'_>) -> Result<VerifySuccess, VerifyError> {
    // 1. 提取 PoW seal
    let seal_data = config
        .block_header
        .digest
        .pow_seal()
        .ok_or(VerifyError::MissingSeal)?;

    // 2. 严格解码 seal
    // citizenchain seal 唯一格式：SCALE 编码的 `(u64, sr25519::Signature)`
    // = 8 字节 nonce(u64 定长 LE) + 64 字节 sr25519 签名 = 恰好 72 字节
    // (定长数组无长度前缀)。节点 (core/service.rs) 与 GPU 矿工 (mining/gpu_miner.rs)
    // 都只发这一种,故此处按精确长度断言,任何偏离一律拒绝,不做「≥8 字节」宽容。
    const POW_SEAL_LEN: usize = 8 + 64;
    if seal_data.len() != POW_SEAL_LEN {
        return Err(VerifyError::InvalidSealFormat);
    }
    let nonce = u64::from_le_bytes(
        seal_data[..8]
            .try_into()
            .map_err(|_| VerifyError::InvalidSealFormat)?,
    );

    Ok(VerifySuccess { nonce })
}
