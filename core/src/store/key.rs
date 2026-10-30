//! 数据库键只由Rust生成；保持原小写十六进制字节，不涉及硬件别名。
use crate::types::ContractResult;
use crate::types::Hash32;
use crate::types::TransactionExecutionId;

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 15)] as char);
    }
    output
}

pub fn block(hash: Hash32) -> String {
    hex(hash.as_bytes())
}

pub fn execution(id: TransactionExecutionId) -> String {
    hex(id.as_bytes())
}

pub fn parse_execution(value: &str) -> ContractResult<TransactionExecutionId> {
    let bytes = value.as_bytes();
    if bytes.len() != 32 {
        return Err(crate::store::error::integrity(
            "history key length is invalid",
        ));
    }
    let nibble = |byte: u8| match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(crate::store::error::integrity(
            "history key is not canonical lowercase hex",
        )),
    };
    let mut id = [0; 16];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        id[index] = nibble(pair[0])? * 16 + nibble(pair[1])?;
    }
    TransactionExecutionId::try_new(id)
        .map_err(|_| crate::store::error::integrity("history key contains an invalid execution id"))
}

pub fn secret(reference: crate::types::SecretRef) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        reference.wallet_index(),
        1,
        hex(reference.generation().as_bytes()),
        hex(reference.owner().as_bytes()),
        hex(reference.account_id().as_bytes())
    )
}
