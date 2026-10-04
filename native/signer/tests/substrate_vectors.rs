//! 冻结 CitizenApp/CitizenWallet 已共同验证的 Substrate 派生结果。
//!
//! 这里只验证 signer 接收到 child mini-secret 后计算出的 AccountId；助记词和 junction
//! 编码已由根钱包金标独立覆盖，避免把钱包职责塞进密码学 crate。

use citizen_signer::{citizen_sr25519_public_key, CITIZEN_SIGNER_OK};

const VECTORS: [(&str, &str); 3] = [
    (
        "914dded06277afbe5b0e8a30bce539ec8a9552a784d08e530dc7c2915c478393",
        "2afba9278e30ccf6a6ceb3a8b6e336b70068f045c666f2e7f4f9cc5f47db8972",
    ),
    (
        "4433c3ada0cf37c3050d5435321872f4f84ef53d8b5f1f1560689d500b882245",
        "b606fc73f57f03cdb4c932d475ab426043e429cecc2ffff0d2672b0df8398c48",
    ),
    (
        "5418179cea7224f2d9d2ab437773c2fdb266e52ef7fa52c0d9c15c6ca6068748",
        "46f136b564e1fad55031404dd84e5cd3fa76bfe7cc7599b39d38fd06663bbc0a",
    ),
];

#[test]
#[allow(unsafe_code)] // 冻结向量同时约束 legacy C ABI，原始指针调用不可避免。
fn frozen_child_keys_produce_expected_account_ids() {
    for (child_hex, expected_public_hex) in VECTORS {
        let child = decode_32(child_hex);
        let expected_public = decode_32(expected_public_hex);
        let mut actual_public = [0u8; 32];
        // SAFETY: 两个指针分别指向本次循环内存活的 32 字节输入和输出数组。
        let status =
            unsafe { citizen_sr25519_public_key(child.as_ptr(), actual_public.as_mut_ptr()) };
        assert_eq!(status, CITIZEN_SIGNER_OK);
        assert_eq!(actual_public, expected_public);
    }
}

fn decode_32(value: &str) -> [u8; 32] {
    assert_eq!(value.len(), 64, "向量必须是 32 字节十六进制");
    let bytes = value.as_bytes();
    let mut output = [0u8; 32];
    for index in 0..output.len() {
        output[index] = (nibble(bytes[index * 2]) << 4) | nibble(bytes[index * 2 + 1]);
    }
    output
}

fn nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => panic!("向量包含非十六进制字符"),
    }
}
