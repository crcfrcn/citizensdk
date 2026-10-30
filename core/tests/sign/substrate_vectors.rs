//! 冻结 CitizenApp/CitizenWallet 已共同验证的 Substrate 派生结果。
//!
//! 这里只验证 signer 接收到 child mini-secret 后计算出的 AccountId；助记词和 junction
//! 编码已由根钱包金标独立覆盖，避免把钱包职责塞进密码学 crate。

#![forbid(unsafe_code)]

use citizensdk::types::SecretBuffer;

use zeroize::Zeroizing;

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
fn frozen_child_keys_produce_expected_account_ids() {
    for (child_hex, expected_public_hex) in VECTORS {
        let child = Zeroizing::new(decode_32(child_hex));
        let expected_public = decode_32(expected_public_hex);
        let secret = match SecretBuffer::try_new(child.to_vec()) {
            Ok(value) => value,
            Err(_) => panic!("固定向量秘密缓冲无效"),
        };
        let actual_public = match citizensdk::sign::public_key(&secret) {
            Ok(value) => value,
            Err(_) => panic!("固定向量公钥派生失败"),
        };
        assert_eq!(actual_public.as_bytes(), &expected_public);
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
