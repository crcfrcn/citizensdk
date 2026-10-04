//! 仅使用公开合成熵，不引入真实用户助记词或密码。
#![allow(clippy::expect_used, clippy::unwrap_used)]

use bip39::{Language, Mnemonic};

use crate::{validate_wallet_mnemonic, wallet_word_suggestions, WalletWordCount};

#[test]
fn headless_input_results_share_the_real_parser_without_secret_echo() {
    use crate::{wallet_mnemonic_validation, wallet_password_validation, WalletInputReason};

    for (bytes, count) in [(16, WalletWordCount::Words12), (24, WalletWordCount::Words18), (32, WalletWordCount::Words24)] {
        let sentence = Mnemonic::from_entropy_in(Language::English, &vec![0; bytes])
            .unwrap().to_string();
        let result = wallet_mnemonic_validation(&sentence, count);
        assert_eq!(result.reason, WalletInputReason::Valid);
        assert_eq!(result.position, None);
        assert!(validate_wallet_mnemonic(&sentence, count).is_ok());
    }
    let mut words = ["abandon"; 12];
    words[4] = "notawalletword";
    let result = wallet_mnemonic_validation(&words.join(" "), WalletWordCount::Words12);
    assert_eq!(result.reason, WalletInputReason::UnknownWord);
    assert_eq!(result.position, Some(4));
    assert!(!format!("{result:?}").contains("notawalletword"));
    assert_eq!(wallet_mnemonic_validation(&"a".repeat(1025), WalletWordCount::Words12).reason, WalletInputReason::InputTooLong);
    assert_eq!(wallet_mnemonic_validation("", WalletWordCount::Words12).reason, WalletInputReason::WordCount);
    assert_eq!(wallet_mnemonic_validation(&["abandon"; 12].join(" "), WalletWordCount::Words12).reason, WalletInputReason::Checksum);
    for password in ["", "public-test", "公开合成测试汉字"] {
        assert_eq!(wallet_password_validation(password).reason, WalletInputReason::Valid);
    }
    assert_eq!(wallet_password_validation("short").reason, WalletInputReason::PasswordLength);
    for password in ["public test", "public\nsecret"] {
        assert_eq!(wallet_password_validation(password).reason, WalletInputReason::PasswordFormat);
    }
    assert_eq!(wallet_password_validation(&"a".repeat(1025)).reason, WalletInputReason::InputTooLong);
}

#[test]
fn selected_word_count_and_checksum_share_the_derivation_contract() {
    for (bytes, count) in [
        (16, WalletWordCount::Words12),
        (24, WalletWordCount::Words18),
        (32, WalletWordCount::Words24),
    ] {
        let mnemonic = Mnemonic::from_entropy_in(Language::English, &vec![0; bytes]).unwrap();
        let sentence = mnemonic.to_string();
        assert!(validate_wallet_mnemonic(&sentence, count).is_ok());
        for other in [
            WalletWordCount::Words12,
            WalletWordCount::Words18,
            WalletWordCount::Words24,
        ] {
            assert_eq!(
                validate_wallet_mnemonic(&sentence, other).is_ok(),
                count == other
            );
        }
        // 替换 checksum 对应末词，仍为词表合法词也必须失败。
        let mut words: Vec<_> = sentence.split_whitespace().collect();
        *words.last_mut().unwrap() = "abandon";
        assert!(validate_wallet_mnemonic(&words.join(" "), count).is_err());
    }
}

#[test]
fn other_bip39_lengths_are_rejected_even_with_valid_checksum() {
    for bytes in [20, 28] {
        let sentence = Mnemonic::from_entropy_in(Language::English, &vec![0; bytes])
            .unwrap()
            .to_string();
        assert!(super::wallet_input::parse_wallet_mnemonic(&sentence, None).is_err());
    }
    assert!(validate_wallet_mnemonic("", WalletWordCount::Words12).is_err());
    assert!(validate_wallet_mnemonic(&"a".repeat(1025), WalletWordCount::Words12).is_err());
}

#[test]
fn errors_report_position_without_echoing_the_input() {
    let mut words = ["abandon"; 12];
    words[4] = "notawalletword";
    let error = validate_wallet_mnemonic(&words.join(" "), WalletWordCount::Words12)
        .unwrap_err()
        .to_string();
    assert!(error.contains("第 5 个"));
    assert!(!error.contains("notawalletword"));
}

#[test]
fn suggestions_are_local_official_words_bounded_and_deterministic() {
    assert!(wallet_word_suggestions("").unwrap().is_empty());
    assert_eq!(wallet_word_suggestions("aban").unwrap(), vec!["abandon"]);
    let suggestions = wallet_word_suggestions("a").unwrap();
    assert_eq!(suggestions.len(), 6);
    assert!(suggestions
        .iter()
        .all(|word| Language::English.word_list().contains(word)));
    assert!(wallet_word_suggestions("zzzz").unwrap().is_empty());
    for invalid in ["A", "a b", "汉", "\n", "a\0"] {
        assert!(wallet_word_suggestions(invalid).is_err());
    }
    assert!(wallet_word_suggestions(&"a".repeat(1025)).is_err());
}
