use super::*;

#[test]
fn range_limit_accepts_120_and_rejects_121_reverse_and_overflow() {
    assert_eq!(validated_finalized_block_range_len(1, 120).ok(), Some(120));
    assert!(validated_finalized_block_range_len(1, 121).is_err());
    assert!(validated_finalized_block_range_len(2, 1).is_err());
    assert!(validated_finalized_block_range_len(0, u64::MAX).is_err());
}
