//! 验证Dart事件来源的实例隔离和错误后的作用域恢复。

use super::*;
#[test]
fn origin_is_owner_scoped_and_restored_after_errors() {
    assert!(!owns(1));
    let _ = scope(1, || {
        assert!(owns(1));
        assert!(!owns(2));
        assert!(scope(2, || Ok(())).is_err());
        Err::<(), _>(FfiError::invalid("fixture"))
    });
    assert!(!owns(1));
}
