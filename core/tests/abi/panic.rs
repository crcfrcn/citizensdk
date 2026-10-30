#[test]
fn sdk_scope_is_nested_and_restored_after_panic() {
    assert!(!super::IN_SDK_BOUNDARY.with(std::cell::Cell::get));
    let result = super::catch_native_panic(|| {
        assert!(super::IN_SDK_BOUNDARY.with(std::cell::Cell::get));
        assert!(super::catch_native_panic(|| panic!("synthetic private value")).is_err());
        assert!(super::IN_SDK_BOUNDARY.with(std::cell::Cell::get));
    });
    assert!(result.is_ok());
    assert!(!super::IN_SDK_BOUNDARY.with(std::cell::Cell::get));
}
